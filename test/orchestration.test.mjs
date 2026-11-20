import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  captureGitDirtySnapshot,
  computeGitDelta,
  createExecutionEvidenceTracker,
  normalizeAndFormatContext,
} from "../src/context.mjs";
import {
  STRUCTURED_REVIEW_SCHEMA,
  buildStructuredSingleReview,
  parseStructuredReviewPayload,
  synthesizeStructuredCrossReview,
  verifyFindingCitation,
} from "../src/cross-review.mjs";
import { validateWorkspaceWriteCwd } from "../src/runners/common.mjs";
import { buildCodexExecSpec } from "../src/runners/codex.mjs";
import { buildClaudeExecSpec } from "../src/runners/claude.mjs";
import { parseCodexJsonLine, parseClaudeStreamJsonLine } from "../src/events.mjs";
import { resolveAutoEngine } from "../src/routing.mjs";
import { JobManager } from "../src/jobs.mjs";
import { handleToolCall } from "../src/mcp-server.mjs";
import { formatStatsTable } from "../src/watch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../src/cli.mjs");
const RM_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 };

async function waitDone(jm, jobId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = jm.getStatus(jobId, { eventsLimit: 0 });
    if (st.status !== "running") return st;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

test("normalizeAndFormatContext validates fields, workspace containment, and formats scoped prefix", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-ctx-test-"));
  try {
    fs.writeFileSync(path.join(dir, "app.mjs"), "console.log('hi');\n", "utf8");

    assert.deepEqual(normalizeAndFormatContext(null, dir), {
      promptPrefix: "",
      metadata: null,
    });

    const formatted = normalizeAndFormatContext(
      {
        files: ["app.mjs", "missing.mjs"],
        summary: "Null guard is missing in helper.",
        constraints: ["Do not modify CLI flags"],
        acceptanceCriteria: ["Unit tests pass"],
      },
      dir,
    );
    assert.match(formatted.promptPrefix, /## Handoff Context/);
    assert.match(formatted.promptPrefix, /`app\.mjs` \(exists\)/);
    assert.match(formatted.promptPrefix, /`missing\.mjs` \(missing on disk\)/);
    assert.deepEqual(formatted.metadata.missingFiles, ["missing.mjs"]);
    assert.equal(formatted.metadata.hasSummary, true);

    assert.throws(
      () => normalizeAndFormatContext({ files: ["../etc/passwd"] }, dir),
      /inside working directory/i,
    );
    assert.throws(
      () => normalizeAndFormatContext({ files: ["bad\x00path.mjs"] }, dir),
      /control characters/i,
    );
    assert.throws(
      () => normalizeAndFormatContext({ constraints: ["line1\n# Injected Heading"] }, dir),
      /line breaks/i,
    );
    assert.throws(
      () => normalizeAndFormatContext({ summary: "x".repeat(5000) }, dir),
      /exceeds/i,
    );
  } finally {
    fs.rmSync(dir, RM_OPTS);
  }
});

test("createExecutionEvidenceTracker tracks successful vs failed tools, avoids Codex file double-counting, and detects consecutive dirty edits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-ev-test-"));
  try {
    // 1. Denied Claude tool does not suppress silent-review warning
    const deniedTracker = createExecutionEvidenceTracker({
      action: "review",
      mode: "read-only",
      jsonStream: true,
    });
    for (const ev of parseClaudeStreamJsonLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "rm -rf /" } }] },
      }),
    )) {
      deniedTracker.recordEvent(ev);
    }
    for (const ev of parseClaudeStreamJsonLine(
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: true, content: "Denied" }] },
      }),
    )) {
      deniedTracker.recordEvent(ev);
    }
    const deniedEvidence = deniedTracker.finalize({ ok: true });
    assert.equal(deniedEvidence.observedToolCalls, 1);
    assert.equal(deniedEvidence.succeededToolCalls, 0);
    assert.equal(deniedEvidence.failedToolCalls, 1);
    assert.match(deniedEvidence.warnings[0], /No successful file reads/i);

    // 2. Codex file_change ignores item.started duplicate and collects all paths in changes[]
    const codexTracker = createExecutionEvidenceTracker({
      action: "delegate",
      mode: "workspace-write",
      jsonStream: true,
    });
    for (const ev of parseCodexJsonLine(
      JSON.stringify({
        type: "item.started",
        item: { type: "file_change", changes: [{ path: "a.mjs" }, { path: "b.mjs" }] },
      }),
    )) {
      codexTracker.recordEvent(ev);
    }
    for (const ev of parseCodexJsonLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", status: "completed", changes: [{ path: "a.mjs" }, { path: "b.mjs" }] },
      }),
    )) {
      codexTracker.recordEvent(ev);
    }
    const codexEvidence = codexTracker.finalize({ ok: true });
    assert.equal(codexEvidence.observedToolCalls, 1);
    assert.deepEqual(codexEvidence.filesModified, ["a.mjs", "b.mjs"]);

    // 3. Git dirty snapshot detects second edit to an already-modified file
    spawnSync("git", ["init"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.txt"), "1\n", "utf8");
    spawnSync("git", ["add", "a.txt"], { cwd: dir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.txt"), "dirty1\n", "utf8");

    const before = await captureGitDirtySnapshot(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "dirty2-even-longer-content\n", "utf8");
    fs.writeFileSync(path.join(dir, "new file.txt"), "hi\n", "utf8");
    const after = await captureGitDirtySnapshot(dir);
    const delta = computeGitDelta(before, after);
    assert.equal(delta.deltaCount, 2);
    assert.deepEqual(delta.changedOrAddedFiles, ["a.txt", "new file.txt"]);
  } finally {
    fs.rmSync(dir, RM_OPTS);
  }
});

test("verifyFindingCitation and synthesizeStructuredCrossReview check trailing newline bounds, symlinked cwd, unreadable paths, consensus, and conflicts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-xr-test-"));
  const linkBase = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-xr-link-"));
  try {
    // 4 lines ending in '\n'
    fs.writeFileSync(
      path.join(dir, "auth.mjs"),
      "export function verify(tok) {\n  if (!tok) return true;\n  return false;\n}\n",
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "empty.mjs"), "", "utf8");

    const valid = verifyFindingCitation({ file: "auth.mjs", line: 4 }, dir);
    assert.equal(valid.status, "valid_citation");
    assert.equal(valid.lineCount, 4);
    assert.equal(valid.semanticallyVerified, false);

    // Trailing newline does NOT create phantom line 5; empty file has lineCount 0
    assert.equal(verifyFindingCitation({ file: "auth.mjs", line: 5 }, dir).status, "line_out_of_range");
    assert.equal(verifyFindingCitation({ file: "empty.mjs", line: 1 }, dir).status, "line_out_of_range");

    // Directory / traversal returns safe status instead of throwing
    fs.mkdirSync(path.join(dir, "subdir"));
    assert.equal(verifyFindingCitation({ file: "subdir", line: 1 }, dir).status, "not_a_file");
    assert.equal(verifyFindingCitation({ file: "../etc/passwd", line: 1 }, dir).status, "path_outside_workspace");

    // Symlinked cwd accepts realpath inside workspace
    if (process.platform !== "win32") {
      const symCwd = path.join(linkBase, "ws-link");
      fs.symlinkSync(dir, symCwd);
      const viaSymlinkCwd = verifyFindingCitation(
        { file: path.join(fs.realpathSync(dir), "auth.mjs"), line: 2 },
        symCwd,
      );
      assert.equal(viaSymlinkCwd.status, "valid_citation");
    }

    const parsed = parseStructuredReviewPayload('```json\n{"summary":"ok","findings":[]}\n```');
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.parsed, { summary: "ok", findings: [] });
    assert.equal(STRUCTURED_REVIEW_SCHEMA.additionalProperties, false);

    const synthesis = synthesizeStructuredCrossReview({
      codexOutput: JSON.stringify({
        summary: "Found 2 issues",
        findings: [
          {
            severity: "critical",
            file: path.join(dir, "auth.mjs"), // absolute path matches relative path
            line: 2,
            title: "Bypass on empty token",
            detail: "Returns true when tok is empty",
            fix: "Return false when !tok",
          },
          {
            severity: "low",
            file: "ghost.mjs",
            line: 10,
            title: "Missing file citation",
            detail: "Does not exist",
            fix: "N/A",
          },
        ],
      }),
      claudeStructured: {
        summary: "Found 2 issues",
        findings: [
          {
            severity: "high",
            file: "./auth.mjs",
            line: 3,
            title: "Broken auth check",
            detail: "Empty token accepted",
            fix: "Reject empty token",
          },
          {
            severity: "medium",
            file: "auth.mjs",
            line: 1,
            title: "No type validation",
            detail: "Check typeof",
            fix: "Ensure string",
          },
        ],
      },
      cwd: dir,
    });

    assert.equal(synthesis.consensus.length, 1);
    assert.ok(synthesis.consensus[0].matchBasis.sharedTokens.includes("empty"));
    assert.ok(synthesis.consensus[0].matchBasis.sharedTokens.includes("token"));
    assert.equal(synthesis.conflicts.length, 1);
    assert.equal(synthesis.conflicts[0].codexSeverity, "critical");
    assert.equal(synthesis.conflicts[0].claudeSeverity, "high");
    assert.equal(synthesis.uniqueCodex.length, 1);
    assert.equal(synthesis.uniqueCodex[0].citation.status, "missing_file");
    assert.equal(synthesis.uniqueClaude.length, 1);
    assert.equal(synthesis.citationSummary.validCitations, 3);
    assert.equal(synthesis.citationSummary.invalidOrMissingCitations, 1);
    assert.equal(synthesis.verificationStages.cliExecution.codex.ok, true);
    assert.equal(synthesis.verificationStages.structuredJsonParse.codex.ok, true);
    assert.equal(synthesis.verificationStages.citationValidity.validCitations, 3);
    assert.equal(synthesis.verificationStages.semanticVerification.verified, false);
    assert.equal(synthesis.verificationStages.semanticVerification.semanticallyVerified, false);

    // Distinct bugs on the exact same/adjacent lines MUST NOT be merged into consensus
    const distinctNearby = synthesizeStructuredCrossReview({
      codexStructured: {
        summary: "Codex finding",
        findings: [
          {
            severity: "high",
            file: "auth.mjs",
            line: 2,
            title: "SQL injection in raw query interpolation",
            detail: "User input concatenated directly into SQL query string",
            fix: "Use parameterized prepared statements",
          },
        ],
      },
      claudeStructured: {
        summary: "Claude finding",
        findings: [
          {
            severity: "medium",
            file: "auth.mjs",
            line: 2,
            title: "Unclosed file descriptor leak on early return",
            detail: "File handle opened with fs.openSync is never closed in finally block",
            fix: "Wrap descriptor usage in try/finally with fs.closeSync",
          },
        ],
      },
      cwd: dir,
    });
    assert.equal(distinctNearby.consensus.length, 0);
    assert.equal(distinctNearby.conflicts.length, 0);
    assert.equal(distinctNearby.uniqueCodex.length, 1);
    assert.equal(distinctNearby.uniqueClaude.length, 1);

    // 3-to-1 Cross-Review synthesis (Codex + Claude + Antigravity Neon High -> Session Model)
    const threeWay = synthesizeStructuredCrossReview({
      codexStructured: {
        summary: "Codex review",
        findings: [
          {
            severity: "critical",
            file: "auth.mjs",
            line: 2,
            title: "Bypass on empty token",
            detail: "Returns true when tok is empty",
            fix: "Return false when !tok",
          },
        ],
      },
      claudeStructured: {
        summary: "Claude review",
        findings: [
          {
            severity: "critical",
            file: "auth.mjs",
            line: 2,
            title: "Empty token auth bypass",
            detail: "Empty token accepted as valid",
            fix: "Reject empty token",
          },
          {
            severity: "medium",
            file: "auth.mjs",
            line: 1,
            title: "Missing typeof string check",
            detail: "Check typeof tok === string",
            fix: "Validate string type",
          },
        ],
      },
      agyStructured: {
        summary: "Antigravity Neon High review",
        findings: [
          {
            severity: "critical",
            file: "auth.mjs",
            line: 2,
            title: "Authentication bypass when token is empty",
            detail: "!tok returns true instead of false",
            fix: "Return false on empty token",
          },
          {
            severity: "medium",
            file: "auth.mjs",
            line: 1,
            title: "No typeof string validation on token parameter",
            detail: "Non-string tok input is not checked with typeof",
            fix: "Add typeof tok !== string check",
          },
          {
            severity: "low",
            file: "auth.mjs",
            line: 3,
            title: "Constant false return stub",
            detail: "Function always returns false for non-empty token",
            fix: "Implement real signature verification",
          },
        ],
      },
      cwd: dir,
    });
    assert.equal(threeWay.architecture, "3-to-1");
    assert.equal(threeWay.consensus.length, 2);
    // Finding 1: 3/3 Unanimous across Codex + Claude + AGY Neon High
    assert.deepEqual(threeWay.consensus[0].agreedBy, ["codex", "claude", "agy"]);
    assert.equal(threeWay.consensus[0].agreementCount, 3);
    assert.equal(threeWay.consensus[0].unanimous, true);
    assert.equal(threeWay.consensus[0].severityMatch, true);
    // Finding 2: 2/3 Majority across Claude + AGY Neon High
    assert.deepEqual(threeWay.consensus[1].agreedBy, ["claude", "agy"]);
    assert.equal(threeWay.consensus[1].agreementCount, 2);
    assert.equal(threeWay.consensus[1].unanimous, false);
    // Finding 3: 1/3 Unique to AGY Neon High
    assert.equal(threeWay.uniqueAgy.length, 1);
    assert.equal(threeWay.verificationStages.cliExecution.agy.ok, true);
    assert.equal(threeWay.verificationStages.structuredJsonParse.agy.ok, true);
    assert.equal(
      threeWay.verificationStages.semanticVerification.synthesizer,
      "current_session_model",
    );

    // Explicit separation of CLI execution success vs Structured JSON parse failure
    const singleParseFail = buildStructuredSingleReview({
      engine: "codex",
      cliOk: true,
      exitCode: 0,
      output: "Non-JSON plain text review output",
      cwd: dir,
    });
    assert.equal(singleParseFail.verificationStages.cliExecution.ok, true);
    assert.equal(singleParseFail.verificationStages.structuredJsonParse.ok, false);
    assert.match(singleParseFail.parseError, /Failed to parse JSON/i);
    assert.equal(singleParseFail.verificationStages.citationValidity.checked, false);
    assert.equal(singleParseFail.verificationStages.semanticVerification.semanticallyVerified, false);

    // Schema violation inside valid JSON (invalid severity enum) fails structuredJsonParse
    const invalidSchemaJson = parseStructuredReviewPayload({
      summary: "ok",
      findings: [
        {
          severity: "urgent",
          file: "auth.mjs",
          line: 1,
          title: "Bad severity",
          detail: "d",
          fix: "f",
        },
      ],
    });
    assert.equal(invalidSchemaJson.parsed, null);
    assert.match(invalidSchemaJson.error, /invalid severity/i);
  } finally {
    fs.rmSync(dir, RM_OPTS);
    fs.rmSync(linkBase, RM_OPTS);
  }
});

