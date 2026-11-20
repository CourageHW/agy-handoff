#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JobManager } from "./jobs.mjs";
import {
  getEffectiveConfigSummary,
  loadConfig,
  resolveEngineConfig,
  updateConfig,
} from "./config.mjs";
import {
  captureGitDirtySnapshot,
  computeGitDelta,
  createExecutionEvidenceTracker,
  normalizeAndFormatContext,
} from "./context.mjs";
import {
  STRUCTURED_REVIEW_SCHEMA,
  buildStructuredSingleReview,
  synthesizeStructuredCrossReview,
} from "./cross-review.mjs";
import {
  STRUCTURED_PLAN_SCHEMA,
  buildCollaborativePlanPrompt,
  synthesizeCollaborativePlan,
} from "./plan.mjs";
import { VALID_TASK_TYPES, resolveAutoEngine } from "./routing.mjs";
import {
  isInsideGitRepo,
  terminateAllForegroundCommands,
  validateCwd,
  validateTimeoutSec,
  validateWorkspaceWriteCwd,
} from "./runners/common.mjs";
import {
  buildCodexExecSpec,
  buildCodexReviewSpec,
  findCodexBinary,
  inspectCodex,
  runCodexExec,
  runCodexReview,
} from "./runners/codex.mjs";
import {
  WORKSPACE_WRITE_DISALLOWED_TOOLS,
  buildClaudeExecSpec,
  buildClaudeReviewSpec,
  findClaudeBinary,
  inspectClaude,
  runClaudeExec,
  runClaudeReview,
} from "./runners/claude.mjs";
import {
  buildAgyExecSpec,
  buildAgyReviewSpec,
  findAgyBinary,
  inspectAgy,
  runAgyExec,
  runAgyReview,
} from "./runners/agy.mjs";

const SERVER_INFO = {
  name: "agy-handoff",
  version: "0.2.0",
};

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"];

const CONTEXT_SCHEMA = {
  type: "object",
  description:
    "Optional structured handoff context (scoped files, prior summary, constraints, acceptance criteria) to prevent redundant exploration.",
  properties: {
    files: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    constraints: { type: "array", items: { type: "string" } },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
  },
};

