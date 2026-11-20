import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renameSyncSafe } from "./runners/common.mjs";
import { VALID_ROUTING_POLICIES, VALID_TASK_TYPES } from "./routing.mjs";

export const DEFAULT_ROUTING_CONFIG = {
  policy: "balanced",
  taskTypes: {},
};

export const BUILTIN_DEFAULTS = {
  codex: { model: "gpt-6.2-sol", effort: "high" },
  claude: { model: "claude-opus-5-5", effort: "high" },
  agy: { model: "gemini-4-neon-high", effort: "high" },
};

export const CONFIGURABLE_COMMANDS = ["review", "delegate", "cross-review"];
export const VALID_SCOPES = ["default", "review", "delegate", "cross-review"];
export const VALID_ENGINES = ["codex", "claude", "agy"];

export const ALLOWED_EFFORTS_BY_ENGINE = {
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  agy: ["low", "medium", "high", "xhigh", "max"],
};

export const CLI_DEFAULT_TOKENS = new Set(["cli-default", "inherit", "auto", "none"]);

const CLAUDE_SHORTHAND_MAP = new Map([
  ["opus55", "claude-opus-5-5"],
  ["sonnet55", "claude-sonnet-5-5"],
  ["haiku55", "claude-haiku-5-5"],
  ["fable52", "claude-fable-5-2"],
]);

const AGY_SHORTHAND_MAP = new Map([
  ["neon", "gemini-4-neon-high"],
  ["neonhigh", "gemini-4-neon-high"],
  ["neonxhigh", "gemini-4-neon-xhigh"],
  ["neonmedium", "gemini-4-neon-medium"],
  ["neonlow", "gemini-4-neon-low"],
  ["gemini4neon", "gemini-4-neon-high"],
  ["argon", "gemini-4-argon-high"],
  ["argonhigh", "gemini-4-argon-high"],
  ["argonmedium", "gemini-4-argon-medium"],
  ["argonlow", "gemini-4-argon-low"],
  ["gemini4argon", "gemini-4-argon-high"],
  ["hydrogen", "gemini-4-hydrogen-high"],
  ["hydrogenhigh", "gemini-4-hydrogen-high"],
  ["hydrogenxhigh", "gemini-4-hydrogen-xhigh"],
  ["hydrogenmedium", "gemini-4-hydrogen-medium"],
  ["hydrogenlow", "gemini-4-hydrogen-low"],
  ["gemini4hydrogen", "gemini-4-hydrogen-high"],
  ["flash", "gemini-3.8-flash-high"],
  ["flashhigh", "gemini-3.8-flash-high"],
  ["flashmedium", "gemini-3.8-flash-medium"],
  ["flashlow", "gemini-3.8-flash-low"],
  ["orchestratorneon", "gemini-pro-orchestrator-neon"],
  ["orchestratorargon", "gemini-pro-orchestrator-g1-pro"],
]);

const AGY_FAMILY_EFFORTS = {
  "gemini-4-neon": new Set(["low", "medium", "high", "xhigh"]),
  "gemini-4-argon": new Set(["low", "medium", "high"]),
  "gemini-4-hydrogen": new Set(["low", "medium", "high", "xhigh"]),
  "gemini-3.8-flash": new Set(["low", "medium", "high"]),
};

const FALLBACK_CODEX_MODELS = [
  "gpt-6.2-sol",
  "gpt-6.2-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
];

const DEFAULT_CLAUDE_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "opus",
  "sonnet",
  "haiku",
];

const DEFAULT_AGY_MODELS = [
  "gemini-4-neon-high",
  "gemini-4-neon-xhigh",
  "gemini-4-neon-medium",
  "gemini-4-neon-low",
  "gemini-4-argon-high",
  "gemini-4-argon-medium",
  "gemini-4-argon-low",
  "gemini-4-hydrogen-high",
  "gemini-4-hydrogen-xhigh",
  "gemini-4-hydrogen-medium",
  "gemini-4-hydrogen-low",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "neon",
  "argon",
  "hydrogen",
  "flash",
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertValidEngine(engine) {
  if (!VALID_ENGINES.includes(engine)) {
    throw new Error(
      `Invalid engine "${engine}". Expected "codex", "claude", or "agy".`,
    );
  }
}

export function getConfigPath(overridePath) {
  if (overridePath) {
    return path.resolve(overridePath);
  }
  if (process.env.AGY_HANDOFF_CONFIG) {
    return path.resolve(process.env.AGY_HANDOFF_CONFIG);
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "agy-handoff", "config.json");
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "agy-handoff", "config.json");
  }
  return path.join(os.homedir(), ".config", "agy-handoff", "config.json");
}

