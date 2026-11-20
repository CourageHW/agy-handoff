---
name: handoff-models
description: >-
  Use this skill when the user wants to view, set, or reset default Codex and
  Claude Code models and reasoning effort levels globally or per command
  (review, delegate, cross-review) via `/agy-handoff:handoff-models`.
---

# Handoff Models

Inspect and configure default `codex` and `claude` models and reasoning effort globally or per command (`review`, `delegate`, `cross-review`).

Built-in plugin defaults:
- **Codex**: `gpt-6.2-sol` (`effort: "high"`)
- **Claude Code**: `claude-opus-5-5` (`effort: "high"`)

## Procedure

### 1. Fast Path (if the user already passed arguments)

If the user specified what to do right after `/agy-handoff:handoff-models`:
- **View current settings** (e.g. `show`, `status`, `list`):
  Call `handoff_config({ action: "get" })` and present a compact Markdown table of effective models/efforts for `default`, `review`, `delegate`, and `cross-review` plus the `configPath`.
- **Reset settings** (e.g. `reset`, `reset review`, `reset all`):
  Call `handoff_config({ action: "reset", scope, engine })` and show the updated table.
- **Set directly** (e.g. `review codex gpt-6.2-sol xhigh`, `cross-review claude opus5.5 high`, `default codex gpt-6.2-sol high claude opus5.5 high`, or setting both engines for one command):
  Call `handoff_config({ action: "set", ... })` immediately without extra confirmation questions, then print the updated effective table.

Shorthand aliases supported automatically:
- `opus5.5` -> `claude-opus-5-5`, `sonnet5.5` -> `claude-sonnet-5-5`, `haiku5.5` -> `claude-haiku-5-5`
- `cli-default` (or `inherit` / `auto`) -> omit model/effort flag and inherit the local CLI's own config file (`~/.codex/config.toml` or `~/.claude/settings.json`).

### 2. Interactive Path (no arguments or ambiguous request)

1. Call `handoff_config({ action: "get" })` first to inspect current effective settings and discovered local models.
2. Print a compact Markdown table showing the current effective model, effort, and source (`builtin` / `default` / `command` / `cli-default`) for `default`, `review`, `delegate`, and `cross-review`.
3. Call `ask_question` in a single prompt with 3 crisp questions so the user can pick everything in one step:
   - **Scope**:
     - `default` (Global default for all commands unless overridden)
     - `review` (`handoff_review` only)
     - `delegate` (`handoff_delegate` only)
     - `cross-review` (`handoff_cross_review` only)
     - `all` (Set global default and clear per-command overrides)
     - `reset` (Reset to built-in defaults: `gpt-6.2-sol` high / `claude-opus-5-5` high)
   - **Codex model & effort** (show `(Recommended) gpt-6.2-sol (high)` first, plus `gpt-6.2-sol (xhigh)`, `gpt-6.1-sol (high)`, `Keep current`, `CLI native default (cli-default)` — users can also pick Other to type any model/effort).
   - **Claude model & effort** (show `(Recommended) claude-opus-5-5 (high)` first, plus `claude-opus-5-5 (max)`, `claude-sonnet-5-5 (high)`, `Keep current`, `CLI native default (cli-default)` — users can also pick Other to type any model/effort).
4. Apply the selection with `handoff_config({ action: "set" | "reset", ... })` (skipping whichever engine was marked `Keep current`) and display the updated effective configuration table and `configPath`.

### CLI Fallback

If MCP is unavailable in the current session, run the bundled CLI:
```bash
node <plugin-root>/src/cli.mjs models show
node <plugin-root>/src/cli.mjs models set review codex gpt-6.2-sol xhigh
node <plugin-root>/src/cli.mjs models set cross-review --codex-model gpt-6.2-sol --codex-effort high --claude-model opus5.5 --claude-effort high
node <plugin-root>/src/cli.mjs models reset all
```