export const TOOLS = [
  {
    name: "handoff_doctor",
    description:
      "Check whether local Codex and Claude Code CLIs are installed, their versions, and basic authentication hints.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "handoff_review",
    description:
      "Run a read-only code review using local Codex or Claude Code CLI (or engine: 'auto'). Supports standard or adversarial review styles, uncommitted/base/commit/custom scopes, scoped context, and structured JSON output.",
    inputSchema: {
      type: "object",
      properties: {
        engine: {
          type: "string",
          enum: ["codex", "claude", "agy", "auto"],
          description:
            "Which CLI to run the review with ('codex', 'claude', 'agy' [default: gemini-4-neon-high], or 'auto').",
        },
        taskType: {
          type: "string",
          enum: VALID_TASK_TYPES,
          default: "review",
          description: "Optional task classification used when engine is 'auto'.",
        },
        style: {
          type: "string",
          enum: ["standard", "adversarial"],
          default: "standard",
          description:
            "'standard' checks bugs/regressions; 'adversarial' aggressively challenges architecture, edge cases, security, and race conditions.",
        },
        scope: {
          type: "string",
          enum: ["uncommitted", "base", "commit", "custom"],
          default: "uncommitted",
          description: "What changes to review.",
        },
        base: {
          type: "string",
          description: "Base branch name (required when scope is 'base').",
        },
        commit: {
          type: "string",
          description: "Commit SHA (required when scope is 'commit').",
        },
        prompt: {
          type: "string",
          description: "Optional extra review focus or custom target files/instructions.",
        },
        context: CONTEXT_SCHEMA,
        structured: {
          type: "boolean",
          default: false,
          description:
            "Request structured JSON review findings compatible with citation verification.",
        },
        model: {
          type: "string",
          description:
            "Optional model override passed to the selected CLI (defaults to configured review/global default; built-in: gpt-6.2-sol for Codex, claude-opus-5-5 for Claude).",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
          description:
            "Optional reasoning effort level (defaults to configured review/global default; built-in: high; Codex supports up to ultra, Claude up to max).",
        },
        cwd: {
          type: "string",
          description: "Repository working directory (defaults to server cwd).",
        },
        skipGitRepoCheck: {
          type: "boolean",
          description:
            "Allow Codex to run outside a Git repository (auto-enabled for custom reviews outside Git repos).",
        },
        background: {
          type: "boolean",
          default: false,
          description: "Run asynchronously and return a jobId immediately.",
        },
        timeoutSec: {
          type: "integer",
          minimum: 10,
          maximum: 3600,
          description: "Execution timeout in seconds (default 600).",
        },
      },
      required: ["engine"],
      additionalProperties: false,
    },
  },
  {
    name: "handoff_delegate",
    description:
      "Delegate an investigation, debugging, or coding task to local Codex or Claude Code CLI (or engine: 'auto'). Defaults to read-only mode for safety.",
    inputSchema: {
      type: "object",
      properties: {
        engine: {
          type: "string",
          enum: ["codex", "claude", "agy", "auto"],
          description:
            "Which CLI to delegate the task to ('codex', 'claude', 'agy' [default: gemini-4-neon-high], or 'auto').",
        },
        taskType: {
          type: "string",
          enum: VALID_TASK_TYPES,
          default: "general",
          description: "Optional task classification used when engine is 'auto'.",
        },
        prompt: {
          type: "string",
          description: "Clear, self-contained task description for the external CLI.",
        },
        context: CONTEXT_SCHEMA,
        mode: {
          type: "string",
          enum: ["read-only", "workspace-write"],
          default: "read-only",
          description:
            "Execution permission mode. Always prefer 'read-only' unless file edits are explicitly intended. Note: for Claude Code, 'workspace-write' grants unrestricted Bash shell access rather than an OS filesystem/network sandbox.",
        },
        model: {
          type: "string",
          description:
            "Optional model override (defaults to configured delegate/global default; built-in: gpt-6.2-sol for Codex, claude-opus-5-5 for Claude).",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
          description:
            "Optional reasoning effort level (defaults to configured delegate/global default; built-in: high; Codex supports up to ultra, Claude up to max).",
        },
        sessionId: {
          type: "string",
          description:
            "Optional session ID to resume a previous conversation ('last' supported for Codex).",
        },
        cwd: {
          type: "string",
          description: "Repository working directory (defaults to server cwd).",
        },
        skipGitRepoCheck: {
          type: "boolean",
          description:
            "Allow Codex to run outside a Git repository (auto-enabled for delegations outside Git repos).",
        },
        background: {
          type: "boolean",
          default: false,
          description: "Run asynchronously and return a jobId immediately.",
        },
        timeoutSec: {
          type: "integer",
          minimum: 10,
          maximum: 3600,
          description: "Execution timeout in seconds (default 600).",
        },
      },
      required: ["engine", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "handoff_cross_review",
    description:
      "Run Codex and Claude Code in parallel for an independent dual-engine second opinion on the same changes or prompt. Gracefully reports if one CLI is not installed.",
    inputSchema: {
      type: "object",
      properties: {
        style: {
          type: "string",
          enum: ["standard", "adversarial"],
          default: "adversarial",
        },
        scope: {
          type: "string",
          enum: ["uncommitted", "base", "commit", "custom"],
          default: "uncommitted",
        },
        base: { type: "string" },
        commit: { type: "string" },
        prompt: { type: "string" },
        context: CONTEXT_SCHEMA,
        structured: {
          type: "boolean",
          default: false,
          description:
            "Request structured findings from both engines and attach consensus, conflicts, unique findings, and mechanical citation checks.",
        },
        codexModel: { type: "string" },
        codexEffort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
        claudeModel: { type: "string" },
        claudeEffort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
        },
        agyModel: {
          type: "string",
          description:
            "Optional model override for the 3rd Antigravity reviewer (default: gemini-4-neon-high / 'neon').",
        },
        agyEffort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
          description: "Optional effort override for the 3rd Antigravity reviewer (default: high).",
        },
        includeAgy: {
          type: "boolean",
          default: true,
          description:
            "Run the 3rd Antigravity reviewer (default: gemini-4-neon-high) in parallel for 3-to-1 cross-review synthesis.",
        },
        cwd: { type: "string" },
        skipGitRepoCheck: {
          type: "boolean",
          description:
            "Allow Codex to run outside a Git repository (auto-enabled for custom reviews outside Git repos).",
        },
        timeoutSec: {
          type: "integer",
          minimum: 10,
          maximum: 3600,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "handoff_config",
    description:
      "Inspect, update, or reset default Codex and Claude Code models, reasoning efforts, and auto-routing policies globally or per command.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "set", "reset"],
          default: "get",
        },
        scope: {
          type: "string",
          enum: ["default", "review", "delegate", "cross-review", "plan", "all"],
        },
        engine: {
          type: "string",
          enum: ["codex", "claude", "agy"],
        },
        model: { type: "string" },
        effort: { type: "string" },
        codexModel: { type: "string" },
        codexEffort: { type: "string" },
        claudeModel: { type: "string" },
        claudeEffort: { type: "string" },
        agyModel: { type: "string" },
        agyEffort: { type: "string" },
        defaults: { type: "object" },
        commands: { type: "object" },
        routing: {
          type: "object",
          description:
            "Optional routing preferences: { policy: 'balanced'|'prefer-codex'|'prefer-claude'|'least-used', taskTypes: { review|debugging|implementation|architecture|general: 'codex'|'claude'|'auto'|null } }.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "handoff_job_status",
    description:
      "Check status and live activity events of a specific background handoff job, or list recent jobs when jobId is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "Job ID returned by a background handoff call.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
        },
        waitSec: {
          type: "integer",
          minimum: 0,
          maximum: 60,
          description:
            "Wait up to N seconds for new activity events or job completion before returning (for live subagent progress tracking).",
        },
        sinceSeq: {
          type: "integer",
          minimum: 0,
          description: "Return only events with sequence number greater than sinceSeq.",
        },
        eventsLimit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 10,
          description: "Maximum number of recent activity events to return.",
        },
        includeStats: {
          type: "boolean",
          default: false,
          description:
            "When jobId is omitted, include aggregated usage and performance stats over retained jobs.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "handoff_job_result",
    description: "Retrieve the output and metadata of a background handoff job.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "Job ID to fetch results for.",
        },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "handoff_job_cancel",
    description: "Cancel a running background handoff job.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "Job ID to cancel.",
        },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "handoff_job_retry",
    description:
      "Safely replay a finished read-only job (optionally switching to the alternate engine). Strictly refuses workspace-write jobs.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "Job ID of a finished read-only job to retry.",
        },
        fallbackEngine: {
          type: "boolean",
          default: false,
          description: "Switch to the alternate engine (Codex <-> Claude) on retry.",
        },
        timeoutSec: {
          type: "integer",
          minimum: 10,
          maximum: 3600,
          description: "Optional timeout override in seconds.",
        },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "handoff_plan",
    description:
      "Design or stress-test a collaborative implementation plan across OpenAI Codex, Anthropic Claude Code, and Google Antigravity (gemini-4-neon-high) in parallel (3-to-1). Combines Grill-Me spec decisions with zero-handwaving TDD task breakdown and mechanical disk file-target verification.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "Primary feature, refactor, or architecture goal to plan.",
        },
        phase: {
          type: "string",
          enum: ["discover", "design"],
          default: "design",
          description:
            "'discover' scans the codebase in read-only mode to surface high-leverage design-tree questions for a Grill-Me interview; 'design' (default) synthesizes a complete 3-to-1 implementation plan from confirmed spec decisions.",
        },
        decisions: {
          type: "array",
          description:
            "Confirmed decisions from the Grill-Me spec interview (array of strings or { branch?, question, answer } objects).",
          items: {
            type: ["string", "object"],
          },
        },
        requirements: {
          type: "array",
          description: "Explicit functional requirements agreed with the user.",
          items: { type: "string" },
        },
        nonGoals: {
          type: "array",
          description: "Explicit out-of-scope items (YAGNI boundaries).",
          items: { type: "string" },
        },
        constraints: {
          type: "array",
          description: "Technical, performance, security, or compatibility constraints.",
          items: { type: "string" },
        },
        acceptanceCriteria: {
          type: "array",
          description: "Concrete verification and acceptance criteria.",
          items: { type: "string" },
        },
        context: CONTEXT_SCHEMA,
        structured: {
          type: "boolean",
          default: true,
          description:
            "Request structured JSON plan blueprints from all 3 engines and synthesize consensus file targets, disk verification, merged risks, and test strategy.",
        },
        codexModel: { type: "string" },
        codexEffort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
        claudeModel: { type: "string" },
        claudeEffort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
        },
        agyModel: {
          type: "string",
          description:
            "Optional model override for the 3rd Antigravity planner (default: gemini-4-neon-high / 'neon').",
        },
        agyEffort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
          description: "Optional effort override for the 3rd Antigravity planner (default: high).",
        },
        includeAgy: {
          type: "boolean",
          default: true,
          description:
            "Run the 3rd Antigravity planner (default: gemini-4-neon-high) in parallel for 3-to-1 collaborative plan synthesis.",
        },
        cwd: {
          type: "string",
          description: "Repository working directory (defaults to server cwd).",
        },
        skipGitRepoCheck: {
          type: "boolean",
          description: "Allow Codex to run outside a Git repository.",
        },
        timeoutSec: {
          type: "integer",
          minimum: 10,
          maximum: 3600,
          description: "Execution timeout in seconds (default 600).",
        },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateToolArgs(toolName, rawArgs) {
  const tool = TOOL_MAP.get(toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  const args = rawArgs === undefined ? {} : rawArgs;
  if (!isPlainObject(args)) {
    throw new Error(`Invalid arguments for ${toolName}: expected a JSON object.`);
  }

  const schema = tool.inputSchema;
  const props = schema.properties || {};

  if (Array.isArray(schema.required)) {
    for (const req of schema.required) {
      if (args[req] === undefined) {
        throw new Error(`Missing required argument "${req}" for ${toolName}.`);
      }
    }
  }

  for (const [key, val] of Object.entries(args)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) {
      throw new Error(`Unknown argument "${key}" for ${toolName}.`);
    }
    if (val === undefined) {
      continue;
    }
    const prop = props[key];
    if (prop.type === "string") {
      if (typeof val !== "string") {
        throw new Error(`Argument "${key}" for ${toolName} must be a string.`);
      }
      if (Array.isArray(prop.enum) && !prop.enum.includes(val)) {
        throw new Error(
          `Invalid "${key}" value "${val}" for ${toolName}. Allowed: ${prop.enum.join(", ")}.`,
        );
      }
    } else if (prop.type === "boolean") {
      if (typeof val !== "boolean") {
        throw new Error(`Argument "${key}" for ${toolName} must be a boolean.`);
      }
    } else if (prop.type === "integer") {
      if (typeof val !== "number" || !Number.isInteger(val)) {
        throw new Error(`Argument "${key}" for ${toolName} must be an integer.`);
      }
      if (prop.minimum !== undefined && val < prop.minimum) {
        throw new Error(
          `Argument "${key}" for ${toolName} must be >= ${prop.minimum}.`,
        );
      }
      if (prop.maximum !== undefined && val > prop.maximum) {
        throw new Error(
          `Argument "${key}" for ${toolName} must be <= ${prop.maximum}.`,
        );
      }
    } else if (prop.type === "object") {
      if (!isPlainObject(val)) {
        throw new Error(`Argument "${key}" for ${toolName} must be an object.`);
      }
    } else if (prop.type === "array") {
      if (!Array.isArray(val)) {
        throw new Error(`Argument "${key}" for ${toolName} must be an array.`);
      }
    }
  }

  if (toolName === "handoff_delegate" && !args.prompt.trim()) {
    throw new Error('Argument "prompt" for handoff_delegate cannot be empty.');
  }
  if (toolName === "handoff_plan" && !args.goal.trim()) {
    throw new Error('Argument "goal" for handoff_plan cannot be empty.');
  }

  return args;
}

