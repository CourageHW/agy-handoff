import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  parseSemver,
  runCommand,
  truncateOutput,
  validateCwd,
  validateGitRef,
  validateModelFlag,
  validateSessionId,
  validateTimeoutSec,
  validateWorkspaceWriteCwd,
} from "./common.mjs";
import { createEventStreamParser } from "../events.mjs";

export const MIN_AGY_VERSION = "1.5.0";
export const REQUIRED_AGY_FLAGS = [
  "--print",
  "--output-format",
  "--model",
  "--effort",
  "--json-schema",
  "--sandbox",
  "--disable-slash-commands",
];

const ALLOWED_MODES = new Set(["read-only", "workspace-write"]);
const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function findAgyBinary() {
  if (process.env.AGY_HANDOFF_AGY_BIN !== undefined) {
    if (
      !process.env.AGY_HANDOFF_AGY_BIN ||
      process.env.AGY_HANDOFF_AGY_BIN === "none"
    ) {
      return null;
    }
    return findBinary("agy", "AGY_HANDOFF_AGY_BIN");
  }
  if (
    process.env.AGY_HANDOFF_CODEX_BIN ||
    process.env.AGY_HANDOFF_CLAUDE_BIN
  ) {
    return null;
  }
  return findBinary("agy", "AGY_HANDOFF_AGY_BIN");
}

function evaluateAgyCompatibility(version, helpText) {
  const versionSemver = parseSemver(version);
  const minSemver = parseSemver(MIN_AGY_VERSION);
  const hasHelp = Boolean(helpText && helpText.trim());
  const missingFlags = hasHelp
    ? detectMissingFlags(helpText, REQUIRED_AGY_FLAGS)
    : [];

  if (!versionSemver && !hasHelp) {
    return {
      minVersion: MIN_AGY_VERSION,
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
        `detected v${versionSemver.raw}, requires >= ${MIN_AGY_VERSION}`,
      );
    }
    if (!flagsOk) {
      reasons.push(`missing required flags: ${missingFlags.join(", ")}`);
    }
    compatibilityNote = `Incompatible Antigravity CLI (${reasons.join("; ")}). Upgrade with \`agy update\`.`;
  }

  return {
    minVersion: MIN_AGY_VERSION,
    compatible,
    missingFlags,
    compatibilityNote,
  };
}

export async function inspectAgy() {
  const info = inspectBinary("agy", "AGY_HANDOFF_AGY_BIN");
  if (!info.installed) {
    return {
      engine: "agy",
      installed: false,
      accessible: false,
      binary: null,
      symlinkTarget: null,
      version: null,
      minVersion: MIN_AGY_VERSION,
      compatible: null,
      missingFlags: [],
      compatibilityNote: null,
      installHint: "Install Google Antigravity CLI (`agy`) and sign in via `agy`.",
    };
  }
  if (!info.accessible) {
    return {
      engine: "agy",
      installed: true,
      accessible: false,
      binary: info.binary,
      symlinkTarget: info.symlinkTarget,
      version: null,
      minVersion: MIN_AGY_VERSION,
      compatible: null,
      missingFlags: [],
      compatibilityNote: null,
      note: info.warning,
    };
  }
  const [version, helpText] = await Promise.all([
    getBinaryVersion(info.binary, ["--version"]),
    getHelpOutput(info.binary, ["--help"]),
  ]);
  const compat = evaluateAgyCompatibility(version, helpText);
  const agyDir = path.join(os.homedir(), ".gemini", "antigravity-cli");
  const hasAuthHint = fs.existsSync(agyDir);
  return {
    engine: "agy",
    installed: true,
    accessible: true,
    binary: info.binary,
    symlinkTarget: info.symlinkTarget,
    version,
    ...compat,
    authHint: hasAuthHint
      ? "~/.gemini/antigravity-cli detected"
      : "Run `agy` to authenticate",
  };
}

