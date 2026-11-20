import { JobManager } from "./jobs.mjs";
import { compactText, stripAnsiAndControl } from "./events.mjs";

export function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins === 0) return `${secs}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs === 0) return `${mins}m ${secs}s`;
  return `${hrs}h ${mins % 60}m ${secs}s`;
}

function statusBadge(status) {
  switch (status) {
    case "running":
      return "[RUNNING]";
    case "completed":
      return "[DONE]";
    case "failed":
      return "[FAILED]";
    case "timed_out":
      return "[TIMEOUT]";
    case "canceled":
      return "[CANCELED]";
    default:
      return `[${String(status || "UNKNOWN").toUpperCase()}]`;
  }
}

function formatTime(iso) {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toTimeString().slice(0, 8);
}

function sanitizeField(text, maxLen = 160) {
  return compactText(stripAnsiAndControl(text), maxLen);
}

function renderSnapshotData(
  jobManager,
  { jobId, eventsLimit = 8, limit = 10 } = {},
) {
  let jobs = [];
  if (jobId) {
    jobManager.validateJobId(jobId);
    try {
      jobs = [jobManager.getStatus(jobId, { eventsLimit, readOnly: true })];
    } catch (err) {
      if (!/^Job not found:/.test(err.message)) {
        throw err;
      }
      return {
        text: `agy-handoff live monitor (${jobManager.jobsDir})\n\nWaiting for job ${jobId}...\n`,
        jobs: [],
      };
    }
  } else {
    const listed = jobManager.listJobs(Math.max(limit, 50), { readOnly: true });
    const detailed = [];
    for (const j of listed) {
      try {
        detailed.push(
          jobManager.getStatus(j.jobId, { eventsLimit, readOnly: true }),
        );
      } catch {
        // skip jobs pruned concurrently
      }
    }
    const running = detailed.filter((j) => j.status === "running");
    const finished = detailed.filter((j) => j.status !== "running").slice(0, 4);
    jobs = [...running, ...finished].slice(0, limit);
  }

  const lines = [
    `agy-handoff live monitor (${jobManager.jobsDir})`,
    `${"=".repeat(64)}`,
  ];

  if (jobs.length === 0) {
    lines.push("No handoff jobs recorded yet.");
    return { text: `${lines.join("\n")}\n`, jobs };
  }

  for (const job of jobs) {
    const modelStr = job.model
      ? `${sanitizeField(job.model, 60)}${job.effort ? `/${sanitizeField(job.effort, 20)}` : ""}`
      : "cli-default";
    const modeTag = job.foreground ? "fg" : "bg";
    lines.push(
      `${statusBadge(job.status)} ${job.jobId}  (${job.engine}:${job.action}, ${modeTag}, ${modelStr}, ${formatElapsed(job.elapsedMs)})`,
    );
    if (job.currentActivity) {
      lines.push(`  Now: ${sanitizeField(job.currentActivity, 140)}`);
    }
    if (job.sessionId) {
      lines.push(`  Session: ${sanitizeField(job.sessionId, 80)}`);
    }
    if (job.recentEvents && job.recentEvents.length > 0) {
      for (const ev of job.recentEvents) {
        lines.push(
          `  [${formatTime(ev.ts)}] #${ev.seq} ${sanitizeField(ev.summary, 140)}`,
        );
      }
    } else {
      lines.push("  (no activity events yet)");
    }
    if (job.error) {
      lines.push(`  Error: ${sanitizeField(job.error, 200)}`);
    }
    lines.push("");
  }

  return { text: `${lines.join("\n")}`, jobs };
}

export function renderWatchSnapshot(jobManager, opts = {}) {
  return renderSnapshotData(jobManager, opts).text;
}

