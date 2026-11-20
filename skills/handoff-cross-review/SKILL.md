---
name: handoff-cross-review
description: >-
  Use this skill when the user wants a second opinion or dual-engine cross-review
  running both OpenAI Codex and Anthropic Claude Code in parallel on the same
  diff, commit, architecture decision, or set of files.
---

# Handoff Cross-Review

Run Codex and Claude Code independently in parallel and synthesize their findings into a unified, verified report.

## Procedure

1. **Choose direct parallel MCP vs visible subagent panes**:
   - **Visible subagent panes (`/agents`, `Alt+J`) — recommended in Antigravity CLI when parallel inspection matters**: If `invoke_subagent` is available, check active defaults with `handoff_config({ action: "get" })` (unless overridden), then launch `codex-handoff` (with `Role: "<codexModel> <codexEffort> review"`) and `claude-handoff` (with `Role: "<claudeModel> <claudeEffort> review"`) in parallel, giving each the repository `cwd`, `style`, `scope`, optional `base`/`commit`/`prompt`/`context`, and `model`/`effort`. Each subagent runs in background mode and streams live `recentEvents` updates into its own `/agents` pane.
   - **Direct single-call MCP (`handoff_cross_review`)**: Pass `cwd` (repository root), `style` (`"adversarial"` recommended for second opinions), `scope` (`"uncommitted"`, `"base"`, `"commit"`, or `"custom"`), optional `context` (`{ files, summary, constraints }`), `structured: true` (for schema-constrained findings + mechanical file/line citation checks), and optional `base`, `commit`, `prompt`, `codexModel`, `codexEffort`, `claudeModel`, `claudeEffort`.
   - CLI fallback:
     `node <plugin-root>/src/cli.mjs cross-review --style adversarial --scope uncommitted --structured --cwd <cwd>`
   - Live terminal dashboard (optional in another pane):
     `node <plugin-root>/src/cli.mjs watch`

2. **Handle partial availability gracefully**:
   - If one CLI is not installed, `handoff_cross_review` still runs the installed CLI and marks the missing one as `skipped`. Report the available review and briefly note the missing CLI install hint.

3. **Synthesize the two reviews**:
   Organize the unified report into four structured sections:
   - **Consensus Findings**: Issues independently flagged by both engines (with highest severity/file/line references first).
   - **Unique Findings**: Issues raised by only one engine.
   - **Conflicts / Trade-offs**: Places where Codex and Claude disagreed on severity, root cause, or architectural direction, plus your recommendation.
   - **Verified Findings**: Only after you directly read the cited local files and line ranges yourself, confirm which Consensus/Unique findings hold up in the actual codebase and dismiss any false positives. Never list a finding as Verified without checking the underlying source lines.
