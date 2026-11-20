import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAgyReviewSpec, findAgyBinary, runAgyExec } from "../src/runners/agy.mjs";
import {
  MIN_CLAUDE_VERSION,
  buildClaudeExecSpec,
  buildClaudeReviewSpec,
  inspectClaude,
  parseClaudeJsonOutput,
  runClaudeExec,
} from "../src/runners/claude.mjs";
import {
  MIN_CODEX_VERSION,
  buildCodexExecSpec,
  buildCodexReviewSpec,
  extractCodexSessionId,
  inspectCodex,
  runCodexExec,
} from "../src/runners/codex.mjs";
import {
  compareSemver,
  detectMissingFlags,
  findBinary,
  inspectBinary,
  parseSemver,
  resolveSpawnSpec,
  runCommand,
  truncateOutput,
} from "../src/runners/common.mjs";

const tmpDir = os.tmpdir();
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

test("buildCodexExecSpec constructs safe read-only ephemeral command", () => {
  const spec = buildCodexExecSpec({
    prompt: "Explain why tests fail",
    cwd: tmpDir,
    model: "gpt-5.4",
    outputFile: "/tmp/out.txt",
  });

  assert.equal(spec.cwd, tmpDir);
  assert.equal(spec.stdin, "Explain why tests fail");
  assert.deepEqual(spec.args, [
    "exec",
    "--color",
    "never",
    "-C",
    tmpDir,
    "-s",
    "read-only",
    "--json",
    "--ephemeral",
    "-m",
    "gpt-5.4",
    "-o",
    "/tmp/out.txt",
    "-",
  ]);
});

test("buildCodexExecSpec rejects unsupported sandbox modes", () => {
  assert.throws(
    () =>
      buildCodexExecSpec({
        prompt: "hi",
        cwd: tmpDir,
        mode: "danger-full-access",
      }),
    /Unsupported mode/,
  );
});

test("buildCodexExecSpec supports session resume with explicit sandbox enforcement", () => {
  const spec = buildCodexExecSpec({
    prompt: "Follow up",
    cwd: tmpDir,
    sessionId: "last",
  });
  assert.deepEqual(spec.args, [
    "exec",
    "resume",
    "-c",
    'sandbox_mode="read-only"',
    "--json",
    "--last",
    "-",
  ]);
  assert.equal(spec.outputFile, null);

  assert.throws(
    () =>
      buildCodexExecSpec({
        prompt: "Follow up",
        cwd: tmpDir,
        sessionId: "--dangerously-bypass-approvals-and-sandbox",
      }),
    /cannot start with "-"/,
  );
});

test("buildCodexExecSpec passes reasoning effort and rejects invalid values", () => {
  const spec = buildCodexExecSpec({
    prompt: "Check logic",
    cwd: tmpDir,
    model: "gpt-6.2-sol",
    effort: "high",
  });
  const cfgIdx = spec.args.indexOf('model_reasoning_effort="high"');
  assert.notEqual(cfgIdx, -1);
  assert.equal(spec.args[cfgIdx - 1], "-c");

  assert.throws(
    () =>
      buildCodexExecSpec({
        prompt: "Check logic",
        cwd: tmpDir,
        effort: "extreme",
      }),
    /Unsupported effort/,
  );
});

test("buildCodexReviewSpec uses native codex review with explicit read-only sandbox", () => {
  const spec = buildCodexReviewSpec({
    cwd: tmpDir,
    style: "standard",
    scope: "uncommitted",
    model: "o3",
    effort: "high",
  });
  assert.deepEqual(spec.args, [
    "review",
    "-c",
    'sandbox_mode="read-only"',
    "-c",
    'model="o3"',
    "-c",
    'model_reasoning_effort="high"',
    "--uncommitted",
  ]);
  assert.equal(spec.stdin, null);
});