async function runTrackedForeground(
  jobManager,
  {
    engine,
    action,
    cwd,
    model,
    effort,
    mode = "read-only",
    structured = false,
    handoffContext = null,
    requestParams = null,
    jsonStream = true,
    onProgress,
  },
  fn,
) {
  const tracker = jobManager.beginForegroundRun({
    engine,
    action,
    cwd,
    model: model || null,
    effort: effort || null,
    mode,
    structured,
    handoffContext,
    requestParams,
  });

  const evidenceTracker = createExecutionEvidenceTracker({
    action,
    mode,
    jsonStream,
  });
  const beforeGit =
    mode === "workspace-write" ? await captureGitDirtySnapshot(cwd) : null;

  const handleEvent = (ev) => {
    evidenceTracker.recordEvent(ev);
    tracker.recordEvent(ev);
    if (typeof onProgress === "function") {
      try {
        onProgress({
          progress: ev.seq,
          message: `[${ev.engine}] ${ev.summary}`,
        });
      } catch {
        // ignore progress emission error
      }
    }
  };

  try {
    const result = await fn(handleEvent);
    const afterGit =
      mode === "workspace-write" ? await captureGitDirtySnapshot(cwd) : null;
    const gitDelta =
      beforeGit && afterGit ? computeGitDelta(beforeGit, afterGit) : null;
    const executionEvidence = evidenceTracker.finalize({
      ok: Boolean(result.ok),
      gitDelta,
    });

    await tracker.finish({
      status: result.ok ? "completed" : result.timedOut ? "timed_out" : "failed",
      exitCode: result.exitCode,
      error: result.ok ? null : result.stderr || null,
      sessionId: result.sessionId || null,
      costUsd: typeof result.costUsd === "number" ? result.costUsd : null,
      usage: result.usage || null,
      executionEvidence,
    });
    return {
      ...result,
      jobId: tracker.jobId,
      eventsPath: tracker.eventsPath,
      executionEvidence,
    };
  } catch (err) {
    await tracker.finish({
      status: "failed",
      exitCode: -1,
      error: err.message,
      executionEvidence: evidenceTracker.finalize({ ok: false }),
    });
    throw err;
  }
}

function buildBackgroundReviewJobSpec({
  engine,
  effectiveArgs,
  resolved,
  jobManager,
  timeoutSec,
  handoffContext,
  retryOf,
  requestParams,
}) {
  if (engine === "codex") {
    const binary = findCodexBinary();
    if (!binary) throw new Error("Codex CLI (`codex`) not found in PATH.");
    const jobId = jobManager.allocateJobId("codex");
    const outputFile = jobManager.outputFilePath(jobId);
    const outputSchemaFile = effectiveArgs.outputSchema
      ? jobManager.schemaPath(jobId)
      : null;
    const spec = buildCodexReviewSpec({
      ...effectiveArgs,
      outputFile,
      outputSchemaFile,
    });
    return {
      jobId,
      engine: "codex",
      action: "review",
      mode: "read-only",
      command: binary,
      args: spec.args,
      cwd: spec.cwd,
      stdin: spec.stdin,
      timeoutMs: (timeoutSec || 600) * 1000,
      hasOutputFile: Boolean(spec.outputFile),
      parseMode: "text",
      model: resolved.model || null,
      effort: resolved.effort || null,
      handoffContext,
      retryOf,
      structured: Boolean(effectiveArgs.outputSchema || requestParams?.structured),
      outputSchema: effectiveArgs.outputSchema || null,
      requestParams,
    };
  }
  if (engine === "agy") {
    const binary = findAgyBinary();
    if (!binary) throw new Error("Antigravity CLI (`agy`) not found in PATH.");
    const spec = buildAgyReviewSpec(effectiveArgs);
    return {
      engine: "agy",
      action: "review",
      mode: "read-only",
      command: binary,
      args: spec.args,
      cwd: spec.cwd,
      stdin: spec.stdin,
      timeoutMs: (timeoutSec || 600) * 1000,
      parseMode: "agy-json",
      model: resolved.model || null,
      effort: resolved.effort || null,
      handoffContext,
      retryOf,
      structured: Boolean(effectiveArgs.jsonSchema || requestParams?.structured),
      requestParams,
    };
  }
  const binary = findClaudeBinary();
  if (!binary) throw new Error("Claude Code CLI (`claude`) not found in PATH.");
  const spec = buildClaudeReviewSpec(effectiveArgs);
  return {
    engine: "claude",
    action: "review",
    mode: "read-only",
    command: binary,
    args: spec.args,
    cwd: spec.cwd,
    stdin: spec.stdin,
    timeoutMs: (timeoutSec || 600) * 1000,
    parseMode: "claude-json",
    model: resolved.model || null,
    effort: resolved.effort || null,
    handoffContext,
    retryOf,
    structured: Boolean(effectiveArgs.jsonSchema || requestParams?.structured),
    requestParams,
  };
}

