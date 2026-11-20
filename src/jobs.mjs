import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  DEFAULT_TIMEOUT_MS,
  renameSyncSafe,
  resolveSpawnSpec,
  terminateProcessTree,
  truncateOutput,
} from "./runners/common.mjs";
import { parseClaudeJsonOutput } from "./runners/claude.mjs";
import { extractCodexSessionId } from "./runners/codex.mjs";
import { createEventStreamParser, parseCodexJsonlOutput } from "./events.mjs";
import { parseStructuredReviewPayload } from "./cross-review.mjs";
import {
  captureGitDirtySnapshot,
  computeGitDelta,
  createExecutionEvidenceTracker,
} from "./context.mjs";

export const MAX_JOB_LOG_BYTES = 4 * 1024 * 1024; // 4 MB per stream
export const MAX_JOB_EVENTS_BYTES = 512 * 1024; // 512 KB per event log
const MAX_RETAINED_JOBS = 100;
const META_SYNC_THROTTLE_MS = 500;
const MAX_REPLAY_STDIN_BYTES = 64 * 1024; // 64 KB cap for safe read-only retry specs

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

function extractReportedTokens(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const input =
    typeof usage.input_tokens === "number"
      ? usage.input_tokens
      : typeof usage.inputTokens === "number"
        ? usage.inputTokens
        : null;
  const output =
    typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : typeof usage.outputTokens === "number"
        ? usage.outputTokens
        : null;
  if (input === null && output === null) {
    return null;
  }
  return {
    input: input ?? 0,
    output: output ?? 0,
  };
}

function sanitizePersistedRequestParams(requestParams, fallbackPrompt = null) {
  if (!requestParams || typeof requestParams !== "object") {
    return null;
  }
  if (requestParams.sessionId === "last") {
    return null;
  }
  const promptText =
    typeof requestParams.prompt === "string"
      ? requestParams.prompt
      : typeof fallbackPrompt === "string"
        ? fallbackPrompt
        : undefined;
  if (
    typeof promptText === "string" &&
    Buffer.byteLength(promptText, "utf8") > MAX_REPLAY_STDIN_BYTES
  ) {
    return null;
  }
  return {
    style: requestParams.style,
    scope: requestParams.scope,
    base: requestParams.base,
    commit: requestParams.commit,
    prompt: promptText,
    structured: Boolean(requestParams.structured),
    sessionId: requestParams.sessionId,
    skipGitRepoCheck: requestParams.skipGitRepoCheck,
    timeoutSec: requestParams.timeoutSec,
  };
}