test("buildCodexReviewSpec uses read-only exec with adversarial prompt and validates git refs", () => {
  const spec = buildCodexReviewSpec({
    cwd: tmpDir,
    style: "adversarial",
    scope: "base",
    base: "main",
    effort: "xhigh",
    prompt: "Check race conditions",
  });
  assert.equal(spec.args[0], "exec");
  assert.ok(spec.args.includes("read-only"));
  assert.ok(spec.args.includes("--json"));
  assert.ok(spec.args.includes('model_reasoning_effort="xhigh"'));
  assert.match(spec.stdin, /adversarial code review/i);
  assert.match(spec.stdin, /git diff main\.\.\.HEAD/);
  assert.match(spec.stdin, /Check race conditions/);

  const customNonGit = buildCodexReviewSpec({
    cwd: tmpDir,
    style: "adversarial",
    scope: "custom",
    prompt: "Inspect file",
  });
  assert.ok(customNonGit.args.includes("--skip-git-repo-check"));

  assert.throws(
    () =>
      buildCodexReviewSpec({
        cwd: tmpDir,
        style: "standard",
        scope: "base",
        base: "--output=/tmp/pwn",
      }),
    /cannot start with "-"/,
  );
});

test("buildClaudeExecSpec enforces restricted read-only mode, stream-json, and disallowedTools", () => {
  const spec = buildClaudeExecSpec({
    prompt: "Inspect auth flow",
    cwd: tmpDir,
    model: "sonnet",
    effort: "high",
  });
  assert.equal(spec.stdin, "Inspect auth flow");
  assert.ok(spec.args.includes("-p"));
  assert.ok(spec.args.includes("--output-format"));
  assert.ok(spec.args.includes("stream-json"));
  assert.ok(spec.args.includes("--verbose"));
  assert.ok(spec.args.includes("--permission-prompts"));
  assert.ok(spec.args.includes("none"));
  assert.ok(spec.args.includes("dontAsk"));
  assert.ok(spec.args.includes("--restricted"));
  assert.ok(spec.args.includes("--strict-mcp-config"));
  assert.ok(spec.args.includes("--model"));
  assert.ok(spec.args.includes("sonnet"));
  assert.ok(spec.args.includes("--effort"));
  assert.ok(spec.args.includes("high"));
  assert.ok(!spec.args.includes("--no-session-persistence"));

  const toolsIdx = spec.args.indexOf("--tools");
  assert.notEqual(toolsIdx, -1);
  assert.equal(spec.args[toolsIdx + 1], "Read,Grep,Glob,Bash");

  const allowedIdx = spec.args.indexOf("--allowedTools");
  assert.notEqual(allowedIdx, -1);
  assert.match(spec.args[allowedIdx + 1], /Bash\(git diff \*\)/);

  const disallowedIdx = spec.args.indexOf("--disallowedTools");
  assert.notEqual(disallowedIdx, -1);
  assert.match(spec.args[disallowedIdx + 1], /Edit/);
  assert.match(spec.args[disallowedIdx + 1], /Write/);
  assert.match(spec.args[disallowedIdx + 1], /--output\*/);
  assert.match(spec.args[disallowedIdx + 1], /--ext-diff\*/);
});

test("buildClaudeExecSpec rejects unsupported effort levels", () => {
  assert.throws(
    () =>
      buildClaudeExecSpec({
        prompt: "Inspect auth flow",
        cwd: tmpDir,
        effort: "ultra",
      }),
    /Unsupported effort/,
  );
});

test("buildClaudeReviewSpec always stays read-only and ephemeral", () => {
  const spec = buildClaudeReviewSpec({
    cwd: tmpDir,
    style: "adversarial",
    scope: "commit",
    commit: "abc1234",
    effort: "medium",
  });
  assert.ok(spec.args.includes("dontAsk"));
  assert.ok(spec.args.includes("--restricted"));
  assert.ok(spec.args.includes("--no-session-persistence"));
  assert.ok(spec.args.includes("--effort"));
  assert.ok(spec.args.includes("medium"));
  assert.match(spec.stdin, /git show abc1234/);
});

test("inspectBinary detects inaccessible symlinks and resolves relative paths to absolute", () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, "agy-handoff-bin-test-"));
  const linkPath = path.join(dir, "claude");
  const missingTarget = path.join(dir, "nonexistent-target-2.1.325");
  const envKey = "AGY_HANDOFF_TEST_CLAUDE_BIN";
  const prev = process.env[envKey];

  try {
    if (process.platform !== "win32") {
      fs.symlinkSync(missingTarget, linkPath);
      process.env[envKey] = linkPath;

      const info = inspectBinary("claude", envKey);
      assert.equal(info.installed, true);
      assert.equal(info.accessible, false);
      assert.equal(info.binary, linkPath);
      assert.equal(info.symlinkTarget, missingTarget);
      assert.match(info.warning, /symlink exists/i);
      assert.equal(findBinary("claude", envKey), null);
    }

    process.env[envKey] = "src/cli.mjs";
    const resolved = findBinary("cli", envKey);
    if (process.platform !== "win32") {
      assert.ok(resolved);
      assert.ok(path.isAbsolute(resolved));
    }
  } finally {
    if (prev === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = prev;
    }
    fs.rmSync(dir, RM_OPTS);
  }
});

