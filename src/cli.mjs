#!/usr/bin/env node
import { handleToolCall } from "./mcp-server.mjs";
import { validateTimeoutSec } from "./runners/common.mjs";
import { runWatch } from "./watch.mjs";

const BOOLEAN_FLAGS = new Set([
  "background",
  "skip-git-repo-check",
  "once",
  "stream",
]);

const COMMAND_ALLOWED_FLAGS = {
  doctor: new Set(),
  review: new Set([
    "engine",
    "style",
    "scope",
    "base",
    "commit",
    "prompt",
    "model",
    "effort",
    "cwd",
    "background",
    "skip-git-repo-check",
    "timeout",
  ]),
  delegate: new Set([
    "engine",
    "prompt",
    "mode",
    "model",
    "effort",
    "session",
    "cwd",
    "background",
    "skip-git-repo-check",
    "timeout",
  ]),
  "cross-review": new Set([
    "style",
    "scope",
    "base",
    "commit",
    "prompt",
    "codex-model",
    "codex-effort",
    "claude-model",
    "claude-effort",
    "cwd",
    "skip-git-repo-check",
    "timeout",
  ]),
  models: new Set([
    "scope",
    "engine",
    "model",
    "effort",
    "codex-model",
    "codex-effort",
    "claude-model",
    "claude-effort",
  ]),
  config: new Set([
    "scope",
    "engine",
    "model",
    "effort",
    "codex-model",
    "codex-effort",
    "claude-model",
    "claude-effort",
  ]),
  jobs: new Set(["limit"]),
  watch: new Set(["once", "stream", "interval", "limit"]),
};

function printHelp() {
  console.log(`agy-handoff CLI

Usage:
  agy-handoff doctor
  agy-handoff review --engine <codex|claude> [options]
  agy-handoff delegate --engine <codex|claude> --prompt "<task>" [options]
  agy-handoff cross-review [options]
  agy-handoff models [show | set [scope] [engine] [model] [effort] | reset [scope]]
  agy-handoff jobs [status <jobId> | result <jobId> | cancel <jobId>]
  agy-handoff watch [jobId] [--once] [--stream] [--interval <ms>]

Common options:
  --engine <codex|claude>
  --style <standard|adversarial>
  --scope <uncommitted|base|commit|custom | default|review|delegate|cross-review|all>
  --base <branch>
  --commit <sha>
  --mode <read-only|workspace-write>
  --prompt <text>
  --model <model>
  --effort <low|medium|high|xhigh|max|ultra>
  --codex-model <model>
  --codex-effort <low|medium|high|xhigh|max|ultra>
  --claude-model <model>
  --claude-effort <low|medium|high|xhigh|max>
  --session <id>
  --cwd <path>
  --skip-git-repo-check
  --timeout <seconds> (10-3600)
  --help, -h
`);
}

function parseFlags(argv, allowedFlags) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token === "-h" || token === "--help") {
      return { help: true, flags, positional };
    }
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const key = eqIdx !== -1 ? token.slice(2, eqIdx) : token.slice(2);
      if (allowedFlags && !allowedFlags.has(key)) {
        throw new Error(`Unknown option: --${key}`);
      }
      if (BOOLEAN_FLAGS.has(key)) {
        if (eqIdx !== -1) {
          throw new Error(`Flag --${key} does not take a value`);
        }
        flags[key] = true;
      } else if (eqIdx !== -1) {
        flags[key] = token.slice(eqIdx + 1);
      } else {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith("--")) {
          throw new Error(`Missing value for flag --${key}`);
        }
        flags[key] = val;
        i += 1;
      }
    } else if (token.startsWith("-") && token.length > 1) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      positional.push(token);
    }
  }
  return { help: false, flags, positional };
}

