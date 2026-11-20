import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_OUTPUT_BYTES = 128 * 1024; // 128 KB per stream
export const VALID_REVIEW_STYLES = new Set(["standard", "adversarial"]);
export const VALID_REVIEW_SCOPES = new Set(["uncommitted", "base", "commit", "custom"]);

const activeForegroundPids = new Set();
let exitHookRegistered = false;
const managedSignalHandlers = new Map();
const CLEANUP_SIGNALS =
  process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];

function removeManagedSignalHooks() {
  for (const [sig, handler] of managedSignalHandlers.entries()) {
    process.off(sig, handler);
  }
  managedSignalHandlers.clear();
}

function registerForegroundPid(pid) {
  if (!pid) return;
  activeForegroundPids.add(pid);

  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.on("exit", () => {
      terminateAllForegroundCommands();
    });
  }

  for (const sig of CLEANUP_SIGNALS) {
    if (!managedSignalHandlers.has(sig) && process.listenerCount(sig) === 0) {
      const handler = () => {
        terminateAllForegroundCommands();
        removeManagedSignalHooks();
        try {
          process.kill(process.pid, sig);
        } catch {
          process.exit(sig === "SIGINT" ? 130 : sig === "SIGHUP" ? 129 : 143);
        }
      };
      managedSignalHandlers.set(sig, handler);
      process.on(sig, handler);
    }
  }
}

function unregisterForegroundPid(pid) {
  if (!pid) return;
  activeForegroundPids.delete(pid);
  if (activeForegroundPids.size === 0) {
    removeManagedSignalHooks();
  }
}