test("resolveSpawnSpec unwraps Windows npm .cmd shims to Node directly", () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, "agy-handoff-shim-test-"));
  try {
    const jsDir = path.join(dir, "node_modules", "pkg", "bin");
    fs.mkdirSync(jsDir, { recursive: true });
    const targetJs = path.join(jsDir, "tool.js");
    fs.writeFileSync(targetJs, "console.log('ok');", "utf8");
    const cmdPath = path.join(dir, "tool.cmd");
    fs.writeFileSync(
      cmdPath,
      '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\pkg\\bin\\tool.js" %*\r\n',
      "utf8",
    );

    const spec = resolveSpawnSpec(cmdPath, ["--version"], "win32");
    assert.equal(spec.command, process.execPath);
    assert.deepEqual(spec.args, [targetJs, "--version"]);
    assert.equal(spec.shell, false);
  } finally {
    fs.rmSync(dir, RM_OPTS);
  }
});

test("parseClaudeJsonOutput parses single JSON, stream-json JSONL, and broken JSON envelopes", () => {
  const parsed = parseClaudeJsonOutput(
    JSON.stringify({
      result: "No critical bugs found.",
      session_id: "sess_123",
      total_cost_usd: 0.042,
      usage: { input_tokens: 12, output_tokens: 5 },
      is_error: false,
    }),
  );
  assert.deepEqual(parsed, {
    text: "No critical bugs found.",
    sessionId: "sess_123",
    costUsd: 0.042,
    usage: { input_tokens: 12, output_tokens: 5 },
    structuredOutput: null,
    isError: false,
    parseError: false,
  });

  const streamOut = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess_stream" }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Working..." }] },
    }),
    JSON.stringify({
      type: "result",
      result: "Stream final answer",
      session_id: "sess_stream",
      total_cost_usd: 0.011,
      is_error: false,
    }),
  ].join("\n");
  assert.deepEqual(parseClaudeJsonOutput(streamOut), {
    text: "Stream final answer",
    sessionId: "sess_stream",
    costUsd: 0.011,
    usage: null,
    structuredOutput: null,
    isError: false,
    parseError: false,
  });

  const withStructured = parseClaudeJsonOutput(
    JSON.stringify({
      type: "result",
      result: "",
      structured_output: { summary: "ok", findings: [] },
      session_id: "sess_struct",
      is_error: false,
    }),
  );
  assert.deepEqual(withStructured.structuredOutput, { summary: "ok", findings: [] });
  assert.equal(withStructured.text, '{"summary":"ok","findings":[]}');

  const plain = parseClaudeJsonOutput("Plain output text");
  assert.equal(plain.text, "Plain output text");
  assert.equal(plain.parseError, false);

  const truncated = parseClaudeJsonOutput('{"result":"incomplete');
  assert.equal(truncated.parseError, true);
});

test("runClaudeExec streams events via onEvent and parses >135 KB JSON before truncating", async () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, "agy-handoff-claude-big-"));
  const prev = process.env.AGY_HANDOFF_CLAUDE_BIN;
  try {
    const fakeBin = createFakeExecutable(
      dir,
      "fake-claude",
      `
      console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess_big_999", model: "claude-opus-5-5" }));
      console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/cli.mjs" } }] } }));
      console.log(JSON.stringify({
        type: "result",
        result: "A".repeat(140000),
        session_id: "sess_big_999",
        total_cost_usd: 0.123,
        is_error: true,
      }));
      `,
    );
    process.env.AGY_HANDOFF_CLAUDE_BIN = fakeBin;

    const events = [];
    const res = await runClaudeExec({
      prompt: "Check",
      cwd: dir,
      onEvent: (ev) => events.push(ev),
    });
    assert.equal(res.ok, false);
    assert.equal(res.sessionId, "sess_big_999");
    assert.equal(res.costUsd, 0.123);
    assert.match(res.output, /\.\.\.\[truncated \d+ bytes\]$/);
    assert.ok(events.some((e) => e.summary === "Read: src/cli.mjs"));
  } finally {
    if (prev === undefined) delete process.env.AGY_HANDOFF_CLAUDE_BIN;
    else process.env.AGY_HANDOFF_CLAUDE_BIN = prev;
    fs.rmSync(dir, RM_OPTS);
  }
});