test("workspace-write boundary blocks root/home/system directories, sessionId='last', and flags suspicious external shell commands", () => {
  const rootDir = path.parse(process.cwd()).root;
  assert.throws(
    () => validateWorkspaceWriteCwd(rootDir),
    /Refusing workspace-write in filesystem root/i,
  );
  assert.throws(
    () => validateWorkspaceWriteCwd(os.homedir()),
    /Refusing workspace-write directly in the user home directory/i,
  );
  if (process.platform !== "win32" && fs.existsSync("/etc")) {
    assert.throws(
      () => validateWorkspaceWriteCwd("/etc"),
      /Refusing workspace-write in protected system directory/i,
    );
  }
  assert.throws(
    () =>
      buildCodexExecSpec({
        prompt: "Apply fix",
        cwd: os.tmpdir(),
        mode: "workspace-write",
        sessionId: "last",
      }),
    /Refusing to use sessionId="last" in workspace-write mode/i,
  );
  assert.throws(
    () =>
      buildClaudeExecSpec({
        prompt: "Apply fix",
        cwd: os.homedir(),
        mode: "workspace-write",
      }),
    /Refusing workspace-write directly in the user home directory/i,
  );

  const tracker = createExecutionEvidenceTracker({
    action: "delegate",
    mode: "workspace-write",
    jsonStream: true,
  });
  for (const ev of parseCodexJsonLine(
    JSON.stringify({
      type: "item.started",
      item: { id: "cmd_1", type: "command_execution", command: "cat /etc/passwd" },
    }),
  )) {
    tracker.recordEvent(ev);
  }
  const evidence = tracker.finalize({ ok: true });
  assert.ok(
    evidence.warnings.some((w) => /referencing paths outside the workspace/i.test(w)),
  );
});

