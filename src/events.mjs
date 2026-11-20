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
                  target: typeof item.command === "string" ? item.command : null,
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
          if (isStart) return [];
          const changes = Array.isArray(item.changes)
            ? item.changes
                .map((c) => c?.path || c?.file_path)
                .filter((p) => typeof p === "string" && p.trim())
            : [];
          const primaryTarget =
            item.path || item.file_path || changes[0] || "changed";
          const allTargets =
            changes.length > 0
              ? changes
              : typeof primaryTarget === "string" && primaryTarget !== "changed"
                ? [primaryTarget]
                : [];
          return [
            {
              kind: "file",
              target: typeof primaryTarget === "string" ? primaryTarget : null,
              ...(allTargets.length > 0 ? { targets: allTargets } : {}),
              ...(item.status ? { status: item.status } : {}),
              summary: `File: ${compactText(primaryTarget)}`,
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
        const isPatternOnly =
          (toolName === "Grep" || toolName === "Glob") &&
          !block.input?.file_path &&
          !block.input?.path;
        events.push({
          kind: "tool_start",
          tool: toolName,
          target: detail ? detail : null,
          ...(typeof block.id === "string" && block.id ? { toolUseId: block.id } : {}),
          ...(isPatternOnly ? { patternOnly: true } : {}),
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
      if (block?.type !== "tool_result") continue;
      const toolUseId =
        typeof block.tool_use_id === "string" && block.tool_use_id
          ? block.tool_use_id
          : null;
      if (block.is_error === true) {
        const text =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c) => c?.text || "").join(" ")
              : "";
        events.push({
          kind: "error",
          ...(toolUseId ? { toolUseId } : {}),
          summary: `Tool error: ${compactText(text)}`,
        });
      } else if (toolUseId) {
        events.push({
          kind: "tool_done",
          toolUseId,
          isError: false,
          summary: "Tool completed",
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

export function parseAgyStreamJsonLine(line) {
  const ev = tryParseJsonObject(line);
  if (!ev) return [];

  if (ev.event === "init") {
    const model = ev.init?.model || "gemini-4-neon-high";
    return [
      {
        kind: "init",
        sessionId: ev.conversation_id || null,
        model,
        summary: `Session started (${compactText(model, 60)})`,
      },
    ];
  }

  if (ev.event === "step_update" && ev.step_update && typeof ev.step_update === "object") {
    const su = ev.step_update;
    if (su.step_type === "tool") {
      const rawTool = String(su.tool_name || su.tool_info?.name || "Tool");
      const params =
        su.tool_info?.parameters && typeof su.tool_info.parameters === "object"
          ? su.tool_info.parameters
          : {};
      let mappedTool = rawTool;
      if (rawTool === "read_file" || rawTool === "view_file") mappedTool = "Read";
      else if (rawTool === "grep_search") mappedTool = "Grep";
      else if (rawTool === "find_by_name" || rawTool === "list_dir") mappedTool = "Glob";
      else if (rawTool === "run_command") mappedTool = "Bash";
      else if (
        rawTool === "edit_file" ||
        rawTool === "replace_file_content" ||
        rawTool === "multi_replace_file_content" ||
        rawTool === "sed_file"
      ) {
        mappedTool = "Edit";
      } else if (rawTool === "write_file" || rawTool === "write_to_file") {
        mappedTool = "Write";
      }

      const target =
        params.Path ||
        params.TargetFile ||
        params.AbsolutePath ||
        params.CommandLine ||
        params.SearchPath ||
        params.Query ||
        params.Pattern ||
        "";
      const toolUseId =
        typeof su.step_index === "number" ? `agy_step_${su.step_index}` : undefined;

      if (su.state === "ACTIVE") {
        return [
          {
            kind: "tool_start",
            tool: mappedTool,
            target: target ? String(target) : null,
            ...(toolUseId ? { toolUseId } : {}),
            summary: target
              ? `${mappedTool}: ${compactText(target)}`
              : mappedTool,
          },
        ];
      }
      if (su.state === "DONE") {
        return [
          {
            kind: "tool_done",
            tool: mappedTool,
            ...(toolUseId ? { toolUseId } : {}),
            isError: false,
            summary: `${mappedTool} completed`,
          },
        ];
      }
      if (su.state === "ERROR") {
        return [
          {
            kind: "error",
            ...(toolUseId ? { toolUseId } : {}),
            summary: `Tool error: ${compactText(rawTool)}`,
          },
        ];
      }
    }

    if (
      su.step_type === "agent_response" &&
      su.state === "DONE" &&
      typeof su.text_delta === "string" &&
      su.text_delta.trim()
    ) {
      return [
        {
          kind: "message",
          summary: `Note: ${compactText(su.text_delta)}`,
        },
      ];
    }
    return [];
  }

  if (ev.event === "result" && ev.result && typeof ev.result === "object") {
    const r = ev.result;
    const isError = r.status === "ERROR";
    const turns = typeof r.num_turns === "number" ? r.num_turns : 1;
    return [
      {
        kind: "result",
        sessionId: r.conversation_id || null,
        usage: r.usage && typeof r.usage === "object" ? r.usage : null,
        isError,
        numTurns: r.num_turns ?? null,
        summary: isError
          ? `Error: ${compactText(r.error || r.response || "failed")}`
          : `Completed (${turns} turns)`,
      },
    ];
  }

  return [];
}

export function createEventStreamParser(engine, onEvent) {
  const parseLine =
    engine === "codex"
      ? parseCodexJsonLine
      : engine === "agy"
        ? parseAgyStreamJsonLine
        : parseClaudeStreamJsonLine;
  let seq = 0;

  return createLineStreamParser((line) => {
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
  });
}

export function createLineStreamParser(emitLine, maxLineBytes = MAX_BUFFERED_LINE_BYTES) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let dropUntilNewline = false;

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

      if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) {
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
