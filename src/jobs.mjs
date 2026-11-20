import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  DEFAULT_TIMEOUT_MS,
  resolveSpawnSpec,
  terminateProcessTree,
  truncateOutput,
} from "./runners/common.mjs";
import { parseClaudeJsonOutput } from "./runners/claude.mjs";
import { extractCodexSessionId } from "./runners/codex.mjs";
import { createEventStreamParser, parseCodexJsonlOutput } from "./events.mjs";

export const MAX_JOB_LOG_BYTES = 4 * 1024 * 1024; // 4 MB per stream
export const MAX_JOB_EVENTS_BYTES = 512 * 1024; // 512 KB per event log
const MAX_RETAINED_JOBS = 100;
const META_SYNC_THROTTLE_MS = 500;

function defaultJobsDir() {
  if (process.env.AGY_HANDOFF_JOBS_DIR) {
    return path.resolve(process.env.AGY_HANDOFF_JOBS_DIR);
  }
  if (process.env.PLUGIN_DATA) {
    return path.join(path.resolve(process.env.PLUGIN_DATA), "jobs");
  }
  const agyJobsDir = path.join(
    os.homedir(),
    ".gemini",
    "antigravity-cli",
    "plugin_data",
    "agy-handoff",
    "jobs",
  );
  if (fs.existsSync(agyJobsDir)) {
    return agyJobsDir;
  }
  const userSuffix =
    typeof process.getuid === "function"
      ? String(process.getuid())
      : os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.tmpdir(), `agy-handoff-jobs-${userSuffix}`);
}