export function normalizeModelName(engine, model) {
  assertValidEngine(engine);
  if (model === undefined) return undefined;
  if (model === null) return null;
  if (typeof model !== "string") {
    throw new Error(`Model for ${engine} must be a string or null.`);
  }
  const trimmed = model.trim();
  if (!trimmed || CLI_DEFAULT_TOKENS.has(trimmed.toLowerCase())) {
    return null;
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`Invalid model "${model}": model names cannot start with "-".`);
  }
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(
      `Invalid model "${model}": whitespace and control characters are not allowed.`,
    );
  }

  if (engine === "claude") {
    const shorthandKey = trimmed.toLowerCase().replace(/[-_.]/g, "");
    const mapped = CLAUDE_SHORTHAND_MAP.get(shorthandKey);
    if (mapped) {
      return mapped;
    }
  }

  if (engine === "agy") {
    const shorthandKey = trimmed.toLowerCase().replace(/[-_.]/g, "");
    const mapped = AGY_SHORTHAND_MAP.get(shorthandKey);
    if (mapped) {
      return mapped;
    }
  }

  return trimmed;
}

export function normalizeEffort(engine, effort) {
  assertValidEngine(engine);
  if (effort === undefined) return undefined;
  if (effort === null) return null;
  if (typeof effort !== "string") {
    throw new Error(`Effort for ${engine} must be a string or null.`);
  }
  const normalized = effort.trim().toLowerCase();
  if (!normalized || CLI_DEFAULT_TOKENS.has(normalized)) {
    return null;
  }
  const allowed = ALLOWED_EFFORTS_BY_ENGINE[engine];
  if (!allowed.includes(normalized)) {
    throw new Error(
      `Unsupported effort "${effort}" for ${engine}. Allowed: ${allowed.join(", ")}.`,
    );
  }
  return normalized;
}

function normalizeRoutingConfig(rawRouting) {
  if (!isPlainObject(rawRouting)) {
    return {
      policy: DEFAULT_ROUTING_CONFIG.policy,
      taskTypes: {},
      allowUnsandboxedWriteAuto: false,
    };
  }
  const policy = VALID_ROUTING_POLICIES.includes(rawRouting.policy)
    ? rawRouting.policy
    : DEFAULT_ROUTING_CONFIG.policy;
  const taskTypes = {};
  if (isPlainObject(rawRouting.taskTypes)) {
    for (const [k, v] of Object.entries(rawRouting.taskTypes)) {
      if (VALID_TASK_TYPES.includes(k) && ["codex", "claude", "auto"].includes(v)) {
        taskTypes[k] = v;
      }
    }
  }
  return {
    policy,
    taskTypes,
    allowUnsandboxedWriteAuto: Boolean(rawRouting.allowUnsandboxedWriteAuto),
  };
}

