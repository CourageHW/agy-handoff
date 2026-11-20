import {
  ALLOWED_EFFORTS_BY_ENGINE,
  VALID_ROUTING_POLICIES,
  VALID_TASK_TYPES,
} from "./config.mjs";
import { ENGINES } from "./engines.mjs";
import { DEFAULT_EXTERNAL_AGENTS } from "./harness.mjs";
export { VALID_ROUTING_POLICIES, VALID_TASK_TYPES };

const INSPECT_CACHE_TTL_MS = 15_000;
const cachedInspections = new Map();

async function getAvailability(engine, inspect) {
  const cacheable = inspect === ENGINES[engine].inspect;
  const cached = cachedInspections.get(engine);
  if (cacheable && cached?.expiresAt > Date.now()) return cached.info;
  let info;
  try {
    info = await inspect();
  } catch (err) {
    info = { accessible: false, compatible: false, error: err.message };
  }
  if (cacheable) {
    cachedInspections.set(engine, { expiresAt: Date.now() + INSPECT_CACHE_TTL_MS, info });
  }
  return info;
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
  candidates = DEFAULT_EXTERNAL_AGENTS.antigravity,
  inspectCodexFn = ENGINES.codex.inspect,
  inspectClaudeFn = ENGINES.claude.inspect,
  inspectAgyFn = ENGINES.agy.inspect,
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

  const inspectors = { codex: inspectCodexFn, claude: inspectClaudeFn, agy: inspectAgyFn };
  const availability = await Promise.all(candidates.map(async (engine) => {
    if (effort && !ALLOWED_EFFORTS_BY_ENGINE[engine].includes(String(effort).toLowerCase())) {
      return { engine, error: `Unsupported effort "${effort}" for ${engine}.` };
    }
    if (mode === "workspace-write" && ENGINES[engine].unsandboxedWrite &&
        !routingCfg.allowUnsandboxedWriteAuto) {
      return { engine, error: "Claude Bash lacks an OS sandbox for workspace-write." };
    }
    const info = await getAvailability(engine, inspectors[engine] ?? ENGINES[engine].inspect);
    return {
      engine,
      compatible: info?.compatible,
      error: info?.accessible && info.compatible !== false
        ? null
        : info?.error || info?.compatibilityNote || "CLI missing or incompatible",
    };
  }));
  const ready = availability.filter(({ error }) => !error);
  if (!ready.length) {
    const detail = availability.map(({ engine, error }) => `${engine}: ${error}`).join("; ");
    throw new Error(`No eligible CLI available for auto-routing. ${detail}. Run handoff_doctor or select an engine explicitly.`);
  }

  let stats;
  try {
    stats = jobManager?.getStats({ limit: 20 });
  } catch {
    // Routing remains available when job statistics cannot be read.
  }
  const recentCounts = Object.fromEntries(candidates.map((engine) => [
    engine, stats?.byEngine?.[engine]?.count || 0,
  ]));
  const confirmed = ready.filter(({ compatible }) => compatible === true);
  const compatible = (confirmed.length ? confirmed : ready).map(({ engine }) => engine);
  const healthy = compatible.filter((engine) => getConsecutiveFailures(stats, engine) < 2);
  const eligible = healthy.length ? healthy : compatible;
  const taskPref = routingCfg.taskTypes?.[normalizedTask];
  const policyPref = policy.startsWith("prefer-") ? policy.slice(7) : null;
  let selectedEngine;
  let reason;
  if (ready.length === 1) {
    selectedEngine = ready[0].engine;
    reason = `Only ${selectedEngine} is eligible. ${availability.filter(({ error }) => error).map(({ error }) => error).join(" ")}`.trim();
  } else if (compatible.length === 1) {
    selectedEngine = compatible[0];
    reason = `${selectedEngine} has confirmed flag compatibility.`;
  } else if (healthy.length === 1) {
    selectedEngine = healthy[0];
    const failures = Math.max(...compatible.filter((engine) => engine !== selectedEngine).map((engine) => getConsecutiveFailures(stats, engine)));
    reason = `Other compatible engines failed or timed out on their last ${failures} recent runs; routing to healthy ${selectedEngine} CLI.`;
  } else if (eligible.includes(taskPref) || eligible.includes(policyPref)) {
    selectedEngine = eligible.includes(taskPref) ? taskPref : policyPref;
    reason = selectedEngine === taskPref
      ? `Matched configured routing.taskTypes preference for "${normalizedTask}".`
      : `Configured routing policy is "${policy}".`;
  } else {
    selectedEngine = eligible.reduce((best, engine) =>
      recentCounts[engine] < recentCounts[best] ? engine : best);
    reason = `Policy "${policy}" selected ${selectedEngine} using recent run counts.`;
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
