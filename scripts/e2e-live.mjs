#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handleToolCall } from "../src/mcp-server.mjs";
import { JobManager } from "../src/jobs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const RM_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 };

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-live-e2e-"));
  const runGit = (args) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });

  runGit(["init"]);
  runGit(["config", "user.name", "E2E Tester"]);
  runGit(["config", "user.email", "e2e@example.com"]);

  const targetFile = path.join(dir, "math.mjs");
  fs.writeFileSync(
    targetFile,
    "export function divide(a, b) {\n  return a / b;\n}\n",
    "utf8",
  );
  runGit(["add", "math.mjs"]);
  runGit(["commit", "-m", "Initial commit"]);

  // Uncommitted division-by-zero edge case for review checks
  fs.writeFileSync(
    targetFile,
    "export function average(nums) {\n  let sum = 0;\n  for (const n of nums) sum += n;\n  return sum / nums.length;\n}\n",
    "utf8",
  );

  return dir;
}

async function main() {
  const results = [];
  const tempRepo = createTempRepo();
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-live-jobs-"));
  const outsideFile = path.join(
    os.tmpdir(),
    `agy-handoff-outside-test-${process.pid}.txt`,
  );
  fs.rmSync(outsideFile, { force: true });

  const jm = new JobManager(jobsDir);

  const record = async (name, fn) => {
    const start = Date.now();
    process.stdout.write(`-> ${name} ... `);
    try {
      const outcome = await fn();
      const ms = Date.now() - start;
      if (outcome && outcome.skipped) {
        console.log(`SKIP (${outcome.reason}, ${ms}ms)`);
        results.push({ name, status: "SKIP", ms, detail: outcome.reason });
      } else {
        console.log(`PASS (${ms}ms)`);
        results.push({ name, status: "PASS", ms, detail: outcome?.detail || "" });
      }
    } catch (err) {
      const ms = Date.now() - start;
      console.log(`FAIL (${ms}ms): ${err.message}`);
      results.push({ name, status: "FAIL", ms, detail: err.message });
    }
  };

  try {
    // 1. agy plugin validate --strict
    await record("agy plugin validate --strict .", async () => {
      const check = spawnSync("agy", ["--version"], { encoding: "utf8" });
      if (check.error) {
        return { skipped: true, reason: "agy binary not in PATH" };
      }
      const res = spawnSync("agy", ["plugin", "validate", "--strict", "."], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (res.status !== 0) {
        throw new Error(res.stderr || res.stdout || `exit ${res.status}`);
      }
    });

    // 2. Doctor compatibility inspection
    const doctor = await handleToolCall("handoff_doctor", {}, jm);
    const hasCodex = Boolean(doctor.engines.codex.accessible);
    const hasClaude = Boolean(doctor.engines.claude.accessible);

    await record("handoff_doctor CLI compatibility", async () => {
      if (!hasCodex && !hasClaude) {
        return { skipped: true, reason: "Neither codex nor claude CLI is accessible" };
      }
      if (hasCodex && doctor.engines.codex.compatible !== true) {
        throw new Error(
          doctor.engines.codex.compatibilityNote || "Codex incompatible",
        );
      }
      if (hasClaude && doctor.engines.claude.compatible !== true) {
        throw new Error(
          doctor.engines.claude.compatibilityNote || "Claude incompatible",
        );
      }
      return {
        detail: `codex=${doctor.engines.codex.version || "none"}, claude=${doctor.engines.claude.version || "none"}`,
      };
    });

    // 3. Real Codex read-only review
    await record("Codex live read-only review", async () => {
      if (!hasCodex) return { skipped: true, reason: "codex not accessible" };
      const res = await handleToolCall(
        "handoff_review",
        {
          engine: "codex",
          style: "standard",
          scope: "uncommitted",
          effort: "low",
          cwd: tempRepo,
          timeoutSec: 120,
        },
        jm,
      );
      if (!res.ok) throw new Error(res.output || res.stderr || "review failed");
    });

    // 4. Real Claude read-only review
    await record("Claude live read-only review", async () => {
      if (!hasClaude) return { skipped: true, reason: "claude not accessible" };
      const res = await handleToolCall(
        "handoff_review",
        {
          engine: "claude",
          style: "standard",
          scope: "uncommitted",
          effort: "low",
          cwd: tempRepo,
          timeoutSec: 120,
        },
        jm,
      );
      if (!res.ok) throw new Error(res.output || res.stderr || "review failed");
    });

    // 5. Real Codex read-only write prevention
    await record("Codex read-only prevents file writes", async () => {
      if (!hasCodex) return { skipped: true, reason: "codex not accessible" };
      await handleToolCall(
        "handoff_delegate",
        {
          engine: "codex",
          mode: "read-only",
          effort: "low",
          prompt: "Try creating a file named blocked_codex.txt containing TEST in the current working directory. If blocked, explain briefly.",
          cwd: tempRepo,
          timeoutSec: 90,
        },
        jm,
      );
      if (fs.existsSync(path.join(tempRepo, "blocked_codex.txt"))) {
        throw new Error("blocked_codex.txt was created in read-only mode!");
      }
    });

    // 6. Real Claude read-only write prevention
    await record("Claude read-only prevents file writes", async () => {
      if (!hasClaude) return { skipped: true, reason: "claude not accessible" };
      await handleToolCall(
        "handoff_delegate",
        {
          engine: "claude",
          mode: "read-only",
          effort: "low",
          prompt: "Try creating a file named blocked_claude.txt containing TEST using Write or Bash. If blocked, explain briefly.",
          cwd: tempRepo,
          timeoutSec: 90,
        },
        jm,
      );
      if (fs.existsSync(path.join(tempRepo, "blocked_claude.txt"))) {
        throw new Error("blocked_claude.txt was created in read-only mode!");
      }
    });

    // 7. Real Claude workspace-write with --restricted confinement
    await record("Claude workspace-write edits cwd but confines Write from outside paths", async () => {
      if (!hasClaude) return { skipped: true, reason: "claude not accessible" };
      const res = await handleToolCall(
        "handoff_delegate",
        {
          engine: "claude",
          mode: "workspace-write",
          effort: "low",
          prompt: `Using the Write tool, create ./allowed_edit.txt with text OK, and also attempt to Write ${outsideFile} with text ESCAPE.`,
          cwd: tempRepo,
          timeoutSec: 120,
        },
        jm,
      );
      if (!res.ok) {
        throw new Error(res.output || res.stderr || "workspace-write failed");
      }
      if (!fs.existsSync(path.join(tempRepo, "allowed_edit.txt"))) {
        throw new Error("allowed_edit.txt was not created inside workspace");
      }
      if (fs.existsSync(outsideFile)) {
        throw new Error("outsideFile was written despite --restricted confinement!");
      }
    });

    // 8. Real parallel cross-review
    await record("Parallel handoff_cross_review", async () => {
      if (!hasCodex || !hasClaude) {
        return { skipped: true, reason: "Requires both codex and claude" };
      }
      const res = await handleToolCall(
        "handoff_cross_review",
        {
          style: "standard",
          scope: "uncommitted",
          codexEffort: "low",
          claudeEffort: "low",
          cwd: tempRepo,
          timeoutSec: 120,
        },
        jm,
      );
      if (!res.ok || !res.results.codex.ok || !res.results.claude.ok) {
        throw new Error(JSON.stringify(res.summary));
      }
    });

    // 9. Real background job + live polling + stats
    await record("Background job + live events polling + stats", async () => {
      const engine = hasClaude ? "claude" : hasCodex ? "codex" : null;
      if (!engine) return { skipped: true, reason: "No CLI available" };
      const started = await handleToolCall(
        "handoff_review",
        {
          engine,
          style: "standard",
          scope: "uncommitted",
          effort: "low",
          cwd: tempRepo,
          background: true,
          timeoutSec: 120,
        },
        jm,
      );
      let snap;
      let sinceSeq = 0;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        snap = await handleToolCall(
          "handoff_job_status",
          { jobId: started.jobId, waitSec: 10, sinceSeq },
          jm,
        );
        if (snap.recentEvents?.length) {
          sinceSeq = Math.max(sinceSeq, ...snap.recentEvents.map((e) => e.seq || 0));
        }
        if (snap.status !== "running") break;
      }
      if (!snap || snap.status !== "completed") {
        throw new Error(`Background job ended with status=${snap?.status}`);
      }
      const res = await handleToolCall("handoff_job_result", { jobId: started.jobId }, jm);
      if (!res.output) throw new Error("Empty background output");
      const stats = jm.getStats();
      if (stats.analyzedJobs < 1) throw new Error("Stats did not record jobs");
    });

    // 10. Real session resume round-trip
    await record("Claude session resume round-trip", async () => {
      if (!hasClaude) return { skipped: true, reason: "claude not accessible" };
      const t1 = await handleToolCall(
        "handoff_delegate",
        {
          engine: "claude",
          mode: "read-only",
          effort: "low",
          prompt: "Remember the secret marker AGY_E2E_TOKEN_42 and reply ONLY with ACK.",
          cwd: tempRepo,
          timeoutSec: 90,
        },
        jm,
      );
      if (!t1.ok || !t1.sessionId) {
        throw new Error(`Turn 1 missing sessionId (ok=${t1.ok})`);
      }
      const t2 = await handleToolCall(
        "handoff_delegate",
        {
          engine: "claude",
          mode: "read-only",
          effort: "low",
          sessionId: t1.sessionId,
          prompt: "What exact secret marker did I ask you to remember in our previous turn? Reply with the marker only.",
          cwd: tempRepo,
          timeoutSec: 90,
        },
        jm,
      );
      if (!t2.ok || !/AGY_E2E_TOKEN_42/.test(t2.output)) {
        throw new Error(`Resumed turn did not recall token: ${t2.output}`);
      }
    });

    await record("Codex session resume round-trip", async () => {
      if (!hasCodex) return { skipped: true, reason: "codex not accessible" };
      const t1 = await handleToolCall(
        "handoff_delegate",
        {
          engine: "codex",
          mode: "read-only",
          effort: "low",
          prompt: "Remember the exact marker CODEX_E2E_99 and reply with ACK only.",
          cwd: tempRepo,
          timeoutSec: 90,
        },
        jm,
      );
      if (!t1.ok || !t1.sessionId) {
        throw new Error(`Turn 1 missing sessionId (ok=${t1.ok})`);
      }
      const t2 = await handleToolCall(
        "handoff_delegate",
        {
          engine: "codex",
          mode: "read-only",
          effort: "low",
          sessionId: t1.sessionId,
          prompt: "Repeat the exact marker from the previous message only.",
          cwd: tempRepo,
          timeoutSec: 90,
        },
        jm,
      );
      if (!t2.ok || !/CODEX_E2E_99/.test(t2.output)) {
        throw new Error(`Resumed turn did not recall token: ${t2.output}`);
      }
    });

    // 11. Context-aware handoff + executionEvidence + auto-routing + stats --table
    await record("Context-aware handoff, auto-routing & executionEvidence", async () => {
      if (!hasCodex && !hasClaude) {
        return { skipped: true, reason: "No CLI available" };
      }
      const res = await handleToolCall(
        "handoff_review",
        {
          engine: "auto",
          taskType: "review",
          style: "standard",
          scope: "custom",
          context: {
            files: ["math.mjs"],
            summary: "Verify average() behavior on an empty array.",
          },
          effort: "low",
          cwd: tempRepo,
          timeoutSec: 120,
        },
        jm,
      );
      if (!res.ok || !res.routingDecision || !res.executionEvidence) {
        throw new Error("Missing routingDecision or executionEvidence");
      }
      if (!res.handoffContext?.inlinedFiles?.includes("math.mjs")) {
        throw new Error("Expected math.mjs to be preloaded in the handoff context");
      }
      const { observedToolCalls, warnings } = res.executionEvidence;
      if (!Number.isInteger(observedToolCalls) || observedToolCalls < 0) {
        throw new Error("Expected a nonnegative observed tool call count");
      }
      if (observedToolCalls === 0 &&
          !warnings.some((warning) => warning.includes("No successful file reads"))) {
        throw new Error("Expected an evidence warning when reviewing preloaded code without tools");
      }
      const statsTable = spawnSync(
        process.execPath,
        [path.join(repoRoot, "src/cli.mjs"), "stats", "--table"],
        {
          encoding: "utf8",
          env: { ...process.env, AGY_HANDOFF_JOBS_DIR: jobsDir },
        },
      );
      if (statsTable.status !== 0 || !/By Engine:/.test(statsTable.stdout)) {
        throw new Error(statsTable.stderr || "stats --table failed");
      }
    });

    // 12. Structured JSON cross-review live against real Codex + Claude
    await record("Structured parallel cross-review & citation check", async () => {
      if (!hasCodex || !hasClaude) {
        return { skipped: true, reason: "Requires both codex and claude" };
      }
      const res = await handleToolCall(
        "handoff_cross_review",
        {
          style: "standard",
          scope: "uncommitted",
          context: { files: ["math.mjs"] },
          structured: true,
          codexEffort: "low",
          claudeEffort: "low",
          cwd: tempRepo,
          timeoutSec: 150,
        },
        jm,
      );
      if (
        !res.ok ||
        res.results.codex.skipped ||
        !res.results.codex.ok ||
        res.results.claude.skipped ||
        !res.results.claude.ok ||
        !res.structuredSynthesis
      ) {
        throw new Error(
          `Expected both engines to succeed with structuredSynthesis: codex.ok=${res.results?.codex?.ok}, claude.ok=${res.results?.claude?.ok}`,
        );
      }
      if (
        res.structuredSynthesis.parseErrors.codex ||
        res.structuredSynthesis.parseErrors.claude
      ) {
        throw new Error(
          `Structured parse error: ${JSON.stringify(res.structuredSynthesis.parseErrors)}`,
        );
      }
      const stages = res.structuredSynthesis.verificationStages;
      if (
        !stages?.cliExecution?.codex?.ok ||
        !stages?.cliExecution?.claude?.ok ||
        !stages?.structuredJsonParse?.codex?.ok ||
        !stages?.structuredJsonParse?.claude?.ok ||
        !stages?.citationValidity?.checked ||
        stages?.semanticVerification?.semanticallyVerified !== false
      ) {
        throw new Error(
          `Expected 4-stage verificationStages separation: ${JSON.stringify(stages)}`,
        );
      }
      return {
        detail: `consensus=${res.structuredSynthesis.consensus.length}, citations=${res.structuredSynthesis.citationSummary.validCitations}/${res.structuredSynthesis.citationSummary.totalFindings}`,
      };
    });
  } finally {
    jm.shutdown();
    fs.rmSync(outsideFile, { force: true });
    fs.rmSync(tempRepo, RM_OPTS);
    fs.rmSync(jobsDir, RM_OPTS);
  }

  console.log("\n=== Live E2E Summary ===");
  let failed = 0;
  for (const r of results) {
    console.log(`- [${r.status}] ${r.name} (${r.ms}ms)${r.detail ? ` — ${r.detail}` : ""}`);
    if (r.status === "FAIL") failed += 1;
  }
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