test("resolveAutoEngine respects workspace-write sandbox guard, effort/model constraints, compatibility, and failure streaks", async () => {
  const ready = async () => ({ accessible: true, compatible: true });
  const unverified = async () => ({ accessible: true, compatible: null });
  const missing = async () => ({ accessible: false, compatible: null });

  // Single engine fallback
  const onlyClaude = await resolveAutoEngine({
    taskType: "review",
    config: {},
    inspectCodexFn: missing,
    inspectClaudeFn: ready,
  });
  assert.equal(onlyClaude.selectedEngine, "claude");

  // Prefer confirmed compatibility over null
  const confirmedCodex = await resolveAutoEngine({
    taskType: "review",
    config: {},
    inspectCodexFn: ready,
    inspectClaudeFn: unverified,
  });
  assert.equal(confirmedCodex.selectedEngine, "codex");

  // workspace-write excludes Claude unless explicitly allowed
  await assert.rejects(
    () =>
      resolveAutoEngine({
        taskType: "implementation",
        mode: "workspace-write",
        config: {},
        inspectCodexFn: missing,
        inspectClaudeFn: ready,
      }),
    /No eligible CLI available/i,
  );

  // effort=ultra excludes Claude and selects Codex even if policy prefers Claude
  const ultraChoice = await resolveAutoEngine({
    taskType: "review",
    effort: "ultra",
    config: { routing: { policy: "prefer-claude" } },
    inspectCodexFn: ready,
    inspectClaudeFn: ready,
  });
  assert.equal(ultraChoice.selectedEngine, "codex");

  // Explicit single-engine model rejected with engine=auto
  await assert.rejects(
    () =>
      resolveAutoEngine({
        model: "gpt-6.2-sol",
        config: {},
        inspectCodexFn: ready,
        inspectClaudeFn: ready,
      }),
    /Cannot specify explicit `model`/i,
  );

  // Consecutive failure avoidance overrides preference even past top-10 jobs
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-route-test-"));
  try {
    const jm = new JobManager(dir);
    jm.writeMeta({
      id: "codex-fail-1",
      engine: "codex",
      action: "review",
      status: "failed",
      startedAt: "2026-11-20T10:00:00Z",
      finishedAt: "2026-11-20T10:00:05Z",
    });
    jm.writeMeta({
      id: "codex-fail-2",
      engine: "codex",
      action: "review",
      status: "timed_out",
      startedAt: "2026-11-20T10:01:00Z",
      finishedAt: "2026-11-20T10:01:10Z",
    });
    jm.writeMeta({
      id: "claude-ok-1",
      engine: "claude",
      action: "review",
      status: "completed",
      startedAt: "2026-11-20T09:59:00Z",
      finishedAt: "2026-11-20T09:59:05Z",
    });

    const healthDecision = await resolveAutoEngine({
      taskType: "review",
      config: { routing: { policy: "prefer-codex", taskTypes: { review: "codex" } } },
      jobManager: jm,
      inspectCodexFn: ready,
      inspectClaudeFn: ready,
    });
    assert.equal(healthDecision.selectedEngine, "claude");
    assert.match(healthDecision.routingDecision.reason, /last 2 recent runs/i);
  } finally {
    fs.rmSync(dir, RM_OPTS);
  }
});