function buildBackgroundDelegateJobSpec({
  engine,
  mode,
  effectiveArgs,
  resolved,
  jobManager,
  timeoutSec,
  handoffContext,
  retryOf,
  requestParams,
}) {
  if (engine === "codex") {
    const binary = findCodexBinary();
    if (!binary) throw new Error("Codex CLI (`codex`) not found in PATH.");
    const jobId = jobManager.allocateJobId("codex");
    const outputFile = effectiveArgs.sessionId
      ? null
      : jobManager.outputFilePath(jobId);
    const spec = buildCodexExecSpec({ ...effectiveArgs, outputFile });
    return {
      jobId,
      engine: "codex",
      action: "delegate",
      mode,
      command: binary,
      args: spec.args,
      cwd: spec.cwd,
      stdin: spec.stdin,
      timeoutMs: (timeoutSec || 600) * 1000,
      hasOutputFile: Boolean(spec.outputFile),
      parseMode: "text",
      model: resolved.model || null,
      effort: resolved.effort || null,
      handoffContext,
      retryOf,
      requestParams: mode === "read-only" ? requestParams : null,
    };
  }
  if (engine === "agy") {
    const binary = findAgyBinary();
    if (!binary) throw new Error("Antigravity CLI (`agy`) not found in PATH.");
    const spec = buildAgyExecSpec(effectiveArgs);
    return {
      engine: "agy",
      action: "delegate",
      mode,
      command: binary,
      args: spec.args,
      cwd: spec.cwd,
      stdin: spec.stdin,
      timeoutMs: (timeoutSec || 600) * 1000,
      parseMode: "agy-json",
      model: resolved.model || null,
      effort: resolved.effort || null,
      handoffContext,
      retryOf,
      requestParams: mode === "read-only" ? requestParams : null,
    };
  }
  const binary = findClaudeBinary();
  if (!binary) throw new Error("Claude Code CLI (`claude`) not found in PATH.");
  const spec = buildClaudeExecSpec(effectiveArgs);
  return {
    engine: "claude",
    action: "delegate",
    mode,
    command: binary,
    args: spec.args,
    cwd: spec.cwd,
    stdin: spec.stdin,
    timeoutMs: (timeoutSec || 600) * 1000,
    parseMode: "claude-json",
    model: resolved.model || null,
    effort: resolved.effort || null,
    handoffContext,
    retryOf,
    requestParams: mode === "read-only" ? requestParams : null,
  };
}

