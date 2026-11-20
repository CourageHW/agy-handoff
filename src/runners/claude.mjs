import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_TIMEOUT_MS,
  VALID_REVIEW_SCOPES,
  VALID_REVIEW_STYLES,
  buildAdversarialReviewPrompt,
  buildStandardReviewPrompt,
  findBinary,
  getBinaryVersion,
  inspectBinary,
  runCommand,
  truncateOutput,
  validateCwd,
  validateGitRef,
  validateModelFlag,
  validateSessionId,
  validateTimeoutSec,
} from "./common.mjs";
import { createEventStreamParser } from "../events.mjs";

const ALLOWED_MODES = new Set(["read-only", "workspace-write"]);
const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

const READ_ONLY_AVAILABLE_TOOLS = "Read,Grep,Glob,Bash";

const READ_ONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git status)",
  "Bash(git status *)",
  "Bash(git diff)",
  "Bash(git diff *)",
  "Bash(git log)",
  "Bash(git log *)",
  "Bash(git show)",
  "Bash(git show *)",
].join(",");

const READ_ONLY_DISALLOWED_TOOLS = [
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash(git * --output*)",
  "Bash(git * --ext-diff*)",
  "Bash(git * --textconv*)",
].join(",");

const WORKSPACE_WRITE_TOOLS = "Read,Edit,Write,Grep,Glob,Bash";

export function findClaudeBinary() {
  return findBinary("claude", "AGY_HANDOFF_CLAUDE_BIN");
}

export async function inspectClaude() {
  const info = inspectBinary("claude", "AGY_HANDOFF_CLAUDE_BIN");
  if (!info.installed) {
    return {
      engine: "claude",
      installed: false,
      accessible: false,
      binary: null,
      symlinkTarget: null,
      version: null,
      installHint:
        "curl -fsSL https://claude.ai/install.sh | bash (or npm install -g @anthropic-ai/claude-code)",
    };
  }
  if (!info.accessible) {
    return {
      engine: "claude",
      installed: true,
      accessible: false,
      binary: info.binary,
      symlinkTarget: info.symlinkTarget,
      version: null,
      note: info.warning,
    };
  }
  const version = await getBinaryVersion(info.binary, ["--version"]);
  const home = os.homedir();
  const claudeDir = path.join(home, ".claude");
  const claudeJson = path.join(home, ".claude.json");
  const hasAuthHint =
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    fs.existsSync(claudeJson) ||
    fs.existsSync(claudeDir);
  return {
    engine: "claude",
    installed: true,
    accessible: true,
    binary: info.binary,
    symlinkTarget: info.symlinkTarget,
    version,
    authHint: hasAuthHint
      ? "ANTHROPIC_API_KEY or ~/.claude(.json) detected"
      : "No local auth hint detected (run `claude` to sign in or set ANTHROPIC_API_KEY)",
  };
}

