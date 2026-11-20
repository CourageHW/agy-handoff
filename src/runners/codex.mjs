import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  DEFAULT_TIMEOUT_MS,
  VALID_REVIEW_SCOPES,
  VALID_REVIEW_STYLES,
  buildAdversarialReviewPrompt,
  buildStandardReviewPrompt,
  compareSemver,
  detectMissingFlags,
  findBinary,
  getBinaryVersion,
  getHelpOutput,
  inspectBinary,
  isCliFlagCompatibilityError,
  isInsideGitRepo,
  parseSemver,
  runCommand,
  truncateOutput,
  validateCwd,
  validateGitRef,
  validateModelFlag,
  validateSessionId,
  validateTimeoutSec,
} from "./common.mjs";
import { createEventStreamParser, parseCodexJsonlOutput } from "../events.mjs";
import { parseStructuredReviewPayload } from "../cross-review.mjs";

export const MIN_CODEX_VERSION = "0.160.0";
export const REQUIRED_CODEX_EXEC_FLAGS = [
  "--sandbox",
  "--json",
  "--ephemeral",
  "--color",
  "--skip-git-repo-check",
  "-o",
];
export const REQUIRED_CODEX_RESUME_FLAGS = [
  "--json",
  "--last",
  "--skip-git-repo-check",
  "-c",
];
export const REQUIRED_CODEX_REVIEW_FLAGS = [
  "--uncommitted",
  "--base",
  "--commit",
  "-c",
];

const ALLOWED_SANDBOX_MODES = new Set(["read-only", "workspace-write"]);
const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

function validateCodexEffort(effort) {
  if (effort !== undefined && effort !== null && !ALLOWED_EFFORTS.has(effort)) {
    throw new Error(
      `Unsupported effort "${effort}". Allowed: low, medium, high, xhigh, max, ultra.`,
    );
  }
}

export function extractCodexSessionId(text) {
  if (!text) return null;
  const match = String(text).match(/^session id:\s*([A-Za-z0-9._:-]+)$/im);
  return match ? match[1] : null;
}

export function findCodexBinary() {
  return findBinary("codex", "AGY_HANDOFF_CODEX_BIN");
}

function evaluateCodexCompatibility(version, execHelp, resumeHelp, reviewHelp) {
  const versionSemver = parseSemver(version);
  const minSemver = parseSemver(MIN_CODEX_VERSION);
  const hasExec = Boolean(execHelp && execHelp.trim());
  const hasResume = Boolean(resumeHelp && resumeHelp.trim());
  const hasReview = Boolean(reviewHelp && reviewHelp.trim());

  const missingFlags = [
    ...(hasExec
      ? detectMissingFlags(execHelp, REQUIRED_CODEX_EXEC_FLAGS).map((f) => `exec:${f}`)
      : []),
    ...(hasResume
      ? detectMissingFlags(resumeHelp, REQUIRED_CODEX_RESUME_FLAGS).map(
          (f) => `exec resume:${f}`,
        )
      : []),
    ...(hasReview
      ? detectMissingFlags(reviewHelp, REQUIRED_CODEX_REVIEW_FLAGS).map(
          (f) => `review:${f}`,
        )
      : []),
  ];

  if (!versionSemver && !hasExec && !hasResume && !hasReview) {
    return {
      minVersion: MIN_CODEX_VERSION,
      compatible: null,
      missingFlags: [],
      compatibilityNote: null,
    };
  }

  const versionOk = versionSemver
    ? compareSemver(versionSemver, minSemver) >= 0
    : true;
  const flagsOk = missingFlags.length === 0;
  const compatible = versionOk && flagsOk;

  let compatibilityNote = null;
  if (!compatible) {
    const reasons = [];
    if (!versionOk && versionSemver) {
      reasons.push(
        `detected v${versionSemver.raw}, requires >= ${MIN_CODEX_VERSION}`,
      );
    }
    if (!flagsOk) {
      reasons.push(`missing required flags: ${missingFlags.join(", ")}`);
    }
    compatibilityNote = `Incompatible Codex CLI (${reasons.join("; ")}). Upgrade with \`npm install -g @openai/codex@latest\`.`;
  }

  return {
    minVersion: MIN_CODEX_VERSION,
    compatible,
    missingFlags,
    compatibilityNote,
  };
}

