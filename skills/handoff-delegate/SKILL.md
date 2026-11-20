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

- Default to `mode: "read-only"` for investigation, root-cause analysis, test-failure triage, and patch proposals. Never silently escalate from `read-only` to `workspace-write`.
- Only use `mode: "workspace-write"` when the user explicitly requests and confirms that Codex or Claude Code should directly edit files in the workspace.
- Understand the engine sandbox difference before allowing writes:
  - **Codex** runs inside its OS sandbox (`-s workspace-write`).
  - **Claude Code** runs with `--permission-mode acceptEdits --restricted --strict-mcp-config --disallowedTools "Bash(sudo *),Bash(git push),Bash(git push *)"`, which confines built-in file tools (`Read`, `Edit`, `Write`, `Grep`, `Glob`) to `cwd`, but `Bash` itself has no OS filesystem/network sandbox.
- Never run two `workspace-write` handoffs concurrently on the same files.

## Procedure

1. **Write a concrete task contract (no persona fluff)**:
   - Skip role-play intros (*"You are an expert..."*). State clearly:
     - **Objective & Scope**: exact bug, module, or deliverable and what NOT to touch.
     - **Expected Output**: e.g., root cause with `file:line` + minimal patch, interface design + failure modes, or exact test command + fix.
     - **Constraints & Verification**: permission boundary, compatibility/security constraints, and reproduction/test command(s).
   - Always pass `cwd`, `taskType` (`"debugging" | "implementation" | "architecture" | "review" | "general"`), and structured `context: { files, summary, constraints, acceptanceCriteria }` so `agy-handoff` attaches the matching execution contract and preloads small scoped files automatically.
   - Pass `engine: "auto"` only when policy-based automatic routing is desired.

2. **Execute via MCP or dedicated subagent pane**:
   - Use `invoke_subagent` with `codex-handoff` or `claude-handoff` (passing `Role: "<model> <effort> delegate"` after checking `handoff_config({ action: "get" })` if omitted) when you want a dedicated `/agents` (`Alt+J`) pane streaming live progress, OR call `handoff_delegate` with `{ engine, taskType, prompt, context, mode, cwd, model, effort, sessionId, background, timeoutSec }`.
   - To continue a previous Claude Code or Codex session, pass its returned `sessionId` (or `"last"` for Codex).
   - CLI fallback (if MCP is unavailable):
     `node <plugin-root>/src/cli.mjs delegate --engine <codex|claude|auto> --mode <read-only|workspace-write> --cwd <cwd> --files "<a,b>" --prompt "<task>"`

3. **Manage, observe & safely recover jobs**:
   - Inspect live status & `recentEvents`: `handoff_job_status` (supports `waitSec` and `sinceSeq`, or `includeStats: true` when `jobId` is omitted)
   - Live terminal monitor / stats: `node <plugin-root>/src/cli.mjs watch [jobId]` or `node <plugin-root>/src/cli.mjs stats --table`
   - Fetch completed output & evidence: `handoff_job_result`
   - Safely replay a failed/timed-out `read-only` job (never `workspace-write`): `handoff_job_retry({ jobId, fallbackEngine })`
   - Cancel a stuck or unwanted run: `handoff_job_cancel`

4. **Post-handoff verification**:
   - Inspect `executionEvidence` (observed tool calls, commands, files modified, and warnings).
   - If `mode: "workspace-write"` was used, never rely solely on CLI prose: verify `workspaceGitDelta` / `git status` / `git diff` and run tests before concluding.