export async function runWatch({
  jobId,
  once = false,
  stream = false,
  intervalMs = 500,
  limit = 10,
  jobsDir,
} = {}) {
  process.stdout.on("error", () => {});

  const jobManager = new JobManager(jobsDir);
  if (jobId) {
    jobManager.validateJobId(jobId);
  }

  if (once) {
    process.stdout.write(renderWatchSnapshot(jobManager, { jobId, limit }));
    return;
  }

  const useStream = stream || !process.stdout.isTTY;
  let stop = false;
  let activeSleepTimer = null;
  let activeSleepResolve = null;

  const sleep = (ms) =>
    new Promise((resolve) => {
      if (stop) {
        resolve();
        return;
      }
      activeSleepResolve = resolve;
      activeSleepTimer = setTimeout(() => {
        activeSleepTimer = null;
        activeSleepResolve = null;
        resolve();
      }, ms);
    });

  const onStop = () => {
    stop = true;
    if (activeSleepTimer) {
      clearTimeout(activeSleepTimer);
      activeSleepTimer = null;
    }
    if (activeSleepResolve) {
      const resolve = activeSleepResolve;
      activeSleepResolve = null;
      resolve();
    }
  };

  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  try {
    if (useStream) {
      const seenSeq = new Map();
      const printedStart = new Set();
      const lastStatus = new Map();
      let initialized = false;

      while (!stop) {
        let targets = [];
        if (jobId) {
          try {
            targets = [
              jobManager.getStatus(jobId, {
                eventsLimit: null,
                sinceSeq: seenSeq.get(jobId) || 0,
                readOnly: true,
              }),
            ];
          } catch (err) {
            if (!/^Job not found:/.test(err.message)) {
              throw err;
            }
            targets = [];
          }
        } else {
          const listed = jobManager.listJobs(Math.max(limit, 50), {
            readOnly: true,
          });
          for (const j of listed) {
            try {
              targets.push(
                jobManager.getStatus(j.jobId, {
                  eventsLimit: null,
                  sinceSeq: seenSeq.get(j.jobId) || 0,
                  readOnly: true,
                }),
              );
            } catch {
              // ignore jobs pruned concurrently
            }
          }
        }

        for (const job of targets) {
          if (!initialized && !jobId && job.status !== "running") {
            seenSeq.set(job.jobId, job.eventCount || 0);
            lastStatus.set(job.jobId, job.status);
            continue;
          }

          if (!printedStart.has(job.jobId) && (job.status === "running" || jobId)) {
            printedStart.add(job.jobId);
            const modelStr = job.model
              ? `${sanitizeField(job.model, 60)}${job.effort ? `/${sanitizeField(job.effort, 20)}` : ""}`
              : "cli-default";
            process.stdout.write(
              `[${formatTime(job.startedAt)}] [${job.jobId}] ${statusBadge(job.status)} ${job.engine}:${job.action} (${modelStr})\n`,
            );
          }

          for (const ev of job.recentEvents || []) {
            process.stdout.write(
              `[${formatTime(ev.ts)}] [${job.jobId}] #${ev.seq} ${sanitizeField(ev.summary, 140)}\n`,
            );
            seenSeq.set(job.jobId, Math.max(seenSeq.get(job.jobId) || 0, ev.seq || 0));
          }

          const prev = lastStatus.get(job.jobId);
          lastStatus.set(job.jobId, job.status);

          if (job.status !== "running" && (jobId || prev === "running")) {
            process.stdout.write(
              `[${formatTime(job.finishedAt)}] [${job.jobId}] ${statusBadge(job.status)} elapsed=${formatElapsed(job.elapsedMs)}${job.error ? ` error=${sanitizeField(job.error, 160)}` : ""}\n`,
            );
            if (jobId) {
              return;
            }
          }
        }

        if (!jobId) {
          const activeIds = new Set(targets.map((t) => t.jobId));
          for (const id of seenSeq.keys()) {
            if (!activeIds.has(id)) seenSeq.delete(id);
          }
          for (const id of printedStart) {
            if (!activeIds.has(id)) printedStart.delete(id);
          }
          for (const id of lastStatus.keys()) {
            if (!activeIds.has(id)) lastStatus.delete(id);
          }
        }

        initialized = true;
        await sleep(intervalMs);
      }
      return;
    }

    while (!stop) {
      const { text, jobs } = renderSnapshotData(jobManager, { jobId, limit });
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(text);
      process.stdout.write("Press Ctrl+C to exit.\n");

      if (jobId && jobs[0] && jobs[0].status !== "running") {
        return;
      }

      await sleep(intervalMs);
    }
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
  }
}

function makeBar(pct, width = 20) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const filled = Math.round((clamped / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

export function formatStatsTable(stats) {
  const s = stats || {};
  const byStatus = s.byStatus || {};
  const lines = [
    `agy-handoff usage & performance stats (${s.jobsDir || "n/a"})`,
    `${"=".repeat(72)}`,
    `Jobs: ${s.analyzedJobs ?? 0} analyzed (${s.retainedJobs ?? 0} retained) | Finished: ${s.finishedCount ?? 0} | Success rate: ${s.successRatePct !== null && s.successRatePct !== undefined ? `${s.successRatePct}%` : "n/a"}`,
    `Status breakdown: completed=${byStatus.completed ?? 0}, failed=${byStatus.failed ?? 0}, timed_out=${byStatus.timed_out ?? 0}, canceled=${byStatus.canceled ?? 0}, running=${byStatus.running ?? 0}`,
    "",
    "By Engine:",
  ];

  for (const engineName of ["codex", "claude", "agy"]) {
    const e = s.byEngine?.[engineName];
    if (!e) continue;
    if (engineName === "agy" && e.count === 0) continue;
    const avg = e.avgDurationMs !== null ? formatElapsed(e.avgDurationMs) : "n/a";
    const tokens =
      e.reportedTokens?.jobsWithUsage > 0
        ? `tokens(in=${e.reportedTokens.input}, out=${e.reportedTokens.output})`
        : "tokens(unreported)";
    const cost =
      e.reportedCostUsd !== null && e.reportedCostUsd !== undefined
        ? `, cost=$${e.reportedCostUsd}`
        : "";
    lines.push(
      `  ${engineName.padEnd(7)} ${makeBar(e.sharePct)} ${String(e.sharePct.toFixed(1)).padStart(5)}% | total=${e.count} ok=${e.completed} fail=${e.failed} timeout=${e.timedOut} | avg=${avg} | ${tokens}${cost}`,
    );
  }

  const models = Object.values(s.byModel || {});
  if (models.length > 0) {
    lines.push("");
    lines.push("By Model:");
    for (const m of models) {
      const label = `${m.engine}/${m.model || "cli-default"}`;
      const avg = m.avgDurationMs !== null ? formatElapsed(m.avgDurationMs) : "n/a";
      lines.push(
        `  ${label.padEnd(28)} total=${m.count} ok=${m.completed} fail=${m.failed} timeout=${m.timedOut} avg=${avg}`,
      );
    }
  }

  lines.push("");
  lines.push(
    `Note: ${s.scopeNote || "Metrics reflect CLI-reported values on retained job logs only."}`,
  );
  return `${lines.join("\n")}\n`;
}