test("runCodexExec streams JSONL events via onEvent and extracts thread_id", async () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, "agy-handoff-codex-stream-"));
  const prev = process.env.AGY_HANDOFF_CODEX_BIN;
  try {
    const fakeBin = createFakeExecutable(
      dir,
      "fake-codex",
      `
      console.log(JSON.stringify({ type: "thread.started", thread_id: "thr_live_42" }));
      console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "git status" } }));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Clean repo" } }));
      `,
    );
    process.env.AGY_HANDOFF_CODEX_BIN = fakeBin;

    const events = [];
    const res = await runCodexExec({
      prompt: "Check",
      cwd: dir,
      onEvent: (ev) => events.push(ev),
    });
    assert.equal(res.ok, true);
    assert.equal(res.sessionId, "thr_live_42");
    assert.equal(res.output, "Clean repo");
    assert.ok(events.some((e) => e.summary === "Run: git status"));
  } finally {
    if (prev === undefined) delete process.env.AGY_HANDOFF_CODEX_BIN;
    else process.env.AGY_HANDOFF_CODEX_BIN = prev;
    fs.rmSync(dir, RM_OPTS);
  }
});

test("extractCodexSessionId extracts session id from Codex header", () => {
  assert.equal(
    extractCodexSessionId("model: gpt-6.2-sol\nsession id: 01a1f92c-bce8-7d03-800d-83b68318a561\n"),
    "01a1f92c-bce8-7d03-800d-83b68318a561",
  );
  assert.equal(extractCodexSessionId("no session here"), null);
});

test("truncateOutput respects UTF-8 codepoint boundaries and appends notice", () => {
  const big = "a".repeat(200);
  const out = truncateOutput(big, 50);
  assert.match(out, /\.\.\.\[truncated 150 bytes\]$/);

  const utf8Out = truncateOutput("가가", 4);
  assert.equal(utf8Out, "가\n\n...[truncated 3 bytes]");
  assert.ok(!utf8Out.includes("\uFFFD"));
});

test("runCommand handles early child exit with large stdin without EPIPE crash", async () => {
  const bigInput = "x".repeat(256 * 1024);
  const res = await runCommand({
    command: process.execPath,
    args: ["-e", "process.exit(2)"],
    cwd: tmpDir,
    stdin: bigInput,
    timeoutMs: 5000,
  });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
});

test("runCommand timeout terminates grandchild process tree and settles promptly", async () => {
  const script = `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit" });
    setTimeout(() => {}, 30000);
  `;
  const started = Date.now();
  const res = await runCommand({
    command: process.execPath,
    args: ["-e", script],
    cwd: tmpDir,
    timeoutMs: 150,
  });
  const elapsed = Date.now() - started;
  assert.equal(res.timedOut, true);
  assert.equal(res.ok, false);
  assert.ok(elapsed < 4000, `Expected prompt timeout settle, took ${elapsed}ms`);
});

test("buildClaudeExecSpec hardens workspace-write with --restricted, --strict-mcp-config, and disallowed dangerous commands", () => {
  const spec = buildClaudeExecSpec({
    prompt: "Fix bug",
    cwd: tmpDir,
    mode: "workspace-write",
  });
  assert.ok(spec.args.includes("acceptEdits"));
  assert.ok(spec.args.includes("--restricted"));
  assert.ok(spec.args.includes("--strict-mcp-config"));
  const disallowedIdx = spec.args.indexOf("--disallowedTools");
  assert.notEqual(disallowedIdx, -1);
  assert.match(spec.args[disallowedIdx + 1], /Bash\(sudo \*\)/);
  assert.match(spec.args[disallowedIdx + 1], /Bash\(git push \*\)/);
});

