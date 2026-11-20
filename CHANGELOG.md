# Changelog

All notable changes to `agy-handoff` are documented in this file.

## [0.2.0] - 2026-11-21

### Added
- **Context-Aware Handoff (`src/context.mjs`)**: Optional `context: { files, summary, constraints, acceptanceCriteria }` on `handoff_review`, `handoff_delegate`, and `handoff_cross_review` (plus `--files` / `--context-summary` CLI flags). Resolves and annotates target paths on disk and injects a focused `## Handoff Context` header to reduce redundant full-repo exploration.
- **Execution Evidence & Git Delta Verification (`src/context.mjs`, `src/jobs.mjs`)**: Tracks factual runtime observations (`observedToolCalls`, `toolsUsed`, `commandsExecuted`, `filesInspected`, `filesModified`, and `workspaceGitDelta` for `workspace-write`), emitting explicit warnings if zero tool calls occur in a review or zero edits occur in `workspace-write`.
- **Structured Cross-Review & 4-Stage Verification (`src/cross-review.mjs`)**: Optional `structured: true` on `handoff_review` / `handoff_cross_review` uses `codex exec --output-schema` and `claude --json-schema` to collect typed findings, match Consensus / Severity Conflicts / Unique findings using both location and defect-token/concept similarity (`matchBasis` avoids merging unrelated bugs on nearby lines), and explicitly separates 4 verification stages in `verificationStages` (`cliExecution`, `structuredJsonParse`, `citationValidity`, and `semanticVerification` with `semanticallyVerified: false`).
- **Workspace-Write Boundary Hardening (`src/runners/common.mjs`, `src/runners/claude.mjs`, `src/runners/codex.mjs`)**: Added `validateWorkspaceWriteCwd()` blocking root (`/`), OS system directories, raw home directory (`~`), and sensitive credential/config subdirs (`.ssh`, `.gnupg`, `.aws`, `.claude`, `.codex`, `.gemini`); blocked `sessionId="last"` in `workspace-write`; expanded Claude `WORKSPACE_WRITE_DISALLOWED_TOOLS`; and attached `permissionBoundary` + outside-workspace shell path warnings in `executionEvidence`.
- **Safe Read-Only Job Recovery & Retry (`handoff_job_retry`)**: Added `recoverStaleJobs()` (surfaced in `handoff_doctor`) and `handoff_job_retry` / `jobs retry <jobId> [--fallback]` to replay finished `read-only` jobs on the same or alternate engine while strictly refusing `workspace-write` retries.
- **Opt-In Policy Routing (`engine: "auto"`) (`src/routing.mjs`)**: Transparently routes `engine: "auto"` using CLI compatibility (`handoff_doctor`), configured per-task-type preferences (`config.routing`), consecutive-failure avoidance, and least-used recent quota balancing, returning `routingDecision` with the exact reason.
- **Visual Stats Dashboard (`stats --table`)**: Added `formatStatsTable()` in `src/watch.mjs` and `--table` on `node src/cli.mjs stats` / `jobs stats`.
- **Subagent Context Isolation & Demo Recipe**: Tightened `codex-handoff` and `claude-handoff` instructions for scoped subagent execution and added `assets/demo.tape`.

## [0.1.1] - 2026-11-20

### Fixed
- **Windows process cleanup**: Always pass `/F` to `taskkill` in `terminateProcessTree` on Windows so console processes (`node.exe`, etc.) terminate cleanly on timeout and cancel.
- **Windows rename reliability & CI (`ENAMETOOLONG`)**: Added `renameSyncSafe` retry helper, replaced 64 KB `node -e` CLI literal in `test/jobs.test.mjs`, added `rmSync` retry options, and added case-insensitive Windows entry-path check in `isDirectExecution`.
- **Job timeout & cancellation guards**: Added `hardSettleTimer` failsafe on timed-out background jobs and guarded `SIGKILL` escalation against PID reuse.

### Security & Compatibility
- **Minimum CLI verification**: `handoff_doctor` enforces `Codex >= 0.160.0` and `Claude Code >= 2.1.259` and checks required CLI flags.
- **Claude Code `workspace-write` hardening**: Added `--restricted`, `--strict-mcp-config`, `--tools`, and `--disallowedTools "Bash(sudo *),Bash(git push),Bash(git push *)"`.

## [0.1.0] - 2026-11-20

### Added
- Initial release of `agy-handoff` with zero-dependency stdio MCP server, 8 tools, 5 skills, `rules/AGENTS.md`, `codex-handoff` / `claude-handoff` subagents, and `watch` live monitor.
