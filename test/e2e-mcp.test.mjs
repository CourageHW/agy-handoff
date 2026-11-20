import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const serverPath = path.resolve(repoRoot, "src/mcp-server.mjs");
const RM_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 };

function createFakeExecutable(dir, name, jsSource) {
  const scriptPath = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${jsSource}`, {
    encoding: "utf8",
    mode: 0o755,
  });
  if (process.platform === "win32") {
    const cmdPath = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(
      cmdPath,
      `@"${process.execPath}" "%~dp0\\${name}.mjs" %*\r\n`,
      "utf8",
    );
    return cmdPath;
  }
  return scriptPath;
}

class McpStdioClient {
  constructor(envOverrides = {}, serverArgs = [serverPath]) {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.child = spawn(process.execPath, serverArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...envOverrides },
    });

    this.exitPromise = new Promise((resolve, reject) => {
      this.child.on("error", reject);
      this.child.on("close", (code) => {
        for (const [, entry] of this.pending.entries()) {
          entry.reject(new Error(`Server exited (${code}) before responding: ${this.stderr}`));
        }
        this.pending.clear();
        if (code !== 0) {
          reject(new Error(`MCP server exited ${code}: ${this.stderr}`));
        } else {
          resolve();
        }
      });
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          entry.resolve(msg);
        }
      }
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  notify(method, params) {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  async callTool(name, args = {}) {
    const resp = await this.request("tools/call", { name, arguments: args });
    if (resp.error) {
      throw new Error(`RPC error: ${resp.error.message}`);
    }
    const text = resp.result?.content?.[0]?.text || "{}";
    return {
      isError: Boolean(resp.result?.isError),
      text,
      data: text.startsWith("{") ? JSON.parse(text) : null,
    };
  }

  async close() {
    this.child.stdin.end();
    await this.exitPromise;
  }
}

function createFakeCodexScript(recordFile) {
  return `
    import fs from "node:fs";
    const args = process.argv.slice(2);
    if (args.includes("--version")) {
      console.log("codex-cli 0.171.0");
      process.exit(0);
    }
    if (args.includes("--help")) {
      console.log("Options:\\n  -s, --sandbox <M>\\n  --json\\n  --ephemeral\\n  --color <C>\\n  --skip-git-repo-check\\n  -o, --output-last-message <F>\\n  --last\\n  -c, --config <K>\\n  --uncommitted\\n  --base <B>\\n  --commit <S>");
      process.exit(0);
    }
    fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(args) + "\\n");
    if (args.includes("exec")) {
      const schemaIdx = args.indexOf("--output-schema");
      const outIdx = args.indexOf("-o");
      const hasSchema = schemaIdx !== -1;
      const outFile = outIdx !== -1 ? args[outIdx + 1] : null;
      const chunks = [];
      process.stdin.on("data", (c) => chunks.push(c));
      process.stdin.on("end", () => {
        const prompt = Buffer.concat(chunks).toString("utf8");
        console.log(JSON.stringify({ type: "thread.started", thread_id: "thr_e2e_101" }));
        console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "git status" } }));
        console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, output_tokens: 30 } }));
        let msg;
        if (hasSchema && prompt.includes("Collaborative Implementation Plan Request")) {
          msg = JSON.stringify({
            architectureSummary: "Codex plan blueprint",
            fileChanges: [
              {
                file: "target.mjs",
                action: "create",
                responsibility: "Core module",
                summary: "Create target module",
              },
            ],
            implementationSteps: [
              {
                step: 1,
                title: "Add target module",
                files: ["target.mjs"],
                testFirst: "Write unit test for target.mjs",
                implementation: "Export main function",
                verificationCommand: "npm test",
              },
            ],
            risksAndEdgeCases: [
              {
                severity: "high",
                title: "Null input risk",
                detail: "Missing null guard on input",
                mitigation: "Validate input before processing",
              },
            ],
            testStrategy: ["Run npm test"],
            openQuestions: [],
          });
        } else if (hasSchema) {
          msg = JSON.stringify({
            summary: "Codex structured ok",
            findings: [
              {
                severity: "critical",
                file: "target.mjs",
                line: 2,
                title: "Null bug",
                detail: "Missing guard",
                fix: "Check null",
              },
            ],
          });
        } else if (args.includes("resume")) {
          msg = "Codex resumed session: " + prompt.slice(0, 40);
        } else {
          msg = "Codex E2E ok: " + prompt.slice(0, 40);
        }
        if (outFile) fs.writeFileSync(outFile, msg, "utf8");
        console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: msg } }));
      });
    } else {
      console.log("Codex native review ok");
    }
  `;
}

function createFakeClaudeScript(recordFile) {
  return `
    import fs from "node:fs";
    const args = process.argv.slice(2);
    if (args.includes("--version")) {
      console.log("2.1.325 (Claude Code)");
      process.exit(0);
    }
    if (args.includes("--help")) {
      console.log("Options:\\n  -p, --print\\n  --output-format <F>\\n  --verbose\\n  --permission-mode <M>\\n  --permission-prompts <T>\\n  --restricted\\n  --strict-mcp-config\\n  --tools <T>\\n  --allowedTools <T>\\n  --disallowedTools <T>\\n  --effort <E>");
      process.exit(0);
    }
    fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(args) + "\\n");
    const hasSchema = args.includes("--json-schema");
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      const prompt = Buffer.concat(chunks).toString("utf8");
      console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude_e2e_202", model: "claude-opus-5-5" }));
      console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "target.mjs" } }] } }));
      const isPlan = hasSchema && prompt.includes("Collaborative Implementation Plan Request");
      const structured = isPlan
        ? {
            architectureSummary: "Claude plan blueprint",
            fileChanges: [
              {
                file: "target.mjs",
                action: "create",
                responsibility: "Core module",
                summary: "Create target module with null guard",
              },
            ],
            implementationSteps: [
              {
                step: 1,
                title: "Implement target module",
                files: ["target.mjs"],
                testFirst: "Assert null guard behavior",
                implementation: "Create target.mjs",
                verificationCommand: "npm test",
              },
            ],
            risksAndEdgeCases: [
              {
                severity: "high",
                title: "Null input risk",
                detail: "Missing null guard on input can crash caller",
                mitigation: "Add explicit guard",
              },
            ],
            testStrategy: ["Run npm test"],
            openQuestions: [],
          }
        : hasSchema
          ? {
            summary: "Claude structured ok",
            findings: [
              {
                severity: "high",
                file: "target.mjs",
                line: 3,
                title: "Same bug",
                detail: "Null check needed",
                fix: "Return early",
              },
            ],
          }
        : undefined;
      const out = hasSchema
        ? ""
        : args.includes("--resume")
          ? "Claude resumed session: " + prompt.slice(0, 40)
          : "Claude E2E ok: " + prompt.slice(0, 40);
      console.log(JSON.stringify({ type: "result", result: out, structured_output: structured, session_id: "claude_e2e_202", total_cost_usd: 0.025, usage: { input_tokens: 210, output_tokens: 45 }, is_error: false, num_turns: 1 }));
    });
  `;
}

test("Plugin bundle structure and manifest references are complete", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugin.json"), "utf8"));
  const mcp = JSON.parse(fs.readFileSync(path.join(repoRoot, "mcp_config.json"), "utf8"));
  assert.equal(plugin.name, "agy-handoff");
  assert.ok(Array.isArray(plugin.suggestedPrompts) && plugin.suggestedPrompts.length <= 3);
  assert.equal(mcp.mcpServers.handoff.command, "node");
  assert.deepEqual(mcp.mcpServers.handoff.args, [
    "${PLUGIN_ROOT}/src/mcp-server.mjs", "--host", "antigravity", "--legacy-group",
  ]);

  for (const rel of [
    "agents/codex-handoff.md",
    "agents/claude-handoff.md",
    "agents/neon-handoff.md",
    "rules/AGENTS.md",
    "skills/handoff-doctor/SKILL.md",
    "skills/handoff-review/SKILL.md",
    "skills/handoff-delegate/SKILL.md",
    "skills/handoff-cross-review/SKILL.md",
    "skills/handoff-grill-me/SKILL.md",
    "skills/handoff-plan/SKILL.md",
    "skills/handoff-models/SKILL.md",
    "CHANGELOG.md",
  ]) {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), `Missing plugin component: ${rel}`);
  }
});

test("E2E MCP: doctor, read-only reviews, parallel cross-review, background lifecycle, stats, and session resume", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-e2e-"));
  const cfgPath = path.join(tmpDir, "config.json");
  const codexLog = path.join(tmpDir, "codex-args.jsonl");
  const claudeLog = path.join(tmpDir, "claude-args.jsonl");

  const fakeCodex = createFakeExecutable(tmpDir, "codex", createFakeCodexScript(codexLog));
  const fakeClaude = createFakeExecutable(tmpDir, "claude", createFakeClaudeScript(claudeLog));

  const client = new McpStdioClient({
    AGY_HANDOFF_CONFIG: cfgPath,
    PLUGIN_DATA: tmpDir,
    AGY_HANDOFF_CODEX_BIN: fakeCodex,
    AGY_HANDOFF_CLAUDE_BIN: fakeClaude,
  });

  try {
    const init = await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
    });
    assert.equal(init.result.serverInfo.name, "agy-handoff");
    client.notify("notifications/initialized", {});

    // 1. Doctor checks versions + required flags
    const doc = await client.callTool("handoff_doctor");
    assert.equal(doc.isError, false);
    assert.equal(doc.data.engines.codex.compatible, true);
    assert.deepEqual(doc.data.engines.codex.missingFlags, []);
    assert.equal(doc.data.engines.claude.compatible, true);
    assert.deepEqual(doc.data.engines.claude.missingFlags, []);

    // 2. Read-only Codex & Claude reviews
    const codexRev = await client.callTool("handoff_review", {
      engine: "codex",
      style: "adversarial",
      scope: "custom",
      prompt: "Check auth",
      cwd: tmpDir,
    });
    assert.equal(codexRev.isError, false);
    assert.match(codexRev.data.output, /Codex E2E ok/);

    const claudeRev = await client.callTool("handoff_review", {
      engine: "claude",
      style: "adversarial",
      scope: "custom",
      prompt: "Check auth",
      cwd: tmpDir,
    });
    assert.equal(claudeRev.isError, false);
    assert.match(claudeRev.data.output, /Claude E2E ok/);

    // Verify exact read-only flags recorded by spawned binaries
    const codexInvocations = fs
      .readFileSync(codexLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((l) => JSON.parse(l));
    assert.ok(codexInvocations[0].includes("read-only"));
    assert.ok(codexInvocations[0].includes("--ephemeral"));

    const claudeInvocations = fs
      .readFileSync(claudeLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((l) => JSON.parse(l));
    assert.ok(claudeInvocations[0].includes("--restricted"));
    assert.ok(claudeInvocations[0].includes("--strict-mcp-config"));
    assert.ok(claudeInvocations[0].includes("--permission-prompts"));
    assert.ok(claudeInvocations[0].includes("dontAsk"));

    // 3. Parallel cross-review
    const cross = await client.callTool("handoff_cross_review", {
      includeAgy: false,
      style: "adversarial",
      scope: "custom",
      prompt: "Compare both",
      cwd: tmpDir,
    });
    assert.equal(cross.isError, false);
    assert.equal(cross.data.ok, true);
    assert.equal(cross.data.summary.enginesAttempted, 2);
    assert.equal(cross.data.summary.enginesSucceeded, 2);
    assert.equal(cross.data.summary.enginesSkipped, 0);
    assert.match(cross.data.results.codex.output, /Codex E2E ok/);
    assert.match(cross.data.results.claude.output, /Claude E2E ok/);

    // 4. Session resume round-trip for Codex and Claude
    const codexResumed = await client.callTool("handoff_delegate", {
      engine: "codex",
      prompt: "Follow up codex",
      sessionId: codexRev.data.sessionId,
      cwd: tmpDir,
    });
    assert.equal(codexResumed.isError, false);
    assert.match(codexResumed.data.output, /Codex resumed session/);

    const claudeResumed = await client.callTool("handoff_delegate", {
      engine: "claude",
      prompt: "Follow up claude",
      sessionId: claudeRev.data.sessionId,
      cwd: tmpDir,
    });
    assert.equal(claudeResumed.isError, false);
    assert.match(claudeResumed.data.output, /Claude resumed session/);

    // 5. Background review + live status polling + result + stats
    const started = await client.callTool("handoff_review", {
      engine: "claude",
      style: "adversarial",
      scope: "custom",
      prompt: "Background inspect",
      cwd: tmpDir,
      background: true,
    });
    assert.equal(started.data.status, "running");

    let statusSnap;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      statusSnap = (
        await client.callTool("handoff_job_status", {
          jobId: started.data.jobId,
          waitSec: 2,
          sinceSeq: 0,
        })
      ).data;
      if (statusSnap.status !== "running") break;
    }
    assert.equal(statusSnap.status, "completed");

    const bgRes = await client.callTool("handoff_job_result", {
      jobId: started.data.jobId,
    });
    assert.equal(bgRes.data.status, "completed");
    assert.match(bgRes.data.output, /Claude E2E ok/);

    const statsResp = await client.callTool("handoff_job_status", {
      includeStats: true,
    });
    assert.ok(statsResp.data.stats.analyzedJobs >= 7);
    assert.equal(statsResp.data.stats.byEngine.claude.reportedTokens.output > 0, true);

    // 6. Collaborative Plan (handoff_plan) with Grill-Me decisions & disk file target verification
    const planResp = await client.callTool("handoff_plan", {
      includeAgy: false,
      goal: "Add target.mjs module",
      phase: "design",
      decisions: [
        {
          branch: "Scope & Non-Goals",
          question: "Should target.mjs be zero-dependency?",
          answer: "Yes, use Node.js built-ins only.",
        },
      ],
      requirements: ["Create target.mjs"],
      cwd: tmpDir,
    });
    assert.equal(planResp.isError, false);
    assert.equal(planResp.data.ok, true);
    assert.equal(planResp.data.structuredPlan.consensusFileChanges.length, 1);
    assert.equal(planResp.data.structuredPlan.consensusFileChanges[0].file, "target.mjs");
    assert.equal(
      planResp.data.structuredPlan.consensusFileChanges[0].targetVerification.status,
      "valid_new_file",
    );
    assert.equal(planResp.data.structuredPlan.mergedRisksAndEdgeCases.length, 1);
    assert.equal(planResp.data.structuredPlan.mergedRisksAndEdgeCases[0].agreementCount, 2);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tmpDir, RM_OPTS);
  }
});

test("E2E MCP: cross-review fallback on missing CLI, partial error tolerance, and background cancel", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-e2e-fb-"));
  const cfgPath = path.join(tmpDir, "config.json");
  const claudeLog = path.join(tmpDir, "claude-args.jsonl");
  const fakeClaude = createFakeExecutable(tmpDir, "claude", createFakeClaudeScript(claudeLog));
  const slowCodex = createFakeExecutable(
    tmpDir,
    "slow-codex",
    `
    if (process.argv.includes("--version")) { console.log("codex-cli 0.171.0"); process.exit(0); }
    setTimeout(() => {}, 30000);
    `,
  );
  const failCodex = createFakeExecutable(
    tmpDir,
    "fail-codex",
    `process.stderr.write("codex crashed"); process.exit(1);`,
  );

  // Subtest A: missing Codex CLI -> cross-review gracefully skips Codex
  const clientMissing = new McpStdioClient({
    AGY_HANDOFF_CONFIG: cfgPath,
    PLUGIN_DATA: tmpDir,
    AGY_HANDOFF_CODEX_BIN: path.join(tmpDir, "does-not-exist-codex"),
    AGY_HANDOFF_CLAUDE_BIN: fakeClaude,
  });
  try {
    const crossMissing = await clientMissing.callTool("handoff_cross_review", {
      includeAgy: false,
      scope: "custom",
      prompt: "Check fallback",
      cwd: tmpDir,
    });
    assert.equal(crossMissing.isError, false);
    assert.equal(crossMissing.data.ok, true);
    assert.equal(crossMissing.data.results.codex.skipped, true);
    assert.equal(crossMissing.data.results.claude.ok, true);
    assert.equal(crossMissing.data.summary.enginesSkipped, 1);
  } finally {
    await clientMissing.close().catch(() => {});
  }

  // Subtest B: failing Codex CLI -> cross-review still returns Claude's result with ok=true
  const clientPartial = new McpStdioClient({
    AGY_HANDOFF_CONFIG: cfgPath,
    PLUGIN_DATA: tmpDir,
    AGY_HANDOFF_CODEX_BIN: failCodex,
    AGY_HANDOFF_CLAUDE_BIN: fakeClaude,
  });
  try {
    const crossPartial = await clientPartial.callTool("handoff_cross_review", {
      includeAgy: false,
      scope: "custom",
      prompt: "Check partial failure",
      cwd: tmpDir,
    });
    assert.equal(crossPartial.isError, false);
    assert.equal(crossPartial.data.ok, true);
    assert.equal(crossPartial.data.results.codex.ok, false);
    assert.equal(crossPartial.data.results.claude.ok, true);
    assert.equal(crossPartial.data.summary.enginesFailed, 1);
    assert.equal(crossPartial.data.summary.enginesSucceeded, 1);
  } finally {
    await clientPartial.close().catch(() => {});
  }

  // Subtest C: background cancel
  const clientCancel = new McpStdioClient({
    AGY_HANDOFF_CONFIG: cfgPath,
    PLUGIN_DATA: tmpDir,
    AGY_HANDOFF_CODEX_BIN: slowCodex,
    AGY_HANDOFF_CLAUDE_BIN: fakeClaude,
  });
  try {
    const started = await clientCancel.callTool("handoff_delegate", {
      engine: "codex",
      prompt: "Sleep forever",
      cwd: tmpDir,
      background: true,
    });
    assert.equal(started.data.status, "running");
    const cancel = await clientCancel.callTool("handoff_job_cancel", {
      jobId: started.data.jobId,
    });
    assert.equal(cancel.data.canceled, true);
    assert.equal(cancel.data.status, "canceled");
  } finally {
    await clientCancel.close().catch(() => {});
  }

  // Subtest D: v0.2.0 context, auto-routing, structured cross-review, executionEvidence & safe read-only fallback retry
  fs.writeFileSync(
    path.join(tmpDir, "target.mjs"),
    "export function fn(x) {\n  if (!x) return 0;\n  return x;\n}\n",
    "utf8",
  );
  const clientV2 = new McpStdioClient({
    AGY_HANDOFF_CONFIG: cfgPath,
    PLUGIN_DATA: tmpDir,
    AGY_HANDOFF_CODEX_BIN: failCodex,
    AGY_HANDOFF_CLAUDE_BIN: fakeClaude,
  });
  try {
    // Wait until a failed codex read-only background job exists, then retry with fallbackEngine -> claude
    const failedStart = await clientV2.callTool("handoff_delegate", {
      engine: "codex",
      mode: "read-only",
      prompt: "Check target.mjs",
      context: { files: ["target.mjs"], summary: "Line 2 returns 0" },
      cwd: tmpDir,
      background: true,
    });
    let st;
    const dl = Date.now() + 5000;
    while (Date.now() < dl) {
      st = (await clientV2.callTool("handoff_job_status", { jobId: failedStart.data.jobId })).data;
      if (st.status !== "running") break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(st.status, "failed");
    assert.equal(st.retryable, true);

    const retryStart = await clientV2.callTool("handoff_job_retry", {
      jobId: failedStart.data.jobId,
      fallbackEngine: true,
    });
    assert.equal(retryStart.isError, false);
    assert.equal(retryStart.data.engine, "claude");
    const dl2 = Date.now() + 5000;
    let rSt;
    while (Date.now() < dl2) {
      rSt = (await clientV2.callTool("handoff_job_status", { jobId: retryStart.data.jobId })).data;
      if (rSt.status !== "running") break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(rSt.status, "completed");
    assert.equal(rSt.retryOf, failedStart.data.jobId);
    assert.ok(rSt.executionEvidence.observedToolCalls >= 1);

    const foreground = await clientV2.callTool("handoff_delegate", {
      engine: "codex",
      prompt: "Check target.mjs",
      cwd: tmpDir,
    });
    assert.equal(foreground.isError, true);
    const foregroundRetry = await clientV2.callTool("handoff_job_retry", {
      jobId: foreground.data.jobId,
      fallbackEngine: true,
    });
    assert.equal(foregroundRetry.isError, false);
    const retried = await clientV2.callTool("handoff_job_status", {
      jobId: foregroundRetry.data.jobId,
      waitSec: 5,
      sinceSeq: 100,
    });
    assert.equal(retried.data.status, "completed");
    assert.equal(retried.data.retryOf, foreground.data.jobId);

    // Structured cross-review with real codex+claude fake scripts
    const clientBoth = new McpStdioClient({
      AGY_HANDOFF_CONFIG: cfgPath,
      PLUGIN_DATA: tmpDir,
      AGY_HANDOFF_CODEX_BIN: createFakeExecutable(
        tmpDir,
        "codex-struct",
        createFakeCodexScript(path.join(tmpDir, "codex-struct-log.jsonl")),
      ),
      AGY_HANDOFF_CLAUDE_BIN: fakeClaude,
    });
    try {
      const autoRev = await clientBoth.callTool("handoff_review", {
        engine: "auto",
        taskType: "review",
        scope: "custom",
        context: { files: ["target.mjs"] },
        cwd: tmpDir,
      });
      assert.equal(autoRev.isError, false);
      assert.equal(autoRev.data.routingDecision.requestedEngine, "auto");
      assert.ok(autoRev.data.executionEvidence.observedToolCalls >= 1);

      const sCross = await clientBoth.callTool("handoff_cross_review", {
        includeAgy: false,
        scope: "custom",
        context: { files: ["target.mjs"] },
        structured: true,
        cwd: tmpDir,
      });
      assert.equal(sCross.isError, false);
      assert.equal(sCross.data.structuredSynthesis.consensus.length, 1);
      assert.equal(sCross.data.structuredSynthesis.conflicts.length, 1);
      assert.equal(sCross.data.structuredSynthesis.citationSummary.validCitations, 2);
      assert.equal(
        sCross.data.structuredSynthesis.consensus[0].codex.citation.semanticallyVerified,
        false,
      );

      // Background Codex structured review writes schema file, passes --output-schema, and returns structuredOutput in result
      const bgCodexStruct = await clientBoth.callTool("handoff_review", {
        engine: "codex",
        style: "standard",
        scope: "uncommitted",
        structured: true,
        cwd: tmpDir,
        background: true,
      });
      assert.equal(bgCodexStruct.data.status, "running");
      let bgSt;
      const dl3 = Date.now() + 5000;
      while (Date.now() < dl3) {
        bgSt = (
          await clientBoth.callTool("handoff_job_status", {
            jobId: bgCodexStruct.data.jobId,
          })
        ).data;
        if (bgSt.status !== "running") break;
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.equal(bgSt.status, "completed");
      assert.equal(bgSt.structured, true);
      const bgCodexResult = await clientBoth.callTool("handoff_job_result", {
        jobId: bgCodexStruct.data.jobId,
      });
      assert.equal(bgCodexResult.data.structuredOutput.summary, "Codex structured ok");
    } finally {
      await clientBoth.close().catch(() => {});
    }
  } finally {
    await clientV2.close().catch(() => {});
    fs.rmSync(tmpDir, RM_OPTS);
  }
});

function createHostEngine(dir, engine) {
  return createFakeExecutable(dir, engine, `
    import { spawnSync } from "node:child_process";
    const args = process.argv.slice(2);
    if (args.includes("--version")) {
      console.log(${JSON.stringify({ codex: "codex-cli 0.171.0", claude: "2.1.325 (Claude Code)", agy: "1.5.13" }[engine])});
      process.exit(0);
    }
    if (args.includes("--help")) process.exit(0);
    let prompt = args.includes("--print") ? args[args.indexOf("--print") + 1] : "";
    for await (const chunk of process.stdin) prompt += chunk;
    // Test the actual nested MCP boundary in the captured child environment.
    const nested = spawnSync(process.execPath, [
      ${JSON.stringify(serverPath)}, "--host", ${JSON.stringify(engine === "claude" ? "codex" : "claude")},
    ], {
      input: [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
          name: "handoff_delegate", arguments: { engine: ${JSON.stringify(engine)}, prompt: "nested" },
        }},
      ].map(JSON.stringify).join("\\n") + "\\n",
      encoding: "utf8",
      timeout: 3000,
      env: {
        ...process.env,
        AGY_HANDOFF_CODEX_BIN: ${JSON.stringify(path.join(dir, "missing-codex"))},
        AGY_HANDOFF_CLAUDE_BIN: ${JSON.stringify(path.join(dir, "missing-claude"))},
        AGY_HANDOFF_AGY_BIN: "none",
      },
    });
    const responses = nested.stdout.trim().split("\\n").map(JSON.parse);
    const blocked = responses.some((r) => r.id === 1 && r.result.tools.length === 0) &&
      responses.some((r) => r.id === 2 && r.result.isError &&
        r.result.content[0].text.includes("Recursive"));
    const engine = ${JSON.stringify(engine)};
    if (!blocked || (engine === "claude" && process.env.CLAUDECODE)) process.exit(2);
    if (engine === "agy" && prompt.includes("quota fixture")) {
      console.error("429 RESOURCE_EXHAUSTED");
      process.exit(1);
    }
    if (prompt.includes("duplicate fixture")) await new Promise((resolve) => setTimeout(resolve, 1000));
    const summary = engine + " nested handoff blocked";
    const review = { summary, findings: [] };
    const plan = {
      architectureSummary: summary,
      fileChanges: [],
      implementationSteps: [],
      risksAndEdgeCases: [],
      testStrategy: [],
      openQuestions: [],
    };
    if (prompt.includes("invalid fixture") && engine === "agy") {
      review.findings = "invalid";
    }
    const payload = prompt.includes("portable design") ? plan : review;
    if (engine === "claude") {
      console.log(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(payload),
        structured_output: payload }));
    } else if (engine === "agy") {
      console.log(JSON.stringify({ event: "result", result: {
        status: "SUCCESS", response: JSON.stringify(payload), structured_output: payload,
      }}));
    } else {
      console.log(JSON.stringify({ type: "item.completed", item: {
        type: "agent_message", text: JSON.stringify(payload),
      }}));
    }
  `);
}

test("packaged host adapters share the same tools, select peers and block recursive CLI handoffs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-hosts with spaces-"));
  const clients = [];
  try {
    const stage = path.join(dir, "marketplace");
    const packed = spawnSync(process.execPath, [path.join(repoRoot, "scripts/package-integrations.mjs"), stage], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
    const env = {
      AGY_HANDOFF_JOBS_DIR: path.join(dir, "jobs"),
      AGY_HANDOFF_CONFIG: path.join(dir, "config.json"),
      AGY_HANDOFF_CODEX_BIN: createHostEngine(dir, "codex"),
      AGY_HANDOFF_CLAUDE_BIN: createHostEngine(dir, "claude"),
      AGY_HANDOFF_AGY_BIN: createHostEngine(dir, "agy"),
      // Simulate the Claude host's session marker.
      CLAUDECODE: "1",
      AGY_HANDOFF_HOST: "codex",
    };
    for (const [host, peers] of Object.entries({
      antigravity: ["codex", "claude", "agy"],
      claude: ["codex", "agy"],
      codex: ["claude", "agy"],
    })) {
      const plugin = host === "antigravity" ? repoRoot : path.join(stage, "plugins", `${host}-handoff`);
      const config = { antigravity: "mcp_config.json", claude: ".mcp.json", codex: "mcp.json" }[host];
      const serverArgs = read(path.join(plugin, config)).mcpServers.handoff.args
        .map((arg) => arg.replace(/^\$\{(?:CLAUDE_)?PLUGIN_ROOT\}/, plugin));
      const client = new McpStdioClient(env, serverArgs);
      clients.push(client);
      const initialized = await client.request("initialize", { protocolVersion: "2025-03-26" });
      assert.equal(initialized.result.serverInfo.name, host === "antigravity" ? "agy-handoff" : `${host}-handoff`);
      const doctor = await client.callTool("handoff_doctor");
      assert.equal(doctor.data.host, host);
      assert.deepEqual(doctor.data.defaultGroupEngines, peers);
      const review = await client.callTool("handoff_cross_review", {
        cwd: dir, scope: "custom", structured: true, prompt: "portable review",
      });
      assert.equal(review.isError, false, review.text);
      assert.deepEqual(review.data.requestedEngines, peers);
      assert.deepEqual(review.data.participatingEngines, peers);
      assert.equal(review.data.architecture, `${peers.length}-to-1`);
      assert.equal(review.data.synthesizerHost, host);
      assert.equal(review.data.structuredSynthesis.verificationStages.semanticVerification.semanticallyVerified, false);
      const direct = await client.callTool("handoff_review", {
        cwd: dir, engine: peers[0], scope: "custom", structured: true, prompt: "single review",
      });
      assert.equal(direct.isError, false, direct.text);
      assert.match(direct.data.structuredReview.summary, /nested handoff blocked/);
      const delegate = await client.callTool("handoff_delegate", {
        cwd: dir, engine: peers[0], prompt: "read-only delegation", background: true,
      });
      assert.equal(delegate.isError, false, delegate.text);
      for (let i = 0; i < 10; i += 1) {
        const status = await client.callTool("handoff_job_status", { jobId: delegate.data.jobId, waitSec: 1 });
        if (status.data.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const result = await client.callTool("handoff_job_result", { jobId: delegate.data.jobId });
      assert.equal(result.data.status, "completed", result.text);
      assert.match(result.data.output, /nested handoff blocked/);
    }

    const claude = clients[1];
    const defaultPlan = await claude.callTool("handoff_plan", { goal: "portable design", cwd: dir });
    assert.equal(defaultPlan.isError, false, defaultPlan.text);
    assert.deepEqual(defaultPlan.data.participatingEngines, ["codex", "agy"]);
    const explicit = await claude.callTool("handoff_plan", {
      goal: "portable design", cwd: dir, engines: ["claude", "agy"],
    });
    assert.equal(explicit.isError, false, explicit.text);
    assert.deepEqual(explicit.data.participatingEngines, ["claude", "agy"]);
    assert.deepEqual(Object.keys(explicit.data.structuredPlan.verificationStages.structuredJsonParse), ["claude", "agy"]);
    for (const client of clients.slice(1)) {
      const write = await client.callTool("handoff_delegate", {
        cwd: dir, engine: "agy", mode: "workspace-write", prompt: "try writing",
      });
      assert.equal(write.isError, true);
      assert.match(write.text, /explicit user approval/);
    }

    const approvedWrite = await clients[2].callTool("handoff_delegate", {
      cwd: dir, engine: "claude", mode: "workspace-write", confirmWorkspaceWrite: true,
      prompt: "approved fixture",
    });
    assert.equal(approvedWrite.isError, false, approvedWrite.text);
    assert.equal(approvedWrite.data.permissionBoundary.osSandboxed, false);
    assert.match(approvedWrite.data.permissionBoundary.warning, /Bash runs without an OS/);

    const duplicateArgs = { cwd: dir, scope: "custom", engines: ["agy"], prompt: "duplicate fixture" };
    const [first, duplicate] = await Promise.all([
      claude.callTool("handoff_cross_review", duplicateArgs),
      claude.callTool("handoff_cross_review", duplicateArgs),
    ]);
    assert.equal(first.isError, false, first.text);
    assert.equal(duplicate.isError, true);
    assert.match(duplicate.text, /identical handoff is already running/);
    const bgArgs = { cwd: dir, engine: "agy", prompt: "duplicate fixture", background: true };
    const background = await claude.callTool("handoff_delegate", bgArgs);
    const bgDuplicate = await claude.callTool("handoff_delegate", { ...bgArgs, background: false });
    assert.equal(background.isError, false);
    assert.match(bgDuplicate.text, /identical handoff is already running/);
    assert.ok(bgDuplicate.text.includes(background.data.jobId));
    await claude.callTool("handoff_job_cancel", { jobId: background.data.jobId });

    const partial = await claude.callTool("handoff_cross_review", {
      cwd: dir, scope: "custom", structured: true, prompt: "quota fixture",
    });
    assert.equal(partial.isError, false, partial.text);
    assert.equal(partial.data.partial, true);
    assert.equal(partial.data.architecture, "1-to-1");
    assert.equal(partial.data.results.agy.failureReason, "quota");
    const invalid = await claude.callTool("handoff_cross_review", {
      cwd: dir, scope: "custom", structured: true, prompt: "invalid fixture",
    });
    assert.deepEqual(invalid.data.participatingEngines, ["codex"]);
    assert.match(invalid.data.structuredSynthesis.parseErrors.agy, /findings/);
    const noCli = new McpStdioClient({
      ...env, AGY_HANDOFF_CODEX_BIN: path.join(dir, "missing"), AGY_HANDOFF_AGY_BIN: "none",
    }, [serverPath, "--host", "claude"]);
    clients.push(noCli);
    const unavailable = await noCli.callTool("handoff_plan", { cwd: dir, goal: "portable design" });
    assert.equal(unavailable.isError, true);
    assert.equal(unavailable.data.architecture, "0-to-1");
    assert.equal(unavailable.data.results.agy.skipped, true);
    assert.match(unavailable.data.results.codex.reason, /not installed/);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    fs.rmSync(dir, RM_OPTS);
  }
});

test("host-aware parallel plan retains a successful result when an engine times out", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-host-timeout-"));
  const slowAgy = createFakeExecutable(dir, "agy-slow", "setInterval(() => {}, 1000);");
  const client = new McpStdioClient({
    AGY_HANDOFF_JOBS_DIR: path.join(dir, "jobs"),
    AGY_HANDOFF_CONFIG: path.join(dir, "config.json"),
    AGY_HANDOFF_CODEX_BIN: createHostEngine(dir, "codex"),
    AGY_HANDOFF_AGY_BIN: slowAgy,
  }, [serverPath, "--host", "claude"]);
  try {
    const plan = await client.callTool("handoff_plan", { cwd: dir, goal: "portable design", timeoutSec: 10 });
    assert.equal(plan.isError, false, plan.text);
    assert.equal(plan.data.partial, true);
    assert.deepEqual(plan.data.participatingEngines, ["codex"]);
    assert.equal(plan.data.results.agy.failureReason, "timeout");
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(dir, RM_OPTS);
  }
});