export function buildClaudeExecSpec({
  prompt,
  cwd,
  mode = "read-only",
  model,
  effort,
  sessionId,
  ephemeral = false,
}) {
  if (!prompt || !prompt.trim()) {
    throw new Error("Prompt is required for Claude Code execution.");
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
  const resolvedCwd = validateCwd(cwd);

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompts",
    "none",
  ];
  if (mode === "read-only") {
    args.push(
      "--permission-mode",
      "dontAsk",
      "--restricted",
      "--strict-mcp-config",
      "--tools",
      READ_ONLY_AVAILABLE_TOOLS,
      "--allowedTools",
      READ_ONLY_TOOLS,
      "--disallowedTools",
      READ_ONLY_DISALLOWED_TOOLS,
    );
  } else {
    args.push(
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      WORKSPACE_WRITE_TOOLS,
    );
  }

  if (validModel) {
    args.push("--model", validModel);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  if (validSessionId) {
    args.push("--resume", validSessionId);
  }
  if (ephemeral && !validSessionId) {
    args.push("--no-session-persistence");
  }

  return {
    args,
    cwd: resolvedCwd,
    stdin: prompt,
  };
}

export function buildClaudeReviewSpec({
  cwd,
  style = "standard",
  scope = "uncommitted",
  base,
  commit,
  prompt,
  model,
  effort,
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

  return buildClaudeExecSpec({
    prompt: composedPrompt,
    cwd,
    mode: "read-only",
    model,
    effort,
    ephemeral: true,
  });
}

export function parseClaudeJsonOutput(stdout) {
  const trimmed = (stdout || "").trim();
  if (!trimmed) {
    return {
      text: "",
      sessionId: null,
      costUsd: null,
      isError: false,
      parseError: false,
    };
  }

  if (!trimmed.includes("\n")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const text =
          typeof parsed.result === "string"
            ? parsed.result
            : typeof parsed.content === "string"
              ? parsed.content
              : trimmed;
        return {
          text,
          sessionId: parsed.session_id || parsed.sessionId || null,
          costUsd:
            typeof parsed.total_cost_usd === "number"
              ? parsed.total_cost_usd
              : typeof parsed.cost_usd === "number"
                ? parsed.cost_usd
                : null,
          isError: Boolean(parsed.is_error),
          parseError: false,
        };
      }
    } catch {
      return {
        text: trimmed,
        sessionId: null,
        costUsd: null,
        isError: false,
        parseError: trimmed.startsWith("{") || trimmed.startsWith("["),
      };
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let validLines = 0;
  let sessionId = null;
  let costUsd = null;
  let isError = false;
  let resultText = null;
  let lastAssistantText = null;
  let sawResultEvent = false;
  let lastLineFailed = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      if (i === lines.length - 1 && (line.startsWith("{") || line.startsWith("["))) {
        lastLineFailed = true;
      }
      continue;
    }
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) continue;

    validLines += 1;
    lastLineFailed = false;

    if (ev.session_id || ev.sessionId) {
      sessionId = ev.session_id || ev.sessionId;
    }
    if (typeof ev.total_cost_usd === "number") {
      costUsd = ev.total_cost_usd;
    } else if (typeof ev.cost_usd === "number") {
      costUsd = ev.cost_usd;
    }

    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      const texts = ev.message.content
        .filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim())
        .map((b) => b.text);
      if (texts.length > 0) {
        lastAssistantText = texts.join("\n").trim();
      }
    } else if (ev.type === "result") {
      sawResultEvent = true;
      isError = Boolean(ev.is_error);
      if (typeof ev.result === "string") {
        resultText = ev.result;
      }
    } else if (typeof ev.result === "string") {
      resultText = ev.result;
      isError = Boolean(ev.is_error);
    }
  }

  if (validLines === 0) {
    return {
      text: trimmed,
      sessionId: null,
      costUsd: null,
      isError: false,
      parseError: trimmed.startsWith("{") || trimmed.startsWith("["),
    };
  }

  if (lastLineFailed && !sawResultEvent) {
    return {
      text: lastAssistantText || trimmed,
      sessionId,
      costUsd,
      isError,
      parseError: true,
    };
  }

  return {
    text: resultText ?? lastAssistantText ?? trimmed,
    sessionId,
    costUsd,
    isError,
    parseError: false,
  };
}

async function executeClaude(spec, options) {
  const binary = findClaudeBinary();
  if (!binary) {
    throw new Error(
      "Claude Code CLI (`claude`) was not found in PATH. Install it with `npm install -g @anthropic-ai/claude-code`.",
    );
  }
  const timeoutSec = validateTimeoutSec(options.timeoutSec);
  const parser =
    typeof options.onEvent === "function"
      ? createEventStreamParser("claude", options.onEvent)
      : null;

  const res = await runCommand({
    command: binary,
    args: spec.args,
    cwd: spec.cwd,
    stdin: spec.stdin,
    timeoutMs: (timeoutSec || DEFAULT_TIMEOUT_MS / 1000) * 1000,
    truncateStdout: false,
    maxCaptureBytes: 4 * 1024 * 1024,
    signal: options.signal,
    onStdoutChunk: parser ? (chunk) => parser.push(chunk) : undefined,
  });

  if (parser) {
    parser.flush();
  }

  const parsed = parseClaudeJsonOutput(res.stdout);
  const hasEnvelopeFailure = res.stdoutTruncated || parsed.parseError;
  const ok = res.ok && !parsed.isError && !hasEnvelopeFailure;

  let rawOutput;
  if (res.stdoutTruncated) {
    rawOutput =
      "Claude Code JSON output exceeded the 4 MB capture limit and could not be parsed cleanly.";
  } else if (parsed.parseError) {
    rawOutput = `Claude Code returned malformed or truncated JSON output.\n\n${parsed.text || res.stderr}`;
  } else {
    rawOutput = parsed.text || res.stderr;
  }

  return {
    engine: "claude",
    ok,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    aborted: Boolean(res.aborted),
    durationMs: res.durationMs,
    sessionId: parsed.sessionId,
    costUsd: parsed.costUsd,
    output: truncateOutput(rawOutput),
    stderr: ok ? "" : res.stderr,
  };
}

export async function runClaudeExec(options) {
  return executeClaude(buildClaudeExecSpec(options), options);
}

export async function runClaudeReview(options) {
  return executeClaude(buildClaudeReviewSpec(options), options);
}
