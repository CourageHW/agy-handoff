import { inspectCodex } from "./runners/codex.mjs";
import { inspectClaude } from "./runners/claude.mjs";

export const VALID_ROUTING_POLICIES = [
  "balanced",
  "prefer-codex",
  "prefer-claude",
  "least-used",
];

export const VALID_TASK_TYPES = [
  "review",
  "debugging",
  "implementation",
  "architecture",
  "general",
];

const INSPECT_CACHE_TTL_MS = 15_000;
let cachedInspection = { expiresAt: 0, codex: null, claude: null };

async function getEngineAvailability(inspectCodexFn, inspectClaudeFn) {
  const useCache =
    inspectCodexFn === inspectCodex &&
    inspectClaudeFn === inspectClaude &&
    Date.now() < cachedInspection.expiresAt;
  if (useCache) {
    return {
      codexInfo: cachedInspection.codex,
      claudeInfo: cachedInspection.claude,
    };
  }

  const [codexSettled, claudeSettled] = await Promise.allSettled([
    inspectCodexFn(),
    inspectClaudeFn(),
  ]);
  const codexInfo =
    codexSettled.status === "fulfilled"
      ? codexSettled.value
      : { accessible: false, compatible: false, error: codexSettled.reason?.message };
  const claudeInfo =
    claudeSettled.status === "fulfilled"
      ? claudeSettled.value
      : { accessible: false, compatible: false, error: claudeSettled.reason?.message };

  if (inspectCodexFn === inspectCodex && inspectClaudeFn === inspectClaude) {
    cachedInspection = {
      expiresAt: Date.now() + INSPECT_CACHE_TTL_MS,
      codex: codexInfo,
      claude: claudeInfo,
    };
  }
  return { codexInfo, claudeInfo };
}

function getConsecutiveFailures(stats, engine) {
  if (typeof stats?.consecutiveFailures?.[engine] === "number") {
    return stats.consecutiveFailures[engine];
  }
  let failures = 0;
  for (const job of stats?.recentJobs || []) {
    if (job.engine !== engine) continue;
    if (job.status === "running") continue;
    if (job.status === "failed" || job.status === "timed_out") {
      failures += 1;
    } else {
      break;
    }
  }
  return failures;
}

