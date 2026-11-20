---
name: handoff-cross-review
description: >-
  Use this skill when the user wants a 3-to-1 Cross-Review running 3 independent
  frontier models in parallel — OpenAI Codex (gpt-6.2-sol high), Anthropic Claude
  Code (claude-opus-5-5 high), and Google Antigravity Agent (gemini-4-neon-high) —
  and synthesizing all 3 into 1 verified report via the active session model.
---

# Handoff 3-to-1 Cross-Review

Run **3 independent reviewers in parallel** — **OpenAI Codex** (`codex`, default: `gpt-6.2-sol` `high`), **Anthropic Claude Code** (`claude`, default: `claude-opus-5-5` `high`), and **Google Antigravity Agent** (`agy`, default: `gemini-4-neon-high` / `neon` `high`) — then **the current session's conversation model** acts as the final lead synthesizer (**3-to-1**).

## Procedure

1. **Choose 3 parallel subagent panes (`/agents`, `Alt+J`) vs direct single-call MCP (`handoff_cross_review`)**:
   - **Visible 3-subagent panes (`/agents`, `Alt+J`) — recommended in Antigravity CLI**:
     If `invoke_subagent` is available, check active defaults with `handoff_config({ action: "get" })` (unless overridden), then launch all **3 subagents in parallel**:
     1. `codex-handoff` with `Role: "<codexModel> <codexEffort> review"` (default `"gpt-6.2-sol high review"`)
     2. `claude-handoff` with `Role: "<claudeModel> <claudeEffort> review"` (default `"claude-opus-5-5 high review"`)
     3. `neon-handoff` with `Role: "<agyModel> <agyEffort> review"` (default `"gemini-4-neon-high high review"`)
     Give each the repository `cwd`, `style`, `scope`, optional `base`/`commit`/`prompt`/`context`, and `model`/`effort`. Each subagent streams live `recentEvents` updates into its own `/agents` (`Alt+J`) pane.
   - **Direct single-call MCP (`handoff_cross_review`)**:
     Pass `cwd` (repository root), `style` (`"adversarial"` recommended), `scope` (`"uncommitted"`, `"base"`, `"commit"`, or `"custom"`), optional `context` (`{ files, summary, constraints }`), `structured: true` (for schema-constrained findings, 3-way consensus clustering, and 4-stage verification), and optional `codexModel`, `codexEffort`, `claudeModel`, `claudeEffort`, `agyModel`, `agyEffort`.
   - CLI fallback:
     `node <plugin-root>/src/cli.mjs cross-review --style adversarial --scope uncommitted --structured --cwd <cwd>`
   - Live terminal dashboard:
     `node <plugin-root>/src/cli.mjs watch`

2. **Handle partial availability or model quota gracefully**:
   - If any CLI is not installed, `handoff_cross_review` still runs the available engines and marks missing ones as `skipped`. If `gemini-4-neon-high` hits temporary individual quota (`RESOURCE_EXHAUSTED`), `agy-handoff` automatically falls back to `gemini-4-argon-high` (or direct `neon-handoff` subagent inspection).

3. **3-to-1 Final Synthesis (by the Current Session's Conversation Model)**:
   As the active session model, synthesize the 3 independent reviews into four structured sections:
   - **Consensus Findings (`3/3 Unanimous` & `2/3 Majority`)**: Issues independently flagged by all 3 models (`3/3`) or any 2 of the 3 models (`2/3`), ordered by agreement count and severity (`agreedBy: ["codex", "claude", "agy"]`).
   - **Unique Findings (`1/3`)**: Issues raised by only one model (`codex`, `claude`, or `agy`).
   - **Conflicts / Tie-Breaks**: Places where the 3 models disagreed on severity, root cause, or architectural direction, using the 3rd model + your own code check as tie-breaker.
   - **Verified Findings**: Only after you directly read the cited local files and line ranges yourself, confirm which findings hold up in the actual codebase and dismiss false positives (`semanticallyVerified` is always `false` until you inspect the code).