export async function handleToolCall(
  name,
  rawArgs = {},
  jobManager = new JobManager(),
  context = {},
) {
  const args = validateToolArgs(name, rawArgs);
  const { signal, onProgress } = context || {};

  switch (name) {
    case "handoff_doctor": {
      const staleJobsRecovered = jobManager.recoverStaleJobs();
      const [codex, claude, agy] = await Promise.all([
        inspectCodex(),
        inspectClaude(),
        inspectAgy(),
      ]);
      const summary = getEffectiveConfigSummary();
      return {
        nodeVersion: process.version,
        platform: process.platform,
        engines: { codex, claude, agy },
        configPath: summary.configPath,
        modelDefaults: summary.effective,
        routingConfig: summary.config?.routing || null,
        staleJobsRecovered,
      };
    }

    case "handoff_review": {
      const { background = false } = args;
      const timeoutSec = validateTimeoutSec(args.timeoutSec);
      const scope = args.scope || "uncommitted";
      const resolvedCwd = validateCwd(args.cwd);
      const ctx = normalizeAndFormatContext(args.context, resolvedCwd);
      const effectivePrompt = args.prompt
        ? `${ctx.promptPrefix}${args.prompt}`
        : ctx.promptPrefix.trim() || undefined;
      const skipGitRepoCheck =
        args.skipGitRepoCheck ?? (scope === "custom" ? !isInsideGitRepo(resolvedCwd) : false);

      let selectedEngine = args.engine;
      let routingDecision = null;
      if (selectedEngine === "auto") {
        const routed = await resolveAutoEngine({
          taskType: args.taskType || "review",
          mode: "read-only",
          effort: args.effort,
          model: args.model,
          config: loadConfig(),
          jobManager,
        });
        selectedEngine = routed.selectedEngine;
        routingDecision = routed.routingDecision;
      }

      const resolved = resolveEngineConfig("review", selectedEngine, {
        model: args.model,
        effort: args.effort,
      });
      const effectiveArgs = {
        ...args,
        engine: selectedEngine,
        prompt: effectivePrompt,
        cwd: resolvedCwd,
        scope,
        skipGitRepoCheck,
        timeoutSec,
        model: resolved.model,
        effort: resolved.effort,
        signal,
        ...(args.structured
          ? selectedEngine === "codex"
            ? { outputSchema: STRUCTURED_REVIEW_SCHEMA }
            : { jsonSchema: STRUCTURED_REVIEW_SCHEMA }
          : {}),
      };

      const requestParams = {
        style: args.style || "standard",
        scope,
        base: args.base,
        commit: args.commit,
        prompt: effectivePrompt,
        structured: Boolean(args.structured),
        skipGitRepoCheck,
        timeoutSec,
      };

      if (background) {
        const jobSpec = buildBackgroundReviewJobSpec({
          engine: selectedEngine,
          effectiveArgs,
          resolved,
          jobManager,
          timeoutSec,
          handoffContext: ctx.metadata,
          requestParams,
        });
        const started = jobManager.startJob(jobSpec);
        return {
          ...started,
          ...(routingDecision ? { routingDecision } : {}),
          ...(ctx.metadata ? { handoffContext: ctx.metadata } : {}),
        };
      }

      const usesCodexNative =
        selectedEngine === "codex" &&
        (args.style || "standard") === "standard" &&
        !effectivePrompt &&
        !args.structured &&
        (scope === "uncommitted" || scope === "base" || scope === "commit");

      const result = await runTrackedForeground(
        jobManager,
        {
          engine: selectedEngine,
          action: "review",
          cwd: resolvedCwd,
          model: resolved.model,
          effort: resolved.effort,
          mode: "read-only",
          structured: Boolean(args.structured),
          handoffContext: ctx.metadata,
          requestParams,
          jsonStream: !usesCodexNative,
          onProgress,
        },
        (onEvent) =>
          selectedEngine === "codex"
            ? runCodexReview({ ...effectiveArgs, onEvent })
            : selectedEngine === "agy"
              ? runAgyReview({ ...effectiveArgs, onEvent })
              : runClaudeReview({ ...effectiveArgs, onEvent }),
      );
      const structuredReview = args.structured
        ? buildStructuredSingleReview({
            engine: selectedEngine,
            cliOk: Boolean(result.ok),
            exitCode: result.exitCode,
            cliError: result.ok ? null : result.stderr || result.output || null,
            output: result.output,
            structuredOutput: result.structuredOutput || null,
            cwd: resolvedCwd,
          })
        : undefined;
      return {
        ...result,
        ...(structuredReview ? { structuredReview } : {}),
        ...(routingDecision ? { routingDecision } : {}),
        ...(ctx.metadata ? { handoffContext: ctx.metadata } : {}),
      };
    }

    case "handoff_delegate": {
      const { background = false } = args;
      const mode = args.mode || "read-only";
      if (mode === "workspace-write" && args.sessionId === "last") {
        throw new Error(
          'Refusing to use sessionId="last" in workspace-write mode; pass an explicit session ID.',
        );
      }
      const timeoutSec = validateTimeoutSec(args.timeoutSec);
      const resolvedCwd =
        mode === "workspace-write"
          ? validateWorkspaceWriteCwd(args.cwd)
          : validateCwd(args.cwd);
      const ctx = normalizeAndFormatContext(args.context, resolvedCwd);
      const effectivePrompt = `${ctx.promptPrefix}${args.prompt}`;
      const skipGitRepoCheck =
        args.skipGitRepoCheck ?? !isInsideGitRepo(resolvedCwd);

      let selectedEngine = args.engine;
      let routingDecision = null;
      if (selectedEngine === "auto") {
        if (args.sessionId) {
          throw new Error(
            'Cannot combine `sessionId` with `engine: "auto"`; specify the engine that owns the session.',
          );
        }
        const routed = await resolveAutoEngine({
          taskType: args.taskType || "general",
          mode,
          effort: args.effort,
          model: args.model,
          config: loadConfig(),
          jobManager,
        });
        selectedEngine = routed.selectedEngine;
        routingDecision = routed.routingDecision;
      }

      const sandboxModel =
        mode === "workspace-write"
          ? selectedEngine === "codex"
            ? "os-sandbox (workspace-write)"
            : "restricted-file-tools + acceptEdits + unsandboxed-bash"
          : undefined;
      const permissionBoundary =
        mode === "workspace-write"
          ? {
              mode: "workspace-write",
              engine: selectedEngine,
              requiresExplicitUserApproval: true,
              osSandboxed: selectedEngine === "codex",
              sandboxModel,
              disallowedCommands:
                selectedEngine === "claude"
                  ? WORKSPACE_WRITE_DISALLOWED_TOOLS.split(",")
                  : [],
              warning:
                selectedEngine === "claude"
                  ? "Claude Code built-in file tools (Read/Edit/Write/Grep/Glob) are confined to cwd via --restricted, but Bash runs without an OS filesystem/network sandbox. Confirm observed workspaceGitDelta and executionEvidence."
                  : "Codex runs inside an OS workspace-write sandbox confined to cwd. Confirm observed workspaceGitDelta and executionEvidence.",
            }
          : undefined;

      const resolved = resolveEngineConfig("delegate", selectedEngine, {
        model: args.model,
        effort: args.effort,
      });
      const effectiveArgs = {
        ...args,
        engine: selectedEngine,
        prompt: effectivePrompt,
        mode,
        cwd: resolvedCwd,
        skipGitRepoCheck,
        ephemeral: false,
        timeoutSec,
        model: resolved.model,
        effort: resolved.effort,
        signal,
      };

      const requestParams =
        mode === "read-only"
          ? {
              prompt: effectivePrompt,
              mode: "read-only",
              sessionId: args.sessionId,
              skipGitRepoCheck,
              timeoutSec,
            }
          : null;

      if (background) {
        const beforeGit =
          mode === "workspace-write"
            ? await captureGitDirtySnapshot(resolvedCwd)
            : null;
        const jobSpec = buildBackgroundDelegateJobSpec({
          engine: selectedEngine,
          mode,
          effectiveArgs,
          resolved,
          jobManager,
          timeoutSec,
          handoffContext: ctx.metadata,
          requestParams,
        });
        const started = jobManager.startJob({ ...jobSpec, beforeGit });
        return {
          ...started,
          ...(sandboxModel ? { sandboxModel } : {}),
          ...(permissionBoundary ? { permissionBoundary } : {}),
          ...(routingDecision ? { routingDecision } : {}),
          ...(ctx.metadata ? { handoffContext: ctx.metadata } : {}),
        };
      }

      const result = await runTrackedForeground(
        jobManager,
        {
          engine: selectedEngine,
          action: "delegate",
          cwd: resolvedCwd,
          model: resolved.model,
          effort: resolved.effort,
          mode,
          handoffContext: ctx.metadata,
          requestParams,
          jsonStream: true,
          onProgress,
        },
        (onEvent) =>
          selectedEngine === "codex"
            ? runCodexExec({ ...effectiveArgs, onEvent })
            : selectedEngine === "agy"
              ? runAgyExec({ ...effectiveArgs, onEvent })
              : runClaudeExec({ ...effectiveArgs, onEvent }),
      );
      return {
        ...result,
        ...(sandboxModel ? { sandboxModel } : {}),
        ...(permissionBoundary ? { permissionBoundary } : {}),
        ...(routingDecision ? { routingDecision } : {}),
        ...(ctx.metadata ? { handoffContext: ctx.metadata } : {}),
      };
    }

    case "handoff_cross_review": {
      const startedAt = Date.now();
      const codexBin = findCodexBinary();
      const claudeBin = findClaudeBinary();
      const agyBin = findAgyBinary();
      const shouldIncludeAgy =
        args.includeAgy !== false &&
        (Boolean(agyBin) ||
          args.includeAgy === true ||
          process.env.AGY_HANDOFF_AGY_BIN !== undefined ||
          (!process.env.AGY_HANDOFF_CODEX_BIN && !process.env.AGY_HANDOFF_CLAUDE_BIN));

      if (!codexBin && !claudeBin && (!shouldIncludeAgy || !agyBin)) {
        throw new Error(
          "Neither `codex`, `claude`, nor `agy` CLI was found in PATH. Run `handoff_doctor` for install instructions.",
        );
      }

      const timeoutSec = validateTimeoutSec(args.timeoutSec);
      const style = args.style || "adversarial";
      const scope = args.scope || "uncommitted";
      const resolvedCwd = validateCwd(args.cwd);
      const ctx = normalizeAndFormatContext(args.context, resolvedCwd);
      const effectivePrompt = args.prompt
        ? `${ctx.promptPrefix}${args.prompt}`
        : ctx.promptPrefix.trim() || undefined;
      const skipGitRepoCheck =
        args.skipGitRepoCheck ?? (scope === "custom" ? !isInsideGitRepo(resolvedCwd) : false);
      const structured = Boolean(args.structured);

      const codexCfg = resolveEngineConfig("cross-review", "codex", {
        model: args.codexModel,
        effort: args.codexEffort,
      });
      const claudeCfg = resolveEngineConfig("cross-review", "claude", {
        model: args.claudeModel,
        effort: args.claudeEffort,
      });
      const agyCfg = resolveEngineConfig("cross-review", "agy", {
        model: args.agyModel,
        effort: args.agyEffort,
      });

      let progressSeq = 0;
      const emitCombinedProgress = (engine, ev) => {
        if (typeof onProgress !== "function") return;
        progressSeq += 1;
        onProgress({
          progress: progressSeq,
          message: `[${engine}] ${ev.summary}`,
        });
      };

      const tasks = [];
      if (codexBin) {
        tasks.push(
          runTrackedForeground(
            jobManager,
            {
              engine: "codex",
              action: "cross-review",
              cwd: resolvedCwd,
              model: codexCfg.model,
              effort: codexCfg.effort,
              mode: "read-only",
              handoffContext: ctx.metadata,
              jsonStream:
                structured ||
                style !== "standard" ||
                Boolean(effectivePrompt) ||
                scope === "custom",
              onProgress: ({ message }) => {
                if (typeof onProgress === "function") {
                  progressSeq += 1;
                  onProgress({ progress: progressSeq, message });
                }
              },
            },
            (onEvent) =>
              runCodexReview({
                style,
                scope,
                base: args.base,
                commit: args.commit,
                prompt: effectivePrompt,
                model: codexCfg.model,
                effort: codexCfg.effort,
                cwd: resolvedCwd,
                skipGitRepoCheck,
                timeoutSec,
                signal,
                outputSchema: structured ? STRUCTURED_REVIEW_SCHEMA : undefined,
                onEvent: (ev) => {
                  onEvent(ev);
                  void emitCombinedProgress;
                },
              }),
          ).catch((err) => ({
            engine: "codex",
            ok: false,
            error: err.message,
          })),
        );
      } else {
        tasks.push(
          Promise.resolve({
            engine: "codex",
            skipped: true,
            reason: "codex CLI not installed",
          }),
        );
      }

      if (claudeBin) {
        tasks.push(
          runTrackedForeground(
            jobManager,
            {
              engine: "claude",
              action: "cross-review",
              cwd: resolvedCwd,
              model: claudeCfg.model,
              effort: claudeCfg.effort,
              mode: "read-only",
              handoffContext: ctx.metadata,
              jsonStream: true,
              onProgress: ({ message }) => {
                if (typeof onProgress === "function") {
                  progressSeq += 1;
                  onProgress({ progress: progressSeq, message });
                }
              },
            },
            (onEvent) =>
              runClaudeReview({
                style,
                scope,
                base: args.base,
                commit: args.commit,
                prompt: effectivePrompt,
                model: claudeCfg.model,
                effort: claudeCfg.effort,
                cwd: resolvedCwd,
                timeoutSec,
                signal,
                jsonSchema: structured ? STRUCTURED_REVIEW_SCHEMA : undefined,
                onEvent,
              }),
          ).catch((err) => ({
            engine: "claude",
            ok: false,
            error: err.message,
          })),
        );
      } else {
        tasks.push(
          Promise.resolve({
            engine: "claude",
            skipped: true,
            reason: "claude CLI not installed",
          }),
        );
      }

      if (shouldIncludeAgy) {
        if (agyBin) {
          tasks.push(
            runTrackedForeground(
              jobManager,
              {
                engine: "agy",
                action: "cross-review",
                cwd: resolvedCwd,
                model: agyCfg.model,
                effort: agyCfg.effort,
                mode: "read-only",
                handoffContext: ctx.metadata,
                jsonStream: true,
                onProgress: ({ message }) => {
                  if (typeof onProgress === "function") {
                    progressSeq += 1;
                    onProgress({ progress: progressSeq, message });
                  }
                },
              },
              (onEvent) =>
                runAgyReview({
                  style,
                  scope,
                  base: args.base,
                  commit: args.commit,
                  prompt: effectivePrompt,
                  model: agyCfg.model,
                  effort: agyCfg.effort,
                  cwd: resolvedCwd,
                  timeoutSec,
                  signal,
                  jsonSchema: structured ? STRUCTURED_REVIEW_SCHEMA : undefined,
                  onEvent,
                }),
            ).catch((err) => ({
              engine: "agy",
              ok: false,
              error: err.message,
            })),
          );
        } else {
          tasks.push(
            Promise.resolve({
              engine: "agy",
              skipped: true,
              reason: "agy CLI not installed",
            }),
          );
        }
      }

      const [codexResult, claudeResult, agyResult = null] = await Promise.all(tasks);
      const allResults = shouldIncludeAgy
        ? [codexResult, claudeResult, agyResult]
        : [codexResult, claudeResult];
      const enginesAttempted = allResults.filter((r) => r && !r.skipped).length;
      const enginesSucceeded = allResults.filter((r) => r && !r.skipped && r.ok).length;
      const enginesFailed = allResults.filter((r) => r && !r.skipped && !r.ok).length;
      const enginesSkipped = allResults.filter((r) => r && r.skipped).length;
      const ok = enginesSucceeded > 0;

      let structuredSynthesis;
      if (structured) {
        try {
          structuredSynthesis = synthesizeStructuredCrossReview({
            codexOutput:
              !codexResult.skipped && codexResult.ok ? codexResult.output : "",
            codexStructured:
              !codexResult.skipped && codexResult.ok
                ? codexResult.structuredOutput || null
                : null,
            codexStatus: codexResult,
            claudeOutput:
              !claudeResult.skipped && claudeResult.ok ? claudeResult.output : "",
            claudeStructured:
              !claudeResult.skipped && claudeResult.ok
                ? claudeResult.structuredOutput || null
                : null,
            claudeStatus: claudeResult,
            ...(shouldIncludeAgy
              ? {
                  agyOutput:
                    !agyResult.skipped && agyResult.ok ? agyResult.output : "",
                  agyStructured:
                    !agyResult.skipped && agyResult.ok
                      ? agyResult.structuredOutput || null
                      : null,
                  agyStatus: agyResult,
                }
              : {}),
            cwd: resolvedCwd,
          });
        } catch (err) {
          structuredSynthesis = {
            summaries: {
              codex: null,
              claude: null,
              ...(shouldIncludeAgy ? { agy: null } : {}),
            },
            consensus: [],
            conflicts: [],
            uniqueCodex: [],
            uniqueClaude: [],
            ...(shouldIncludeAgy ? { uniqueAgy: [] } : {}),
            parseErrors: {
              codex: err.message,
              claude: err.message,
              ...(shouldIncludeAgy ? { agy: err.message } : {}),
            },
            citationSummary: {
              totalFindings: 0,
              validCitations: 0,
              fileOnlyCitations: 0,
              invalidOrMissingCitations: 0,
              error: err.message,
            },
          };
        }
      }

      return {
        ok,
        architecture: shouldIncludeAgy ? "3-to-1" : "2-to-1",
        synthesizer: "current_session_model",
        style,
        scope,
        ...(ctx.metadata ? { handoffContext: ctx.metadata } : {}),
        summary: {
          totalDurationMs: Date.now() - startedAt,
          enginesAttempted,
          enginesSucceeded,
          enginesFailed,
          enginesSkipped,
        },
        resolvedModels: {
          codex: codexCfg,
          claude: claudeCfg,
          ...(shouldIncludeAgy ? { agy: agyCfg } : {}),
        },
        ...(structuredSynthesis ? { structuredSynthesis } : {}),
        results: {
          codex: codexResult,
          claude: claudeResult,
          ...(shouldIncludeAgy ? { agy: agyResult } : {}),
        },
      };
    }

    case "handoff_config": {
      return updateConfig(args);
    }

    case "handoff_job_status": {
      if (args.jobId) {
        return jobManager.waitForStatus(args.jobId, {
          waitSec: args.waitSec || 0,
          sinceSeq: args.sinceSeq || 0,
          eventsLimit: args.eventsLimit || 10,
        });
      }
      const jobs = jobManager.listJobs(args.limit || 20);
      return args.includeStats
        ? { jobs, stats: jobManager.getStats({ limit: 100 }) }
        : { jobs };
    }

    case "handoff_job_result": {
      return jobManager.getResult(args.jobId);
    }

    case "handoff_job_cancel": {
      return jobManager.cancelJob(args.jobId);
    }

    case "handoff_job_retry": {
      const timeoutSec = validateTimeoutSec(args.timeoutSec);
      const fallbackEngine = Boolean(args.fallbackEngine);
      const meta = jobManager.readMeta(args.jobId);
      if (!meta) {
        throw new Error(`Job not found: ${args.jobId}`);
      }
      if (meta.status === "running" || jobManager.activeChildren.has(args.jobId)) {
        throw new Error(`Job is still running: ${args.jobId}`);
      }
      const effectiveMode = meta.mode ?? "unknown";
      if (effectiveMode !== "read-only") {
        throw new Error(
          `Refusing to retry non-read-only job "${args.jobId}" (mode=${effectiveMode}). Only read-only jobs can be safely replayed.`,
        );
      }
      if (!meta.retryable || !meta.replaySpec?.requestParams) {
        throw new Error(
          `Job "${args.jobId}" is not retryable (prompt exceeded 64 KB, used '--last', or lacked bounded request metadata).`,
        );
      }

      const req = meta.replaySpec.requestParams;
      if (req.sessionId === "last") {
        throw new Error(
          `Refusing to retry job "${args.jobId}": '--last' session target can drift across concurrent runs.`,
        );
      }
      if (fallbackEngine && req.sessionId) {
        throw new Error(
          `Cannot use fallbackEngine=true when retrying session-resumed job "${args.jobId}".`,
        );
      }

      const targetEngine = fallbackEngine
        ? meta.engine === "codex"
          ? "claude"
          : "codex"
        : meta.engine;
      const targetCmd = meta.action === "review" ? "review" : "delegate";
      const resolved = resolveEngineConfig(targetCmd, targetEngine);
      const resolvedCwd = validateCwd(meta.cwd);
      const effTimeoutSec = timeoutSec ?? req.timeoutSec;
      const isStructured = Boolean(req.structured ?? meta.structured);

      const overrideSpec =
        targetCmd === "review"
          ? buildBackgroundReviewJobSpec({
              engine: targetEngine,
              effectiveArgs: {
                ...req,
                structured: isStructured,
                cwd: resolvedCwd,
                model: resolved.model,
                effort: resolved.effort,
                ...(isStructured
                  ? targetEngine === "codex"
                    ? { outputSchema: STRUCTURED_REVIEW_SCHEMA }
                    : { jsonSchema: STRUCTURED_REVIEW_SCHEMA }
                  : {}),
              },
              resolved,
              jobManager,
              timeoutSec: effTimeoutSec,
              handoffContext: meta.handoffContext || null,
              retryOf: meta.id,
              requestParams: { ...req, structured: isStructured },
            })
          : buildBackgroundDelegateJobSpec({
              engine: targetEngine,
              mode: "read-only",
              effectiveArgs: {
                ...req,
                cwd: resolvedCwd,
                mode: "read-only",
                ephemeral: false,
                model: resolved.model,
                effort: resolved.effort,
              },
              resolved,
              jobManager,
              timeoutSec: effTimeoutSec,
              handoffContext: meta.handoffContext || null,
              retryOf: meta.id,
              requestParams: req,
            });

      return jobManager.retryJob(args.jobId, {
        overrideSpec,
        timeoutMs: effTimeoutSec ? effTimeoutSec * 1000 : null,
      });
    }

    case "handoff_plan": {
      const startedAt = Date.now();
      const codexBin = findCodexBinary();
      const claudeBin = findClaudeBinary();
      const agyBin = findAgyBinary();
      const shouldIncludeAgy =
        args.includeAgy !== false &&
        (Boolean(agyBin) ||
          args.includeAgy === true ||
          process.env.AGY_HANDOFF_AGY_BIN !== undefined ||
          (!process.env.AGY_HANDOFF_CODEX_BIN && !process.env.AGY_HANDOFF_CLAUDE_BIN));

      if (!codexBin && !claudeBin && (!shouldIncludeAgy || !agyBin)) {
        throw new Error(
          "Neither `codex`, `claude`, nor `agy` CLI was found in PATH. Run `handoff_doctor` for install instructions.",
        );
      }

      const timeoutSec = validateTimeoutSec(args.timeoutSec);
      const phase = args.phase || "design";
      const structured = args.structured !== false;
      const resolvedCwd = validateCwd(args.cwd);
      const ctx = normalizeAndFormatContext(args.context, resolvedCwd);
      const skipGitRepoCheck =
        args.skipGitRepoCheck ?? !isInsideGitRepo(resolvedCwd);

      const composedPrompt = buildCollaborativePlanPrompt({
        goal: args.goal,
        phase,
        decisions: args.decisions,
        requirements: args.requirements,
        nonGoals: args.nonGoals,
        constraints: args.constraints,
        acceptanceCriteria: args.acceptanceCriteria,
        promptPrefix: ctx.promptPrefix,
        structured,
      });

      const codexCfg = resolveEngineConfig("plan", "codex", {
        model: args.codexModel,
        effort: args.codexEffort,
      });
      const claudeCfg = resolveEngineConfig("plan", "claude", {
        model: args.claudeModel,
        effort: args.claudeEffort,
      });
      const agyCfg = resolveEngineConfig("plan", "agy", {
        model: args.agyModel,
        effort: args.agyEffort,
      });

      let progressSeq = 0;
      const tasks = [];

      if (codexBin) {
        tasks.push(
          runTrackedForeground(
            jobManager,
            {
              engine: "codex",
              action: "plan",
              cwd: resolvedCwd,
              model: codexCfg.model,
              effort: codexCfg.effort,
              mode: "read-only",
              structured,
              handoffContext: ctx.metadata,
              jsonStream: true,
              onProgress: ({ message }) => {
                if (typeof onProgress === "function") {
                  progressSeq += 1;
                  onProgress({ progress: progressSeq, message });
                }
              },
            },
            (onEvent) =>
              runCodexExec({
                prompt: composedPrompt,
                mode: "read-only",
                model: codexCfg.model,
                effort: codexCfg.effort,
                cwd: resolvedCwd,
                skipGitRepoCheck,
                ephemeral: true,
                timeoutSec,
                signal,
                outputSchema: structured ? STRUCTURED_PLAN_SCHEMA : undefined,
                onEvent,
              }),
          ).catch((err) => ({
            engine: "codex",
            ok: false,
            error: err.message,
          })),
        );
      } else {
        tasks.push(
          Promise.resolve({
            engine: "codex",
            skipped: true,
            reason: "codex CLI not installed",
          }),
        );
      }

      if (claudeBin) {
        tasks.push(
          runTrackedForeground(
            jobManager,
            {
              engine: "claude",
              action: "plan",
              cwd: resolvedCwd,
              model: claudeCfg.model,
              effort: claudeCfg.effort,
              mode: "read-only",
              structured,
              handoffContext: ctx.metadata,
              jsonStream: true,
              onProgress: ({ message }) => {
                if (typeof onProgress === "function") {
                  progressSeq += 1;
                  onProgress({ progress: progressSeq, message });
                }
              },
            },
            (onEvent) =>
              runClaudeExec({
                prompt: composedPrompt,
                mode: "read-only",
                model: claudeCfg.model,
                effort: claudeCfg.effort,
                cwd: resolvedCwd,
                ephemeral: true,
                timeoutSec,
                signal,
                jsonSchema: structured ? STRUCTURED_PLAN_SCHEMA : undefined,
                onEvent,
              }),
          ).catch((err) => ({
            engine: "claude",
            ok: false,
            error: err.message,
          })),
        );
      } else {
        tasks.push(
          Promise.resolve({
            engine: "claude",
            skipped: true,
            reason: "claude CLI not installed",
          }),
        );
      }

      if (shouldIncludeAgy) {
        if (agyBin) {
          tasks.push(
            runTrackedForeground(
              jobManager,
              {
                engine: "agy",
                action: "plan",
                cwd: resolvedCwd,
                model: agyCfg.model,
                effort: agyCfg.effort,
                mode: "read-only",
                structured,
                handoffContext: ctx.metadata,
                jsonStream: true,
                onProgress: ({ message }) => {
                  if (typeof onProgress === "function") {
                    progressSeq += 1;
                    onProgress({ progress: progressSeq, message });
                  }
                },
              },
              (onEvent) =>
                runAgyExec({
                  prompt: composedPrompt,
                  mode: "read-only",
                  model: agyCfg.model,
                  effort: agyCfg.effort,
                  cwd: resolvedCwd,
                  timeoutSec,
                  signal,
                  jsonSchema: structured ? STRUCTURED_PLAN_SCHEMA : undefined,
                  onEvent,
                }),
            ).catch((err) => ({
              engine: "agy",
              ok: false,
              error: err.message,
            })),
          );
        } else {
          tasks.push(
            Promise.resolve({
              engine: "agy",
              skipped: true,
              reason: "agy CLI not installed",
            }),
          );
        }
      }

      const [codexResult, claudeResult, agyResult = null] = await Promise.all(tasks);
      const allResults = shouldIncludeAgy
        ? [codexResult, claudeResult, agyResult]
        : [codexResult, claudeResult];
      const enginesAttempted = allResults.filter((r) => r && !r.skipped).length;
      const enginesSucceeded = allResults.filter((r) => r && !r.skipped && r.ok).length;
      const enginesFailed = allResults.filter((r) => r && !r.skipped && !r.ok).length;
      const enginesSkipped = allResults.filter((r) => r && r.skipped).length;
      const ok = enginesSucceeded > 0;

      let structuredPlan;
      if (structured) {
        try {
          structuredPlan = synthesizeCollaborativePlan({
            codexOutput:
              !codexResult.skipped && codexResult.ok ? codexResult.output : "",
            codexStructured:
              !codexResult.skipped && codexResult.ok
                ? codexResult.structuredOutput || null
                : null,
            codexStatus: codexResult,
            claudeOutput:
              !claudeResult.skipped && claudeResult.ok ? claudeResult.output : "",
            claudeStructured:
              !claudeResult.skipped && claudeResult.ok
                ? claudeResult.structuredOutput || null
                : null,
            claudeStatus: claudeResult,
            ...(shouldIncludeAgy
              ? {
                  agyOutput:
                    !agyResult.skipped && agyResult.ok ? agyResult.output : "",
                  agyStructured:
                    !agyResult.skipped && agyResult.ok
                      ? agyResult.structuredOutput || null
                      : null,
                  agyStatus: agyResult,
                }
              : {}),
            cwd: resolvedCwd,
          });
        } catch (err) {
          structuredPlan = {
            error: err.message,
          };
        }
      }

      return {
        ok,
        architecture: shouldIncludeAgy ? "3-to-1" : "2-to-1",
        synthesizer: "current_session_model",
        phase,
        goal: args.goal,
        ...(ctx.metadata ? { handoffContext: ctx.metadata } : {}),
        summary: {
          totalDurationMs: Date.now() - startedAt,
          enginesAttempted,
          enginesSucceeded,
          enginesFailed,
          enginesSkipped,
        },
        resolvedModels: {
          codex: codexCfg,
          claude: claudeCfg,
          ...(shouldIncludeAgy ? { agy: agyCfg } : {}),
        },
        ...(structuredPlan ? { structuredPlan } : {}),
        results: {
          codex: codexResult,
          claude: claudeResult,
          ...(shouldIncludeAgy ? { agy: agyResult } : {}),
        },
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function createJsonRpcHandler(
  jobManager = new JobManager(),
  { emitNotification } = {},
) {
  const inFlight = new Map();

  async function handleSingleMessage(msg) {
    if (!isPlainObject(msg) || msg.jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    const { id, method, params } = msg;

    // Client response envelope (has result/error without method) requires no reply.
    if (typeof method !== "string") {
      if ("result" in msg || "error" in msg) {
        return null;
      }
      return {
        jsonrpc: "2.0",
        id:
          typeof id === "string" || (typeof id === "number" && Number.isFinite(id))
            ? id
            : null,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    // Notifications (no id property) require no response.
    if (!Object.prototype.hasOwnProperty.call(msg, "id") || id === undefined) {
      if (method === "notifications/cancelled") {
        const targetId = params?.requestId;
        const controller = inFlight.get(targetId);
        if (controller) {
          controller.abort(params?.reason || "Client cancelled request");
        }
      }
      return null;
    }

    if (
      id === null ||
      (typeof id !== "string" && (typeof id !== "number" || !Number.isFinite(id)))
    ) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    try {
      switch (method) {
        case "initialize": {
          const requested = params?.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion,
              capabilities: {
                tools: {},
              },
              serverInfo: SERVER_INFO,
            },
          };
        }

        case "ping": {
          return { jsonrpc: "2.0", id, result: {} };
        }

        case "tools/list": {
          return {
            jsonrpc: "2.0",
            id,
            result: { tools: TOOLS },
          };
        }

        case "tools/call": {
          const toolName = params?.name;
          const toolArgs = params?.arguments === undefined ? {} : params.arguments;
          const rawToken = params?._meta?.progressToken;
          const hasProgressToken =
            typeof rawToken === "string" ||
            (typeof rawToken === "number" && Number.isFinite(rawToken));
          const onProgress =
            hasProgressToken && typeof emitNotification === "function"
              ? ({ progress, message }) => {
                  emitNotification({
                    jsonrpc: "2.0",
                    method: "notifications/progress",
                    params: {
                      progressToken: rawToken,
                      progress,
                      message,
                    },
                  });
                }
              : undefined;

          const controller = new AbortController();
          inFlight.set(id, controller);
          try {
            const data = await handleToolCall(toolName, toolArgs, jobManager, {
              signal: controller.signal,
              onProgress,
            });
            if (controller.signal.aborted) {
              return {
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: "Request canceled." }],
                  isError: true,
                },
              };
            }
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(data, null, 2),
                  },
                ],
                isError: data?.ok === false,
              },
            };
          } catch (err) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `Error: ${err.message}`,
                  },
                ],
                isError: true,
              },
            };
          } finally {
            inFlight.delete(id);
          }
        }

        default:
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
      }
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err.message || "Internal error",
        },
      };
    }
  }

  return async function handleMessage(msg) {
    if (Array.isArray(msg)) {
      if (msg.length === 0) {
        return {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request" },
        };
      }
      const results = await Promise.all(msg.map((item) => handleSingleMessage(item)));
      const filtered = results.filter((r) => r !== null);
      return filtered.length > 0 ? filtered : null;
    }
    return handleSingleMessage(msg);
  };
}

