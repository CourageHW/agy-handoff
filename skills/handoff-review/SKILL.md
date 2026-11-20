---
name: handoff-review
description: >-
  Use this skill when the user asks to review uncommitted changes, a branch diff,
  a commit, or specific files using OpenAI Codex or Anthropic Claude Code
  (including standard or adversarial code reviews).
---

# Handoff Review

Run a read-only code review using the local `codex` or `claude` CLI via `agy-handoff`.

## Procedure

1. **Determine review parameters** from the user's request:
   - `engine`: `"codex"` or `"claude"` (if unspecified, check availability via `handoff_doctor` or default to the installed engine).
   - `style`: `"standard"` for general bug/regression review, or `"adversarial"` when the user asks for a strict, skeptical, architecture/security/edge-case challenge.
   - `scope`: `"uncommitted"` (default), `"base"` (requires `base` branch), `"commit"` (requires `commit` SHA), or `"custom"` (provide target files/focus in `prompt`).
   - `model` / `effort`: optional overrides; if omitted, uses the configured `review` or global default (built-in: Codex `gpt-6.2-sol` `high`, Claude `claude-opus-5-5` `high`; configure via `/agy-handoff:handoff-models` or `handoff_config`).
   - `cwd`: active repository root path.
   - `background`: set `true` for large diffs if the user wants to keep working while the review runs.

2. **Invoke the tool (or visible subagent pane)**:
   - Prefer `invoke_subagent` with `codex-handoff` or `claude-handoff` (passing `Role: "<model> <effort> review"` after checking `handoff_config({ action: "get" })` if omitted) when the user wants a visible `/agents` (`Alt+J`) pane streaming live progress, or call the MCP tool `handoff_review` directly for a fast single call.
   - If the MCP server is unavailable in the current session, fall back to the bundled CLI:
     `node <plugin-root>/src/cli.mjs review --engine <codex|claude> --style <standard|adversarial> --scope <scope> --cwd <cwd>`

3. **Handle background jobs** (if `background: true`):
   - Share the returned `jobId` with the user (and mention `node <plugin-root>/src/cli.mjs watch <jobId>` if they want a live terminal tail).
   - Check progress with `handoff_job_status` (`waitSec`, `sinceSeq` return `recentEvents`), fetch output with `handoff_job_result`, or cancel with `handoff_job_cancel`.

4. **Verify and present findings**:
   - Spot-check critical/high findings against the local files to confirm line numbers and avoid false positives.
   - Present findings ordered by severity with concise, actionable fixes.
