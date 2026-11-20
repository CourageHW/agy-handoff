# Changelog

All notable changes to `agy-handoff` are documented in this file.

## [0.1.1] - Unreleased

### Fixed
- **Windows process cleanup**: Always pass `/F` to `taskkill` in `terminateProcessTree` on Windows so console processes (such as `node.exe`) terminate cleanly on timeout and cancellation without hanging.
- **Windows rename reliability**: Added `renameSyncSafe` retry helper for atomic config and job metadata writes on Windows `EPERM`/`EBUSY`/`EACCES`.
- **Windows CI (`ENAMETOOLONG`)**: Replaced a 64 KB command-line argument in `test/jobs.test.mjs` with an expression generating the payload inside Node, and added retry options to temporary directory cleanup.
- **Job timeout & cancellation guards**: Added a hard-settle failsafe on timed-out background jobs and guarded background `SIGTERM`->`SIGKILL` escalation timers against PID reuse.

### Security & Compatibility
- **Minimum CLI verification**: `handoff_doctor` now checks CLI versions (`Codex >= 0.160.0`, `Claude Code >= 2.1.259`) and verifies required CLI flags (`--restricted`, `--permission-prompts`, `--json`, `--ephemeral`, etc.) with explicit upgrade messages on mismatch.
- **Claude Code `workspace-write` hardening**: Added `--restricted`, `--strict-mcp-config`, `--tools`, and `--disallowedTools "Bash(sudo *),Bash(git push),Bash(git push *)"` alongside `--permission-mode acceptEdits` so built-in file tools stay confined to `cwd`.

### Added
- **Read-only job statistics**: Added `node src/cli.mjs stats` (`agy-handoff stats` / `jobs stats`) and `handoff_job_status({ includeStats: true })` reporting job counts, engine shares, status rates, average elapsed time, and CLI-reported token/cost totals without estimation.
- **Cross-review summary metadata**: `handoff_cross_review` now returns factual execution counts and total duration in `summary`, paired with structured 4-part synthesis guidance (`Consensus Findings`, `Unique Findings`, `Conflicts / Trade-offs`, `Verified Findings`).
- **Integration & live E2E suites**: Added `test/e2e-mcp.test.mjs` for CI-safe MCP end-to-end tests and `scripts/e2e-live.mjs` (`npm run test:live`) for live local Codex/Claude verification.

## [0.1.0] - 2026-11-20

### Added
- Initial release of `agy-handoff` for Google Antigravity (`agy` CLI, Antigravity IDE, and Antigravity 2.0).
- Zero-dependency stdio MCP server exposing `handoff_doctor`, `handoff_review`, `handoff_delegate`, `handoff_cross_review`, `handoff_config`, `handoff_job_status`, `handoff_job_result`, and `handoff_job_cancel`.
- Five companion skills (`handoff-doctor`, `handoff-review`, `handoff-delegate`, `handoff-cross-review`, `handoff-models`), safety rules (`rules/AGENTS.md`), and two dedicated subagents (`codex-handoff`, `claude-handoff`) with live progress streaming and `agy-handoff watch`.
