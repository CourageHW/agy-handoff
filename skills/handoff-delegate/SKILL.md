---
name: handoff-delegate
description: >-
  Use this skill when the user asks to delegate a debugging task, deep codebase
  investigation, implementation draft, or background job to local Codex or
  Claude Code CLI, or to inspect/cancel running handoff background jobs.
---

# Handoff Delegate

Delegate focused tasks to local `codex` or `claude` CLIs safely and manage asynchronous runs.

## Safety First

- Default to `mode: "read-only"` for investigation, root-cause analysis, test-failure triage, and patch proposals.
- Only use `mode: "workspace-write"` when the user explicitly requests that Codex or Claude Code directly edit files in the workspace.
- Never run two `workspace-write` handoffs concurrently on the same files.

## Procedure

1. **Scope the handoff prompt**:
   - State the concrete objective, relevant paths/symbols, reproduction command (if debugging), and acceptance criteria.
   - Avoid pasting huge file contents; pass `cwd` so the external CLI reads the workspace directly.

2. **Execute via MCP or dedicated subagent pane**:
   - Use `invoke_subagent` with `codex-handoff` or `claude-handoff` (passing `Role: "<model> <effort> delegate"` after checking `handoff_config({ action: "get" })` if omitted) when you want a dedicated `/agents` (`Alt+J`) pane streaming live progress, OR call `handoff_delegate` with `{ engine, prompt, mode, cwd, model, effort, sessionId, background, timeoutSec }`.
   - Omitted `model` / `effort` values automatically use the configured `delegate` or global default (built-in: Codex `gpt-6.2-sol` `high`, Claude `claude-opus-5-5` `high`; configure via `/agy-handoff:handoff-models` or `handoff_config`).
   - To continue a previous Claude Code or Codex session, pass its returned `sessionId` (or `"last"` for Codex).
   - CLI fallback (if MCP is unavailable):
     `node <plugin-root>/src/cli.mjs delegate --engine <codex|claude> --mode <read-only|workspace-write> --cwd <cwd> --prompt "<task>"`

3. **Manage & observe background jobs**:
   - Inspect live status & `recentEvents`: `handoff_job_status` (supports `waitSec` and `sinceSeq`)
   - Live terminal monitor: `node <plugin-root>/src/cli.mjs watch [jobId]`
   - Fetch completed output: `handoff_job_result`
   - Cancel a stuck or unwanted run: `handoff_job_cancel`

4. **Post-handoff check**:
   - If `mode: "workspace-write"` was used, inspect `git status` and `git diff` and run relevant tests before concluding.
