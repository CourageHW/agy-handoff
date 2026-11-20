---
name: handoff-models
description: View, set, or reset model, effort, and routing settings for Codex, Claude Code, and Antigravity.
---

# Handoff Models

1. For a status request, call `handoff_config({ action: "get" })`. Show effective models, effort, and setting sources for `default`, `review`, `delegate`, `cross-review`, and `plan`, along with the configuration path.
2. For an update, use `handoff_config` with `action: "set"` or `"reset"`, the requested scope, and the specified engine (`codex`, `claude`, or `agy`). If the request is ambiguous, ask which setting and scope the user wants to change. Use `cli-default` to inherit the CLI setting. Existing model aliases such as `neon` and `opus5.5` are supported.
3. For auto-routing, set `routing.policy` to `balanced`, `least-used`, `prefer-codex`, `prefer-claude`, or `prefer-agy`, and apply any requested per-task preferences under `routing.taskTypes`. Routing chooses from the current host's eligible peers.
4. Show the resulting effective settings. If MCP is unavailable, use `node <plugin-root>/src/cli.mjs models show`, `models set review codex gpt-6.2-sol xhigh`, or `models reset all` as appropriate.
