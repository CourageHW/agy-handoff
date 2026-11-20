import test from "node:test";
import assert from "node:assert/strict";
import {
  compactText,
  createEventStreamParser,
  parseClaudeStreamJsonLine,
  parseCodexJsonLine,
  parseCodexJsonlOutput,
  stripAnsiAndControl,
} from "../src/events.mjs";

test("stripAnsiAndControl and compactText remove escape sequences and respect codepoint limits", () => {
  assert.equal(stripAnsiAndControl("\x1b[31mred\x1b[0m\x07ok"), "red ok");
  assert.equal(compactText("  hello\n\tworld  "), "hello world");
  assert.equal(compactText(0), "0");
  assert.equal(compactText(false), "false");
  assert.equal(compactText("\x1b]0;pwn\x07abc😀def", 6), "abc...");
  assert.equal(compactText("abcdef", 3), "abc");
  assert.equal(compactText("abcdef", 0), "");
});

test("parseCodexJsonLine parses session, command execution, message, and error events", () => {
  assert.deepEqual(
    parseCodexJsonLine('{"type":"thread.started","thread_id":"thr_1"}'),
    [{ kind: "init", sessionId: "thr_1", summary: "Session started" }],
  );

  assert.deepEqual(
    parseCodexJsonLine(
      JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", command: "git diff --stat" },
      }),
    ),
    [{ kind: "tool_start", tool: "Bash", summary: "Run: git diff --stat" }],
  );

  assert.deepEqual(
    parseCodexJsonLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "git diff --stat", exit_code: 0 },
      }),
    ),
    [
      {
        kind: "tool_done",
        tool: "Bash",
        exitCode: 0,
        summary: "Exit 0: git diff --stat",
      },
    ],
  );

  assert.deepEqual(parseCodexJsonLine("not json"), []);
});

test("parseClaudeStreamJsonLine parses init, tool_use, text, and result events compactly", () => {
  assert.deepEqual(
    parseClaudeStreamJsonLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess_1",
        model: "claude-opus-5-5",
      }),
    ),
    [
      {
        kind: "init",
        sessionId: "sess_1",
        model: "claude-opus-5-5",
        summary: "Session started (claude-opus-5-5)",
      },
    ],
  );

  assert.deepEqual(
    parseClaudeStreamJsonLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "src/jobs.mjs" } },
            { type: "text", text: "Checking job flush order." },
          ],
        },
      }),
    ),
    [
      { kind: "tool_start", tool: "Read", summary: "Read: src/jobs.mjs" },
      { kind: "message", summary: "Note: Checking job flush order." },
    ],
  );

  assert.deepEqual(
    parseClaudeStreamJsonLine(
      JSON.stringify({
        type: "result",
        result: "Done",
        session_id: "sess_1",
        total_cost_usd: 0.015,
        is_error: false,
        num_turns: 2,
      }),
    ),
    [
      {
        kind: "result",
        sessionId: "sess_1",
        costUsd: 0.015,
        isError: false,
        numTurns: 2,
        summary: "Completed (2 turns)",
      },
    ],
  );
});

test("parseCodexJsonlOutput handles whitespace messages and turn.completed clearing transient errors", () => {
  const out = [
    JSON.stringify({ type: "thread.started", thread_id: "thr_abc" }),
    JSON.stringify({ type: "error", message: "Transient warning" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Final answer" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "   \n  " },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");

  assert.deepEqual(parseCodexJsonlOutput(out), {
    lastMessage: "Final answer",
    sessionId: "thr_abc",
    error: null,
    eventCount: 5,
    parsedAnyJson: true,
  });
});

test("createEventStreamParser decodes split multibyte UTF-8 chunks and isolates callback errors", () => {
  const seen = [];
  let count = 0;
  const parser = createEventStreamParser("codex", (ev) => {
    count += 1;
    if (count === 1) {
      throw new Error("consumer glitch");
    }
    seen.push(ev);
  });

  const line1 = JSON.stringify({ type: "thread.started", thread_id: "t1" });
  const line2 = JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "한글😀테스트" },
  });
  const combinedBuf = Buffer.from(`${line1}\n${line2}`, "utf8");
  const emojiOffset = combinedBuf.indexOf("한글😀테스트");

  // Split right inside the multibyte UTF-8 sequence
  parser.push(combinedBuf.subarray(0, emojiOffset + 4));
  parser.push(combinedBuf.subarray(emojiOffset + 4));
  parser.flush();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].seq, 2);
  assert.equal(seen[0].summary, "Note: 한글😀테스트");
  assert.ok(!seen[0].summary.includes("\uFFFD"));
});
