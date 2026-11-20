import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobManager } from "../src/jobs.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-job-test-"));
}

async function waitForStatus(jm, jobId, targetStatuses, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = jm.getStatus(jobId);
    if (targetStatuses.includes(st.status)) return st;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

test("JobManager runs a background job, enforces private permissions, and flushes output before completed", async () => {
  const dir = makeTempDir();
  try {
    const jm = new JobManager(dir);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    }

    const expected = "X".repeat(64 * 1024);
    const started = jm.startJob({
      engine: "codex",
      action: "delegate",
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(expected)})`],
      cwd: dir,
    });

    assert.equal(started.status, "running");
    const done = await waitForStatus(jm, started.jobId, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.exitCode, 0);

    const res = jm.getResult(started.jobId);
    assert.equal(res.output, expected);

    if (process.platform !== "win32") {
      assert.equal(fs.statSync(jm.metaPath(started.jobId)).mode & 0o777, 0o600);
      assert.equal(fs.statSync(jm.stdoutPath(started.jobId)).mode & 0o777, 0o600);
    }

    const listed = jm.listJobs();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].jobId, started.jobId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("JobManager captures trailing JSONL events without newline and respects eventsLimit=0 / null", async () => {
  const dir = makeTempDir();
  try {
    const jm = new JobManager(dir);
    const script = `
      console.log(JSON.stringify({ type: "thread.started", thread_id: "thr_bg_99" }));
      setTimeout(() => {
        console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "npm test" } }));
      }, 60);
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "All green" } }));
      }, 140);
    `;
    const started = jm.startJob({
      engine: "codex",
      action: "review",
      model: "gpt-6.2-sol",
      effort: "high",
      command: process.execPath,
      args: ["-e", script],
      cwd: dir,
    });

    const snap1 = await jm.waitForStatus(started.jobId, {
      waitSec: 3,
      sinceSeq: 0,
      eventsLimit: 10,
    });
    assert.ok(snap1.recentEvents.length >= 1);

    // eventsLimit: 0 must return an empty array even while live or from disk
    assert.deepEqual(
      jm.getStatus(started.jobId, { eventsLimit: 0 }).recentEvents,
      [],
    );

    const done = await waitForStatus(jm, started.jobId, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.sessionId, "thr_bg_99");
    assert.equal(done.eventCount, 3);
    assert.ok(fs.existsSync(done.eventsPath));

    assert.deepEqual(
      jm.getStatus(started.jobId, { eventsLimit: 0 }).recentEvents,
      [],
    );
    const allEvents = jm.getStatus(started.jobId, {
      eventsLimit: null,
      sinceSeq: 0,
    }).recentEvents;
    assert.equal(allEvents.length, 3);
    assert.equal(allEvents[2].summary, "Note: All green");

    const res = jm.getResult(started.jobId);
    assert.equal(res.sessionId, "thr_bg_99");
    assert.equal(res.output, "All green");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("JobManager marks claude-json job failed when is_error is true", async () => {
  const dir = makeTempDir();
  try {
    const jm = new JobManager(dir);
    const started = jm.startJob({
      engine: "claude",
      action: "review",
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write(JSON.stringify({ result: "Quota exceeded", is_error: true, session_id: "s1" }))',
      ],
      cwd: dir,
      parseMode: "claude-json",
    });

    const done = await waitForStatus(jm, started.jobId, ["completed", "failed"]);
    assert.equal(done.status, "failed");
    assert.match(done.error, /Quota exceeded/);

    const res = jm.getResult(started.jobId);
    assert.equal(res.sessionId, "s1");
    assert.equal(res.output, "Quota exceeded");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("JobManager readOnly status leaves stale metadata untouched on disk and refuses unowned cancel", async () => {
  const dir = makeTempDir();
  try {
    const jm = new JobManager(dir);
    const secretFile = path.join(dir, "secret.txt");
    fs.writeFileSync(secretFile, "DO_NOT_LEAK", "utf8");

    const staleJobId = "codex-stale-ro-1";
    const staleJson = JSON.stringify({
      id: staleJobId,
      engine: "codex",
      action: "review",
      cwd: dir,
      pid: 999999,
      ownerPid: process.pid,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    fs.writeFileSync(jm.metaPath(staleJobId), staleJson, "utf8");

    // readOnly check must not mutate stale disk metadata
    const roStatus = jm.getStatus(staleJobId, { readOnly: true });
    assert.equal(roStatus.status, "running");
    assert.equal(fs.readFileSync(jm.metaPath(staleJobId), "utf8"), staleJson);

    const jobId = "codex-forged-1";
    const initialJson = JSON.stringify({
      id: jobId,
      engine: "codex",
      action: "review",
      cwd: dir,
      pid: process.pid,
      ownerPid: process.pid,
      status: "running",
      startedAt: new Date().toISOString(),
      stdoutPath: secretFile,
    });
    fs.writeFileSync(jm.metaPath(jobId), initialJson, "utf8");
    fs.writeFileSync(jm.stdoutPath(jobId), "SAFE_JOB_OUTPUT", "utf8");

    const cancelRes = jm.cancelJob(jobId);
    assert.equal(cancelRes.canceled, false);
    assert.match(cancelRes.message, /not owned by this server instance/i);

    const res = jm.getResult(jobId);
    assert.equal(res.output, "SAFE_JOB_OUTPUT");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("JobManager rejects symlinked jobs directory", () => {
  if (process.platform === "win32") return;
  const base = makeTempDir();
  try {
    const realTarget = path.join(base, "real");
    const linkDir = path.join(base, "link");
    fs.mkdirSync(realTarget);
    fs.symlinkSync(realTarget, linkDir);
    assert.throws(() => new JobManager(linkDir), /cannot be a symlink/i);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("JobManager cancels a running job cleanly and supports shutdown", async () => {
  const dir = makeTempDir();
  try {
    const jm = new JobManager(dir);
    const started = jm.startJob({
      engine: "claude",
      action: "review",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      cwd: dir,
    });

    const canceled = jm.cancelJob(started.jobId);
    assert.equal(canceled.canceled, true);
    assert.equal(canceled.status, "canceled");

    const st = jm.getStatus(started.jobId);
    assert.equal(st.status, "canceled");

    const deadline = Date.now() + 3000;
    while (jm.activeChildren.has(started.jobId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(jm.activeChildren.has(started.jobId), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