test("parseSemver, compareSemver, detectMissingFlags, and CLI compatibility checks work accurately", async () => {
  assert.deepEqual(parseSemver("2.1.325 (Claude Code)"), {
    major: 2,
    minor: 1,
    patch: 325,
    raw: "2.1.325",
  });
  assert.deepEqual(parseSemver("codex-cli 0.171.0"), {
    major: 0,
    minor: 171,
    patch: 0,
    raw: "0.171.0",
  });
  assert.equal(compareSemver(parseSemver("2.1.325"), parseSemver("2.1.259")), 1);
  assert.equal(compareSemver(parseSemver("2.1.258"), parseSemver("2.1.259")), -1);
  assert.equal(compareSemver(parseSemver("0.171.0"), parseSemver("0.171.0")), 0);

  // Token boundary ensures -o does not falsely match --output
  assert.deepEqual(detectMissingFlags("--output --permission-prompt", ["-o", "--permission-prompts"]), [
    "-o",
    "--permission-prompts",
  ]);
  assert.deepEqual(
    detectMissingFlags("  -o, --output-last-message\n  --permission-prompts <t>", [
      "-o",
      "--permission-prompts",
    ]),
    [],
  );

  const dir = fs.mkdtempSync(path.join(tmpDir, "agy-handoff-compat-test-"));
  const prevClaude = process.env.AGY_HANDOFF_CLAUDE_BIN;
  const prevCodex = process.env.AGY_HANDOFF_CODEX_BIN;
  try {
    const oldClaude = createFakeExecutable(
      dir,
      "old-claude",
      `
      if (process.argv.includes("--version")) {
        console.log("2.1.100 (Claude Code)");
        process.exit(0);
      }
      if (process.argv.includes("--help")) {
        console.log("Options:\\n  -p, --print\\n  --output-format <f>");
        process.exit(0);
      }
      console.error("error: unknown option '--restricted'");
      process.exit(2);
      `,
    );
    const oldCodex = createFakeExecutable(
      dir,
      "old-codex",
      `
      if (process.argv.includes("--version")) {
        console.log("codex-cli 0.120.0");
        process.exit(0);
      }
      if (process.argv.includes("--help")) {
        console.log("Usage: codex\\n  --json");
        process.exit(0);
      }
      console.error("error: unexpected argument '--ephemeral'");
      process.exit(2);
      `,
    );

    process.env.AGY_HANDOFF_CLAUDE_BIN = oldClaude;
    process.env.AGY_HANDOFF_CODEX_BIN = oldCodex;

    const claudeInfo = await inspectClaude();
    assert.equal(claudeInfo.minVersion, MIN_CLAUDE_VERSION);
    assert.equal(claudeInfo.compatible, false);
    assert.ok(claudeInfo.missingFlags.includes("--restricted"));
    assert.ok(claudeInfo.missingFlags.includes("--permission-prompts"));
    assert.match(claudeInfo.compatibilityNote, /claude update/);

    const codexInfo = await inspectCodex();
    assert.equal(codexInfo.minVersion, MIN_CODEX_VERSION);
    assert.equal(codexInfo.compatible, false);
    assert.ok(codexInfo.missingFlags.some((f) => f.includes("--ephemeral")));
    assert.match(codexInfo.compatibilityNote, /@openai\/codex@latest/);

    const claudeFail = await runClaudeExec({ prompt: "hi", cwd: dir });
    assert.equal(claudeFail.ok, false);
    assert.match(claudeFail.output, new RegExp(MIN_CLAUDE_VERSION.replace(/\./g, "\\.")));

    const codexFail = await runCodexExec({ prompt: "hi", cwd: dir });
    assert.equal(codexFail.ok, false);
    assert.match(codexFail.output, new RegExp(MIN_CODEX_VERSION.replace(/\./g, "\\.")));

    const structuredClaude = buildClaudeReviewSpec({
      cwd: tmpDir,
      jsonSchema: { type: "object", properties: { summary: { type: "string" } } },
    });
    assert.ok(structuredClaude.args.includes("--json-schema"));

    const structuredCodex = buildCodexReviewSpec({
      cwd: tmpDir,
      style: "standard",
      scope: "uncommitted",
      outputSchemaFile: "/tmp/schema.json",
    });
    assert.equal(structuredCodex.args[0], "exec");
    assert.ok(structuredCodex.args.includes("--output-schema"));
  } finally {
    if (prevClaude === undefined) delete process.env.AGY_HANDOFF_CLAUDE_BIN;
    else process.env.AGY_HANDOFF_CLAUDE_BIN = prevClaude;
    if (prevCodex === undefined) delete process.env.AGY_HANDOFF_CODEX_BIN;
    else process.env.AGY_HANDOFF_CODEX_BIN = prevCodex;
    fs.rmSync(dir, RM_OPTS);
  }
});