export async function resolveAutoEngine({
  taskType = "general",
  mode = "read-only",
  effort = null,
  model = null,
  config = {},
  jobManager = null,
  inspectCodexFn = inspectCodex,
  inspectClaudeFn = inspectClaude,
} = {}) {
  const normalizedTask = String(taskType || "general").trim().toLowerCase();
  if (!VALID_TASK_TYPES.includes(normalizedTask)) {
    throw new Error(
      `Invalid taskType "${taskType}". Allowed: ${VALID_TASK_TYPES.join(", ")}.`,
    );
  }
  if (model !== undefined && model !== null) {
    throw new Error(
      "Cannot specify explicit `model` together with `engine: \"auto\"`; omit `model` or choose an engine explicitly.",
    );
  }

  const routingCfg =
    config?.routing && typeof config.routing === "object" ? config.routing : {};
  const policy = VALID_ROUTING_POLICIES.includes(routingCfg.policy)
    ? routingCfg.policy
    : "balanced";

  const { codexInfo, claudeInfo } = await getEngineAvailability(
    inspectCodexFn,
    inspectClaudeFn,
  );

  const codexAccessible = Boolean(
    codexInfo?.accessible && codexInfo?.compatible !== false,
  );
  const claudeAccessible = Boolean(
    claudeInfo?.accessible && claudeInfo?.compatible !== false,
  );

  // Respect capability & security boundaries before scoring engines.
  const codexReady = codexAccessible;
  let claudeReady = claudeAccessible;
  const exclusionReasons = [];

  if (claudeReady && effort && String(effort).trim().toLowerCase() === "ultra") {
    claudeReady = false;
    exclusionReasons.push('Claude excluded because effort "ultra" is Codex-only.');
  }
  if (
    claudeReady &&
    mode === "workspace-write" &&
    !routingCfg.allowUnsandboxedWriteAuto
  ) {
    claudeReady = false;
    exclusionReasons.push(
      'Claude excluded for automatic workspace-write routing because Claude Bash lacks an OS sandbox (pass explicit engine: "claude" or opt in via routing.allowUnsandboxedWriteAuto).',
    );
  }

  if (!codexReady && !claudeReady) {
    const detail = exclusionReasons.length > 0 ? ` ${exclusionReasons.join(" ")}` : "";
    throw new Error(
      `No eligible CLI available for auto-routing.${detail} Run \`handoff_doctor\` or choose an engine explicitly.`,
    );
  }

  let stats = null;
  if (jobManager && typeof jobManager.getStats === "function") {
    try {
      stats = jobManager.getStats({ limit: 20 });
    } catch {
      stats = null;
    }
  }

  const recentCounts = {
    codex: stats?.byEngine?.codex?.count || 0,
    claude: stats?.byEngine?.claude?.count || 0,
  };

  let selectedEngine;
  let reason;

  if (!claudeReady) {
    selectedEngine = "codex";
    reason =
      exclusionReasons[0] || "Only Codex CLI is accessible and compatible.";
  } else if (!codexReady) {
    selectedEngine = "claude";
    reason = "Only Claude Code CLI is accessible and compatible.";
  } else if (codexInfo?.compatible === true && claudeInfo?.compatible !== true) {
    selectedEngine = "codex";
    reason = "Codex CLI has confirmed flag compatibility while Claude compatibility is unverified.";
  } else if (claudeInfo?.compatible === true && codexInfo?.compatible !== true) {
    selectedEngine = "claude";
    reason = "Claude CLI has confirmed flag compatibility while Codex compatibility is unverified.";
  } else {
    const codexFailures = getConsecutiveFailures(stats, "codex");
    const claudeFailures = getConsecutiveFailures(stats, "claude");
    const taskPref = routingCfg.taskTypes?.[normalizedTask];

    if (
      (taskPref === "codex" || taskPref === "claude") &&
      !(taskPref === "codex" && codexFailures >= 2 && claudeFailures < 2) &&
      !(taskPref === "claude" && claudeFailures >= 2 && codexFailures < 2)
    ) {
      selectedEngine = taskPref;
      reason = `Matched configured routing.taskTypes preference for "${normalizedTask}".`;
    } else if (codexFailures >= 2 && claudeFailures < 2) {
      selectedEngine = "claude";
      reason = `Codex failed or timed out on its last ${codexFailures} recent runs; routing to healthy Claude CLI.`;
    } else if (claudeFailures >= 2 && codexFailures < 2) {
      selectedEngine = "codex";
      reason = `Claude failed or timed out on its last ${claudeFailures} recent runs; routing to healthy Codex CLI.`;
    } else if (policy === "least-used") {
      selectedEngine = recentCounts.claude < recentCounts.codex ? "claude" : "codex";
      reason = `Policy "least-used" selected engine with fewer runs among last ${stats?.analyzedJobs || 0} jobs (codex=${recentCounts.codex}, claude=${recentCounts.claude}).`;
    } else if (policy === "prefer-codex") {
      selectedEngine = "codex";
      reason = 'Configured routing policy is "prefer-codex".';
    } else if (policy === "prefer-claude") {
      selectedEngine = "claude";
      reason = 'Configured routing policy is "prefer-claude".';
    } else if (recentCounts.claude < recentCounts.codex) {
      selectedEngine = "claude";
      reason = `Balanced selection among last ${stats?.analyzedJobs || 0} jobs (codex=${recentCounts.codex}, claude=${recentCounts.claude}).`;
    } else {
      selectedEngine = "codex";
      reason = `Balanced selection among last ${stats?.analyzedJobs || 0} jobs (codex=${recentCounts.codex}, claude=${recentCounts.claude}).`;
    }
  }

  return {
    selectedEngine,
    routingDecision: {
      requestedEngine: "auto",
      selectedEngine,
      taskType: normalizedTask,
      policy,
      reason,
      recentCounts,
    },
  };
}
