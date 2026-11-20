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
   - **Visible subagent panes (`/agents`, `Alt+J`) — recommended in Antigravity CLI when parallel inspection matters**: If `invoke_subagent` is available, check active defaults with `handoff_config({ action: "get" })` (unless overridden), then launch `codex-handoff` (with `Role: "<codexModel> <codexEffort> review"`) and `claude-handoff` (with `Role: "<claudeModel> <claudeEffort> review"`) in parallel, giving each the repository `cwd`, `style`, `scope`, optional `base`/`commit`/`prompt`, and `model`/`effort`. Each subagent runs in background mode and streams live `recentEvents` updates into its own `/agents` pane.
   - **Direct single-call MCP (`handoff_cross_review`)**: Pass `cwd` (repository root), `style` (`"adversarial"` recommended for second opinions), `scope` (`"uncommitted"`, `"base"`, `"commit"`, or `"custom"`), and optional `base`, `commit`, `prompt`, `codexModel`, `codexEffort`, `claudeModel`, `claudeEffort`.
   - Omitted model/effort values automatically use the configured `cross-review` or global default (built-in: Codex `gpt-6.2-sol` `high`, Claude `claude-opus-5-5` `high`; configure via `/agy-handoff:handoff-models` or `handoff_config`).
   - CLI fallback:
     `node <plugin-root>/src/cli.mjs cross-review --style adversarial --scope uncommitted --cwd <cwd>`
   - Live terminal dashboard (optional in another pane):
     `node <plugin-root>/src/cli.mjs watch`

2. **Handle partial availability gracefully**:
   - If one CLI is not installed, `handoff_cross_review` still runs the installed CLI and marks the missing one as `skipped`. Report the available review and briefly note the missing CLI install hint.

3. **Synthesize the two reviews**:
   - **Consensus findings** (flagged by both engines): prioritize these at the top.
   - **Unique findings** (flagged by only one engine): verify against the actual source files to distinguish genuine catches from false positives.
   - **Disagreements / Trade-offs**: summarize where the two engines took different architectural stances and give your recommendation.