function startStdioServer() {
  const jobManager = new JobManager();
  let buffer = "";
  let pending = 0;

  process.stdout.on("error", () => {});

  const writeResponse = (payload) => {
    if (!process.stdout.destroyed) {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    }
  };

  const handleMessage = createJsonRpcHandler(jobManager, {
    emitNotification: writeResponse,
  });

  const dispatchLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    pending += 1;
    Promise.resolve(handleMessage(parsed))
      .then((response) => {
        if (response) {
          writeResponse(response);
        }
      })
      .catch((err) => {
        writeResponse({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: err?.message || "Internal error" },
        });
      })
      .finally(() => {
        pending -= 1;
      });
  };

  const shutdown = () => {
    jobManager.shutdown();
    terminateAllForegroundCommands();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      dispatchLine(line);
    }
  });

  process.stdin.on("end", () => {
    if (buffer.trim()) {
      dispatchLine(buffer);
      buffer = "";
    }
  });
}

// Run stdio server only when executed directly.
function isDirectExecution() {
  if (!process.argv[1]) return false;
  let entryPath;
  try {
    entryPath = fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    entryPath = path.resolve(process.argv[1]);
  }
  const entryUrl = pathToFileURL(entryPath).href;
  if (process.platform === "win32") {
    return import.meta.url.toLowerCase() === entryUrl.toLowerCase();
  }
  return import.meta.url === entryUrl;
}

if (isDirectExecution()) {
  startStdioServer();
}
