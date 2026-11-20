---
name: handoff-grill-me
description: >-
  Use this skill when the user wants an interactive spec interview (Grill-Me) to
  relentlessly resolve design-tree decisions, edge cases, and acceptance criteria
  before building a 3-to-1 collaborative implementation plan with handoff_plan.
---

# Handoff Grill-Me (Design-Tree Spec Interview)

Interview the user relentlessly about every aspect of the feature or plan until you reach a shared understanding—walking down each branch of the design tree one dependency at a time, and exploring the codebase first whenever a question can be answered from code.

## Core Principles (Inspired by `mattpocock/skills` `grill-me` + Multi-Agent Discovery)

1. **Explore the Codebase First (Never Ask What Code Already Knows)**:
   - Before asking the user your first question, inspect the relevant repository files, existing schemas, conventions, and tests.
   - Optional Multi-Agent Discovery: For complex or unfamiliar subsystems, call `handoff_plan` with `phase: "discover"`, `goal`, and `context: { files }` so **OpenAI Codex** (`gpt-6.2-sol`), **Anthropic Claude Code** (`claude-opus-5-5`), and **Google Antigravity** (`gemini-4-neon-high`) scan the codebase in parallel (`read-only`) and surface non-obvious `openQuestions` and coupling risks.

2. **Walk Down the Design Tree Branch-by-Branch**:
   - Use `ask_question` (putting your recommended option first, prefixed with `(Recommended)`, and explaining the trade-off concisely) to resolve one branch at a time:
     1. **Scope & Non-Goals (YAGNI Boundary)**: What is the core problem, and what is explicitly out of scope?
     2. **Interface, UX & API Contract**: Exact inputs, outputs, CLI/UI/API surface, and error contracts.
     3. **Data Lifecycle, State & Concurrency**: Persistence format, backward compatibility, and race/retry semantics.
     4. **Failure Modes, Security & Permission Boundaries**: Timeouts, partial failures, rollback behavior, and sandbox/trust boundaries.
     5. **Verification & Acceptance Criteria**: Concrete test cases and proof of completion.

3. **Produce a Locked Decision Ledger & Hand Off to `handoff_plan`**:
   - Once all high-impact branches are resolved, summarize the locked **Decision Ledger** (`goal`, `decisions: [{ branch, question, answer }]`, `requirements`, `nonGoals`, `constraints`, `acceptanceCriteria`, `context.files`).
   - Transition directly to `/agy-handoff:handoff-plan` (`handoff_plan` with `phase: "design"`) so Codex, Claude Code, and Antigravity Neon design and cross-verify the 3-to-1 implementation plan.