export function validateCwd(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Working directory does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${resolved}`);
  }
  return resolved;
}

const BLOCKED_UNIX_WRITE_ROOTS = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/System",
];

const BLOCKED_HOME_SUBDIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".claude",
  ".codex",
  ".gemini",
];

function isSameOrSubpath(parentDir, candidateDir) {
  const rel = path.relative(parentDir, candidateDir);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

export function validateWorkspaceWriteCwd(cwd) {
  const resolved = validateCwd(cwd);
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // keep resolved
  }

  for (const target of [resolved, real]) {
    const parsedRoot = path.parse(target).root;
    if (target === parsedRoot) {
      throw new Error(
        `Refusing workspace-write in filesystem root "${target}". Specify a scoped project directory.`,
      );
    }

    if (process.platform === "win32") {
      const lower = target.toLowerCase();
      const winRoot = (process.env.SystemRoot || "C:\\Windows").toLowerCase();
      if (
        lower === winRoot ||
        lower.startsWith(`${winRoot}\\`) ||
        lower === "c:\\program files" ||
        lower.startsWith("c:\\program files\\") ||
        lower === "c:\\program files (x86)" ||
        lower.startsWith("c:\\program files (x86)\\")
      ) {
        throw new Error(
          `Refusing workspace-write in protected system directory "${target}".`,
        );
      }
    } else {
      for (const sysRoot of BLOCKED_UNIX_WRITE_ROOTS) {
        let sysReal = sysRoot;
        try {
          if (fs.existsSync(sysRoot)) {
            sysReal = fs.realpathSync(sysRoot);
          }
        } catch {
          // ignore
        }
        if (
          isSameOrSubpath(sysRoot, target) ||
          isSameOrSubpath(sysReal, target)
        ) {
          throw new Error(
            `Refusing workspace-write in protected system directory "${target}".`,
          );
        }
      }
    }
  }

  let homeDir = os.homedir();
  let homeReal = homeDir;
  try {
    homeReal = fs.realpathSync(homeDir);
  } catch {
    // ignore
  }

  if (resolved === homeDir || real === homeReal) {
    throw new Error(
      `Refusing workspace-write directly in the user home directory "${resolved}". Specify a project subdirectory.`,
    );
  }

  for (const sub of BLOCKED_HOME_SUBDIRS) {
    const blockedNom = path.join(homeDir, sub);
    const blockedReal = path.join(homeReal, sub);
    if (
      isSameOrSubpath(blockedNom, resolved) ||
      isSameOrSubpath(blockedReal, real)
    ) {
      throw new Error(
        `Refusing workspace-write inside sensitive home configuration/credential directory "${resolved}".`,
      );
    }
  }

  return resolved;
}

export function isInsideGitRepo(dir) {
  let current = path.resolve(dir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

export function validateTimeoutSec(timeoutSec) {
  if (timeoutSec === undefined || timeoutSec === null) return undefined;
  if (
    typeof timeoutSec !== "number" ||
    !Number.isInteger(timeoutSec) ||
    timeoutSec < 10 ||
    timeoutSec > 3600
  ) {
    throw new Error(
      `Invalid timeoutSec "${timeoutSec}". Expected an integer between 10 and 3600.`,
    );
  }
  return timeoutSec;
}

export function validateGitRef(label, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`\`${label}\` is required and must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("-")) {
    throw new Error(`Invalid ${label} "${value}": cannot start with "-".`);
  }
  if (/[\s\x00-\x1f\x7f]/.test(trimmed) || !/^[A-Za-z0-9._/@^~:+{}-]+$/.test(trimmed)) {
    throw new Error(`Invalid ${label} "${value}": contains disallowed characters.`);
  }
  return trimmed;
}

export function validateSessionId(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("`sessionId` must be a non-empty string.");
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("-")) {
    throw new Error(`Invalid sessionId "${value}": cannot start with "-".`);
  }
  if (
    /[\s\x00-\x1f\x7f]/.test(trimmed) ||
    (trimmed !== "last" && !/^[A-Za-z0-9._:-]+$/.test(trimmed))
  ) {
    throw new Error(`Invalid sessionId "${value}": contains disallowed characters.`);
  }
  return trimmed;
}

export function validateModelFlag(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("`model` must be a non-empty string.");
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("-")) {
    throw new Error(`Invalid model "${value}": model names cannot start with "-".`);
  }
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(
      `Invalid model "${value}": whitespace and control characters are not allowed.`,
    );
  }
  return trimmed;
}

function isExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function handoffChildEnv(engine) {
  return {
    AGY_HANDOFF_NESTED: "1",
    // An explicit same-engine handoff is a separate Claude session with strict MCP and tool limits.
    ...(engine === "claude" ? { CLAUDECODE: "" } : {}),
  };
}

export function handoffChildArgs(engine, args) {
  if (engine !== "codex" || !["exec", "review"].includes(args[0])) return args;
  // Codex can filter environment variables before starting MCP. Disable the bundled
  // handoff plugin and conventional standalone server as well as marking the child.
  return [
    args[0],
    "-c", 'plugins."codex-handoff@agy-handoff".enabled=false',
    "-c", 'mcp_servers.handoff={command="node",enabled=false}',
    ...args.slice(1),
  ];
}

export function getCandidatePaths(binaryName, envOverrideKey) {
  if (envOverrideKey && process.env[envOverrideKey]) {
    return [path.resolve(process.env[envOverrideKey])];
  }

  const pathEnv = process.env.PATH || "";
  const home = os.homedir();
  const rawDirs = [
    ...pathEnv.split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".claude", "local", "node_modules", ".bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    "/home/linuxbrew/.linuxbrew/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];

  const seen = new Set();
  const dirs = [];
  for (const dir of rawDirs) {
    const absDir = path.resolve(dir);
    if (!seen.has(absDir)) {
      seen.add(absDir);
      dirs.push(absDir);
    }
  }

  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];

  const candidates = [];
  const seenCandidates = new Set();
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.resolve(dir, binaryName + ext);
      if (!seenCandidates.has(candidate)) {
        seenCandidates.add(candidate);
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

export function inspectBinary(binaryName, envOverrideKey) {
  const candidates = getCandidatePaths(binaryName, envOverrideKey);

  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      let symlinkTarget = null;
      try {
        const lstat = fs.lstatSync(candidate);
        if (lstat.isSymbolicLink()) {
          symlinkTarget = fs.readlinkSync(candidate);
        }
      } catch {
        // ignore readlink failure
      }
      return {
        installed: true,
        accessible: true,
        binary: candidate,
        symlinkTarget,
      };
    }
  }

  // Detect symlinks whose targets are blocked inside a restricted sandbox.
  for (const candidate of candidates) {
    try {
      const lstat = fs.lstatSync(candidate);
      if (lstat.isSymbolicLink()) {
        let symlinkTarget = null;
        try {
          symlinkTarget = fs.readlinkSync(candidate);
        } catch {
          // ignore
        }
        return {
          installed: true,
          accessible: false,
          binary: candidate,
          symlinkTarget,
          warning:
            "Binary symlink exists, but its target is inaccessible in the current environment (e.g., restricted sandbox). It will run normally outside the sandbox.",
        };
      }
    } catch {
      // candidate does not exist
    }
  }

  return {
    installed: false,
    accessible: false,
    binary: null,
    symlinkTarget: null,
  };
}

export function findBinary(binaryName, envOverrideKey) {
  const info = inspectBinary(binaryName, envOverrideKey);
  return info.accessible ? info.binary : null;
}

function escapeCmdExeToken(token) {
  const str = String(token);
  if (/[\r\n\0]/.test(str)) {
    throw new Error("Command arguments cannot contain newline or null bytes on Windows.");
  }
  const escaped = str.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

function buildCmdExeCommandLine(command, args) {
  const tokens = [command, ...args].map(escapeCmdExeToken).join(" ");
  return `"${tokens}"`;
}

export function resolveSpawnSpec(command, args = [], platform = process.platform) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    try {
      const shimContent = fs.readFileSync(command, "utf8");
      const match = shimContent.match(/(?:%~dp0|%dp0%)[\\/]([^"'\r\n]+\.(?:mjs|cjs|js))/i);
      if (match) {
        const relParts = match[1].split(/[\\/]+/).filter(Boolean);
        const scriptPath = path.resolve(path.dirname(command), ...relParts);
        if (fs.existsSync(scriptPath) && fs.statSync(scriptPath).isFile()) {
          return {
            command: process.execPath,
            args: [scriptPath, ...args],
            shell: false,
          };
        }
      }
    } catch {
      // fall back to cmd.exe wrapper when shim cannot be inspected
    }

    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(command, args)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }

  return {
    command,
    args,
    shell: false,
  };
}

export function truncateOutput(text, maxBytes = MAX_OUTPUT_BYTES) {
  if (!text) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  if (end < buf.length && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) {
      end -= 1;
    }
  }
  const kept = buf.subarray(0, end).toString("utf8");
  const omitted = buf.length - end;
  return `${kept}\n\n...[truncated ${omitted} bytes]`;
}

export function terminateProcessTree(pid, signal = "SIGTERM") {
  if (!pid || typeof pid !== "number") return;
  if (process.platform === "win32") {
    try {
      // Windows console processes (like node.exe) ignore taskkill without /F.
      const killer = spawn(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.on("error", () => {});
      killer.unref();
    } catch {
      // ignore
    }
    return;
  }

  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // fallback if child is not a process group leader
  }
  try {
    process.kill(pid, signal);
  } catch {
    // ignore ESRCH/EPERM
  }
}

const WIN_RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function renameSyncSafe(src, dest) {
  if (process.platform !== "win32") {
    fs.renameSync(src, dest);
    return;
  }
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      if (!WIN_RENAME_RETRY_CODES.has(err?.code) || attempt === maxAttempts) {
        throw err;
      }
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      } catch {
        // ignore if Atomics.wait is unavailable
      }
    }
  }
}

export function terminateAllForegroundCommands() {
  for (const pid of activeForegroundPids) {
    terminateProcessTree(pid, "SIGTERM");
  }
}

export function runCommand({
  command,
  args = [],
  cwd,
  stdin,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env,
  truncateStdout = true,
  maxCaptureBytes = MAX_OUTPUT_BYTES * 2,
  signal,
  onStdoutChunk,
  onStderrChunk,
}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const spawnSpec = resolveSpawnSpec(command, args);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      windowsVerbatimArguments: Boolean(spawnSpec.windowsVerbatimArguments),
    });

    if (child.pid) {
      registerForegroundPid(child.pid);
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exitCode = null;
    let exitSignal = null;
    let timer = null;
    let exitGraceTimer = null;
    let killEscalateTimer = null;
    let hardSettleTimer = null;

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      killTree();
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      if (killEscalateTimer) clearTimeout(killEscalateTimer);
      if (hardSettleTimer) clearTimeout(hardSettleTimer);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      if (child.pid) {
        unregisterForegroundPid(child.pid);
      }
      resolve({
        ...result,
        stdoutTruncated,
        stderrTruncated,
        aborted,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    const settleFromBuffers = (code, sig) => {
      const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
      const rawStderr = Buffer.concat(stderrChunks).toString("utf8");
      finish({
        ok: !timedOut && !aborted && code === 0,
        exitCode: code ?? (sig ? 128 : -1),
        signal: sig || null,
        stdout: truncateStdout ? truncateOutput(rawStdout) : rawStdout,
        stderr: truncateOutput(rawStderr),
      });
    };

    const killTree = () => {
      if (settled) return;
      terminateProcessTree(child.pid, "SIGTERM");
      if (!killEscalateTimer) {
        killEscalateTimer = setTimeout(() => {
          terminateProcessTree(child.pid, "SIGKILL");
        }, 2000);
        killEscalateTimer.unref();
      }
      if (!hardSettleTimer) {
        hardSettleTimer = setTimeout(() => {
          try {
            child.stdout?.destroy();
            child.stderr?.destroy();
          } catch {
            // ignore
          }
          settleFromBuffers(exitCode ?? -1, exitSignal ?? "SIGKILL");
        }, 3000);
        hardSettleTimer.unref();
      }
    };

    timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree();
          }, timeoutMs)
        : null;
    if (timer) timer.unref();

    if (signal) {
      if (signal.aborted) {
        aborted = true;
        killTree();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdin.on("error", () => {});

    child.stdout.on("data", (chunk) => {
      if (typeof onStdoutChunk === "function") {
        try {
          onStdoutChunk(chunk);
        } catch {
          // ignore stream callback errors
        }
      }
      if (stdoutBytes < maxCaptureBytes) {
        const remaining = maxCaptureBytes - stdoutBytes;
        if (chunk.length <= remaining) {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        } else {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes += remaining;
          stdoutTruncated = true;
        }
      } else {
        stdoutTruncated = true;
      }
    });

    child.stderr.on("data", (chunk) => {
      if (typeof onStderrChunk === "function") {
        try {
          onStderrChunk(chunk);
        } catch {
          // ignore stream callback errors
        }
      }
      if (stderrBytes < maxCaptureBytes) {
        const remaining = maxCaptureBytes - stderrBytes;
        if (chunk.length <= remaining) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        } else {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes += remaining;
          stderrTruncated = true;
        }
      } else {
        stderrTruncated = true;
      }
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        exitCode: -1,
        signal: null,
        stdout: "",
        stderr: err.message,
      });
    });

    child.on("exit", (code, sig) => {
      exitCode = code;
      exitSignal = sig;
      if ((timedOut || aborted) && !exitGraceTimer) {
        exitGraceTimer = setTimeout(() => {
          try {
            child.stdout?.destroy();
            child.stderr?.destroy();
          } catch {
            // ignore
          }
          settleFromBuffers(exitCode, exitSignal);
        }, 500);
        exitGraceTimer.unref();
      }
    });

    child.on("close", (code, sig) => {
      settleFromBuffers(code, sig);
    });

    if (stdin !== undefined && stdin !== null) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

export async function getBinaryVersion(binaryPath, args = ["--version"]) {
  if (!binaryPath) return null;
  const res = await runCommand({
    command: binaryPath,
    args,
    timeoutMs: 10_000,
  });
  const combined = (res.stdout || res.stderr || "").trim();
  if (!combined) return null;
  // Filter out benign warnings like read-only filesystem PATH alias warnings.
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("WARNING:"));
  return lines[0] || combined.split(/\r?\n/)[0];
}

export function parseSemver(text) {
  if (!text) return null;
  const match = String(text).match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    raw: match[0],
  };
}

export function compareSemver(a, b) {
  const pa = typeof a === "string" ? parseSemver(a) : a;
  const pb = typeof b === "string" ? parseSemver(b) : b;
  if (!pa || !pb) return null;
  for (const field of ["major", "minor", "patch"]) {
    if (pa[field] < pb[field]) return -1;
    if (pa[field] > pb[field]) return 1;
  }
  return 0;
}

export async function getHelpOutput(binaryPath, args = ["--help"]) {
  if (!binaryPath) return "";
  const res = await runCommand({
    command: binaryPath,
    args,
    timeoutMs: 10_000,
    truncateStdout: false,
  });
  return `${res.stdout || ""}\n${res.stderr || ""}`;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectMissingFlags(helpText, requiredFlags = []) {
  const text = String(helpText || "");
  const missing = [];
  for (const flag of requiredFlags) {
    const pattern = new RegExp(
      `(?:^|[\\s,|([=])${escapeRegex(flag)}(?=$|[\\s,.)\\]=:<>\\[])`,
    );
    if (!pattern.test(text)) {
      missing.push(flag);
    }
  }
  return missing;
}

export function isCliFlagCompatibilityError(stderr) {
  if (!stderr) return false;
  return /unknown option|unrecognized option|unexpected argument|unknown flag/i.test(
    String(stderr),
  );
}

export function buildAdversarialReviewPrompt({ targetDescription, extraInstructions }) {
  const parts = [
    "Perform a strict, adversarial code review.",
    "Challenge assumptions, architecture, edge cases, failure modes, concurrency/race conditions, security risks, and subtle regressions.",
    "Evidence & Scope Contract: Ground every finding in the repository diff and local files (never fabricate paths, lines, or APIs); use preloaded diff/files first and avoid redundant external web searches or unrelated repo sweeps.",
    "Output Contract: Order concrete findings by severity (Critical, High, Medium, Low). For each finding include exact `file:line`, concrete failure trigger/impact, and minimal actionable fix. Skip style nitpicks and generic praise; if no material defects exist, state so explicitly and list residual risks or untested paths.",
  ];
  if (targetDescription) {
    parts.push(`Review target: ${targetDescription}`);
  }
  if (extraInstructions) {
    parts.push(`Additional focus:\n${extraInstructions}`);
  }
  return parts.join("\n\n");
}

export function buildStandardReviewPrompt({ targetDescription, extraInstructions }) {
  const parts = [
    "Perform a thorough, read-only code review.",
    "Identify bugs, logic errors, missing error handling, API misuse, performance issues, and test gaps.",
    "Evidence & Scope Contract: Ground every finding in the repository diff and local files (never fabricate paths, lines, or APIs); use preloaded diff/files first and avoid redundant external web searches or unrelated repo sweeps.",
    "Output Contract: Group concrete findings by severity (Critical, High, Medium, Low) with exact `file:line`, impact, and minimal actionable fix. Omit generic summaries or filler; if no defects exist, state so explicitly and note untested paths.",
  ];
  if (targetDescription) {
    parts.push(`Review target: ${targetDescription}`);
  }
  if (extraInstructions) {
    parts.push(`Additional focus:\n${extraInstructions}`);
  }
  return parts.join("\n\n");
}