export function loadConfig(overridePath) {
  const filePath = getConfigPath(overridePath);
  if (!fs.existsSync(filePath)) {
    return {
      version: 1,
      defaults: {},
      commands: {},
      routing: { policy: DEFAULT_ROUTING_CONFIG.policy, taskTypes: {} },
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse config at ${filePath}: ${err.message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid config at ${filePath}: root must be a JSON object.`);
  }
  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    defaults: isPlainObject(parsed.defaults) ? parsed.defaults : {},
    commands: isPlainObject(parsed.commands) ? parsed.commands : {},
    routing: normalizeRoutingConfig(parsed.routing),
  };
}

export function saveConfig(config, overridePath) {
  const filePath = getConfigPath(overridePath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSyncSafe(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
  return filePath;
}

function resolveFromConfig(config, command, engine, overrides = {}) {
  assertValidEngine(engine);
  if (command && !CONFIGURABLE_COMMANDS.includes(command)) {
    throw new Error(
      `Invalid command "${command}". Expected one of: ${CONFIGURABLE_COMMANDS.join(", ")}.`,
    );
  }

  const overrideModel = normalizeModelName(engine, overrides?.model);
  const overrideEffort = normalizeEffort(engine, overrides?.effort);

  const cmdCfg = command ? config.commands?.[command]?.[engine] : undefined;
  const defCfg = config.defaults?.[engine];
  const builtin = BUILTIN_DEFAULTS[engine];

  let modelValue;
  let modelSource;
  if (overrideModel !== undefined) {
    modelValue = overrideModel;
    modelSource = "override";
  } else if (cmdCfg && cmdCfg.model !== undefined) {
    modelValue = normalizeModelName(engine, cmdCfg.model);
    modelSource = "command";
  } else if (defCfg && defCfg.model !== undefined) {
    modelValue = normalizeModelName(engine, defCfg.model);
    modelSource = "default";
  } else {
    modelValue = builtin.model;
    modelSource = "builtin";
  }

  let effortValue;
  let effortSource;
  if (overrideEffort !== undefined) {
    effortValue = overrideEffort;
    effortSource = "override";
  } else if (cmdCfg && cmdCfg.effort !== undefined) {
    effortValue = normalizeEffort(engine, cmdCfg.effort);
    effortSource = "command";
  } else if (defCfg && defCfg.effort !== undefined) {
    effortValue = normalizeEffort(engine, defCfg.effort);
    effortSource = "default";
  } else {
    effortValue = builtin.effort;
    effortSource = "builtin";
  }

  if (engine === "agy" && modelValue && effortValue) {
    for (const [family, supportedEfforts] of Object.entries(AGY_FAMILY_EFFORTS)) {
      if (
        (modelValue === family || modelValue.startsWith(`${family}-`)) &&
        supportedEfforts.has(effortValue)
      ) {
        modelValue = `${family}-${effortValue}`;
        break;
      }
    }
  }

  return {
    model: modelValue === null ? undefined : modelValue,
    effort: effortValue === null ? undefined : effortValue,
    modelSource: modelValue === null ? "cli-default" : modelSource,
    effortSource: effortValue === null ? "cli-default" : effortSource,
  };
}

export function resolveEngineConfig(command, engine, overrides = {}, overridePath) {
  const config = loadConfig(overridePath);
  return resolveFromConfig(config, command, engine, overrides);
}

export function discoverAvailableModels() {
  let codexModels = [...FALLBACK_CODEX_MODELS];
  try {
    const cacheFile = path.join(
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      "models_cache.json",
    );
    if (fs.existsSync(cacheFile)) {
      const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (Array.isArray(raw?.models)) {
        const slugs = raw.models
          .map((m) => (typeof m?.slug === "string" ? m.slug.trim() : ""))
          .filter(Boolean);
        if (slugs.length > 0) {
          const deduped = Array.from(new Set(slugs));
          const idx = deduped.indexOf(BUILTIN_DEFAULTS.codex.model);
          if (idx > 0) {
            deduped.splice(idx, 1);
            deduped.unshift(BUILTIN_DEFAULTS.codex.model);
          }
          codexModels = deduped;
        }
      }
    }
  } catch {
    // keep fallback list on read/parse error
  }

  return {
    codex: {
      models: codexModels,
      efforts: [...ALLOWED_EFFORTS_BY_ENGINE.codex],
    },
    claude: {
      models: [...DEFAULT_CLAUDE_MODELS],
      efforts: [...ALLOWED_EFFORTS_BY_ENGINE.claude],
    },
    agy: {
      models: [...DEFAULT_AGY_MODELS],
      efforts: [...ALLOWED_EFFORTS_BY_ENGINE.agy],
    },
  };
}

export function getEffectiveConfigSummary(overridePath) {
  const configPath = getConfigPath(overridePath);
  const config = loadConfig(overridePath);

  const buildPair = (command) => ({
    codex: resolveFromConfig(config, command, "codex"),
    claude: resolveFromConfig(config, command, "claude"),
    agy: resolveFromConfig(config, command, "agy"),
  });

  const effective = {
    default: buildPair(null),
    review: buildPair("review"),
    delegate: buildPair("delegate"),
    "cross-review": buildPair("cross-review"),
  };

  return {
    configPath,
    builtinDefaults: BUILTIN_DEFAULTS,
    config,
    effective,
    availableModels: discoverAvailableModels(),
  };
}

function cloneConfig(config) {
  return {
    version: config.version || 1,
    defaults: structuredClone(config.defaults || {}),
    commands: structuredClone(config.commands || {}),
    routing: structuredClone(config.routing || DEFAULT_ROUTING_CONFIG),
  };
}

function applyEngineEntry(targetMap, engine, entry) {
  assertValidEngine(engine);
  if (!isPlainObject(entry)) {
    throw new Error(`Config entry for ${engine} must be an object.`);
  }
  const hasModel = entry.model !== undefined;
  const hasEffort = entry.effort !== undefined;
  if (!hasModel && !hasEffort) {
    return false;
  }

  const nextEntry = isPlainObject(targetMap[engine]) ? { ...targetMap[engine] } : {};
  if (hasModel) {
    nextEntry.model = normalizeModelName(engine, entry.model);
  }
  if (hasEffort) {
    nextEntry.effort = normalizeEffort(engine, entry.effort);
  }
  targetMap[engine] = nextEntry;
  return true;
}

function clearEngineFromCommands(commandsMap, engine) {
  for (const cmd of CONFIGURABLE_COMMANDS) {
    if (commandsMap[cmd] && Object.prototype.hasOwnProperty.call(commandsMap[cmd], engine)) {
      delete commandsMap[cmd][engine];
      if (Object.keys(commandsMap[cmd]).length === 0) {
        delete commandsMap[cmd];
      }
    }
  }
}

export function updateConfig(args = {}, overridePath) {
  const action = args.action || "get";
  if (!["get", "set", "reset"].includes(action)) {
    throw new Error(`Invalid action "${action}". Expected "get", "set", or "reset".`);
  }

  if (action === "get") {
    return getEffectiveConfigSummary(overridePath);
  }

  const current = loadConfig(overridePath);

  if (action === "reset") {
    const scope = args.scope || "all";
    if (args.engine !== undefined) {
      assertValidEngine(args.engine);
    }

    let next;
    if (scope === "all") {
      if (args.engine) {
        next = cloneConfig(current);
        delete next.defaults[args.engine];
        clearEngineFromCommands(next.commands, args.engine);
      } else {
        next = {
          version: 1,
          defaults: {},
          commands: {},
          routing: { policy: DEFAULT_ROUTING_CONFIG.policy, taskTypes: {} },
        };
      }
    } else if (scope === "default") {
      next = cloneConfig(current);
      if (args.engine) {
        delete next.defaults[args.engine];
      } else {
        next.defaults = {};
      }
    } else if (CONFIGURABLE_COMMANDS.includes(scope)) {
      next = cloneConfig(current);
      if (args.engine) {
        if (next.commands[scope]) {
          delete next.commands[scope][args.engine];
          if (Object.keys(next.commands[scope]).length === 0) {
            delete next.commands[scope];
          }
        }
      } else {
        delete next.commands[scope];
      }
    } else {
      throw new Error(
        `Invalid reset scope "${scope}". Expected one of: all, ${VALID_SCOPES.join(", ")}.`,
      );
    }

    saveConfig(next, overridePath);
    return getEffectiveConfigSummary(overridePath);
  }

  // action === "set"
  const scope = args.scope || "default";
  if (scope !== "all" && !VALID_SCOPES.includes(scope)) {
    throw new Error(
      `Invalid scope "${scope}". Expected one of: all, ${VALID_SCOPES.join(", ")}.`,
    );
  }

  const next = cloneConfig(current);
  let changed = false;

  if (args.defaults !== undefined) {
    if (!isPlainObject(args.defaults)) {
      throw new Error("`defaults` must be an object keyed by engine (codex, claude).");
    }
    for (const [eng, entry] of Object.entries(args.defaults)) {
      if (applyEngineEntry(next.defaults, eng, entry)) {
        changed = true;
      }
    }
  }

  if (args.commands !== undefined) {
    if (!isPlainObject(args.commands)) {
      throw new Error(
        "`commands` must be an object keyed by command (review, delegate, cross-review).",
      );
    }
    for (const [cmd, cmdMap] of Object.entries(args.commands)) {
      if (!CONFIGURABLE_COMMANDS.includes(cmd)) {
        throw new Error(
          `Invalid command "${cmd}" in commands map. Expected one of: ${CONFIGURABLE_COMMANDS.join(", ")}.`,
        );
      }
      if (!isPlainObject(cmdMap)) {
        throw new Error(`Command entry for "${cmd}" must be an object.`);
      }
      if (!isPlainObject(next.commands[cmd])) {
        next.commands[cmd] = {};
      }
      for (const [eng, entry] of Object.entries(cmdMap)) {
        if (applyEngineEntry(next.commands[cmd], eng, entry)) {
          changed = true;
        }
      }
      if (Object.keys(next.commands[cmd]).length === 0) {
        delete next.commands[cmd];
      }
    }
  }

  const getTargetMap = () => {
    if (scope === "default" || scope === "all") {
      return next.defaults;
    }
    if (!isPlainObject(next.commands[scope])) {
      next.commands[scope] = {};
    }
    return next.commands[scope];
  };

  if (args.model !== undefined || args.effort !== undefined) {
    if (!args.engine) {
      throw new Error("`engine` (codex or claude) is required when passing `model` or `effort`.");
    }
    assertValidEngine(args.engine);
    const target = getTargetMap();
    if (applyEngineEntry(target, args.engine, { model: args.model, effort: args.effort })) {
      changed = true;
      if (scope === "all") {
        clearEngineFromCommands(next.commands, args.engine);
      }
    }
  }

  if (args.codexModel !== undefined || args.codexEffort !== undefined) {
    const target = getTargetMap();
    if (
      applyEngineEntry(target, "codex", {
        model: args.codexModel,
        effort: args.codexEffort,
      })
    ) {
      changed = true;
      if (scope === "all") {
        clearEngineFromCommands(next.commands, "codex");
      }
    }
  }

  if (args.claudeModel !== undefined || args.claudeEffort !== undefined) {
    const target = getTargetMap();
    if (
      applyEngineEntry(target, "claude", {
        model: args.claudeModel,
        effort: args.claudeEffort,
      })
    ) {
      changed = true;
      if (scope === "all") {
        clearEngineFromCommands(next.commands, "claude");
      }
    }
  }

  if (args.agyModel !== undefined || args.agyEffort !== undefined) {
    const target = getTargetMap();
    if (
      applyEngineEntry(target, "agy", {
        model: args.agyModel,
        effort: args.agyEffort,
      })
    ) {
      changed = true;
      if (scope === "all") {
        clearEngineFromCommands(next.commands, "agy");
      }
    }
  }

  if (args.routing !== undefined) {
    if (!isPlainObject(args.routing)) {
      throw new Error("`routing` must be an object with `policy` and/or `taskTypes`.");
    }
    if (args.routing.policy !== undefined) {
      if (!VALID_ROUTING_POLICIES.includes(args.routing.policy)) {
        throw new Error(
          `Invalid routing policy "${args.routing.policy}". Expected one of: ${VALID_ROUTING_POLICIES.join(", ")}.`,
        );
      }
      next.routing.policy = args.routing.policy;
      changed = true;
    }
    if (args.routing.taskTypes !== undefined) {
      if (!isPlainObject(args.routing.taskTypes)) {
        throw new Error("`routing.taskTypes` must be an object keyed by task type.");
      }
      if (!isPlainObject(next.routing.taskTypes)) {
        next.routing.taskTypes = {};
      }
      for (const [taskKey, engineVal] of Object.entries(args.routing.taskTypes)) {
        if (!VALID_TASK_TYPES.includes(taskKey)) {
          throw new Error(
            `Invalid routing taskType "${taskKey}". Expected one of: ${VALID_TASK_TYPES.join(", ")}.`,
          );
        }
        if (engineVal === null || engineVal === "auto") {
          delete next.routing.taskTypes[taskKey];
        } else if (engineVal === "codex" || engineVal === "claude") {
          next.routing.taskTypes[taskKey] = engineVal;
        } else {
          throw new Error(
            `Invalid routing engine "${engineVal}" for taskType "${taskKey}". Expected "codex", "claude", "auto", or null.`,
          );
        }
        changed = true;
      }
    }
    if (args.routing.allowUnsandboxedWriteAuto !== undefined) {
      if (typeof args.routing.allowUnsandboxedWriteAuto !== "boolean") {
        throw new Error(
          "`routing.allowUnsandboxedWriteAuto` must be a boolean.",
        );
      }
      next.routing.allowUnsandboxedWriteAuto =
        args.routing.allowUnsandboxedWriteAuto;
      changed = true;
    }
  }

  if (!changed) {
    throw new Error(
      "No configuration changes provided. Pass model/effort, codexModel/claudeModel, defaults/commands, or routing.",
    );
  }

  saveConfig(next, overridePath);
  return getEffectiveConfigSummary(overridePath);
}
