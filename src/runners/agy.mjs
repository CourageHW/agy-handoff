import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  VALID_REVIEW_SCOPES,
  VALID_REVIEW_STYLES,
  buildAdversarialReviewPrompt,
  buildStandardReviewPrompt,
  compareSemver,
  detectMissingFlags,
  getBinaryVersion,
  getHelpOutput,
  inspectBinary,
  isCliFlagCompatibilityError,
  parseSemver,
  handoffChildEnv,
  runCommand,
  truncateOutput,
  validateCwd,
  validateGitRef,
  validateModelFlag,
  validateSessionId,
  validateTimeoutSec,
  validateWorkspaceWriteCwd,
} from "./common.mjs";
import { createEventStreamParser, createLineStreamParser } from "../events.mjs";

export const MIN_AGY_VERSION = "1.5.0";
export const REQUIRED_AGY_FLAGS = [
  "--print",
  "--output-format",
  "--model",
  "--mode",
  "--effort",
  "--json-schema",
  "--sandbox",
  "--disable-slash-commands",
];

const MAX_RESULT_LINE_BYTES = 4 * 1024 * 1024;
const ALLOWED_MODES = new Set(["read-only", "workspace-write"]);
const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function inspectAgyBinary() {
  const override = process.env.AGY_HANDOFF_AGY_BIN;
  if (override === "" || override === "none") return { installed: false, accessible: false };
  return inspectBinary("agy", "AGY_HANDOFF_AGY_BIN");
}

export function findAgyBinary() {
  const info = inspectAgyBinary();
  return info.accessible ? info.binary : null;
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
  const info = inspectAgyBinary();
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
  timeoutSec,
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
  const validTimeoutSec = validateTimeoutSec(timeoutSec);
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
    "--mode",
    mode === "read-only" ? "plan" : "accept-edits",
  ];
  if (validModel) {
    args.push("--model", validModel);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  if (validSessionId) {
    args.push("--conversation", validSessionId);
  }
  if (validTimeoutSec) {
    args.push("--print-timeout", `${validTimeoutSec}s`);
  }
  if (jsonSchema && typeof jsonSchema === "object" && !Array.isArray(jsonSchema)) {
    args.push("--json-schema", JSON.stringify(jsonSchema));
  }
  args.push("--print", effectivePrompt);

  return {
    args,
    mode,
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
  timeoutSec,
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
    timeoutSec,
  });
}

function createAgyResultParser() {
  let sessionId = null;
  let result = null;
  let responseDelta = "";
  const lines = createLineStreamParser((line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (!ev || typeof ev !== "object") return;
    sessionId = ev.conversation_id || sessionId;
    if (ev.event === "step_update" && ev.step_update?.step_type === "agent_response") {
      const delta = ev.step_update.text_delta;
      if (typeof delta === "string" && responseDelta.length < MAX_OUTPUT_BYTES) {
        responseDelta += delta.slice(0, MAX_OUTPUT_BYTES - responseDelta.length);
      }
    }
    // Older CLI versions emit the terminal object without an event envelope.
    if (ev.event && ev.event !== "result") return;
    const terminal = ev.event === "result" ? ev.result : ev;
    if (terminal?.status === "SUCCESS" || terminal?.status === "ERROR") {
      result = terminal;
      sessionId = terminal.conversation_id || sessionId;
    }
  }, MAX_RESULT_LINE_BYTES);

  return {
    push: lines.push,
    finish() {
      lines.flush();
      const isError = result?.status === "ERROR";
      const structured = result?.structured_output;
      const structuredOutput =
        structured && typeof structured === "object" && !Array.isArray(structured)
          ? structured
          : null;
      let text = "Antigravity CLI stream ended without a valid result.";
      if (isError) {
        const error = result.error || result.response || "Antigravity CLI reported an error.";
        text = typeof error === "string" ? error : JSON.stringify(error);
      } else if (typeof result?.response === "string") {
        text = result.response.trim();
      } else if (result) {
        text = structuredOutput ? JSON.stringify(structuredOutput) : responseDelta.trim();
      }
      return {
        text,
        sessionId,
        costUsd: null,
        usage: result?.usage || null,
        structuredOutput,
        isError,
        parseError: !result,
      };
    },
  };
}

export function parseAgyJsonOutput(stdout) {
  const parser = createAgyResultParser();
  parser.push(stdout || "");
  return parser.finish();
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

  const resultParser = createAgyResultParser();
  const result = await runCommand({
    command: binary,
    args: spec.args,
    cwd: spec.cwd,
    stdin: spec.stdin,
    env: handoffChildEnv("agy"),
    timeoutMs,
    signal,
    onStdoutChunk(chunk) {
      resultParser.push(chunk);
      parser?.push(chunk);
    },
  });

  if (parser) {
    parser.flush();
  }

  const parsed = resultParser.finish();
  const combinedError = `${parsed.parseError ? result.stdout : parsed.text}\n${result.stderr || ""}`;

  // If primary Neon model hits temporary individual quota (429 RESOURCE_EXHAUSTED),
  // transparently fall back once to Gemini 4 Argon so 3-to-1 cross-review still completes.
  if (
    allowQuotaFallback &&
    spec.mode === "read-only" &&
    !result.timedOut &&
    !result.aborted &&
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
  let outputText = parsed.parseError
    ? [parsed.text, result.stderr || result.stdout].filter(Boolean).join("\n")
    : parsed.text || result.stderr || "(no output)";
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
