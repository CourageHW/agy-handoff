import { StringDecoder } from "node:string_decoder";

const MAX_BUFFERED_LINE_BYTES = 512 * 1024; // 512 KB cap per incomplete line

export function stripAnsiAndControl(text) {
  if (text === null || text === undefined) return "";
  let str;
  if (typeof text === "string") {
    str = text;
  } else if (typeof text === "number" || typeof text === "boolean") {
    str = String(text);
  } else {
    try {
      str = JSON.stringify(text) || "";
    } catch {
      return "";
    }
  }
  return str
    .replace(
      /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g,
      "",
    )
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export function compactText(text, maxLen = 120) {
  if (text === null || text === undefined) return "";
  const cleaned = stripAnsiAndControl(String(text))
    .replace(/\s+/g, " ")
    .trim();
  if (maxLen <= 0) return "";
  const chars = Array.from(cleaned);
  if (chars.length <= maxLen) return cleaned;
  if (maxLen <= 3) return chars.slice(0, maxLen).join("");
  return `${chars.slice(0, maxLen - 3).join("")}...`;
}

function tryParseJsonObject(line) {
  const trimmed = (line || "").trim();
  if (!trimmed || !trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function parseCodexJsonLine(line) {
  const ev = tryParseJsonObject(line);
  if (!ev) return [];

  switch (ev.type) {
    case "thread.started":
      return [
        {
          kind: "init",
          sessionId: ev.thread_id || null,
          summary: "Session started",
        },
      ];

    case "turn.started":
      return [
        {
          kind: "turn",
          summary: "Turn started",
        },
      ];

    case "item.started":
    case "item.completed": {
      const item = ev.item;
      if (!item || typeof item !== "object") return [];
      const isStart = ev.type === "item.started";

      switch (item.type) {
        case "command_execution":
          return [
            isStart
              ? {
                  kind: "tool_start",
                  tool: "Bash",
                  summary: `Run: ${compactText(item.command ?? "")}`,
                }
              : {
                  kind: "tool_done",
                  tool: "Bash",
                  exitCode: item.exit_code ?? null,
                  summary: `Exit ${item.exit_code ?? "?"}: ${compactText(item.command ?? "")}`,
                },
          ];

        case "agent_message":
          if (!isStart && typeof item.text === "string" && item.text.trim()) {
            return [
              {
                kind: "message",
                summary: `Note: ${compactText(item.text)}`,
              },
            ];
          }
          return [];

        case "file_change": {
          const target =
            item.path || item.file_path || item.changes?.[0]?.path || "changed";
          return [
            {
              kind: "file",
              summary: `File: ${compactText(target)}`,
            },
          ];
        }

        case "mcp_tool_call":
          return [
            {
              kind: isStart ? "tool_start" : "tool_done",
              tool: item.tool || item.name || "mcp",
              summary: `MCP: ${compactText(item.tool || item.name || "call")}`,
            },
          ];

        case "web_search":
          return [
            {
              kind: isStart ? "tool_start" : "tool_done",
              tool: "WebSearch",
              summary: `Search: ${compactText(item.query ?? "")}`,
            },
          ];

        case "reasoning":
          if (!isStart || item.text) {
            return [
              {
                kind: "thinking",
                summary: compactText(item.text || "Reasoning..."),
              },
            ];
          }
          return [];

        default:
          return [];
      }
    }

    case "turn.completed":
      return [
        {
          kind: "turn_done",
          usage: ev.usage || null,
          summary: "Turn completed",
        },
      ];

    case "turn.failed":
    case "error":
      return [
        {
          kind: "error",
          summary: `Error: ${compactText(ev.error?.message || ev.message || "execution failed")}`,
        },
      ];

    default:
      return [];
  }
}

function extractClaudeToolDetail(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of ["file_path", "path", "pattern", "command", "url", "query"]) {
    if (typeof input[key] === "string" && input[key].trim()) {
      return input[key];
    }
  }
  for (const val of Object.values(input)) {
    if (typeof val === "string" && val.trim()) {
      return val;
    }
  }
  return "";
}

export function parseClaudeStreamJsonLine(line) {
  const ev = tryParseJsonObject(line);
  if (!ev) return [];

  if (ev.type === "system" && ev.subtype === "init") {
    return [
      {
        kind: "init",
        sessionId: ev.session_id || null,
        model: ev.model || null,
        summary: `Session started (${compactText(ev.model || "claude", 60)})`,
      },
    ];
  }

  if (ev.type === "assistant") {
    const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
    const events = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use") {
        const toolName = compactText(block.name || "Tool", 40) || "Tool";
        const detail = extractClaudeToolDetail(block.input);
        events.push({
          kind: "tool_start",
          tool: toolName,
          summary: detail ? `${toolName}: ${compactText(detail)}` : toolName,
        });
      } else if (
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim()
      ) {
        events.push({
          kind: "message",
          summary: `Note: ${compactText(block.text)}`,
        });
      } else if (block.type === "thinking") {
        events.push({
          kind: "thinking",
          summary: "Reasoning...",
        });
      }
    }
    return events;
  }

  if (ev.type === "user") {
    const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
    const events = [];
    for (const block of blocks) {
      if (block?.type === "tool_result" && block.is_error === true) {
        const text =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c) => c?.text || "").join(" ")
              : "";
        events.push({
          kind: "error",
          summary: `Tool error: ${compactText(text)}`,
        });
      }
    }
    return events;
  }

  if (ev.type === "result") {
    const turns = typeof ev.num_turns === "number" ? ev.num_turns : 1;
    const errorDetail =
      (typeof ev.result === "string" && ev.result.trim()) ||
      ev.subtype ||
      "failed";
    return [
      {
        kind: "result",
        sessionId: ev.session_id || null,
        costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : null,
        usage: ev.usage && typeof ev.usage === "object" ? ev.usage : null,
        isError: Boolean(ev.is_error),
        numTurns: ev.num_turns ?? null,
        summary: ev.is_error
          ? `Error: ${compactText(errorDetail)}`
          : `Completed (${turns} turns)`,
      },
    ];
  }

  return [];
}

