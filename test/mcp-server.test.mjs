import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../src/mcp-server.mjs");
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

function sendRpcSession(messages, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...envOverrides },
    });

    const responses = [];
    let buffer = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          responses.push(JSON.parse(line));
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Server exited with code ${code}: ${stderr}`));
      } else {
        resolve(responses);
      }
    });

    for (const msg of messages) {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    }
    child.stdin.end();
  });
}

test("MCP stdio server handles initialize, tools/list, and handoff_doctor", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-mcp-test-"));
  const tempConfigPath = path.join(tmpDir, "config.json");
  try {
    const responses = await sendRpcSession(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {} },
        },
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "handoff_doctor",
            arguments: {},
          },
        },
      ],
      { AGY_HANDOFF_CONFIG: tempConfigPath, PLUGIN_DATA: tmpDir },
    );

    assert.equal(responses.length, 3);
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.serverInfo.name, "agy-handoff");
    assert.equal(responses[0].result.protocolVersion, "2025-03-26");

    const toolNames = responses[1].result.tools.map((t) => t.name);
    assert.deepEqual(toolNames, [
      "handoff_doctor",
      "handoff_review",
      "handoff_delegate",
      "handoff_cross_review",
      "handoff_config",
      "handoff_job_status",
      "handoff_job_result",
      "handoff_job_cancel",
      "handoff_job_retry",
      "handoff_plan",
    ]);

    const doctorPayload = JSON.parse(responses[2].result.content[0].text);
    assert.equal(responses[2].result.isError, false);
    assert.ok(doctorPayload.nodeVersion.startsWith("v"));
    assert.equal(typeof doctorPayload.engines.codex.installed, "boolean");
    assert.equal(typeof doctorPayload.engines.claude.installed, "boolean");
    assert.equal(doctorPayload.modelDefaults.review.codex.model, "gpt-6.2-sol");
    assert.equal(doctorPayload.modelDefaults.review.codex.effort, "high");
    assert.equal(doctorPayload.modelDefaults.review.claude.model, "claude-opus-5-5");
    assert.equal(doctorPayload.modelDefaults.review.claude.effort, "high");
  } finally {
    fs.rmSync(tmpDir, RM_OPTS);
  }
});

test("MCP stdio server supports handoff_config get, set, and reset", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-mcp-cfg-test-"));
  const tempConfigPath = path.join(tmpDir, "config.json");
  try {
    const responses = await sendRpcSession(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "handoff_config",
            arguments: { action: "get" },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "handoff_config",
            arguments: {
              action: "set",
              scope: "review",
              codexModel: "gpt-6.1-sol",
              codexEffort: "xhigh",
              claudeModel: "opus5.5",
              claudeEffort: "max",
            },
          },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "handoff_config",
            arguments: { action: "get" },
          },
        },
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "handoff_config",
            arguments: { action: "reset", scope: "all" },
          },
        },
      ],
      { AGY_HANDOFF_CONFIG: tempConfigPath, PLUGIN_DATA: tmpDir },
    );

    assert.equal(responses.length, 4);
    const initial = JSON.parse(responses[0].result.content[0].text);
    assert.equal(initial.effective.review.codex.model, "gpt-6.2-sol");
    assert.equal(initial.effective.review.claude.model, "claude-opus-5-5");

    const afterGet = JSON.parse(responses[2].result.content[0].text);
    assert.equal(afterGet.effective.review.codex.model, "gpt-6.1-sol");
    assert.equal(afterGet.effective.review.codex.effort, "xhigh");
    assert.equal(afterGet.effective.review.claude.model, "claude-opus-5-5");
    assert.equal(afterGet.effective.review.claude.effort, "max");
    assert.equal(afterGet.effective.delegate.codex.model, "gpt-6.2-sol");

    const afterReset = JSON.parse(responses[3].result.content[0].text);
    assert.equal(afterReset.effective.review.codex.model, "gpt-6.2-sol");
    assert.equal(afterReset.effective.review.codex.modelSource, "builtin");
  } finally {
    fs.rmSync(tmpDir, RM_OPTS);
  }
});

test("MCP stdio server validates arguments strictly and handles JSON-RPC batches", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-mcp-batch-"));
  const tempConfigPath = path.join(tmpDir, "config.json");
  try {
    const responses = await sendRpcSession(
      [
        [
          { jsonrpc: "2.0", id: 10, method: "ping" },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: 11,
            method: "tools/call",
            params: {
              name: "handoff_review",
              arguments: { engine: "codex", timeoutSec: -1 },
            },
          },
          {
            jsonrpc: "2.0",
            id: 12,
            method: "tools/call",
            params: {
              name: "handoff_review",
              arguments: { engine: "codex", unknownFlag: true },
            },
          },
        ],
      ],
      { AGY_HANDOFF_CONFIG: tempConfigPath, PLUGIN_DATA: tmpDir },
    );

    assert.equal(responses.length, 1);
    const batch = responses[0];
    assert.equal(batch.length, 3);
    assert.equal(batch[0].id, 10);
    assert.equal(batch[1].id, 11);
    assert.equal(batch[1].result.isError, true);
    assert.match(batch[1].result.content[0].text, /timeoutSec/i);
    assert.equal(batch[2].id, 12);
    assert.equal(batch[2].result.isError, true);
    assert.match(batch[2].result.content[0].text, /Unknown argument/i);
  } finally {
    fs.rmSync(tmpDir, RM_OPTS);
  }
});

test("MCP handoff_cross_review sets ok=false and isError=true when all engines fail", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-mcp-fail-"));
  const tempConfigPath = path.join(tmpDir, "config.json");
  try {
    const failBin = createFakeExecutable(
      tmpDir,
      "fail-cli",
      "process.stderr.write('boom'); process.exit(1);",
    );

    const responses = await sendRpcSession(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "handoff_cross_review",
            arguments: {
              includeAgy: false,
              scope: "custom",
              prompt: "check",
              cwd: tmpDir,
            },
          },
        },
      ],
      {
        AGY_HANDOFF_CONFIG: tempConfigPath,
        PLUGIN_DATA: tmpDir,
        AGY_HANDOFF_CODEX_BIN: failBin,
        AGY_HANDOFF_CLAUDE_BIN: failBin,
      },
    );

    assert.equal(responses.length, 1);
    assert.equal(responses[0].result.isError, true);
    const payload = JSON.parse(responses[0].result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.results.codex.ok, false);
    assert.equal(payload.results.claude.ok, false);
  } finally {
    fs.rmSync(tmpDir, RM_OPTS);
  }
});

test("MCP stdio server emits notifications/progress when progressToken is supplied", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-mcp-prog-"));
  const tempConfigPath = path.join(tmpDir, "config.json");
  try {
    const claudeBin = createFakeExecutable(
      tmpDir,
      "stream-claude",
      `
      console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s_prog", model: "claude-opus-5-5" }));
      console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "package.json" } }] } }));
      console.log(JSON.stringify({ type: "result", result: "All good", session_id: "s_prog", total_cost_usd: 0.01, is_error: false, num_turns: 1 }));
      `,
    );

    const messages = await sendRpcSession(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "handoff_delegate",
            arguments: { engine: "claude", prompt: "Inspect", cwd: tmpDir },
            _meta: { progressToken: "prog-1" },
          },
        },
      ],
      {
        AGY_HANDOFF_CONFIG: tempConfigPath,
        PLUGIN_DATA: tmpDir,
        AGY_HANDOFF_CLAUDE_BIN: claudeBin,
      },
    );

    const progressNotes = messages.filter((m) => m.method === "notifications/progress");
    const finalResp = messages.find((m) => m.id === 1);
    assert.ok(progressNotes.length >= 2);
    assert.equal(progressNotes[0].params.progressToken, "prog-1");
    assert.ok(progressNotes.some((n) => /Read: package\.json/.test(n.params.message)));
    assert.ok(finalResp);
    assert.equal(finalResp.result.isError, false);
    const payload = JSON.parse(finalResp.result.content[0].text);
    assert.equal(payload.output, "All good");
    assert.ok(payload.jobId);
  } finally {
    fs.rmSync(tmpDir, RM_OPTS);
  }
});

test("MCP stdio server dispatches non-blocking requests and handles notifications/cancelled", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-mcp-cancel-"));
  const tempConfigPath = path.join(tmpDir, "config.json");
  try {
    const slowBin = createFakeExecutable(
      tmpDir,
      "slow-cli",
      "setTimeout(() => { process.stdout.write('late'); }, 30000);",
    );

    const startedAt = Date.now();
    const responses = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          AGY_HANDOFF_CONFIG: tempConfigPath,
          PLUGIN_DATA: tmpDir,
          AGY_HANDOFF_CODEX_BIN: slowBin,
        },
      });

      const received = [];
      let buffer = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) {
            const msg = JSON.parse(line);
            received.push(msg);
            if (msg.id === 1) {
              child.stdin.end();
            }
          }
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`Exited ${code}: ${stderr}`));
        else resolve(received);
      });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "handoff_delegate",
            arguments: { engine: "codex", prompt: "Wait", cwd: tmpDir },
          },
        })}\n`,
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);

      setTimeout(() => {
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: 1 },
          })}\n`,
        );
      }, 150);
    });

    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 4000, `Cancellation took too long: ${elapsed}ms`);
    assert.equal(responses[0].id, 2);
    const cancelledResp = responses.find((r) => r.id === 1);
    assert.ok(cancelledResp);
    assert.equal(cancelledResp.result.isError, true);
    assert.match(cancelledResp.result.content[0].text, /canceled/i);
  } finally {
    fs.rmSync(tmpDir, RM_OPTS);
  }
});

test("MCP stdio server disables tools when AGY_HANDOFF_NESTED=1 and emits heartbeats during silent runs", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-mcp-nested-"));
  const tempConfigPath = path.join(tmpDir, "config.json");
  try {
    const nestedResponses = await sendRpcSession(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "handoff_doctor", arguments: {} },
        },
      ],
      {
        AGY_HANDOFF_NESTED: "1",
        AGY_HANDOFF_CONFIG: tempConfigPath,
        PLUGIN_DATA: tmpDir,
      },
    );

    const listResp = nestedResponses.find((r) => r.id === 1);
    const callResp = nestedResponses.find((r) => r.id === 2);
    assert.deepEqual(listResp.result.tools, []);
    assert.equal(callResp.result.isError, true);
    assert.match(callResp.result.content[0].text, /Recursive agy-handoff/i);

    const slowClaude = createFakeExecutable(
      tmpDir,
      "slow-heartbeat-claude",
      `
      console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s_hb", model: "claude-opus-5-5" }));
      setTimeout(() => {
        console.log(JSON.stringify({ type: "result", result: "Done after wait", session_id: "s_hb", is_error: false, num_turns: 1 }));
      }, 260);
      `,
    );

    const hbMessages = await sendRpcSession(
      [
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "handoff_delegate",
            arguments: { engine: "claude", prompt: "Think slowly", cwd: tmpDir },
            _meta: { progressToken: "hb-1" },
          },
        },
      ],
      {
        AGY_HANDOFF_CONFIG: tempConfigPath,
        PLUGIN_DATA: tmpDir,
        AGY_HANDOFF_CLAUDE_BIN: slowClaude,
        AGY_HANDOFF_HEARTBEAT_MS: "80",
      },
    );

    const progressNotes = hbMessages.filter((m) => m.method === "notifications/progress");
    const finalResp = hbMessages.find((m) => m.id === 3);
    assert.ok(
      progressNotes.some((n) => /Still running \(.+ elapsed\)/.test(n.params.message)),
      `Expected heartbeat progress notification, got: ${JSON.stringify(progressNotes)}`,
    );
    assert.equal(finalResp.result.isError, false);
    const payload = JSON.parse(finalResp.result.content[0].text);
    assert.equal(payload.output, "Done after wait");
    // Heartbeat must not pollute executionEvidence
    assert.equal(payload.executionEvidence.observedToolCalls, 0);
  } finally {
    fs.rmSync(tmpDir, RM_OPTS);
  }
});
