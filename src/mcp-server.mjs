#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JobManager } from "./jobs.mjs";
import {
  getEffectiveConfigSummary,
  resolveEngineConfig,
  updateConfig,
} from "./config.mjs";
import {
  isInsideGitRepo,
  terminateAllForegroundCommands,
  validateCwd,
  validateTimeoutSec,
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
  buildClaudeExecSpec,
  buildClaudeReviewSpec,
  findClaudeBinary,
  inspectClaude,
  runClaudeExec,
  runClaudeReview,
} from "./runners/claude.mjs";

const SERVER_INFO = {
  name: "agy-handoff",
  version: "0.1.0",
};

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"];

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
      "Run a read-only code review using local Codex or Claude Code CLI. Supports standard or adversarial review styles and uncommitted, base-branch, commit, or custom scopes.",
    inputSchema: {
      type: "object",
      properties: {
        engine: {
          type: "string",
          enum: ["codex", "claude"],
          description: "Which external CLI to run the review with.",
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
      "Delegate an investigation, debugging, or coding task to local Codex or Claude Code CLI. Defaults to read-only mode for safety.",
    inputSchema: {
      type: "object",
      properties: {
        engine: {
          type: "string",
          enum: ["codex", "claude"],
          description: "Which external CLI to delegate the task to.",
        },
        prompt: {
          type: "string",
          description: "Clear, self-contained task description for the external CLI.",
        },
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
      "Inspect, update, or reset default Codex and Claude Code models and reasoning efforts globally or per command (review, delegate, cross-review).",
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
          enum: ["default", "review", "delegate", "cross-review", "all"],
        },
        engine: {
          type: "string",
          enum: ["codex", "claude"],
        },
        model: { type: "string" },
        effort: { type: "string" },
        codexModel: { type: "string" },
        codexEffort: { type: "string" },
        claudeModel: { type: "string" },
        claudeEffort: { type: "string" },
        defaults: { type: "object" },
        commands: { type: "object" },
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
    }
  }

  if (toolName === "handoff_delegate" && !args.prompt.trim()) {
    throw new Error('Argument "prompt" for handoff_delegate cannot be empty.');
  }

  return args;
}

async function runTrackedForeground(
  jobManager,
  { engine, action, cwd, model, effort, onProgress },
  fn,
) {
  const tracker = jobManager.beginForegroundRun({
    engine,
    action,
    cwd,
    model: model || null,
    effort: effort || null,
  });

  const handleEvent = (ev) => {
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
    await tracker.finish({
      status: result.ok ? "completed" : result.timedOut ? "timed_out" : "failed",
      exitCode: result.exitCode,
      error: result.ok ? null : result.stderr || null,
      sessionId: result.sessionId || null,
    });
    return {
      ...result,
      jobId: tracker.jobId,
      eventsPath: tracker.eventsPath,
    };
  } catch (err) {
    await tracker.finish({
      status: "failed",
      exitCode: -1,
      error: err.message,
    });
    throw err;
  }
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
      const [codex, claude] = await Promise.all([inspectCodex(), inspectClaude()]);
      const summary = getEffectiveConfigSummary();
      return {
        nodeVersion: process.version,
        platform: process.platform,
        engines: { codex, claude },
        configPath: summary.configPath,
        modelDefaults: summary.effective,
      };
    }

    case "handoff_review": {
      const { engine, background = false } = args;
      const timeoutSec = validateTimeoutSec(args.timeoutSec);
      const scope = args.scope || "uncommitted";
      const resolvedCwd = validateCwd(args.cwd);
      const skipGitRepoCheck =
        args.skipGitRepoCheck ?? (scope === "custom" ? !isInsideGitRepo(resolvedCwd) : false);

      const resolved = resolveEngineConfig("review", engine, {
        model: args.model,
        effort: args.effort,
      });
      const effectiveArgs = {
        ...args,
        cwd: resolvedCwd,
        scope,
        skipGitRepoCheck,
        timeoutSec,
        model: resolved.model,
        effort: resolved.effort,
        signal,
      };

      if (background) {
        if (engine === "codex") {
          const binary = findCodexBinary();
          if (!binary) throw new Error("Codex CLI (`codex`) not found in PATH.");
          const jobId = jobManager.allocateJobId("codex");
          const outputFile = jobManager.outputFilePath(jobId);
          const spec = buildCodexReviewSpec({ ...effectiveArgs, outputFile });
          return jobManager.startJob({
            jobId,
            engine: "codex",
            action: "review",
            command: binary,
            args: spec.args,
            cwd: spec.cwd,
            stdin: spec.stdin,
            timeoutMs: (timeoutSec || 600) * 1000,
            hasOutputFile: Boolean(spec.outputFile),
            parseMode: "text",
            model: resolved.model || null,
            effort: resolved.effort || null,
          });
        }
        const binary = findClaudeBinary();
        if (!binary) throw new Error("Claude Code CLI (`claude`) not found in PATH.");
        const spec = buildClaudeReviewSpec(effectiveArgs);
        return jobManager.startJob({
          engine: "claude",
          action: "review",
          command: binary,
          args: spec.args,
          cwd: spec.cwd,
          stdin: spec.stdin,
          timeoutMs: (timeoutSec || 600) * 1000,
          parseMode: "claude-json",
          model: resolved.model || null,
          effort: resolved.effort || null,
        });
      }

      return runTrackedForeground(
        jobManager,
        {
          engine,
          action: "review",
          cwd: resolvedCwd,
          model: resolved.model,
          effort: resolved.effort,
          onProgress,
        },
        (onEvent) =>
          engine === "codex"
            ? runCodexReview({ ...effectiveArgs, onEvent })
            : runClaudeReview({ ...effectiveArgs, onEvent }),
      );
    }

    case "handoff_delegate": {
      const { engine, background = false } = args;
      const timeoutSec = validateTimeoutSec(args.timeoutSec);
      const resolvedCwd = validateCwd(args.cwd);
      const skipGitRepoCheck =
        args.skipGitRepoCheck ?? !isInsideGitRepo(resolvedCwd);

      const resolved = resolveEngineConfig("delegate", engine, {
        model: args.model,
        effort: args.effort,
      });
      const effectiveArgs = {
        ...args,
        cwd: resolvedCwd,
        skipGitRepoCheck,
        ephemeral: false,
        timeoutSec,
        model: resolved.model,
        effort: resolved.effort,
        signal,
      };

      if (background) {
        if (engine === "codex") {
          const binary = findCodexBinary();
          if (!binary) throw new Error("Codex CLI (`codex`) not found in PATH.");
          const jobId = jobManager.allocateJobId("codex");
          const outputFile = args.sessionId ? null : jobManager.outputFilePath(jobId);
          const spec = buildCodexExecSpec({ ...effectiveArgs, outputFile });
          return jobManager.startJob({
            jobId,
            engine: "codex",
            action: "delegate",
            command: binary,
            args: spec.args,
            cwd: spec.cwd,
            stdin: spec.stdin,
            timeoutMs: (timeoutSec || 600) * 1000,
            hasOutputFile: Boolean(spec.outputFile),
            parseMode: "text",
            model: resolved.model || null,
            effort: resolved.effort || null,
          });
        }
        const binary = findClaudeBinary();
        if (!binary) throw new Error("Claude Code CLI (`claude`) not found in PATH.");
        const spec = buildClaudeExecSpec(effectiveArgs);
        return jobManager.startJob({
          engine: "claude",
          action: "delegate",
          command: binary,
          args: spec.args,
          cwd: spec.cwd,
          stdin: spec.stdin,
          timeoutMs: (timeoutSec || 600) * 1000,
          parseMode: "claude-json",
          model: resolved.model || null,
          effort: resolved.effort || null,
        });
      }

      return runTrackedForeground(
        jobManager,
        {
          engine,
          action: "delegate",
          cwd: resolvedCwd,
          model: resolved.model,
          effort: resolved.effort,
          onProgress,
        },
        (onEvent) =>
          engine === "codex"
            ? runCodexExec({ ...effectiveArgs, onEvent })
            : runClaudeExec({ ...effectiveArgs, onEvent }),
      );
    }

    case "handoff_cross_review": {
      const codexBin = findCodexBinary();
      const claudeBin = findClaudeBinary();
      if (!codexBin && !claudeBin) {
        throw new Error(
          "Neither `codex` nor `claude` CLI was found in PATH. Run `handoff_doctor` for install instructions.",
        );
      }

      const timeoutSec = validateTimeoutSec(args.timeoutSec);
      const style = args.style || "adversarial";
      const scope = args.scope || "uncommitted";
      const resolvedCwd = validateCwd(args.cwd);
      const skipGitRepoCheck =
        args.skipGitRepoCheck ?? (scope === "custom" ? !isInsideGitRepo(resolvedCwd) : false);

      const codexCfg = resolveEngineConfig("cross-review", "codex", {
        model: args.codexModel,
        effort: args.codexEffort,
      });
      const claudeCfg = resolveEngineConfig("cross-review", "claude", {
        model: args.claudeModel,
        effort: args.claudeEffort,
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
                prompt: args.prompt,
                model: codexCfg.model,
                effort: codexCfg.effort,
                cwd: resolvedCwd,
                skipGitRepoCheck,
                timeoutSec,
                signal,
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
                prompt: args.prompt,
                model: claudeCfg.model,
                effort: claudeCfg.effort,
                cwd: resolvedCwd,
                timeoutSec,
                signal,
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

      const [codexResult, claudeResult] = await Promise.all(tasks);
      const ok = Boolean(
        (!codexResult.skipped && codexResult.ok) ||
          (!claudeResult.skipped && claudeResult.ok),
      );
      return {
        ok,
        style,
        scope,
        resolvedModels: {
          codex: codexCfg,
          claude: claudeCfg,
        },
        results: {
          codex: codexResult,
          claude: claudeResult,
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
      return { jobs: jobManager.listJobs(args.limit || 20) };
    }

    case "handoff_job_result": {
      return jobManager.getResult(args.jobId);
    }

    case "handoff_job_cancel": {
      return jobManager.cancelJob(args.jobId);
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
  try {
    const resolved = fs.realpathSync(path.resolve(process.argv[1]));
    return import.meta.url === pathToFileURL(resolved).href;
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  }
}

if (isDirectExecution()) {
  startStdioServer();
}