export async function inspectCodex() {
  const info = inspectBinary("codex", "AGY_HANDOFF_CODEX_BIN");
  if (!info.installed) {
    return {
      engine: "codex",
      installed: false,
      accessible: false,
      binary: null,
      symlinkTarget: null,
      version: null,
      minVersion: MIN_CODEX_VERSION,
      compatible: null,
      missingFlags: [],
      compatibilityNote: null,
      installHint: "npm install -g @openai/codex && codex login",
    };
  }
  if (!info.accessible) {
    return {
      engine: "codex",
      installed: true,
      accessible: false,
      binary: info.binary,
      symlinkTarget: info.symlinkTarget,
      version: null,
      minVersion: MIN_CODEX_VERSION,
      compatible: null,
      missingFlags: [],
      compatibilityNote: null,
      note: info.warning,
    };
  }
  const [version, execHelp, resumeHelp, reviewHelp] = await Promise.all([
    getBinaryVersion(info.binary, ["--version"]),
    getHelpOutput(info.binary, ["exec", "--help"]),
    getHelpOutput(info.binary, ["exec", "resume", "--help"]),
    getHelpOutput(info.binary, ["review", "--help"]),
  ]);
  const compat = evaluateCodexCompatibility(version, execHelp, resumeHelp, reviewHelp);
  const authFile = path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    "auth.json",
  );
  const hasAuthHint =
    Boolean(process.env.OPENAI_API_KEY) || fs.existsSync(authFile);
  return {
    engine: "codex",
    installed: true,
    accessible: true,
    binary: info.binary,
    symlinkTarget: info.symlinkTarget,
    version,
    ...compat,
    authHint: hasAuthHint
      ? "OPENAI_API_KEY or ~/.codex/auth.json detected"
      : "No local auth hint detected (run `codex login` or set OPENAI_API_KEY)",
  };
}

export function createTempOutputFile(prefix = "agy-handoff-codex", baseDir) {
  if (baseDir) {
    const id = crypto.randomBytes(6).toString("hex");
    return path.join(baseDir, `${prefix}-${id}.txt`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // ignore chmod errors on restricted filesystems
    }
  }
  return path.join(dir, "last-message.txt");
}

