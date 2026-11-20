---
name: handoff-grill-me
description: >-
  Use this skill when the user wants an interactive spec interview (Grill-Me) to
  relentlessly resolve design-tree decisions, edge cases, and acceptance criteria
  before building a collaborative implementation plan with handoff_plan.
---

# Handoff Grill-Me (Design-Tree Spec Interview)

Interview the user relentlessly about every aspect of the feature or plan until you reach a shared understanding—walking down each branch of the design tree one dependency at a time, and exploring the codebase first whenever a question can be answered from code.

## Core Principles (Inspired by `mattpocock/skills` `grill-me` + Multi-Agent Discovery)

1. **Explore the Codebase First (Never Ask What Code Already Knows)**:
   - Before asking the user your first question, inspect the relevant repository files, existing schemas, conventions, and tests.
   - For unfamiliar subsystems, call `handoff_plan` with `phase: "discover"`, `goal`, `cwd`, and `context.files`. The selected engines inspect the repository read-only and surface open questions and coupling risks.

2. **Walk Down the Design Tree Branch-by-Branch**:
   - Use the host question dialog when available, or ask in chat. Give the recommended option first and explain the trade-off. Work through these branches:
     1. **Scope & Non-Goals (YAGNI Boundary)**: What is the core problem, and what is explicitly out of scope?
     2. **Interface, UX & API Contract**: Exact inputs, outputs, CLI/UI/API surface, and error contracts.
     3. **Data Lifecycle, State & Concurrency**: Persistence format, backward compatibility, and race/retry semantics.
     4. **Failure Modes, Security & Permission Boundaries**: Timeouts, partial failures, rollback behavior, and sandbox/trust boundaries.
     5. **Verification & Acceptance Criteria**: Concrete test cases and proof of completion.

3. **Produce a Locked Decision Ledger & Hand Off to `handoff_plan`**:
   - Once all high-impact branches are resolved, summarize the locked **Decision Ledger** (`goal`, `decisions: [{ branch, question, answer }]`, `requirements`, `nonGoals`, `constraints`, `acceptanceCriteria`, `context.files`).
   - Transition directly to `handoff-plan` (`handoff_plan` with `phase: "design"`) to compare independent implementation proposals from the configured engines.