test("AGY discovery follows PATH independently of Codex and Claude overrides", (t) => {
  const dir = fs.mkdtempSync(path.join(tmpDir, "agy-discovery-"));
  t.after(() => fs.rmSync(dir, RM_OPTS));
  const file = path.join(dir, process.platform === "win32" ? "agy.CMD" : "agy");
  fs.writeFileSync(file, "", { mode: 0o755 });
  const keys = ["PATH", "AGY_HANDOFF_AGY_BIN", "AGY_HANDOFF_CODEX_BIN", "AGY_HANDOFF_CLAUDE_BIN"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.PATH = dir;
  delete process.env.AGY_HANDOFF_AGY_BIN;
  process.env.AGY_HANDOFF_CODEX_BIN = "custom-codex";
  process.env.AGY_HANDOFF_CLAUDE_BIN = "custom-claude";
  assert.equal(findAgyBinary(), file);
  process.env.AGY_HANDOFF_AGY_BIN = "none";
  assert.equal(findAgyBinary(), null);
});

test("AGY enforces the selected mode and limits quota fallback to read-only runs", async (t) => {
  const cwd = fs.mkdtempSync(path.join(tmpDir, "agy-mode-"));
  t.after(() => fs.rmSync(cwd, RM_OPTS));
  const previous = process.env.AGY_HANDOFF_AGY_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.AGY_HANDOFF_AGY_BIN;
    else process.env.AGY_HANDOFF_AGY_BIN = previous;
  });
  process.env.AGY_HANDOFF_AGY_BIN = createFakeExecutable(cwd, "agy", `
    import fs from "node:fs";
    const args = process.argv.slice(2);
    fs.appendFileSync("calls", JSON.stringify(args) + "\\n");
    const fallback = args.includes("gemini-4-argon-high");
    const result = fallback ? {status: "SUCCESS", response: "done"} :
      {status: "ERROR", error: "RESOURCE_EXHAUSTED"};
    console.log(JSON.stringify({event: "result", result}));
  `);
  const calls = () => fs.readFileSync(path.join(cwd, "calls"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const mode = (args) => args[args.indexOf("--mode") + 1];
  const write = await runAgyExec({ cwd, prompt: "task", mode: "workspace-write" });
  assert.equal(write.ok, false);
  assert.match(write.output, /RESOURCE_EXHAUSTED/);
  assert.deepEqual(calls().map(mode), ["accept-edits"]);
  const read = await runAgyExec({ cwd, prompt: "task" });
  assert.equal(read.ok, true);
  assert.equal(read.quotaFallback.toModel, "gemini-4-argon-high");
  assert.deepEqual(calls().map(mode), ["accept-edits", "plan", "plan"]);
  assert.equal(mode(buildAgyReviewSpec({ cwd }).args), "plan");
});

test("AGY reads terminal results past the stdout limit and fails incomplete streams", async (t) => {
  const cwd = fs.mkdtempSync(path.join(tmpDir, "agy-stream-"));
  t.after(() => fs.rmSync(cwd, RM_OPTS));
  const previous = process.env.AGY_HANDOFF_AGY_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.AGY_HANDOFF_AGY_BIN;
    else process.env.AGY_HANDOFF_AGY_BIN = previous;
  });
  process.env.AGY_HANDOFF_AGY_BIN = createFakeExecutable(cwd, "agy", `
    const prompt = process.argv.at(-1);
    console.log(JSON.stringify({event: "init", conversation_id: "run-id"}));
    console.log(JSON.stringify({event: "progress", text: "x".repeat(300000)}));
    if (prompt.endsWith("incomplete")) {
      console.log(JSON.stringify({event: "progress", status: "SUCCESS"}));
    } else {
      const result = prompt.endsWith("fail") ? {status: "ERROR", error: "late error"}
        : {status: "SUCCESS", structured_output: {report: "완료"}};
      process.stdout.write(JSON.stringify({event: "result", result}));
    }
  `);
  const fail = await runAgyExec({ cwd, prompt: "fail" });
  assert.equal(fail.ok, false);
  assert.equal(fail.output, "late error");
  const success = await runAgyExec({ cwd, prompt: "success" });
  assert.equal(success.ok, true);
  assert.deepEqual(success.structuredOutput, { report: "완료" });
  assert.equal(success.sessionId, "run-id");
  const incomplete = await runAgyExec({ cwd, prompt: "incomplete" });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.output, /ended without a valid result/);
});