export function readAndCleanupOutputFile(filePath) {
  if (!filePath) return "";
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8").trim();
    }
  } catch {
    // ignore read failure and fall back to stdout
  } finally {
    try {
      fs.rmSync(filePath, { force: true });
      const parentDir = path.dirname(filePath);
      if (path.basename(parentDir).startsWith("agy-handoff-codex")) {
        fs.rmSync(parentDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
  return "";
}

export function createTempSchemaFile(schemaObj) {
  if (!schemaObj || typeof schemaObj !== "object" || Array.isArray(schemaObj)) {
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-codex-schema-"));
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // ignore
    }
  }
  const schemaPath = path.join(dir, "schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify(schemaObj, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return schemaPath;
}

export function cleanupTempSchemaFile(filePath) {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
    const parentDir = path.dirname(filePath);
    if (path.basename(parentDir).startsWith("agy-handoff-codex-schema-")) {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

export function buildCodexExecSpec({
  prompt,
  cwd,
  mode = "read-only",
  model,
  effort,
  sessionId,
  skipGitRepoCheck = false,
  ephemeral = true,
  jsonStream = true,
  outputFile,
  outputSchemaFile,
}) {
  if (!prompt || !prompt.trim()) {
    throw new Error("Prompt is required for Codex execution.");
  }
  if (!ALLOWED_SANDBOX_MODES.has(mode)) {
    throw new Error(
      `Unsupported mode "${mode}". Allowed: read-only, workspace-write.`,
    );
  }
  validateCodexEffort(effort);
  const validModel = validateModelFlag(model);
  const validSessionId = validateSessionId(sessionId);
  const resolvedCwd = validateCwd(cwd);

  const args = ["exec"];
  if (validSessionId) {
    args.push("resume", "-c", `sandbox_mode=${JSON.stringify(mode)}`);
    if (jsonStream) {
      args.push("--json");
    }
    if (validModel) {
      args.push("-m", validModel);
    }
    if (effort) {
      args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
    }
    if (skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }
    if (outputSchemaFile) {
      args.push("--output-schema", outputSchemaFile);
    }
    if (outputFile) {
      args.push("-o", outputFile);
    }
    if (validSessionId === "last") {
      args.push("--last");
    } else {
      args.push(validSessionId);
    }
    args.push("-");
    return {
      args,
      cwd: resolvedCwd,
      stdin: prompt,
      outputFile: outputFile || null,
      jsonStream: Boolean(jsonStream),
    };
  }

  args.push("--color", "never", "-C", resolvedCwd, "-s", mode);
  if (jsonStream) {
    args.push("--json");
  }
  if (ephemeral) {
    args.push("--ephemeral");
  }
  if (validModel) {
    args.push("-m", validModel);
  }
  if (effort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  }
  if (skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  if (outputSchemaFile) {
    args.push("--output-schema", outputSchemaFile);
  }
  if (outputFile) {
    args.push("-o", outputFile);
  }

  // Read prompt safely from stdin.
  args.push("-");

  return {
    args,
    cwd: resolvedCwd,
    stdin: prompt,
    outputFile: outputFile || null,
    jsonStream: Boolean(jsonStream),
  };
}

export function buildCodexReviewSpec({
  cwd,
  style = "standard",
  scope = "uncommitted",
  base,
  commit,
  prompt,
  model,
  effort,
  skipGitRepoCheck,
  jsonStream = true,
  outputFile,
  outputSchemaFile,
}) {
  if (!VALID_REVIEW_STYLES.has(style)) {
    throw new Error(`Unsupported style "${style}". Allowed: standard, adversarial.`);
  }
  if (!VALID_REVIEW_SCOPES.has(scope)) {
    throw new Error(
      `Unsupported scope "${scope}". Allowed: uncommitted, base, commit, custom.`,
    );
  }
  validateCodexEffort(effort);
  const validModel = validateModelFlag(model);
  const resolvedCwd = validateCwd(cwd);

  const safeBase = scope === "base" ? validateGitRef("base", base) : undefined;
  const safeCommit = scope === "commit" ? validateGitRef("commit", commit) : undefined;

  // Use native `codex review` for standard git-scoped reviews without custom prompt/schema overrides.
  const canUseNativeReview =
    style === "standard" &&
    !prompt &&
    !outputSchemaFile &&
    (scope === "uncommitted" || scope === "base" || scope === "commit");

  if (canUseNativeReview) {
    const args = ["review", "-c", 'sandbox_mode="read-only"'];
    if (validModel) {
      args.push("-c", `model=${JSON.stringify(validModel)}`);
    }
    if (effort) {
      args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
    }
    if (scope === "base") {
      args.push("--base", safeBase);
    } else if (scope === "commit") {
      args.push("--commit", safeCommit);
    } else {
      args.push("--uncommitted");
    }
    return {
      args,
      cwd: resolvedCwd,
      stdin: null,
      outputFile: null,
      jsonStream: false,
    };
  }

  let targetDescription =
    "Uncommitted changes in the repository (inspect via `git status` and `git diff`).";
  if (scope === "base") {
    targetDescription = `Changes compared against base branch \`${safeBase}\` (inspect via \`git diff ${safeBase}...HEAD\`).`;
  } else if (scope === "commit") {
    targetDescription = `Changes introduced by commit \`${safeCommit}\` (inspect via \`git show ${safeCommit}\`).`;
  } else if (scope === "custom") {
    targetDescription = "Files and scope specified in the additional focus below.";
  }

  const composedPrompt =
    style === "adversarial"
      ? buildAdversarialReviewPrompt({
          targetDescription,
          extraInstructions: prompt,
        })
      : buildStandardReviewPrompt({
          targetDescription,
          extraInstructions: prompt,
        });

  const resolvedSkipGitRepoCheck =
    skipGitRepoCheck ?? (scope === "custom" ? !isInsideGitRepo(resolvedCwd) : false);

  return buildCodexExecSpec({
    prompt: composedPrompt,
    cwd: resolvedCwd,
    mode: "read-only",
    model: validModel,
    effort,
    skipGitRepoCheck: resolvedSkipGitRepoCheck,
    ephemeral: true,
    jsonStream,
    outputFile,
    outputSchemaFile,
  });
}

async function executeCodex(spec, options) {
  const binary = findCodexBinary();
  if (!binary) {
    throw new Error(
      "Codex CLI (`codex`) was not found in PATH. Install it with `npm install -g @openai/codex` and run `codex login`.",
    );
  }
  const timeoutSec = validateTimeoutSec(options.timeoutSec);
  const parser =
    spec.jsonStream && typeof options.onEvent === "function"
      ? createEventStreamParser("codex", options.onEvent)
      : null;

  const res = await runCommand({
    command: binary,
    args: spec.args,
    cwd: spec.cwd,
    stdin: spec.stdin,
    timeoutMs: (timeoutSec || DEFAULT_TIMEOUT_MS / 1000) * 1000,
    truncateStdout: !spec.jsonStream,
    maxCaptureBytes: spec.jsonStream ? 4 * 1024 * 1024 : undefined,
    signal: options.signal,
    onStdoutChunk: parser ? (chunk) => parser.push(chunk) : undefined,
  });

  if (parser) {
    parser.flush();
  }

  const lastMessage = readAndCleanupOutputFile(spec.outputFile);
  const jsonl = spec.jsonStream
    ? parseCodexJsonlOutput(res.stdout)
    : { lastMessage: "", sessionId: null, error: null, usage: null };

  let rawOutput =
    lastMessage ||
    jsonl.lastMessage ||
    (res.ok ? res.stdout : jsonl.error || res.stderr || res.stdout);
  if (!res.ok && isCliFlagCompatibilityError(res.stderr)) {
    const hint = `Unsupported or outdated Codex CLI flags. agy-handoff requires Codex CLI >= ${MIN_CODEX_VERSION}. Run \`npm install -g @openai/codex@latest\` and verify with \`handoff_doctor\`.`;
    rawOutput = rawOutput ? `${rawOutput}\n\n${hint}` : hint;
  }
  const structuredOutput =
    options.outputSchema && res.ok
      ? parseStructuredReviewPayload(rawOutput).parsed
      : null;
  const output = truncateOutput(rawOutput || res.stderr);
  const sessionId =
    jsonl.sessionId || extractCodexSessionId(`${res.stderr}\n${res.stdout}`);

  return {
    engine: "codex",
    ok: res.ok,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    aborted: Boolean(res.aborted),
    durationMs: res.durationMs,
    sessionId,
    usage: jsonl.usage || null,
    structuredOutput,
    output,
    stderr: res.ok ? "" : res.stderr,
  };
}

export async function runCodexExec(options) {
  const resolvedCwd = validateCwd(options.cwd);
  const skipGitRepoCheck = options.skipGitRepoCheck ?? !isInsideGitRepo(resolvedCwd);
  const ephemeral = options.ephemeral ?? false;
  const outputFile = options.sessionId ? null : createTempOutputFile();
  const outputSchemaFile = options.outputSchema
    ? createTempSchemaFile(options.outputSchema)
    : null;
  try {
    const spec = buildCodexExecSpec({
      ...options,
      skipGitRepoCheck,
      ephemeral,
      outputFile,
      outputSchemaFile,
    });
    return await executeCodex(spec, options);
  } finally {
    cleanupTempSchemaFile(outputSchemaFile);
  }
}

export async function runCodexReview(options) {
  const outputSchemaFile = options.outputSchema
    ? createTempSchemaFile(options.outputSchema)
    : null;
  let outputFile = null;
  try {
    const spec = buildCodexReviewSpec({
      ...options,
      outputFile: "__TEMP_IF_EXEC__",
      outputSchemaFile,
    });
    // Allocate a temp last-message file only when falling back to `codex exec` (not native `codex review`).
    if (spec.args[0] === "exec") {
      outputFile = createTempOutputFile("agy-handoff-codex-review");
      const outIdx = spec.args.indexOf("-o");
      if (outIdx !== -1 && outIdx + 1 < spec.args.length) {
        spec.args[outIdx + 1] = outputFile;
        spec.outputFile = outputFile;
      }
    }
    return await executeCodex(spec, options);
  } finally {
    readAndCleanupOutputFile(outputFile);
    cleanupTempSchemaFile(outputSchemaFile);
  }
}
