---
name: handoff-plan
description: Build a collaborative implementation plan by comparing independent proposals, inspecting affected files, and agreeing on a test strategy.
---

# Handoff Collaborative Plan

1. Explore the relevant code and tests. Resolve material open decisions about scope, behavior, and acceptance criteria before requesting a design. Use the `handoff-grill-me` skill or `handoff_plan` with `phase: "discover"` when code inspection leaves open questions.
2. Call `handoff_plan` once for the design. Pass `cwd`, `goal`, known `decisions`, `requirements`, `nonGoals`, `constraints`, `acceptanceCriteria`, relevant `context.files`, and `structured: true`. Omit `engines` for host defaults or pass the set the user requested. Planning is read-only.
3. Report which engines produced usable plans and any skipped or failed runs. As the active session, compare architectures and file targets, resolve conflicting actions against the working tree, and propose the smallest coherent implementation. Include ordered file-level changes, test cases, verification commands, and unresolved questions. Verify code semantics before treating the plan as ready to implement.
