---
name: handoff-doctor
description: >-
  Use this skill when checking whether OpenAI Codex and Anthropic Claude Code
  CLIs are installed, configured, and ready for agy-handoff, or when
  troubleshooting handoff tool errors.
---

# Handoff Doctor

Diagnose local prerequisites for `agy-handoff`.

## Procedure

1. Call the `handoff_doctor` MCP tool (or run `node <plugin-root>/src/cli.mjs doctor` as fallback).
2. Summarize the status clearly in a short table:
   - Node.js version (requires `>= 18.18.0`)
   - `codex`: installed path, version, `compatible` status (`>= 0.160.0`), any `missingFlags` / `compatibilityNote`, auth hint, or install/upgrade command
   - `claude`: installed path, version, `compatible` status (`>= 2.1.259`), any `missingFlags` / `compatibilityNote`, auth hint, or install/upgrade command
   - Active model/effort defaults per command (`modelDefaults` and `configPath`; built-in: Codex `gpt-6.2-sol` `high`, Claude `claude-opus-5-5` `high`, configurable via `/agy-handoff:handoff-models` or `handoff_config`).
3. If an engine is installed in a non-standard path, remind the user they can set `AGY_HANDOFF_CODEX_BIN` or `AGY_HANDOFF_CLAUDE_BIN` in their environment.