export function parseCodexJsonlOutput(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  let sessionId = null;
  let lastMessage = "";
  let error = null;
  let usage = null;
  let eventCount = 0;
  let parsedAnyJson = false;

  for (const rawLine of lines) {
    const ev = tryParseJsonObject(rawLine);
    if (!ev) continue;
    parsedAnyJson = true;
    eventCount += 1;

    if (ev.type === "thread.started" && ev.thread_id) {
      sessionId = ev.thread_id;
    } else if (
      ev.type === "item.completed" &&
      ev.item?.type === "agent_message" &&
      typeof ev.item.text === "string" &&
      ev.item.text.trim()
    ) {
      lastMessage = ev.item.text.trim();
    } else if (ev.type === "turn.completed") {
      error = null;
      if (ev.usage && typeof ev.usage === "object") {
        usage = ev.usage;
      }
    } else if (ev.type === "turn.failed" || ev.type === "error") {
      error = ev.error?.message || ev.message || error;
    }
  }

  return {
    lastMessage,
    sessionId,
    error,
    usage,
    eventCount,
    parsedAnyJson,
  };
}

export function createEventStreamParser(engine, onEvent) {
  const parseLine =
    engine === "codex" ? parseCodexJsonLine : parseClaudeStreamJsonLine;
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let dropUntilNewline = false;
  let seq = 0;

  const emitLine = (line) => {
    let events;
    try {
      events = parseLine(line);
    } catch {
      return;
    }
    for (const ev of events) {
      seq += 1;
      try {
        onEvent({
          ts: new Date().toISOString(),
          seq,
          engine,
          ...ev,
        });
      } catch {
        // isolate consumer errors so remaining events in the chunk still parse
      }
    }
  };

  return {
    push(chunk) {
      let text;
      if (typeof chunk === "string") {
        text = chunk;
      } else {
        const buf = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        text = decoder.write(buf);
      }

      if (dropUntilNewline) {
        const nlIdx = text.indexOf("\n");
        if (nlIdx === -1) return;
        text = text.slice(nlIdx + 1);
        dropUntilNewline = false;
      }

      buffer += text;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || "";

      if (Buffer.byteLength(buffer, "utf8") > MAX_BUFFERED_LINE_BYTES) {
        buffer = "";
        dropUntilNewline = true;
      }

      for (const line of parts) {
        emitLine(line);
      }
    },
    flush() {
      try {
        const tail = decoder.end();
        if (!dropUntilNewline) {
          const remaining = (buffer + tail).trim();
          if (remaining) {
            emitLine(remaining);
          }
        }
      } finally {
        buffer = "";
        dropUntilNewline = false;
      }
    },
  };
}
