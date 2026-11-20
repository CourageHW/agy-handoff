---
name: handoff-plan
description: >-
  Use this skill when the user wants to design a high-precision implementation
  plan using handoff_plan — combining a Grill-Me spec interview with 3-to-1
  collaborative planning across OpenAI Codex, Anthropic Claude Code, and Google
  Antigravity (gemini-4-neon-high).
---

# Handoff 3-to-1 Collaborative Plan (`handoff_plan`)

Design a zero-handwaving, file-verified implementation plan by combining **Grill-Me spec alignment** with **3-to-1 Multi-Agent Collaborative Planning** across **OpenAI Codex** (`gpt-6.2-sol` `high`), **Anthropic Claude Code** (`claude-opus-5-5` `high`), and **Google Antigravity Agent** (`gemini-4-neon-high` / `neon` `high`), synthesized by **the current session's conversation model**.

## Procedure

### Stage 1: Verify Spec Completeness (Grill-Me Gate)
1. **Explore the codebase first**: Identify relevant files, existing abstractions, and test patterns so you never ask the user what the repository already answers.
2. **Check for unresolved design-tree branches**:
   - If the user has not yet run `/agy-handoff:handoff-grill-me` and key decisions (Scope/Non-Goals, API/UX Contract, State/Concurrency, Failure/Security Boundaries, Acceptance Criteria) are ambiguous, interview the user with focused `ask_question` rounds (recommended option first) until decisions are locked.
   - If the spec is already clear or confirmed, proceed immediately to Stage 2.

### Stage 2: 3-to-1 Multi-Agent Collaborative Plan Design (`handoff_plan`)
1. **Scope large greenfield specs & keep planning local-first**:
   - For very large specs (e.g., >30 KB `SPEC.md` spanning many subsystems), prefer splitting into focused architectural slices (e.g., Core/Schema, Runtime/Engine, CLI/Integration) or running `phase: "discover"` first so each child session stays fast and high-signal.
   - `handoff_plan` disables Codex external web search by default (`allowWebSearch: false`) and enforces concise output budgets so child models stay grounded in local files without multi-minute web-search loops.
2. **Run `handoff_plan` (or 3 parallel subagent panes in Antigravity CLI)**:
   - **Direct MCP call (`handoff_plan`)**:
     Pass `cwd` (repository root), `goal`, `phase: "design"`, `decisions` (`[{ branch, question, answer }]`), `requirements`, `nonGoals`, `constraints`, `acceptanceCriteria`, `context: { files, summary }`, and `structured: true`.
   - **Visible 3-subagent panes (`/agents`, `Alt+J`)**:
     When the user wants live per-engine panes in Antigravity CLI, check active defaults via `handoff_config({ action: "get" })` and invoke `codex-handoff`, `claude-handoff`, and `neon-handoff` in parallel in `read-only` mode with `Role` formatted as `"<model> <effort> plan"` (e.g., `"gpt-6.2-sol high plan"`, `"claude-opus-5-5 high plan"`, `"gemini-4-neon-high high plan"`).
   - **CLI fallback**:
     `node <plugin-root>/src/cli.mjs plan --goal "<goal>" --files <path1,path2> --structured --cwd <cwd>`

### Stage 3: 3-to-1 Master Plan Synthesis & Disk Verification
As the **current session's conversation model (Lead Synthesizer)**, inspect `structuredPlan` and synthesize the 3 independent blueprints into one authoritative **Master Implementation Plan** (following `obra/superpowers` `writing-plans` zero-handwaving discipline):

1. **Architecture & Design Consensus**:
   - Reconcile `architectureSummaries` across Codex, Claude Code, and Antigravity Neon. Where models proposed different approaches, explain the trade-off and select the cleanest design that fits the existing codebase.
2. **Verified File Responsibility Map (`consensusFileChanges` & `fileTargetSummary`)**:
   - Prioritize `3/3 Unanimous` and `2/3 Majority` file targets.
   - Check `targetVerification.status` for every file:
     - Dismiss or correct any `"missing_target_file"` (hallucinated modify/delete path) or `"existing_file_collision"` (create path that already exists).
     - Review `fileActionConflicts` and `uniqueFileChanges` against local files before including them (enforce YAGNI).
3. **Bite-Sized TDD Task Breakdown (`implementationSteps`)**:
   - Present ordered, self-contained tasks (2–5 minutes each).
   - Every task must specify:
     - **Exact file path(s)** (`file://` links for existing files)
     - **Test First (`testFirst`)**: Exact failing test case or assertion to write first
     - **Implementation (`implementation`)**: Concrete functions, signatures, and guards (never vague instructions like `"handle edge cases"`)
     - **Verification Command (`verificationCommand`)**: Exact command to prove the step passes
4. **Consolidated Risks, Edge Cases & Open Questions (`mergedRisksAndEdgeCases` & `openQuestions`)**:
   - Include the union of valid security, concurrency, and compatibility risks caught across all 3 models along with concrete mitigations.
   - If any model surfaced genuine `openQuestions` discovered during code inspection, highlight them to the user before execution.
