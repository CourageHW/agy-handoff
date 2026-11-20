import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JobManager } from "../src/jobs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../src/cli.mjs");
const RM_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 };

function runCli(args, envOverrides = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...envOverrides },
  });
}

test("CLI supports --help after subcommands and rejects invalid flags/timeouts/background", () => {
  const help = runCli(["review", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /agy-handoff CLI/);

  const unknown = runCli(["review", "--bogus", "1"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown option: --bogus/);

  const badTimeout1 = runCli(["review", "--timeout", "-1"]);
  assert.notEqual(badTimeout1.status, 0);
  assert.match(badTimeout1.stderr, /Invalid --timeout/);

  const badTimeout2 = runCli(["review", "--timeout", "abc"]);
  assert.notEqual(badTimeout2.status, 0);
  assert.match(badTimeout2.stderr, /Invalid --timeout/);

  const bg = runCli(["review", "--background"]);
  assert.notEqual(bg.status, 0);
  assert.match(bg.stderr, /--background is only supported via the persistent MCP server/);
});

test("CLI models show/set/reset persists and resolves per-command defaults", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-cli-test-"));
  const cfgPath = path.join(tmpDir, "config.json");
  try {
    const show1 = runCli(["models", "show"], {
      AGY_HANDOFF_CONFIG: cfgPath,
      PLUGIN_DATA: tmpDir,
    });
    assert.equal(show1.status, 0);
    const json1 = JSON.parse(show1.stdout);
    assert.equal(json1.effective.review.codex.model, "gpt-6.2-sol");
    assert.equal(json1.effective.review.claude.model, "claude-opus-5-5");

    const setRes = runCli(
      ["models", "set", "review", "codex", "gpt-6.1-sol", "xhigh"],
      { AGY_HANDOFF_CONFIG: cfgPath, PLUGIN_DATA: tmpDir },
    );
    assert.equal(setRes.status, 0);
    const json2 = JSON.parse(setRes.stdout);
    assert.equal(json2.effective.review.codex.model, "gpt-6.1-sol");
    assert.equal(json2.effective.review.codex.effort, "xhigh");

    const resetRes = runCli(["models", "reset", "all"], {
      AGY_HANDOFF_CONFIG: cfgPath,
      PLUGIN_DATA: tmpDir,
    });
    assert.equal(resetRes.status, 0);
    const json3 = JSON.parse(resetRes.stdout);
    assert.equal(json3.effective.review.codex.model, "gpt-6.2-sol");
    assert.equal(json3.effective.review.codex.modelSource, "builtin");
  } finally {
    fs.rmSync(tmpDir, RM_OPTS);
  }
});

test("CLI watch --once strips terminal escapes and rejects invalid jobId", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-watch-test-"));
  try {
    const jm = new JobManager(path.join(tmpDir, "jobs"));
    const tracker = jm.beginForegroundRun({
      engine: "claude",
      action: "review",
      cwd: tmpDir,
      model: "claude-opus-5-5",
      effort: "high",
    });
    tracker.recordEvent({
      ts: new Date().toISOString(),
      seq: 1,
      engine: "claude",
      kind: "tool_start",
      tool: "Read",
      summary: "\x1b[31mRead:\x1b[0m src/cli.mjs",
    });
    await tracker.finish({ status: "completed", exitCode: 0, sessionId: "sess_watch" });

    const watchHelp = runCli(["watch", "--help"]);
    assert.equal(watchHelp.status, 0);

    const badWatch = runCli(["watch", "../evil", "--once"], { PLUGIN_DATA: tmpDir });
    assert.notEqual(badWatch.status, 0);
    assert.match(badWatch.stderr, /Invalid jobId/);

    const watchRes = runCli(["watch", "--once"], { PLUGIN_DATA: tmpDir });
    assert.equal(watchRes.status, 0);
    assert.match(watchRes.stdout, /agy-handoff live monitor/);
    assert.match(watchRes.stdout, /\[DONE\]/);
    assert.match(watchRes.stdout, /Read: src\/cli\.mjs/);
    assert.ok(!watchRes.stdout.includes("\x1b[31m"));

    const statsRes = runCli(["stats"], { PLUGIN_DATA: tmpDir });
    assert.equal(statsRes.status, 0);
    const statsJson = JSON.parse(statsRes.stdout);
    assert.equal(statsJson.analyzedJobs, 1);
    assert.equal(statsJson.byEngine.claude.completed, 1);
    assert.equal(statsJson.reportedMetricsOnly, true);

    const jobsStatsRes = runCli(["jobs", "stats"], { PLUGIN_DATA: tmpDir });
    assert.equal(jobsStatsRes.status, 0);
    assert.equal(JSON.parse(jobsStatsRes.stdout).analyzedJobs, 1);
  } finally {
    fs.rmSync(tmpDir, RM_OPTS);
  }
});