function parseIntFlag(name, raw, min, max) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `Invalid --${name} "${raw}". Expected an integer between ${min} and ${max}.`,
    );
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new Error(
      `Invalid --${name} "${raw}". Expected an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

function parseTimeoutFlag(raw) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `Invalid --timeout "${raw}". Expected an integer between 10 and 3600.`,
    );
  }
  return validateTimeoutSec(Number.parseInt(raw, 10));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help" || command === "help") {
    printHelp();
    process.exit(0);
  }

  const allowedFlags = COMMAND_ALLOWED_FLAGS[command];
  if (!allowedFlags) {
    throw new Error(`Unknown command: ${command}`);
  }

  const { help, flags, positional } = parseFlags(rest, allowedFlags);
  if (help) {
    printHelp();
    process.exit(0);
  }

  if (flags.background) {
    throw new Error(
      "--background is only supported via the persistent MCP server. Use MCP handoff_review/handoff_delegate with background: true, or run the CLI in the background with your shell (&).",
    );
  }

  if (command === "watch") {
    const intervalMs = parseIntFlag("interval", flags.interval, 100, 10_000) ?? 500;
    const limit = parseIntFlag("limit", flags.limit, 1, 100) ?? 10;
    await runWatch({
      jobId: positional[0],
      once: Boolean(flags.once),
      stream: Boolean(flags.stream),
      intervalMs,
      limit,
    });
    return;
  }

  const timeoutSec = parseTimeoutFlag(flags.timeout);
  const skipGitRepoCheck = Boolean(flags["skip-git-repo-check"]);

  let result;
  switch (command) {
    case "doctor":
      if (positional.length > 0) {
        throw new Error(`Unexpected arguments for doctor: ${positional.join(" ")}`);
      }
      result = await handleToolCall("handoff_doctor", {});
      break;

    case "review":
      result = await handleToolCall("handoff_review", {
        engine: flags.engine || "codex",
        style: flags.style || "standard",
        scope: flags.scope || "uncommitted",
        base: flags.base,
        commit: flags.commit,
        prompt: flags.prompt || positional.join(" ") || undefined,
        model: flags.model,
        effort: flags.effort,
        cwd: flags.cwd,
        skipGitRepoCheck: skipGitRepoCheck ? true : undefined,
        timeoutSec,
      });
      break;

    case "delegate":
      result = await handleToolCall("handoff_delegate", {
        engine: flags.engine || "codex",
        prompt: flags.prompt || positional.join(" "),
        mode: flags.mode || "read-only",
        model: flags.model,
        effort: flags.effort,
        sessionId: flags.session,
        cwd: flags.cwd,
        skipGitRepoCheck: skipGitRepoCheck ? true : undefined,
        timeoutSec,
      });
      break;

    case "cross-review":
      result = await handleToolCall("handoff_cross_review", {
        style: flags.style || "adversarial",
        scope: flags.scope || "uncommitted",
        base: flags.base,
        commit: flags.commit,
        prompt: flags.prompt || positional.join(" ") || undefined,
        codexModel: flags["codex-model"],
        codexEffort: flags["codex-effort"],
        claudeModel: flags["claude-model"],
        claudeEffort: flags["claude-effort"],
        cwd: flags.cwd,
        skipGitRepoCheck: skipGitRepoCheck ? true : undefined,
        timeoutSec,
      });
      break;

    case "models":
    case "config": {
      const [sub, ...subArgs] = positional;
      if (!sub || sub === "show" || sub === "get") {
        result = await handleToolCall("handoff_config", { action: "get" });
      } else if (sub === "reset") {
        result = await handleToolCall("handoff_config", {
          action: "reset",
          scope: flags.scope || subArgs[0] || "all",
          engine: flags.engine,
        });
      } else if (sub === "set") {
        let scope = flags.scope;
        let engine = flags.engine;
        let model = flags.model;
        let effort = flags.effort;

        if (subArgs.length > 0) {
          if (subArgs[0] === "codex" || subArgs[0] === "claude") {
            scope = scope || "default";
            engine = engine || subArgs[0];
            if (model === undefined && subArgs[1] !== undefined) model = subArgs[1];
            if (effort === undefined && subArgs[2] !== undefined) effort = subArgs[2];
          } else {
            scope = scope || subArgs[0];
            if (!engine && subArgs[1] !== undefined) engine = subArgs[1];
            if (model === undefined && subArgs[2] !== undefined) model = subArgs[2];
            if (effort === undefined && subArgs[3] !== undefined) effort = subArgs[3];
          }
        }

        result = await handleToolCall("handoff_config", {
          action: "set",
          scope: scope || "default",
          engine,
          model,
          effort,
          codexModel: flags["codex-model"],
          codexEffort: flags["codex-effort"],
          claudeModel: flags["claude-model"],
          claudeEffort: flags["claude-effort"],
        });
      } else {
        throw new Error(`Unknown models subcommand: ${sub}`);
      }
      break;
    }

    case "jobs": {
      const [sub, jobId] = positional;
      if (!sub || sub === "list") {
        result = await handleToolCall("handoff_job_status", {
          limit: parseIntFlag("limit", flags.limit, 1, 100),
        });
      } else if (sub === "status") {
        result = await handleToolCall("handoff_job_status", { jobId });
      } else if (sub === "result") {
        result = await handleToolCall("handoff_job_result", { jobId });
      } else if (sub === "cancel") {
        result = await handleToolCall("handoff_job_cancel", { jobId });
      } else {
        throw new Error(`Unknown jobs subcommand: ${sub}`);
      }
      break;
    }
  }

  console.log(JSON.stringify(result, null, 2));
  if (result?.ok === false) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
