---
name: handoff-cross-review
description: Ask the other agents to independently review changes, compare implementations, or give a second opinion. Verify their findings against the local code.
---

# Handoff Cross-Review

1. Call `handoff_cross_review` once with the repository `cwd`, relevant `scope` (`uncommitted`, `base`, `commit`, or `custom`), `structured: true`, and the relevant files, constraints, and question. Omit `engines` for host defaults. Use an explicit list of `codex`, `claude`, or `agy` when the user asks for a specific set. If the user says “the other two” and the host has a legacy group roster, use `defaultExternalAgents` from `handoff_doctor`. For one second opinion, use `handoff_review` with that engine.
2. Use `requestedEngines`, `participatingEngines`, and per-engine results to report who returned usable findings and any missing CLI, quota, timeout, or parse failure. If the tool provides a job ID, use `handoff_job_status` and `handoff_job_result` to follow the run. Do not invoke a second workflow for work already in progress.
3. As the active session, reconcile consensus, unique findings, and disagreements. Verify each reported issue by reading the cited code and checking behavior before confirming it. Keep unverified findings marked as such even when multiple engines agree.
