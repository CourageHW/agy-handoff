# agy-handoff Guidelines

`agy-handoff` exposes local **OpenAI Codex** (`codex`) and **Anthropic Claude Code** (`claude`) CLIs as MCP tools (`handoff_*`) and companion skills.

## Operating Rules

1. **Prefer read-only by default**: Always start reviews, investigations, and debugging handoffs in `read-only` mode and never auto-escalate permissions. Only pass `mode: "workspace-write"` when the user explicitly asks and confirms that the external CLI should modify files (note: Codex uses OS sandboxing in `workspace-write`, whereas Claude Code restricts built-in file tools via `--restricted` + `acceptEdits` while `Bash` remains unsandboxed).
2. **Pass the workspace root explicitly**: Always pass the active repository root in `cwd` so external CLIs inspect the right checkout.
3. **Keep prompts self-contained**: Do not dump entire files into the prompt; give the goal, relevant file paths, constraints, and expected output format so the external CLI reads the repo directly.
4. **Verify before retrying**: If a handoff fails because a binary or authentication is missing, run `handoff_doctor` once and report the exact setup command rather than retrying blindly.
5. **Synthesize, don't blindly echo**: After receiving a review or second opinion, verify key claims against the local files before recommending or applying edits.
6. **Subagent visibility in Antigravity CLI**: When running Codex and/or Claude Code in Antigravity CLI and the user wants inspectable subagent panes (`/agents`, `Alt+J`) with live progress updates, resolve the active model/effort via `handoff_config({ action: "get" })` (unless explicitly overridden) and invoke `codex-handoff` / `claude-handoff` via `invoke_subagent` with `Role` formatted to include the active model and effort (e.g., `"gpt-6.2-sol high review"`, `"claude-opus-5-5 high review"`, `"gpt-6.2-sol high delegate"`). For live terminal monitoring in another pane/tab, mention `node <plugin-root>/src/cli.mjs watch`.