export function getJobsDir(overrideDir) {
  const dir = overrideDir ? path.resolve(overrideDir) : defaultJobsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const lstat = fs.lstatSync(dir);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Jobs directory cannot be a symlink: ${dir}`);
  }
  if (!lstat.isDirectory()) {
    throw new Error(`Jobs path is not a directory: ${dir}`);
  }
  if (typeof process.getuid === "function") {
    if (lstat.uid !== process.getuid()) {
      throw new Error(`Jobs directory is not owned by the current user: ${dir}`);
    }
    fs.chmodSync(dir, 0o700);
  }
  return dir;
}

function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readFileBounded(filePath, maxBytes = MAX_JOB_LOG_BYTES) {
  if (!fs.existsSync(filePath)) {
    return { text: "", truncated: false };
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const toRead = Math.min(stat.size, maxBytes);
    const buf = Buffer.allocUnsafe(toRead);
    let offset = 0;
    while (offset < toRead) {
      const read = fs.readSync(fd, buf, offset, toRead - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return {
      text: buf.subarray(0, offset).toString("utf8"),
      truncated: stat.size > maxBytes,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function waitForStreamFinish(stream) {
  if (!stream || stream.writableFinished || stream.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      stream.off("finish", finish);
      stream.off("close", finish);
      stream.off("error", finish);
      resolve();
    };
    const guard = setTimeout(finish, 2000);
    guard.unref();
    stream.once("finish", finish);
    stream.once("close", finish);
    stream.once("error", finish);
  });
}

export class JobManager {
  constructor(jobsDir) {
    this.jobsDir = getJobsDir(jobsDir);
    this.activeChildren = new Map();
    this.liveState = new Map();
  }

  validateJobId(jobId) {
    if (typeof jobId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      throw new Error(`Invalid jobId: ${jobId}`);
    }
    return jobId;
  }

  allocateJobId(engine = "job") {
    const prefix = String(engine).replace(/[^a-zA-Z0-9_-]/g, "") || "job";
    return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
  }

  metaPath(jobId) {
    return path.join(this.jobsDir, `${this.validateJobId(jobId)}.json`);
  }

  stdoutPath(jobId) {
    return path.join(this.jobsDir, `${this.validateJobId(jobId)}.stdout.log`);
  }

  stderrPath(jobId) {
    return path.join(this.jobsDir, `${this.validateJobId(jobId)}.stderr.log`);
  }

  outputFilePath(jobId) {
    return path.join(this.jobsDir, `${this.validateJobId(jobId)}.output.txt`);
  }

  eventsPath(jobId) {
    return path.join(this.jobsDir, `${this.validateJobId(jobId)}.events.log`);
  }

  writeMeta(meta) {
    const file = this.metaPath(meta.id);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // ignore cleanup error
      }
      throw err;
    }
  }

  readMeta(jobId, { readOnly = false } = {}) {
    const file = this.metaPath(jobId);
    if (!fs.existsSync(file)) {
      return null;
    }
    const meta = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !readOnly &&
      meta.status === "running" &&
      !this.activeChildren.has(jobId) &&
      !this.liveState.has(jobId)
    ) {
      const sameOwner = meta.ownerPid && meta.ownerPid === process.pid;
      const stale = sameOwner
        ? !isProcessAlive(meta.pid)
        : !meta.ownerPid || !isProcessAlive(meta.ownerPid);
      if (stale) {
        meta.status = "failed";
        meta.finishedAt = meta.finishedAt || new Date().toISOString();
        meta.error = meta.error || "Background process exited unexpectedly.";
        this.writeMeta(meta);
      }
    }
    return meta;
  }

  readEvents(jobId, { limit = 15, sinceSeq = 0 } = {}) {
    if (limit === 0) {
      return [];
    }
    const file = this.eventsPath(jobId);
    if (!fs.existsSync(file)) {
      return [];
    }
    const { text } = readFileBounded(file, MAX_JOB_EVENTS_BYTES);
    if (!text) return [];
    const items = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        if (ev && typeof ev === "object" && (ev.seq || 0) > sinceSeq) {
          items.push(ev);
        }
      } catch {
        // ignore trailing partial event line
      }
    }
    return limit === null || limit < 0 ? items : items.slice(-limit);
  }

  notifyWaiters(jobId, explicitState = null) {
    const state = explicitState || this.liveState.get(jobId);
    if (!state) return;
    for (const fn of state.waiters) {
      try {
        fn();
      } catch {
        // ignore waiter callback failure
      }
    }
  }

  pruneOldJobs(maxJobs = MAX_RETAINED_JOBS) {
    try {
      const files = fs.readdirSync(this.jobsDir).filter((f) => f.endsWith(".json"));
      if (files.length <= maxJobs) return;
      const entries = [];
      for (const file of files) {
        const jobId = file.slice(0, -5);
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(this.jobsDir, file), "utf8"));
          entries.push({
            jobId,
            status: meta.status,
            startedAt: meta.startedAt || "",
          });
        } catch {
          entries.push({ jobId, status: "corrupted", startedAt: "" });
        }
      }
      entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      for (const entry of entries.slice(maxJobs)) {
        if (entry.status === "running") continue;
        for (const p of [
          this.metaPath(entry.jobId),
          this.stdoutPath(entry.jobId),
          this.stderrPath(entry.jobId),
          this.outputFilePath(entry.jobId),
          this.eventsPath(entry.jobId),
        ]) {
          try {
            fs.rmSync(p, { force: true });
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // pruning is best-effort
    }
  }

  beginForegroundRun({ engine, action, cwd, model = null, effort = null }) {
    const id = this.allocateJobId(engine);
    const eventsPath = this.eventsPath(id);
    this.pruneOldJobs();

    const eventsStream = fs.createWriteStream(eventsPath, { mode: 0o600 });
    eventsStream.on("error", () => {});

    const startedAt = new Date().toISOString();
    const meta = {
      id,
      engine,
      action,
      cwd,
      foreground: true,
      model,
      effort,
      sessionId: null,
      pid: process.pid,
      ownerPid: process.pid,
      status: "running",
      startedAt,
      finishedAt: null,
      exitCode: null,
      hasOutputFile: false,
      parseMode: "text",
      currentActivity: "Starting...",
      eventCount: 0,
      lastEventAt: startedAt,
      stdoutTruncated: false,
      stderrTruncated: false,
      error: null,
    };

    const state = {
      currentActivity: "Starting...",
      eventCount: 0,
      sessionId: null,
      recentEvents: [],
      waiters: new Set(),
    };
    this.liveState.set(id, state);

    let eventsBytes = 0;
    let lastMetaSyncAt = 0;
    let finished = false;

    try {
      this.writeMeta(meta);
    } catch {
      // foreground tracking should never fail the main execution
    }

    const recordEvent = (ev) => {
      if (finished) return;
      state.currentActivity = ev.summary || state.currentActivity;
      state.eventCount = ev.seq || state.eventCount + 1;
      if (ev.sessionId) {
        state.sessionId = ev.sessionId;
      }
      state.recentEvents.push(ev);
      if (state.recentEvents.length > 30) {
        state.recentEvents.shift();
      }

      if (
        eventsBytes < MAX_JOB_EVENTS_BYTES &&
        !eventsStream.destroyed &&
        !eventsStream.writableEnded
      ) {
        const line = `${JSON.stringify(ev)}\n`;
        const buf = Buffer.from(line, "utf8");
        if (eventsBytes + buf.length <= MAX_JOB_EVENTS_BYTES) {
          eventsStream.write(buf);
          eventsBytes += buf.length;
        }
      }

      const now = Date.now();
      if (now - lastMetaSyncAt >= META_SYNC_THROTTLE_MS) {
        lastMetaSyncAt = now;
        try {
          meta.currentActivity = state.currentActivity;
          meta.eventCount = state.eventCount;
          meta.lastEventAt = ev.ts || new Date().toISOString();
          meta.sessionId = state.sessionId;
          this.writeMeta(meta);
        } catch {
          // ignore
        }
      }

      this.notifyWaiters(id);
    };

    const finish = async ({
      status = "completed",
      exitCode = 0,
      error = null,
      sessionId = null,
    } = {}) => {
      if (finished) return;
      finished = true;
      try {
        eventsStream.end();
        await waitForStreamFinish(eventsStream);
      } catch {
        // ignore
      }
      try {
        if (fs.existsSync(this.jobsDir)) {
          meta.status = status;
          meta.exitCode = exitCode;
          meta.finishedAt = new Date().toISOString();
          meta.error = error;
          meta.sessionId = sessionId || state.sessionId || meta.sessionId;
          meta.currentActivity = state.currentActivity;
          meta.eventCount = state.eventCount;
          this.writeMeta(meta);
        }
      } catch {
        // ignore
      } finally {
        this.liveState.delete(id);
        this.notifyWaiters(id, state);
      }
    };

    return {
      jobId: id,
      eventsPath,
      recordEvent,
      finish,
    };
  }

  startJob({
    jobId,
    engine,
    action,
    command,
    args,
    cwd,
    stdin,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    hasOutputFile = false,
    parseMode = "text",
    model = null,
    effort = null,
    onEvent = null,
  }) {
    const id = jobId ? this.validateJobId(jobId) : this.allocateJobId(engine);
    const stdoutPath = this.stdoutPath(id);
    const stderrPath = this.stderrPath(id);
    const eventsPath = this.eventsPath(id);
    const outputFile = hasOutputFile ? this.outputFilePath(id) : null;

    this.pruneOldJobs();

    const stdoutStream = fs.createWriteStream(stdoutPath, { mode: 0o600 });
    const stderrStream = fs.createWriteStream(stderrPath, { mode: 0o600 });
    const eventsStream = fs.createWriteStream(eventsPath, { mode: 0o600 });
    stdoutStream.on("error", () => {});
    stderrStream.on("error", () => {});
    eventsStream.on("error", () => {});

    const spawnSpec = resolveSpawnSpec(command, args);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      windowsVerbatimArguments: Boolean(spawnSpec.windowsVerbatimArguments),
    });

    const startedAt = new Date().toISOString();
    const meta = {
      id,
      engine,
      action,
      cwd,
      model,
      effort,
      sessionId: null,
      pid: child.pid || null,
      ownerPid: process.pid,
      status: "running",
      startedAt,
      finishedAt: null,
      exitCode: null,
      hasOutputFile: Boolean(outputFile),
      parseMode,
      currentActivity: "Starting...",
      eventCount: 0,
      lastEventAt: startedAt,
      stdoutTruncated: false,
      stderrTruncated: false,
      error: null,
    };

    const state = {
      currentActivity: "Starting...",
      eventCount: 0,
      sessionId: null,
      recentEvents: [],
      waiters: new Set(),
    };
    this.liveState.set(id, state);

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let eventsBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let finalizing = false;
    let finalized = false;
    let exitCode = null;
    let lastMetaSyncAt = 0;
    let exitGraceTimer = null;
    let killEscalateTimer = null;

    const parser =
      engine === "codex" || engine === "claude"
        ? createEventStreamParser(engine, (ev) => {
            if (finalized) return;
            state.currentActivity = ev.summary || state.currentActivity;
            state.eventCount = ev.seq || state.eventCount + 1;
            if (ev.sessionId) {
              state.sessionId = ev.sessionId;
            }
            state.recentEvents.push(ev);
            if (state.recentEvents.length > 30) {
              state.recentEvents.shift();
            }

            if (
              eventsBytes < MAX_JOB_EVENTS_BYTES &&
              !eventsStream.destroyed &&
              !eventsStream.writableEnded
            ) {
              const line = `${JSON.stringify(ev)}\n`;
              const buf = Buffer.from(line, "utf8");
              if (eventsBytes + buf.length <= MAX_JOB_EVENTS_BYTES) {
                eventsStream.write(buf);
                eventsBytes += buf.length;
              }
            }

            const now = Date.now();
            if (now - lastMetaSyncAt >= META_SYNC_THROTTLE_MS) {
              lastMetaSyncAt = now;
              try {
                const latest = this.readMeta(id) || meta;
                if (latest.status === "running") {
                  latest.currentActivity = state.currentActivity;
                  latest.eventCount = state.eventCount;
                  latest.lastEventAt = ev.ts || new Date().toISOString();
                  latest.sessionId = state.sessionId;
                  this.writeMeta(latest);
                }
              } catch {
                // ignore periodic sync failures
              }
            }

            this.notifyWaiters(id);
            if (typeof onEvent === "function") {
              try {
                onEvent(ev);
              } catch {
                // ignore user callback failure
              }
            }
          })
        : null;

    const appendToStream = (stream, chunk, isStdout) => {
      const current = isStdout ? stdoutBytes : stderrBytes;
      if (current >= MAX_JOB_LOG_BYTES) {
        if (isStdout) stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }
      const remaining = MAX_JOB_LOG_BYTES - current;
      const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      if (chunk.length > remaining) {
        if (isStdout) stdoutTruncated = true;
        else stderrTruncated = true;
      }
      if (isStdout) stdoutBytes += slice.length;
      else stderrBytes += slice.length;
      if (!stream.destroyed && !stream.writableEnded) {
        stream.write(slice);
      }
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminateProcessTree(child.pid, "SIGTERM");
            killEscalateTimer = setTimeout(() => {
              terminateProcessTree(child.pid, "SIGKILL");
            }, 2000);
            killEscalateTimer.unref();
          }, timeoutMs)
        : null;
    if (timer) timer.unref();

    const finalize = async (status, code, error = null) => {
      if (finalizing) return;
      finalizing = true;
      if (timer) clearTimeout(timer);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      if (killEscalateTimer) clearTimeout(killEscalateTimer);

      if (parser) {
        try {
          parser.flush();
        } catch {
          // ignore
        }
      }
      finalized = true;

      try {
        stdoutStream.end();
        stderrStream.end();
        eventsStream.end();
        await Promise.all([
          waitForStreamFinish(stdoutStream),
          waitForStreamFinish(stderrStream),
          waitForStreamFinish(eventsStream),
        ]);
      } catch {
        // ignore stream flush error
      }

      try {
        if (!fs.existsSync(this.jobsDir)) {
          return;
        }
        let finalStatus = status;
        let finalError = error;
        let parsedSessionId = state.sessionId;

        if (parseMode === "claude-json" && finalStatus === "completed") {
          const raw = readFileBounded(stdoutPath, MAX_JOB_LOG_BYTES);
          const parsed = parseClaudeJsonOutput(raw.text);
          if (parsed.sessionId) {
            parsedSessionId = parsed.sessionId;
          }
          if (stdoutTruncated || raw.truncated || parsed.parseError) {
            finalStatus = "failed";
            finalError = "Claude Code JSON output was truncated or malformed.";
          } else if (parsed.isError) {
            finalStatus = "failed";
            finalError = parsed.text || "Claude Code reported an error.";
          }
        } else if (engine === "codex" && !parsedSessionId) {
          const rawOut = readFileBounded(stdoutPath, MAX_JOB_LOG_BYTES).text;
          const rawErr = readFileBounded(stderrPath, MAX_JOB_LOG_BYTES).text;
          const jsonl = parseCodexJsonlOutput(rawOut);
          parsedSessionId =
            jsonl.sessionId || extractCodexSessionId(`${rawErr}\n${rawOut}`);
        }

        const latest = this.readMeta(id) || meta;
        if (latest.status === "canceled") {
          latest.finishedAt = latest.finishedAt || new Date().toISOString();
          latest.exitCode = code;
          latest.currentActivity = state.currentActivity;
          latest.eventCount = state.eventCount;
          latest.sessionId = parsedSessionId || latest.sessionId;
          this.writeMeta(latest);
          return;
        }
        latest.status = finalStatus;
        latest.exitCode = code;
        latest.finishedAt = new Date().toISOString();
        latest.error = finalError;
        latest.stdoutTruncated = stdoutTruncated;
        latest.stderrTruncated = stderrTruncated;
        latest.currentActivity = state.currentActivity;
        latest.eventCount = state.eventCount;
        latest.sessionId = parsedSessionId || latest.sessionId;
        this.writeMeta(latest);
      } catch {
        // never let metadata write failure escape event handler
      } finally {
        this.activeChildren.delete(id);
        this.liveState.delete(id);
        this.notifyWaiters(id, state);
      }
    };

    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      appendToStream(stdoutStream, chunk, true);
      if (parser) {
        try {
          parser.push(chunk);
        } catch {
          // ignore parser error on arbitrary chunk
        }
      }
    });
    child.stderr.on("data", (chunk) => appendToStream(stderrStream, chunk, false));

    child.on("error", (err) => {
      void finalize("failed", -1, err.message);
    });

    child.on("exit", (code) => {
      exitCode = code;
      if (timedOut && !exitGraceTimer) {
        exitGraceTimer = setTimeout(() => {
          try {
            child.stdout?.destroy();
            child.stderr?.destroy();
          } catch {
            // ignore
          }
          void finalize("timed_out", exitCode ?? -1, "Job exceeded timeout limit.");
        }, 500);
        exitGraceTimer.unref();
      }
    });

    child.on("close", (code) => {
      if (timedOut) {
        void finalize("timed_out", code ?? -1, "Job exceeded timeout limit.");
      } else if (code === 0) {
        void finalize("completed", 0, null);
      } else {
        void finalize("failed", code ?? -1, `Process exited with code ${code ?? -1}`);
      }
    });

    try {
      this.activeChildren.set(id, child);
      this.writeMeta(meta);
    } catch (err) {
      this.activeChildren.delete(id);
      this.liveState.delete(id);
      if (timer) clearTimeout(timer);
      terminateProcessTree(child.pid, "SIGKILL");
      stdoutStream.destroy();
      stderrStream.destroy();
      eventsStream.destroy();
      throw err;
    }

    if (stdin !== undefined && stdin !== null) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }

    return {
      jobId: id,
      engine,
      action,
      status: "running",
      model,
      effort,
      pid: meta.pid,
      startedAt: meta.startedAt,
      eventsPath,
    };
  }

  getStatus(jobId, { eventsLimit = 10, sinceSeq = 0, readOnly = false } = {}) {
    const meta = this.readMeta(jobId, { readOnly });
    if (!meta) {
      throw new Error(`Job not found: ${jobId}`);
    }
    const state = this.liveState.get(meta.id);
    const startMs = Date.parse(meta.startedAt || "");
    const endMs = meta.finishedAt ? Date.parse(meta.finishedAt) : Date.now();
    const elapsedMs =
      Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.max(0, endMs - startMs)
        : 0;

    let recentEvents;
    if (eventsLimit === 0) {
      recentEvents = [];
    } else if (state) {
      const filtered = state.recentEvents.filter((ev) => (ev.seq || 0) > sinceSeq);
      recentEvents =
        eventsLimit === null || eventsLimit < 0
          ? filtered
          : filtered.slice(-eventsLimit);
    } else {
      recentEvents = this.readEvents(meta.id, { limit: eventsLimit, sinceSeq });
    }

    return {
      jobId: meta.id,
      engine: meta.engine,
      action: meta.action,
      status: meta.status,
      foreground: Boolean(meta.foreground),
      model: meta.model || null,
      effort: meta.effort || null,
      sessionId: state?.sessionId || meta.sessionId || null,
      pid: meta.pid,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      finishedAt: meta.finishedAt,
      elapsedMs,
      exitCode: meta.exitCode,
      currentActivity: state?.currentActivity || meta.currentActivity || null,
      eventCount: state?.eventCount ?? meta.eventCount ?? 0,
      lastEventAt: meta.lastEventAt || null,
      eventsPath: this.eventsPath(meta.id),
      recentEvents,
      error: meta.error,
    };
  }

  async waitForStatus(jobId, { waitSec = 0, sinceSeq = 0, eventsLimit = 10 } = {}) {
    const initial = this.getStatus(jobId, { eventsLimit, sinceSeq });
    if (!waitSec || waitSec <= 0 || initial.status !== "running") {
      return initial;
    }
    if (initial.recentEvents.length > 0) {
      return initial;
    }

    const deadline = Date.now() + waitSec * 1000;
    const state = this.liveState.get(jobId);

    if (state) {
      await new Promise((resolve) => {
        let done = false;
        let batchTimer = null;
        let maxTimer = null;

        const finish = () => {
          if (done) return;
          done = true;
          if (batchTimer) clearTimeout(batchTimer);
          if (maxTimer) clearTimeout(maxTimer);
          state.waiters.delete(onNotify);
          resolve();
        };

        const onNotify = () => {
          const current = this.liveState.get(jobId);
          if (!current) {
            finish();
            return;
          }
          const hasNew = current.recentEvents.some((e) => (e.seq || 0) > sinceSeq);
          if (hasNew && !batchTimer) {
            const remaining = Math.max(0, deadline - Date.now());
            const delay = Math.min(300, remaining);
            if (delay <= 0) {
              finish();
            } else {
              batchTimer = setTimeout(finish, delay);
            }
          }
        };

        state.waiters.add(onNotify);
        maxTimer = setTimeout(finish, Math.max(10, deadline - Date.now()));
      });
      return this.getStatus(jobId, { eventsLimit, sinceSeq });
    }

    // Cross-process polling fallback
    while (Date.now() < deadline) {
      await new Promise((r) =>
        setTimeout(r, Math.min(400, Math.max(10, deadline - Date.now()))),
      );
      const snap = this.getStatus(jobId, { eventsLimit, sinceSeq });
      if (snap.status !== "running" || snap.recentEvents.length > 0) {
        return snap;
      }
    }
    return this.getStatus(jobId, { eventsLimit, sinceSeq });
  }

  listJobs(limit = 20, { readOnly = false } = {}) {
    const files = fs
      .readdirSync(this.jobsDir)
      .filter((f) => f.endsWith(".json"));
    const items = [];
    for (const file of files) {
      const jobId = file.slice(0, -5);
      try {
        items.push(this.getStatus(jobId, { eventsLimit: 0, readOnly }));
      } catch {
        // skip corrupted or invalid metadata
      }
    }
    items.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    return items.slice(0, limit);
  }

  getResult(jobId) {
    const meta = this.readMeta(jobId);
    if (!meta) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const stdoutRead = readFileBounded(this.stdoutPath(meta.id), MAX_JOB_LOG_BYTES);
    const stderrRead = readFileBounded(this.stderrPath(meta.id), MAX_JOB_LOG_BYTES);
    const rawStdout = stdoutRead.text;
    const rawStderr = stderrRead.text;

    let output = rawStdout;
    let sessionId = meta.sessionId || null;
    let costUsd = null;

    if (meta.hasOutputFile) {
      const outPath = this.outputFilePath(meta.id);
      if (fs.existsSync(outPath)) {
        const lastMsg = readFileBounded(outPath, MAX_JOB_LOG_BYTES).text.trim();
        if (lastMsg) {
          output = lastMsg;
        }
      }
    }

    if (meta.parseMode === "claude-json") {
      const parsed = parseClaudeJsonOutput(rawStdout);
      if (meta.stdoutTruncated || stdoutRead.truncated || parsed.parseError) {
        output = `Claude Code JSON output was truncated or malformed.\n\n${parsed.text || rawStderr}`;
      } else {
        output = parsed.text || rawStderr;
      }
      sessionId = parsed.sessionId || sessionId;
      costUsd = parsed.costUsd;
    } else if (meta.engine === "codex") {
      const jsonl = parseCodexJsonlOutput(rawStdout);
      sessionId =
        sessionId ||
        jsonl.sessionId ||
        extractCodexSessionId(`${rawStderr}\n${rawStdout}`);
      if ((!meta.hasOutputFile || output === rawStdout) && jsonl.parsedAnyJson) {
        output =
          jsonl.lastMessage ||
          (meta.status === "completed" ? rawStdout : jsonl.error || rawStderr || rawStdout);
      }
    }

    if (!output && rawStderr) {
      output = rawStderr;
    }

    return {
      jobId: meta.id,
      engine: meta.engine,
      action: meta.action,
      status: meta.status,
      exitCode: meta.exitCode,
      startedAt: meta.startedAt,
      finishedAt: meta.finishedAt,
      sessionId,
      costUsd,
      eventCount: meta.eventCount ?? 0,
      eventsPath: this.eventsPath(meta.id),
      output: truncateOutput(output),
      stderr: meta.status === "completed" ? "" : truncateOutput(rawStderr),
      error: meta.error,
    };
  }

  cancelJob(jobId) {
    const meta = this.readMeta(jobId);
    if (!meta) {
      throw new Error(`Job not found: ${jobId}`);
    }
    if (meta.status !== "running") {
      return {
        jobId: meta.id,
        status: meta.status,
        canceled: false,
        message: `Job is already ${meta.status}.`,
      };
    }

    const child = this.activeChildren.get(jobId);
    if (!child) {
      return {
        jobId: meta.id,
        status: meta.status,
        canceled: false,
        message:
          "Job is not owned by this server instance; refusing to signal unverified PID.",
      };
    }

    meta.status = "canceled";
    meta.finishedAt = new Date().toISOString();
    meta.error = "Canceled by user.";
    this.writeMeta(meta);
    this.notifyWaiters(jobId);

    terminateProcessTree(child.pid, "SIGTERM");
    setTimeout(() => {
      terminateProcessTree(child.pid, "SIGKILL");
    }, 2000).unref();

    return {
      jobId: meta.id,
      status: "canceled",
      canceled: true,
      message: "Cancellation signal sent.",
    };
  }

  shutdown() {
    for (const [jobId, child] of this.activeChildren.entries()) {
      try {
        const meta = this.readMeta(jobId);
        if (meta && meta.status === "running") {
          meta.status = "canceled";
          meta.finishedAt = new Date().toISOString();
          meta.error = "Server shutting down.";
          this.writeMeta(meta);
        }
      } catch {
        // ignore metadata write errors during shutdown
      }
      this.notifyWaiters(jobId);
      terminateProcessTree(child.pid, "SIGTERM");
    }
  }
}
