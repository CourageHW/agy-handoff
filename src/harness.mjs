import { VALID_ENGINES } from "./config.mjs";

export const DEFAULT_EXTERNAL_AGENTS = Object.freeze({
  antigravity: Object.freeze(["codex", "claude"]),
  claude: Object.freeze(["codex", "agy"]),
  codex: Object.freeze(["claude", "agy"]),
});

export const SYNTHESIZER = "current_session_model";

export function resolveHarness(host = process.env.AGY_HANDOFF_HOST) {
  if (host === undefined) return null;
  if (!Object.hasOwn(DEFAULT_EXTERNAL_AGENTS, host)) {
    throw new Error(`Invalid handoff host "${host}". Choose antigravity, claude, or codex.`);
  }
  return host;
}

export function selectGroupEngines(host, { engines, includeAgy } = {}) {
  if (engines !== undefined) {
    if (includeAgy !== undefined) {
      throw new Error("Specify either engines or the legacy includeAgy flag.");
    }
    if (!Array.isArray(engines) || !engines.length || new Set(engines).size !== engines.length ||
        engines.some((engine) => !VALID_ENGINES.includes(engine))) {
      throw new Error("engines must contain a nonempty, unique list of codex, claude, or agy.");
    }
    return engines;
  }
  // Preserve the legacy group roster when no host or an explicit includeAgy flag is supplied.
  if (!host || includeAgy !== undefined) {
    return includeAgy === false ? DEFAULT_EXTERNAL_AGENTS.antigravity : VALID_ENGINES;
  }
  return DEFAULT_EXTERNAL_AGENTS[host];
}

export function synthesisResults(options) {
  if (options.results) return options.results;
  return Object.fromEntries(VALID_ENGINES.flatMap((engine) => {
    const output = options[`${engine}Output`];
    const structuredOutput = options[`${engine}Structured`];
    const status = options[`${engine}Status`];
    if (engine === "agy" && output === undefined && structuredOutput == null && status == null) {
      return [];
    }
    const ok = structuredOutput != null || Boolean(output && String(output).trim());
    return [[engine, { ok, attempted: ok, ...status, output, structuredOutput }]];
  }));
}
