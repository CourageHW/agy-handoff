#!/usr/bin/env node
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JobManager } from "./jobs.mjs";
import {
  getEffectiveConfigSummary,
  loadConfig,
  resolveEngineConfig,
  updateConfig,
  VALID_ENGINES,
} from "./config.mjs";
import {
  buildDelegationPrompt,
  captureGitDirtySnapshot,
  capturePlanWorkspaceSnapshot,
  captureReviewDiffSnapshot,
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
import { ENGINES } from "./engines.mjs";
import { DEFAULT_EXTERNAL_AGENTS, resolveHarness, selectGroupEngines, SYNTHESIZER } from "./harness.mjs";
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
} from "./runners/codex.mjs";
import {
  WORKSPACE_WRITE_DISALLOWED_TOOLS,
  buildClaudeExecSpec,
  buildClaudeReviewSpec,
  findClaudeBinary,
  inspectClaude,
} from "./runners/claude.mjs";
import {
  buildAgyExecSpec,
  buildAgyReviewSpec,
  findAgyBinary,
  inspectAgy,
} from "./runners/agy.mjs";

const SERVER_INFO = {
  name: "agy-handoff",
  version: "0.2.1",
};

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"];

const GROUP_ENGINES_SCHEMA = {
  type: "array",
  items: { type: "string", enum: VALID_ENGINES },
  minItems: 1,
  uniqueItems: true,
  description: "Optional reviewer/planner list. Can include the current harness's CLI. Omit to use the host defaults.",
};

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
      "Check local engine availability, supported flags, authentication hints, and the current host defaults.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "handoff_review",
    description:
      "Run a read-only code review using an external CLI (or engine: 'auto'). Supports standard or adversarial review styles, uncommitted/base/commit/custom scopes, scoped context, and structured JSON output.",
    inputSchema: {
      type: "object",
      properties: {
        engine: {
          type: "string",
          enum: ["codex", "claude", "agy", "auto"],
          default: "auto",
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
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "handoff_delegate",
    description:
      "Delegate an investigation, debugging, or coding task to an external CLI (or engine: 'auto'). Defaults to read-only mode for safety.",
    inputSchema: {
      type: "object",
      properties: {
        engine: {
          type: "string",
          enum: ["codex", "claude", "agy", "auto"],
          default: "auto",
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
        confirmWorkspaceWrite: {
          type: "boolean",
          description: "Set only after explicit user authorization for this external CLI to write. Required by Claude Code and Codex integrations.",
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
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "handoff_cross_review",
    description:
      "Run independent external reviewers in parallel. Defaults to the host roster and returns per-engine results, including skipped or failed reviewers.",
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
            "Request structured findings from the selected engines and attach consensus, conflicts, unique findings, and mechanical citation checks.",
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
        engines: GROUP_ENGINES_SCHEMA,
        includeAgy: {
          type: "boolean",
          description:
            "Legacy roster flag: true for Codex, Claude and Antigravity, false for Codex and Claude. Prefer engines.",
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
            "Optional routing preferences: { policy: 'balanced'|'prefer-codex'|'prefer-claude'|'prefer-agy'|'least-used', taskTypes: { review|debugging|implementation|architecture|general: 'codex'|'claude'|'agy'|'auto'|null } }.",
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
          description: "Use an available alternate external CLI for this host on retry.",
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
            "'discover' scans the codebase in read-only mode to surface high-leverage design-tree questions for a Grill-Me interview; 'design' (default) synthesizes a collaborative implementation plan from confirmed spec decisions.",
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
            "Request structured JSON plan blueprints from the selected engines and synthesize consensus file targets, disk verification, merged risks, and test strategy.",
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
        engines: GROUP_ENGINES_SCHEMA,
        includeAgy: {
          type: "boolean",
          description:
            "Legacy roster flag: true for Codex, Claude and Antigravity, false for Codex and Claude. Prefer engines.",
        },
        allowWebSearch: {
          type: "boolean",
          default: false,
          description:
            "Allow Codex to perform external web searches during planning (disabled by default to keep planning fast and grounded in local repo files/specs).",
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

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

function getHeartbeatIntervalMs() {
  const raw = process.env.AGY_HANDOFF_HEARTBEAT_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_HEARTBEAT_INTERVAL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_HEARTBEAT_INTERVAL_MS;
  }
  return parsed;
}

function formatHeartbeatElapsed(ms) {
  const totalSec = Math.max(1, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function isNestedHandoffSession() {
  return process.env.AGY_HANDOFF_NESTED === "1";
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

  const startedAt = Date.now();
  let lastEventAt = startedAt;
  let nextSeq = 0;
  let lastMeaningfulActivity = "Starting...";

  const emitTrackedEvent = (ev, { recordEvidence = true } = {}) => {
    nextSeq += 1;
    const normalizedEv = {
      ...ev,
      ts: ev.ts || new Date().toISOString(),
      seq: nextSeq,
      engine: ev.engine || engine,
    };
    lastEventAt = Date.now();
    if (normalizedEv.kind !== "heartbeat" && normalizedEv.summary) {
      lastMeaningfulActivity = normalizedEv.summary;
    }
    if (recordEvidence) {
      evidenceTracker.recordEvent(normalizedEv);
    }
    tracker.recordEvent(normalizedEv);
    if (typeof onProgress === "function") {
      try {
        onProgress({
          progress: normalizedEv.seq,
          message: `[${normalizedEv.engine}] ${normalizedEv.summary}`,
        });
      } catch {
        // ignore progress emission error
      }
    }
  };

  const handleEvent = (ev) => {
    emitTrackedEvent(ev, { recordEvidence: true });
  };

  const heartbeatIntervalMs = getHeartbeatIntervalMs();
  const heartbeatTimer =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          const now = Date.now();
          if (now - lastEventAt < heartbeatIntervalMs) {
            return;
          }
          emitTrackedEvent(
            {
              engine,
              kind: "heartbeat",
              summary: `Still running (${formatHeartbeatElapsed(now - startedAt)} elapsed) — last: ${lastMeaningfulActivity}`,
            },
            { recordEvidence: false },
          );
        }, Math.min(heartbeatIntervalMs, 5000))
      : null;
  if (heartbeatTimer) {
    heartbeatTimer.unref();
  }

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
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
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
    const spec = buildAgyReviewSpec({ ...effectiveArgs, timeoutSec });
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
    const spec = buildAgyExecSpec({ ...effectiveArgs, timeoutSec });
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

const EXECUTION_TOOLS = new Set([
  "handoff_review", "handoff_delegate", "handoff_cross_review", "handoff_plan", "handoff_job_retry",
]);
const activeRequests = new WeakMap();

function executionKey(name, host, args, legacyGroup) {
  const { background, timeoutSec, confirmWorkspaceWrite, ...request } = args;
  if (name !== "handoff_job_retry") request.cwd = validateCwd(args.cwd);
  if (name === "handoff_review" || name === "handoff_delegate") {
    request.engine ??= "auto";
  }
  if (name === "handoff_delegate") {
    request.mode ??= "read-only";
  }
  if (name === "handoff_cross_review" || name === "handoff_plan") {
    request.engines = [...groupEngines(host, args, legacyGroup)].sort();
    delete request.includeAgy;
  }
  return createHash("sha256").update(JSON.stringify([name, host, request], (_key, value) =>
    isPlainObject(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  )).digest("hex");
}

export async function handleToolCall(name, rawArgs = {}, jobManager, context = {}) {
  if (isNestedHandoffSession()) {
    throw new Error("Recursive agy-handoff tool calls are disabled inside nested handoff child sessions.");
  }
  const args = validateToolArgs(name, rawArgs);
  context ??= {};
  const host = resolveHarness(context.host);
  const manager = jobManager ?? new JobManager();
  if (!EXECUTION_TOOLS.has(name)) return dispatchTool(name, args, manager, { ...context, host });

  // The same MCP session can receive concurrent calls with distinct JSON-RPC IDs.
  let requests = activeRequests.get(manager);
  if (!requests) {
    requests = new Map();
    activeRequests.set(manager, requests);
  }
  const key = executionKey(name, host, args, context.legacyGroup);
  if (requests.has(key)) {
    const jobId = requests.get(key);
    const hint = jobId ? ` Check handoff_job_status with jobId "${jobId}".` : " Wait for its result.";
    throw new Error(`An identical handoff is already running.${hint}`);
  }

  requests.set(key, null);
  let child;
  try {
    const result = await dispatchTool(name, args, manager, { ...context, host });
    child = result?.status === "running" && manager.activeChildren.get(result.jobId);
    if (child) {
      requests.set(key, result.jobId);
      child.once("close", () => requests.delete(key));
    }
    return result;
  } finally {
    if (!child) requests.delete(key);
  }
}

function failureDetails(result) {
  if (result.ok) return {};
  const message = [...new Set([result.error, result.stderr, result.output].filter(Boolean))].join("\n");
  if (result.timedOut) return { failureReason: "timeout", error: "CLI timed out. Narrow the scope or increase timeoutSec." };
  if (result.aborted) return { failureReason: "canceled", error: "CLI request canceled." };
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate.limit|usage limit/i.test(message)) {
    return { failureReason: "quota", error: message.trim() || "Model quota exhausted." };
  }
  return { failureReason: "cli_error", error: message.trim() || "CLI failed. Run handoff_doctor and inspect the job logs." };
}

function groupEngines(host, args = {}, legacyGroup = false) {
  return selectGroupEngines(legacyGroup ? null : host, args);
}

async function runGroup(jobManager, {
  action, host, args, context, cwd, structured, handoffContext, runnerArgs,
}) {
  const requestedEngines = groupEngines(host, args, context.legacyGroup);
  const startedAt = Date.now();
  const review = action === "cross-review";
  const schema = review ? STRUCTURED_REVIEW_SCHEMA : STRUCTURED_PLAN_SCHEMA;
  const resolvedModels = Object.fromEntries(requestedEngines.map((engine) => [
    engine,
    resolveEngineConfig(action, engine, { model: args[`${engine}Model`], effort: args[`${engine}Effort`] }),
  ]));
  let progressSeq = 0;
  const results = Object.fromEntries(await Promise.all(requestedEngines.map(async (engine) => {
    const adapter = ENGINES[engine];
    if (!adapter.find()) {
      return [engine, { engine, skipped: true, reason: `${engine} CLI not installed or disabled. Run handoff_doctor for setup.` }];
    }
    const { model, effort } = resolvedModels[engine];
    const codexNative = engine === "codex" && review && !structured &&
      runnerArgs.style === "standard" && !runnerArgs.prompt && runnerArgs.scope !== "custom";
    try {
      const result = await runTrackedForeground(jobManager, {
        engine, action, cwd, model, effort, structured, handoffContext,
        jsonStream: !codexNative,
        onProgress: ({ message }) => context.onProgress?.({ progress: ++progressSeq, message }),
      }, (onEvent) => adapter[review ? "review" : "delegate"]({
        ...runnerArgs,
        model, effort, cwd, signal: context.signal, onEvent,
        ...(structured ? { [adapter.schemaOption]: schema } : {}),
      }));
      return [engine, { ...result, ...failureDetails(result) }];
    } catch (err) {
      return [engine, { engine, ok: false, ...failureDetails({ error: err.message }) }];
    }
  })));
  const successfulEngines = requestedEngines.filter((engine) => results[engine].ok);
  const enginesSkipped = requestedEngines.filter((engine) => results[engine].skipped).length;
  const enginesAttempted = requestedEngines.length - enginesSkipped;
  const enginesSucceeded = successfulEngines.length;
  const synthesis = structured
    ? (review ? synthesizeStructuredCrossReview : synthesizeCollaborativePlan)({ results, cwd })
    : null;
  const participatingEngines = synthesis?.participatingEngines ?? successfulEngines;
  const ok = participatingEngines.length > 0;
  const error = enginesSucceeded > 0
    ? "No selected CLI produced valid structured results. See the structured parse errors."
    : "No selected CLI succeeded. See per-engine results and run handoff_doctor.";
  return {
    ok,
    partial: participatingEngines.length < requestedEngines.length,
    architecture: `${participatingEngines.length}-to-1`,
    synthesizer: SYNTHESIZER,
    synthesizerHost: host,
    requestedEngines,
    participatingEngines,
    ...(ok ? {} : { error }),
    ...(handoffContext ? { handoffContext } : {}),
    summary: {
      totalDurationMs: Date.now() - startedAt,
      enginesAttempted,
      enginesSucceeded,
      enginesFailed: enginesAttempted - enginesSucceeded,
      enginesSkipped,
    },
    resolvedModels,
    ...(synthesis ? { [review ? "structuredSynthesis" : "structuredPlan"]: synthesis } : {}),
    results,
  };
}

async function dispatchTool(name, args, jobManager, context) {
  const { signal, onProgress, host } = context;

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
        host,
        defaultExternalAgents: DEFAULT_EXTERNAL_AGENTS[host ?? "antigravity"],
        defaultGroupEngines: groupEngines(host, {}, context.legacyGroup),
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
      const ctx = normalizeAndFormatContext(args.context, resolvedCwd, {
        inlineFiles: true,
      });
      const basePrompt = args.prompt
        ? `${ctx.promptPrefix}${args.prompt}`
        : ctx.promptPrefix.trim() || undefined;
      const skipGitRepoCheck =
        args.skipGitRepoCheck ?? (scope === "custom" ? !isInsideGitRepo(resolvedCwd) : false);

      let selectedEngine = args.engine ?? "auto";
      let routingDecision = null;
      if (selectedEngine === "auto") {
        const routed = await resolveAutoEngine({
          taskType: args.taskType || "review",
          mode: "read-only",
          effort: args.effort,
          model: args.model,
          config: loadConfig(),
          candidates: DEFAULT_EXTERNAL_AGENTS[host ?? "antigravity"],
          jobManager,
        });
        selectedEngine = routed.selectedEngine;
        routingDecision = routed.routingDecision;
      }

      const resolved = resolveEngineConfig("review", selectedEngine, {
        model: args.model,
        effort: args.effort,
      });
      const usesCodexNative =
        selectedEngine === "codex" &&
        (args.style || "standard") === "standard" &&
        !basePrompt &&
        !args.structured &&
        (scope === "uncommitted" || scope === "base" || scope === "commit");
      const diffSnapshot = usesCodexNative
        ? ""
        : await captureReviewDiffSnapshot({
            cwd: resolvedCwd,
            scope,
            base: args.base,
            commit: args.commit,
          });
      const effectivePrompt =
        diffSnapshot || basePrompt
          ? `${diffSnapshot}${basePrompt || ""}`.trim() || undefined
          : undefined;
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
        (onEvent) => ENGINES[selectedEngine].review({ ...effectiveArgs, onEvent }),
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
        ...failureDetails(result),
        ...(structuredReview ? { structuredReview } : {}),
        ...(routingDecision ? { routingDecision } : {}),
        ...(ctx.metadata ? { handoffContext: ctx.metadata } : {}),
      };
    }

    case "handoff_delegate": {
      const { background = false } = args;
      const mode = args.mode || "read-only";
      if (mode === "workspace-write" && (host === "claude" || host === "codex")) {
        if (args.confirmWorkspaceWrite !== true) {
          throw new Error("Workspace-write requires explicit user approval. Set confirmWorkspaceWrite only after the user approves external edits.");
        }
        if (!args.cwd) throw new Error("Pass the explicitly approved workspace directory as cwd.");
      }
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
      const ctx = normalizeAndFormatContext(args.context, resolvedCwd, {
        inlineFiles: true,
      });
      const effectivePrompt = buildDelegationPrompt({
        prompt: args.prompt,
        taskType: args.taskType || "general",
        mode,
        promptPrefix: ctx.promptPrefix,
        isResume: Boolean(args.sessionId),
      });
      const skipGitRepoCheck =
        args.skipGitRepoCheck ?? !isInsideGitRepo(resolvedCwd);

      let selectedEngine = args.engine ?? "auto";
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
          candidates: DEFAULT_EXTERNAL_AGENTS[host ?? "antigravity"],
          jobManager,
        });
        selectedEngine = routed.selectedEngine;
        routingDecision = routed.routingDecision;
      }

      const unsandboxedWrite = ENGINES[selectedEngine].unsandboxedWrite === true;
      const sandboxModel = mode === "workspace-write"
        ? unsandboxedWrite
          ? "restricted-file-tools + acceptEdits + unsandboxed-bash"
          : selectedEngine === "agy" ? "agy --sandbox --mode accept-edits" : "os-sandbox (workspace-write)"
        : undefined;
      const permissionBoundary = sandboxModel ? {
        mode,
        engine: selectedEngine,
        requiresExplicitUserApproval: true,
        osSandboxed: selectedEngine === "codex",
        sandboxModel,
        disallowedCommands: unsandboxedWrite ? WORKSPACE_WRITE_DISALLOWED_TOOLS.split(",") : [],
        warning: unsandboxedWrite
          ? "Claude file tools are confined to cwd via --restricted. Bash runs without an OS filesystem/network sandbox."
          : "Confirm observed workspaceGitDelta and executionEvidence after edits.",
      } : undefined;

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
        (onEvent) => ENGINES[selectedEngine].delegate({ ...effectiveArgs, onEvent }),
      );
      return {
        ...result,
        ...failureDetails(result),
        ...(sandboxModel ? { sandboxModel } : {}),
        ...(permissionBoundary ? { permissionBoundary } : {}),
        ...(routingDecision ? { routingDecision } : {}),
        ...(ctx.metadata ? { handoffContext: ctx.metadata } : {}),
      };
    }

    case "handoff_cross_review": {
      const timeoutSec = validateTimeoutSec(args.timeoutSec);
      const style = args.style || "adversarial";
      const scope = args.scope || "uncommitted";
      const resolvedCwd = validateCwd(args.cwd);
      const ctx = normalizeAndFormatContext(args.context, resolvedCwd, {
        inlineFiles: true,
      });
      const diffSnapshot = await captureReviewDiffSnapshot({
        cwd: resolvedCwd,
        scope,
        base: args.base,
        commit: args.commit,
      });
      const basePrompt = args.prompt
        ? `${ctx.promptPrefix}${args.prompt}`
        : ctx.promptPrefix.trim() || undefined;
      const effectivePrompt =
        diffSnapshot || basePrompt
          ? `${diffSnapshot}${basePrompt || ""}`.trim() || undefined
          : undefined;
      const skipGitRepoCheck =
        args.skipGitRepoCheck ?? (scope === "custom" ? !isInsideGitRepo(resolvedCwd) : false);
      const structured = Boolean(args.structured);

      const group = await runGroup(jobManager, {
        action: "cross-review", host, args, context, cwd: resolvedCwd, structured,
        handoffContext: ctx.metadata,
        runnerArgs: {
          style, scope, base: args.base, commit: args.commit, prompt: effectivePrompt,
          skipGitRepoCheck, disableWebSearch: true, timeoutSec,
        },
      });
      return { ...group, style, scope };
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
        ? DEFAULT_EXTERNAL_AGENTS[host ?? "antigravity"].find((engine) =>
          engine !== meta.engine && ENGINES[engine].find())
        : meta.engine;
      if (!targetEngine) {
        throw new Error("No alternate external CLI found. Run handoff_doctor or retry with the original engine.");
      }
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
      const timeoutSec = validateTimeoutSec(args.timeoutSec);
      const phase = args.phase || "design";
      const structured = args.structured !== false;
      const resolvedCwd = validateCwd(args.cwd);
      const ctx = normalizeAndFormatContext(args.context, resolvedCwd, {
        inlineFiles: true,
      });
      const workspaceSnapshot = await capturePlanWorkspaceSnapshot(resolvedCwd);
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
        promptPrefix: `${workspaceSnapshot}${ctx.promptPrefix}`,
        structured,
      });

      const group = await runGroup(jobManager, {
        action: "plan", host, args, context, cwd: resolvedCwd, structured,
        handoffContext: ctx.metadata,
        runnerArgs: {
          prompt: composedPrompt, mode: "read-only", ephemeral: true,
          skipGitRepoCheck, disableWebSearch: args.allowWebSearch !== true, timeoutSec,
        },
      });
      return { ...group, phase, goal: args.goal };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function createJsonRpcHandler(
  jobManager = isNestedHandoffSession() ? null : new JobManager(),
  { emitNotification, nested = isNestedHandoffSession(), host = resolveHarness(), legacyGroup = false } = {},
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
              serverInfo: { ...SERVER_INFO, name: host === "claude" || host === "codex" ? `${host}-handoff` : SERVER_INFO.name },
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
            result: { tools: nested ? [] : TOOLS },
          };
        }

        case "tools/call": {
          if (nested) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: "Error: Recursive agy-handoff tool calls are disabled inside nested handoff child sessions.",
                  },
                ],
                isError: true,
              },
            };
          }
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
              host: host ?? undefined,
              legacyGroup,
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
  const argv = process.argv.slice(2);
  const legacyGroup = argv[2] === "--legacy-group" && argv[1] === "antigravity";
  if (argv.length && (argv[0] !== "--host" || argv.length !== (legacyGroup ? 3 : 2))) {
    throw new Error("Usage: node mcp-server.mjs [--host antigravity|claude|codex]");
  }
  const host = resolveHarness(argv[1]);
  const nested = isNestedHandoffSession();
  const jobManager = nested ? null : new JobManager();
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
    nested,
    host,
    legacyGroup,
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
    jobManager?.shutdown();
    terminateAllForegroundCommands();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.platform !== "win32") {
    process.on("SIGHUP", shutdown);
  }

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
