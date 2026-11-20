---
name: handoff-review
description: >-
  Use this skill when the user asks to review uncommitted changes, a branch diff,
  a commit, or specific files using Codex, Claude Code, or Antigravity
  (including standard or adversarial code reviews).
---

# Handoff Review

Run a read-only code review using a local CLI through `handoff_review`.

## Procedure

1. **Determine review parameters** from the user's request:
   - `engine`: `"codex"`, `"claude"`, `"agy"`, or `"auto"` (when `"auto"` is chosen, `handoff_review` selects transparently via CLI health and configured `routing` policy).
   - `style`: `"standard"` for general bug/regression review, or `"adversarial"` for strict architecture/security/race-case challenges.
   - `scope`: `"uncommitted"` (default), `"base"` (requires `base`), `"commit"` (requires `commit`), or `"custom"`.
   - `context`: optional `{ files, summary, constraints }` when target paths or prior findings are already known to avoid redundant repo sweeps.
   - `structured`: optional `true` to enforce JSON finding schema (`severity`, `file`, `line`, `title`, `detail`, `fix`).
   - `model` / `effort`: optional overrides; if omitted, uses the configured review or global defaults.
   - `cwd`: active repository root path.
   - `background`: set `true` for large diffs if the user wants to continue working.

2. **Invoke the MCP tool**:
   - Call the MCP tool `handoff_review` directly. Set `background: true` for a long review and track the returned job ID.
   - If the MCP server is unavailable in the current session, fall back to the bundled CLI:
     `node <plugin-root>/src/cli.mjs review --engine <codex|claude|agy|auto> --style <standard|adversarial> --scope <scope> --cwd <cwd>`

3. **Handle background jobs** (if `background: true`):
   - Share the returned `jobId` with the user (and mention `node <plugin-root>/src/cli.mjs watch <jobId>` if they want a live terminal tail).
   - Check progress with `handoff_job_status` (`waitSec`, `sinceSeq` return `recentEvents`), fetch output with `handoff_job_result`, or cancel with `handoff_job_cancel`.

4. **Verify and present findings**:
   - Spot-check critical/high findings against the local files to confirm line numbers and avoid false positives.
   - Present findings ordered by severity with concise, actionable fixes.