export function buildAgyExecSpec({
  prompt,
  cwd,
  mode = "read-only",
  model,
  effort,
  sessionId,
  jsonSchema,
}) {
  if (!prompt || !prompt.trim()) {
    throw new Error("Prompt is required for Antigravity (`agy`) execution.");
  }
  if (!ALLOWED_MODES.has(mode)) {
    throw new Error(
      `Unsupported mode "${mode}". Allowed: read-only, workspace-write.`,
    );
  }
  if (effort !== undefined && effort !== null && !ALLOWED_EFFORTS.has(effort)) {
    throw new Error(
      `Unsupported effort "${effort}". Allowed: low, medium, high, xhigh, max.`,
    );
  }
  const validModel = validateModelFlag(model);
  const validSessionId = validateSessionId(sessionId);
  const resolvedCwd =
    mode === "workspace-write"
      ? validateWorkspaceWriteCwd(cwd)
      : validateCwd(cwd);

  const readOnlyGuard =
    mode === "read-only"
      ? "[STRICT READ-ONLY MODE: Do not create, edit, or delete any files. Only inspect files and run read-only git commands.]\n\n"
      : "";
  const effectivePrompt = `${readOnlyGuard}${prompt}`;

  const args = [
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--sandbox",
  ];
  if (mode === "workspace-write") {
    args.push("--mode", "accept-edits");
  }
  if (validModel) {
    args.push("--model", validModel);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  if (validSessionId) {
    args.push("--conversation", validSessionId);
  }
  if (jsonSchema && typeof jsonSchema === "object" && !Array.isArray(jsonSchema)) {
    args.push("--json-schema", JSON.stringify(jsonSchema));
  }
  args.push("--print", effectivePrompt);

  return {
    args,
    cwd: resolvedCwd,
    stdin: null,
  };
}

export function buildAgyReviewSpec({
  cwd,
  style = "standard",
  scope = "uncommitted",
  base,
  commit,
  prompt,
  model,
  effort,
  jsonSchema,
}) {
  if (!VALID_REVIEW_STYLES.has(style)) {
    throw new Error(`Unsupported style "${style}". Allowed: standard, adversarial.`);
  }
  if (!VALID_REVIEW_SCOPES.has(scope)) {
    throw new Error(
      `Unsupported scope "${scope}". Allowed: uncommitted, base, commit, custom.`,
    );
  }

  let targetDescription =
    "Uncommitted changes in the repository (inspect via `git status` and `git diff`).";
  if (scope === "base") {
    const safeBase = validateGitRef("base", base);
    targetDescription = `Changes compared against base branch \`${safeBase}\` (inspect via \`git diff ${safeBase}...HEAD\`).`;
  } else if (scope === "commit") {
    const safeCommit = validateGitRef("commit", commit);
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

  return buildAgyExecSpec({
    prompt: composedPrompt,
    cwd,
    mode: "read-only",
    model,
    effort,
    jsonSchema,
  });
}

export function parseAgyJsonOutput(stdout) {
  const trimmed = (stdout || "").trim();
  if (!trimmed) {
    return {
      text: "",
      sessionId: null,
      costUsd: null,
      usage: null,
      structuredOutput: null,
      isError: false,
      parseError: false,
    };
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let sessionId = null;
  let usage = null;
  let resultText = null;
  let structuredOutput = null;
  let isError = false;
  let errorText = null;
  const deltaChunks = [];
  let parsedAnyJson = false;

  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (!ev || typeof ev !== "object") continue;
      parsedAnyJson = true;

      if (ev.conversation_id) {
        sessionId = ev.conversation_id;
      }
      if (
        ev.event === "step_update" &&
        ev.step_update?.step_type === "agent_response" &&
        typeof ev.step_update.text_delta === "string"
      ) {
        deltaChunks.push(ev.step_update.text_delta);
      }
      if (ev.event === "result" && ev.result && typeof ev.result === "object") {
        const r = ev.result;
        sessionId = r.conversation_id || sessionId;
        usage = r.usage && typeof r.usage === "object" ? r.usage : usage;
        if (
          r.structured_output &&
          typeof r.structured_output === "object" &&
          !Array.isArray(r.structured_output)
        ) {
          structuredOutput = r.structured_output;
        }
        if (r.status === "ERROR") {
          isError = true;
          errorText = r.error || r.response || "Antigravity CLI reported an error.";
        } else if (typeof r.response === "string") {
          resultText = r.response.trim();
        }
      } else if (ev.status === "ERROR") {
        isError = true;
        errorText = ev.error || ev.response || "Antigravity CLI reported an error.";
        sessionId = ev.conversation_id || sessionId;
      } else if (ev.status === "SUCCESS" && typeof ev.response === "string") {
        resultText = ev.response.trim();
        sessionId = ev.conversation_id || sessionId;
        if (
          ev.structured_output &&
          typeof ev.structured_output === "object" &&
          !Array.isArray(ev.structured_output)
        ) {
          structuredOutput = ev.structured_output;
        }
      }
    } catch {
      // skip non-JSON warning/banner lines
    }
  }

  if (!parsedAnyJson) {
    return {
      text: trimmed,
      sessionId: null,
      costUsd: null,
      usage: null,
      structuredOutput: null,
      isError: false,
      parseError: true,
    };
  }

  const finalText = isError
    ? errorText || deltaChunks.join("").trim() || trimmed
    : resultText ??
      (structuredOutput ? JSON.stringify(structuredOutput) : deltaChunks.join("").trim());

  return {
    text: finalText,
    sessionId,
    costUsd: null,
    usage,
    structuredOutput,
    isError,
    parseError: false,
  };
}

function isQuotaExhaustedError(text) {
  return /RESOURCE_EXHAUSTED|Individual quota reached/i.test(String(text || ""));
}

function getQuotaFallbackModel(model, effort) {
  const m = String(model || "gemini-4-neon-high").toLowerCase();
  if (!m.includes("neon")) return null;
  const eff = ["low", "medium", "high"].includes(String(effort || "").toLowerCase())
    ? String(effort).toLowerCase()
    : "high";
  return `gemini-4-argon-${eff}`;
}

async function executeAgy(
  spec,
  { timeoutSec, signal, onEvent, model, effort, allowQuotaFallback = true } = {},
) {
  const binary = findAgyBinary();
  if (!binary) {
    return {
      engine: "agy",
      ok: false,
      exitCode: -1,
      timedOut: false,
      durationMs: 0,
      sessionId: null,
      costUsd: null,
      usage: null,
      output:
        "Antigravity CLI (`agy`) was not found in PATH. Run `handoff_doctor` for details.",
      stderr: "",
    };
  }

  const timeoutMs = timeoutSec ? timeoutSec * 1000 : DEFAULT_TIMEOUT_MS;
  const parser =
    typeof onEvent === "function"
      ? createEventStreamParser("agy", onEvent)
      : null;

  const result = await runCommand({
    command: binary,
    args: spec.args,
    cwd: spec.cwd,
    stdin: spec.stdin,
    timeoutMs,
    signal,
    onStdoutChunk: parser ? (chunk) => parser.push(chunk) : undefined,
  });

  if (parser) {
    parser.flush();
  }

  const parsed = parseAgyJsonOutput(result.rawStdout || result.stdout);
  const combinedError = `${parsed.text || ""}\n${result.stderr || ""}`;

  // If primary Neon model hits temporary individual quota (429 RESOURCE_EXHAUSTED),
  // transparently fall back once to Gemini 4 Argon so 3-to-1 cross-review still completes.
  if (
    allowQuotaFallback &&
    (parsed.isError || !result.ok) &&
    isQuotaExhaustedError(combinedError)
  ) {
    const fallbackModel = getQuotaFallbackModel(model, effort);
    if (fallbackModel) {
      const nextArgs = [...spec.args];
      const modelIdx = nextArgs.indexOf("--model");
      if (modelIdx !== -1 && modelIdx + 1 < nextArgs.length) {
        nextArgs[modelIdx + 1] = fallbackModel;
      } else {
        nextArgs.unshift("--model", fallbackModel);
      }
      const retryRes = await executeAgy(
        { ...spec, args: nextArgs },
        {
          timeoutSec,
          signal,
          onEvent,
          model: fallbackModel,
          effort,
          allowQuotaFallback: false,
        },
      );
      return {
        ...retryRes,
        quotaFallback: {
          fromModel: model || "gemini-4-neon-high",
          toModel: fallbackModel,
          reason: "Individual model quota exhausted (429 RESOURCE_EXHAUSTED); automatically fell back to Argon.",
        },
      };
    }
  }

  const ok = result.ok && !parsed.isError && !parsed.parseError;
  let outputText = parsed.text || result.stderr || "(no output)";
  if (
    !result.ok &&
    isCliFlagCompatibilityError(`${result.stderr || ""}\n${result.stdout || ""}`)
  ) {
    outputText = `Antigravity CLI rejected one or more required flags (requires agy >= ${MIN_AGY_VERSION}). Upgrade with \`agy update\` and verify via \`handoff_doctor\`.\n\n${outputText}`;
  }

  return {
    engine: "agy",
    ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    sessionId: parsed.sessionId,
    costUsd: parsed.costUsd,
    usage: parsed.usage,
    structuredOutput: parsed.structuredOutput || null,
    output: truncateOutput(outputText),
    stderr: ok ? "" : result.stderr,
  };
}

export async function runAgyExec(options) {
  const timeoutSec = validateTimeoutSec(options?.timeoutSec);
  const spec = buildAgyExecSpec(options);
  return executeAgy(spec, {
    timeoutSec,
    signal: options?.signal,
    onEvent: options?.onEvent,
    model: options?.model,
    effort: options?.effort,
  });
}

export async function runAgyReview(options) {
  const timeoutSec = validateTimeoutSec(options?.timeoutSec);
  const spec = buildAgyReviewSpec(options);
  return executeAgy(spec, {
    timeoutSec,
    signal: options?.signal,
    onEvent: options?.onEvent,
    model: options?.model,
    effort: options?.effort,
  });
}