test("JobManager.retryJob and handoff_job_retry enforce read-only, block oversized prompts/disk tampering, and render stats --table", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-retry-test-"));
  try {
    const jm = new JobManager(dir);

    // 1. In-memory read-only job retries cleanly
    const roJob = jm.startJob({
      engine: "codex",
      action: "delegate",
      mode: "read-only",
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      cwd: dir,
    });
    await waitDone(jm, roJob.jobId);
    assert.equal(jm.getStatus(roJob.jobId, { eventsLimit: 0 }).retryable, true);

    const replayed = jm.retryJob(roJob.jobId);
    assert.equal(jm.getStatus(replayed.jobId, { eventsLimit: 0 }).retryOf, roJob.jobId);
    await waitDone(jm, replayed.jobId);

    // 2. Tampered disk metadata (no inMemoryReplay entry) cannot run arbitrary command/args
    const forgedId = "forged-disk-cmd-1";
    jm.writeMeta({
      id: forgedId,
      engine: "codex",
      action: "delegate",
      mode: "read-only",
      retryable: true,
      cwd: dir,
      status: "failed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      replaySpec: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    });
    assert.throws(
      () => jm.retryJob(forgedId),
      /unverified disk command/i,
    );

    // 3. Oversized (> 64 KB) stdin marks read-only job non-retryable instead of running empty stdin
    const bigJob = jm.startJob({
      engine: "codex",
      action: "delegate",
      mode: "read-only",
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      stdin: "X".repeat(70 * 1024),
      cwd: dir,
    });
    await waitDone(jm, bigJob.jobId);
    assert.equal(jm.getStatus(bigJob.jobId, { eventsLimit: 0 }).retryable, false);
    assert.throws(() => jm.retryJob(bigJob.jobId), /not retryable/i);

    // 4. workspace-write and legacy (mode: null -> "unknown") jobs refuse retry
    const rwJob = jm.startJob({
      engine: "claude",
      action: "delegate",
      mode: "workspace-write",
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      cwd: dir,
    });
    await waitDone(jm, rwJob.jobId);
    assert.equal(jm.getStatus(rwJob.jobId, { eventsLimit: 0 }).retryable, false);
    assert.throws(
      () => jm.retryJob(rwJob.jobId),
      /Refusing to retry non-read-only job/i,
    );
    await assert.rejects(
      () => handleToolCall("handoff_job_retry", { jobId: rwJob.jobId }, jm),
      /Refusing to retry non-read-only job/i,
    );

    // 5. CLI stats --table formatting
    const stats = jm.getStats();
    const table = formatStatsTable(stats);
    assert.match(table, /By Engine:/);
    assert.match(table, /codex/);
    assert.match(table, /never estimated/i);

    const tableCli = spawnSync(process.execPath, [cliPath, "stats", "--table"], {
      encoding: "utf8",
      env: { ...process.env, AGY_HANDOFF_JOBS_DIR: dir },
    });
    assert.equal(tableCli.status, 0);
    assert.match(tableCli.stdout, /agy-handoff usage & performance stats/);
  } finally {
    fs.rmSync(dir, RM_OPTS);
  }
});