export class JobManager {
  constructor(jobsDir) {
    this.jobsDir = getJobsDir(jobsDir);
    this.activeChildren = new Map();
    this.liveState = new Map();
    this.cancelTimers = new Map();
    this.inMemoryReplay = new Map();
    this.retryingJobs = new Set();
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

  schemaPath(jobId) {
    return path.join(this.jobsDir, `${this.validateJobId(jobId)}.schema.json`);
  }

  writeMeta(meta) {
    const file = this.metaPath(meta.id);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSyncSafe(tmp, file);
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
        : (!meta.ownerPid || !isProcessAlive(meta.ownerPid)) &&
          (!meta.pid || !isProcessAlive(meta.pid));
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
          this.schemaPath(entry.jobId),
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

  beginForegroundRun({
    engine,
    action,
    cwd,
    model = null,
    effort = null,
    mode = null,
    handoffContext = null,
    retryOf = null,
    structured = false,
    requestParams = null,
  }) {
    const id = this.allocateJobId(engine);
    const eventsPath = this.eventsPath(id);
    this.pruneOldJobs();

    const eventsStream = fs.createWriteStream(eventsPath, { mode: 0o600 });
    eventsStream.on("error", () => {});

    const safeRequestParams =
      mode === "read-only" ? sanitizePersistedRequestParams(requestParams) : null;

    const startedAt = new Date().toISOString();
    const meta = {
      id,
      engine,
      action,
      mode,
      retryable: mode === "read-only" && Boolean(safeRequestParams),
      retryOf: retryOf || null,
      structured: Boolean(structured),
      handoffContext: handoffContext || null,
      replaySpec: safeRequestParams ? { requestParams: safeRequestParams } : null,
      executionEvidence: null,
      cwd,
      foreground: true,
      model,
      effort,
      sessionId: null,
      costUsd: null,
      usage: null,
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
      costUsd: null,
      usage: null,
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
      if (typeof ev.costUsd === "number") {
        state.costUsd = ev.costUsd;
      }
      if (ev.usage && typeof ev.usage === "object") {
        state.usage = ev.usage;
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
      costUsd = null,
      usage = null,
      executionEvidence = null,
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
          meta.costUsd =
            typeof costUsd === "number" ? costUsd : state.costUsd ?? meta.costUsd;
          meta.usage = usage || state.usage || meta.usage || null;
          meta.executionEvidence = executionEvidence || meta.executionEvidence || null;
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
    mode = null,
    command,
    args,
    cwd,
    stdin,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    hasOutputFile = false,
    parseMode = "text",
    model = null,
    effort = null,
    handoffContext = null,
    retryOf = null,
    structured = false,
    outputSchema = null,
    beforeGit = null,
    requestParams = null,
    onEvent = null,
  }) {
    const id = jobId ? this.validateJobId(jobId) : this.allocateJobId(engine);
    const stdoutPath = this.stdoutPath(id);
    const stderrPath = this.stderrPath(id);
    const eventsPath = this.eventsPath(id);
    const outputFile = hasOutputFile ? this.outputFilePath(id) : null;
    const schemaFile = outputSchema ? this.schemaPath(id) : null;

    this.pruneOldJobs();

    let stdoutStream = null;
    let stderrStream = null;
    let eventsStream = null;
    let child = null;

    try {
      if (schemaFile) {
        fs.writeFileSync(schemaFile, JSON.stringify(outputSchema, null, 2), {
          encoding: "utf8",
          mode: 0o600,
        });
      }
      const spawnSpec = resolveSpawnSpec(command, args);
      stdoutStream = fs.createWriteStream(stdoutPath, { mode: 0o600 });
      stderrStream = fs.createWriteStream(stderrPath, { mode: 0o600 });
      eventsStream = fs.createWriteStream(eventsPath, { mode: 0o600 });
      stdoutStream.on("error", () => {});
      stderrStream.on("error", () => {});
      eventsStream.on("error", () => {});

      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
        windowsVerbatimArguments: Boolean(spawnSpec.windowsVerbatimArguments),
      });
    } catch (err) {
      stdoutStream?.destroy();
      stderrStream?.destroy();
      eventsStream?.destroy();
      if (schemaFile) {
        try {
          fs.rmSync(schemaFile, { force: true });
        } catch {
          // ignore
        }
      }
      throw err;
    }

    const isReadOnly = mode === "read-only";
    const stdinTooLarge =
      typeof stdin === "string" &&
      Buffer.byteLength(stdin, "utf8") > MAX_REPLAY_STDIN_BYTES;
    const usesLastSession = requestParams?.sessionId === "last";
    const safeRequestParams = isReadOnly
      ? sanitizePersistedRequestParams(requestParams, stdin)
      : null;
    const canReplayInMemory =
      isReadOnly &&
      !stdinTooLarge &&
      !usesLastSession &&
      typeof command === "string" &&
      Array.isArray(args);

    if (canReplayInMemory) {
      this.inMemoryReplay.set(id, {
        engine,
        action,
        mode: "read-only",
        cwd,
        model,
        effort,
        parseMode,
        hasOutputFile: Boolean(outputFile),
        timeoutMs,
        structured: Boolean(structured),
        outputSchema: outputSchema || null,
        command,
        args: [...args],
        stdin: stdin ?? undefined,
        requestParams: safeRequestParams,
      });
    }

    const jsonStreamEnabled =
      parseMode === "claude-json" ||
      (engine === "codex" && Array.isArray(args) && args.includes("--json"));
    const evidenceTracker = createExecutionEvidenceTracker({
      action,
      mode: mode || "unknown",
      jsonStream: jsonStreamEnabled,
    });

    const startedAt = new Date().toISOString();
    const meta = {
      id,
      engine,
      action,
      mode,
      retryable: Boolean(safeRequestParams || canReplayInMemory),
      retryOf: retryOf || null,
      structured: Boolean(structured),
      handoffContext: handoffContext || null,
      replaySpec: safeRequestParams ? { requestParams: safeRequestParams } : null,
      executionEvidence: null,
      cwd,
      model,
      effort,
      sessionId: null,
      costUsd: null,
      usage: null,
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
      costUsd: null,
      usage: null,
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
    let hardSettleTimer = null;

    const parser =
      engine === "codex" || engine === "claude"
        ? createEventStreamParser(engine, (ev) => {
            if (finalized) return;
            evidenceTracker.recordEvent(ev);
            state.currentActivity = ev.summary || state.currentActivity;
            state.eventCount = ev.seq || state.eventCount + 1;
            if (ev.sessionId) {
              state.sessionId = ev.sessionId;
            }
            if (typeof ev.costUsd === "number") {
              state.costUsd = ev.costUsd;
            }
            if (ev.usage && typeof ev.usage === "object") {
              state.usage = ev.usage;
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
            hardSettleTimer = setTimeout(() => {
              try {
                child.stdout?.destroy();
                child.stderr?.destroy();
              } catch {
                // ignore
              }
              void finalize("timed_out", exitCode ?? -1, "Job exceeded timeout limit.");
            }, 3500);
            hardSettleTimer.unref();
          }, timeoutMs)
        : null;
    if (timer) timer.unref();

    const finalize = async (status, code, error = null) => {
      if (finalizing) return;
      finalizing = true;
      if (timer) clearTimeout(timer);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      if (killEscalateTimer) clearTimeout(killEscalateTimer);
      if (hardSettleTimer) clearTimeout(hardSettleTimer);
      const cancelEscTimer = this.cancelTimers.get(id);
      if (cancelEscTimer) {
        clearTimeout(cancelEscTimer);
        this.cancelTimers.delete(id);
      }

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
        let finalCostUsd = state.costUsd;
        let finalUsage = state.usage;

        if (parseMode === "claude-json" && finalStatus === "completed") {
          const raw = readFileBounded(stdoutPath, MAX_JOB_LOG_BYTES);
          const parsed = parseClaudeJsonOutput(raw.text);
          if (parsed.sessionId) {
            parsedSessionId = parsed.sessionId;
          }
          if (typeof parsed.costUsd === "number") {
            finalCostUsd = parsed.costUsd;
          }
          if (parsed.usage) {
            finalUsage = parsed.usage;
          }
          if (stdoutTruncated || raw.truncated || parsed.parseError) {
            finalStatus = "failed";
            finalError = "Claude Code JSON output was truncated or malformed.";
          } else if (parsed.isError) {
            finalStatus = "failed";
            finalError = parsed.text || "Claude Code reported an error.";
          }
        } else if (engine === "codex" && (!parsedSessionId || !finalUsage)) {
          const rawOut = readFileBounded(stdoutPath, MAX_JOB_LOG_BYTES).text;
          const rawErr = readFileBounded(stderrPath, MAX_JOB_LOG_BYTES).text;
          const jsonl = parseCodexJsonlOutput(rawOut);
          parsedSessionId =
            parsedSessionId ||
            jsonl.sessionId ||
            extractCodexSessionId(`${rawErr}\n${rawOut}`);
          if (jsonl.usage) {
            finalUsage = jsonl.usage;
          }
        }

        const afterGit =
          mode === "workspace-write" && beforeGit
            ? await captureGitDirtySnapshot(cwd)
            : null;
        const gitDelta =
          beforeGit && afterGit ? computeGitDelta(beforeGit, afterGit) : null;
        const executionEvidence = evidenceTracker.finalize({
          ok: finalStatus === "completed",
          gitDelta,
        });

        const latest = this.readMeta(id) || meta;
        if (latest.status === "canceled") {
          latest.finishedAt = latest.finishedAt || new Date().toISOString();
          latest.exitCode = code;
          latest.currentActivity = state.currentActivity;
          latest.eventCount = state.eventCount;
          latest.sessionId = parsedSessionId || latest.sessionId;
          latest.costUsd = finalCostUsd ?? latest.costUsd ?? null;
          latest.usage = finalUsage || latest.usage || null;
          latest.executionEvidence = executionEvidence;
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
        latest.costUsd = finalCostUsd ?? latest.costUsd ?? null;
        latest.usage = finalUsage || latest.usage || null;
        latest.executionEvidence = executionEvidence;
        this.writeMeta(latest);
      } catch {
        // never let metadata write failure escape event handler
      } finally {
        if (schemaFile) {
          try {
            fs.rmSync(schemaFile, { force: true });
          } catch {
            // ignore
          }
        }
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
      mode: meta.mode ?? "unknown",
      retryable: Boolean(meta.retryable),
      retryOf: meta.retryOf || null,
      structured: Boolean(meta.structured),
      handoffContext: meta.handoffContext || null,
      executionEvidence: meta.executionEvidence || null,
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
    let costUsd = typeof meta.costUsd === "number" ? meta.costUsd : null;
    let usage = meta.usage || null;
    let structuredOutput = null;

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
        structuredOutput = parsed.structuredOutput || null;
      }
      sessionId = parsed.sessionId || sessionId;
      costUsd = typeof parsed.costUsd === "number" ? parsed.costUsd : costUsd;
      usage = parsed.usage || usage;
    } else if (meta.engine === "codex") {
      const jsonl = parseCodexJsonlOutput(rawStdout);
      sessionId =
        sessionId ||
        jsonl.sessionId ||
        extractCodexSessionId(`${rawStderr}\n${rawStdout}`);
      usage = jsonl.usage || usage;
      if ((!meta.hasOutputFile || output === rawStdout) && jsonl.parsedAnyJson) {
        output =
          jsonl.lastMessage ||
          (meta.status === "completed" ? rawStdout : jsonl.error || rawStderr || rawStdout);
      }
      if (meta.structured && meta.status === "completed") {
        structuredOutput = parseStructuredReviewPayload(output).parsed;
      }
    }

    if (!output && rawStderr) {
      output = rawStderr;
    }

    return {
      jobId: meta.id,
      engine: meta.engine,
      action: meta.action,
      mode: meta.mode ?? "unknown",
      retryable: Boolean(meta.retryable),
      retryOf: meta.retryOf || null,
      structured: Boolean(meta.structured),
      structuredOutput,
      handoffContext: meta.handoffContext || null,
      executionEvidence: meta.executionEvidence || null,
      status: meta.status,
      exitCode: meta.exitCode,
      startedAt: meta.startedAt,
      finishedAt: meta.finishedAt,
      sessionId,
      costUsd,
      usage,
      eventCount: meta.eventCount ?? 0,
      eventsPath: this.eventsPath(meta.id),
      output: truncateOutput(output),
      stderr: meta.status === "completed" ? "" : truncateOutput(rawStderr),
      error: meta.error,
    };
  }

  recoverStaleJobs() {
    const files = fs
      .readdirSync(this.jobsDir)
      .filter((f) => f.endsWith(".json"));
    const recoveredJobIds = [];
    for (const file of files) {
      const jobId = file.slice(0, -5);
      try {
        const before = this.readMeta(jobId, { readOnly: true });
        if (!before || before.status !== "running") continue;
        const after = this.readMeta(jobId, { readOnly: false });
        if (after && after.status === "failed") {
          recoveredJobIds.push(jobId);
        }
      } catch {
        // skip corrupted metadata
      }
    }
    return {
      recoveredCount: recoveredJobIds.length,
      recoveredJobIds,
    };
  }

  retryJob(jobId, { overrideSpec = null, timeoutMs = null } = {}) {
    if (this.retryingJobs.has(jobId)) {
      throw new Error(`Retry already in progress for job: ${jobId}`);
    }
    const meta = this.readMeta(jobId);
    if (!meta) {
      throw new Error(`Job not found: ${jobId}`);
    }
    if (meta.status === "running" || this.activeChildren.has(jobId)) {
      throw new Error(`Job is still running: ${jobId}`);
    }
    if (meta.pid && isProcessAlive(meta.pid)) {
      throw new Error(
        `Original process (pid ${meta.pid}) for job "${jobId}" is still alive; refusing concurrent retry.`,
      );
    }

    const effectiveMode = meta.mode ?? "unknown";
    if (effectiveMode !== "read-only") {
      throw new Error(
        `Refusing to retry non-read-only job "${jobId}" (mode=${effectiveMode}). Only read-only jobs can be safely replayed.`,
      );
    }
    if (!meta.retryable) {
      throw new Error(
        `Job "${jobId}" is not retryable (prompt exceeded 64 KB, used '--last', or lacked replay metadata).`,
      );
    }

    // Never execute arbitrary command/args read back from persisted disk JSON.
    const trustedSpec = overrideSpec || this.inMemoryReplay.get(jobId) || null;
    if (
      !trustedSpec ||
      typeof trustedSpec !== "object" ||
      trustedSpec.mode !== "read-only" ||
      typeof trustedSpec.command !== "string"
    ) {
      throw new Error(
        `Refusing to execute unverified disk command for job "${jobId}". Use \`handoff_job_retry\` to rebuild a safe read-only invocation.`,
      );
    }
    if (!fs.existsSync(trustedSpec.cwd)) {
      throw new Error(`Retry working directory no longer exists: ${trustedSpec.cwd}`);
    }

    this.retryingJobs.add(jobId);
    try {
      const newJobId =
        trustedSpec.jobId || this.allocateJobId(trustedSpec.engine || meta.engine);
      const args = Array.isArray(trustedSpec.args) ? [...trustedSpec.args] : [];
      if (trustedSpec.hasOutputFile && !trustedSpec.jobId) {
        const outIdx = args.indexOf("-o");
        if (outIdx !== -1 && outIdx + 1 < args.length) {
          args[outIdx + 1] = this.outputFilePath(newJobId);
        }
      }
      if (trustedSpec.outputSchema && !trustedSpec.jobId) {
        const schemaIdx = args.indexOf("--output-schema");
        if (schemaIdx !== -1 && schemaIdx + 1 < args.length) {
          args[schemaIdx + 1] = this.schemaPath(newJobId);
        }
      }

      return this.startJob({
        jobId: newJobId,
        engine: trustedSpec.engine || meta.engine,
        action: trustedSpec.action || meta.action,
        mode: "read-only",
        command: trustedSpec.command,
        args,
        cwd: trustedSpec.cwd,
        stdin: trustedSpec.stdin ?? undefined,
        timeoutMs: timeoutMs ?? trustedSpec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        hasOutputFile: Boolean(trustedSpec.hasOutputFile),
        parseMode: trustedSpec.parseMode || meta.parseMode || "text",
        model: trustedSpec.model ?? meta.model ?? null,
        effort: trustedSpec.effort ?? meta.effort ?? null,
        handoffContext: meta.handoffContext || null,
        retryOf: meta.id,
        structured: Boolean(trustedSpec.structured ?? meta.structured),
        outputSchema: trustedSpec.outputSchema || null,
        requestParams: trustedSpec.requestParams || meta.replaySpec?.requestParams || null,
      });
    } finally {
      this.retryingJobs.delete(jobId);
    }
  }

  getStats({ limit = 100 } = {}) {
    const files = fs
      .readdirSync(this.jobsDir)
      .filter((f) => f.endsWith(".json"));
    const metas = [];
    for (const file of files) {
      const jobId = file.slice(0, -5);
      try {
        const meta = this.readMeta(jobId, { readOnly: true });
        if (meta) metas.push(meta);
      } catch {
        // skip corrupted or unreadable metadata
      }
    }
    metas.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    const sampled =
      limit === null || limit < 0 ? metas : metas.slice(0, limit);

    const byStatus = {
      completed: 0,
      failed: 0,
      timed_out: 0,
      canceled: 0,
      running: 0,
    };

    const createEngineEntry = () => ({
      count: 0,
      sharePct: 0,
      completed: 0,
      failed: 0,
      timedOut: 0,
      canceled: 0,
      running: 0,
      avgDurationMs: null,
      reportedCostUsd: null,
      costReportedJobs: 0,
      reportedTokens: {
        input: 0,
        output: 0,
        jobsWithUsage: 0,
      },
      _durationSum: 0,
      _durationCount: 0,
      _costSum: 0,
    });

    const byEngine = {
      codex: createEngineEntry(),
      claude: createEngineEntry(),
    };
    const byModel = {};
    const byAction = {};

    for (const m of sampled) {
      const status = m.status || "failed";
      if (Object.prototype.hasOwnProperty.call(byStatus, status)) {
        byStatus[status] += 1;
      }

      const engineKey = m.engine || "unknown";
      if (!byEngine[engineKey]) {
        byEngine[engineKey] = createEngineEntry();
      }
      const eng = byEngine[engineKey];
      eng.count += 1;
      if (status === "completed") eng.completed += 1;
      else if (status === "failed") eng.failed += 1;
      else if (status === "timed_out") eng.timedOut += 1;
      else if (status === "canceled") eng.canceled += 1;
      else if (status === "running") eng.running += 1;

      const startMs = Date.parse(m.startedAt || "");
      const endMs = m.finishedAt ? Date.parse(m.finishedAt) : NaN;
      const elapsedMs =
        Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
          ? endMs - startMs
          : null;
      if (elapsedMs !== null) {
        eng._durationSum += elapsedMs;
        eng._durationCount += 1;
      }

      if (typeof m.costUsd === "number" && Number.isFinite(m.costUsd)) {
        eng._costSum += m.costUsd;
        eng.costReportedJobs += 1;
      }

      const tokens = extractReportedTokens(m.usage);
      if (tokens) {
        eng.reportedTokens.input += tokens.input;
        eng.reportedTokens.output += tokens.output;
        eng.reportedTokens.jobsWithUsage += 1;
      }

      const modelKey = `${engineKey}:${m.model || "cli-default"}`;
      if (!byModel[modelKey]) {
        byModel[modelKey] = {
          engine: engineKey,
          model: m.model || null,
          count: 0,
          completed: 0,
          failed: 0,
          timedOut: 0,
          canceled: 0,
          avgDurationMs: null,
          _durationSum: 0,
          _durationCount: 0,
        };
      }
      const modelEntry = byModel[modelKey];
      modelEntry.count += 1;
      if (status === "completed") modelEntry.completed += 1;
      else if (status === "failed") modelEntry.failed += 1;
      else if (status === "timed_out") modelEntry.timedOut += 1;
      else if (status === "canceled") modelEntry.canceled += 1;
      if (elapsedMs !== null) {
        modelEntry._durationSum += elapsedMs;
        modelEntry._durationCount += 1;
      }

      const actionKey = m.action || "unknown";
      if (!byAction[actionKey]) {
        byAction[actionKey] = {
          count: 0,
          completed: 0,
          failed: 0,
          timedOut: 0,
          canceled: 0,
        };
      }
      byAction[actionKey].count += 1;
      if (status === "completed") byAction[actionKey].completed += 1;
      else if (status === "failed") byAction[actionKey].failed += 1;
      else if (status === "timed_out") byAction[actionKey].timedOut += 1;
      else if (status === "canceled") byAction[actionKey].canceled += 1;
    }

    for (const eng of Object.values(byEngine)) {
      eng.sharePct =
        sampled.length > 0
          ? Math.round((eng.count / sampled.length) * 1000) / 10
          : 0;
      eng.avgDurationMs =
        eng._durationCount > 0
          ? Math.round(eng._durationSum / eng._durationCount)
          : null;
      eng.reportedCostUsd =
        eng.costReportedJobs > 0
          ? Math.round(eng._costSum * 1_000_000) / 1_000_000
          : null;
      delete eng._durationSum;
      delete eng._durationCount;
      delete eng._costSum;
    }

    for (const modelEntry of Object.values(byModel)) {
      modelEntry.avgDurationMs =
        modelEntry._durationCount > 0
          ? Math.round(modelEntry._durationSum / modelEntry._durationCount)
          : null;
      delete modelEntry._durationSum;
      delete modelEntry._durationCount;
    }

    const finishedCount =
      byStatus.completed + byStatus.failed + byStatus.timed_out + byStatus.canceled;
    const successRatePct =
      finishedCount > 0
        ? Math.round((byStatus.completed / finishedCount) * 1000) / 10
        : null;

    const consecutiveFailures = { codex: 0, claude: 0 };
    for (const engKey of ["codex", "claude"]) {
      let streak = 0;
      for (const m of sampled) {
        if (m.engine !== engKey) continue;
        if (m.status === "running") continue;
        if (m.status === "failed" || m.status === "timed_out") {
          streak += 1;
        } else {
          break;
        }
      }
      consecutiveFailures[engKey] = streak;
    }

    const recentJobs = sampled.slice(0, 10).map((m) => {
      const s = Date.parse(m.startedAt || "");
      const e = m.finishedAt ? Date.parse(m.finishedAt) : Date.now();
      return {
        jobId: m.id,
        engine: m.engine,
        action: m.action,
        model: m.model || null,
        effort: m.effort || null,
        status: m.status,
        foreground: Boolean(m.foreground),
        elapsedMs: Number.isFinite(s) && Number.isFinite(e) ? Math.max(0, e - s) : 0,
        startedAt: m.startedAt,
        costUsd: typeof m.costUsd === "number" ? m.costUsd : null,
        usage: m.usage || null,
      };
    });

    return {
      jobsDir: this.jobsDir,
      retainedJobs: metas.length,
      analyzedJobs: sampled.length,
      reportedMetricsOnly: true,
      scopeNote:
        "Metrics reflect retained job records on disk only. Tokens and cost are reported only when emitted by the underlying CLI; missing values are never estimated.",
      byStatus,
      finishedCount,
      successRatePct,
      consecutiveFailures,
      byEngine,
      byModel,
      byAction,
      recentJobs,
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
    const existingTimer = this.cancelTimers.get(jobId);
    if (existingTimer) clearTimeout(existingTimer);
    const escTimer = setTimeout(() => {
      this.cancelTimers.delete(jobId);
      if (this.activeChildren.get(jobId) === child) {
        terminateProcessTree(child.pid, "SIGKILL");
      }
    }, 2000);
    escTimer.unref();
    this.cancelTimers.set(jobId, escTimer);

    return {
      jobId: meta.id,
      status: "canceled",
      canceled: true,
      message: "Cancellation signal sent.",
    };
  }

  shutdown() {
    for (const timer of this.cancelTimers.values()) {
      clearTimeout(timer);
    }
    this.cancelTimers.clear();
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
