# agy-handoff

Antigravity plugin for delegating code reviews, debugging, and second-opinion checks to local OpenAI Codex and Anthropic Claude Code CLIs.

It runs a local stdio MCP server using only Node.js built-ins, so there is no `npm install` step and no separate API key setup. It reuses whatever `codex` and `claude` auth you already have locally.

## Requirements

- Google Antigravity (`agy` CLI, Antigravity IDE, or Antigravity 2.0)
- Node.js 18.18+
- At least one of:
  - OpenAI Codex CLI (`>= 0.160`): `npm install -g @openai/codex && codex login`
  - Anthropic Claude Code CLI (`>= 2.1`): `npm install -g @anthropic-ai/claude-code && claude`

Having only one CLI installed is fine; `cross-review` skips the missing engine and runs the installed one.

## Install

```bash
agy plugin install https://github.com/CourageHW/agy-handoff
```

Or from a local clone:

```bash
git clone https://github.com/CourageHW/agy-handoff.git
agy plugin validate --strict ./agy-handoff
agy plugin install ./agy-handoff
agy plugin list
```

## Usage

The plugin adds five slash commands and two subagents (`codex-handoff`, `claude-handoff`):

- `/agy-handoff:handoff-doctor` checks Node, local CLI binaries, auth hints, and active model defaults.
- `/agy-handoff:handoff-review` runs a read-only `standard` or `adversarial` review on uncommitted changes, a branch diff, a commit, or a custom file scope.
- `/agy-handoff:handoff-cross-review` runs Codex and Claude Code in parallel on the same diff or prompt and synthesizes the results.
- `/agy-handoff:handoff-delegate` hands off an investigation, debugging task, or scoped edit (`read-only` by default; `workspace-write` requires explicit opt-in).
- `/agy-handoff:handoff-models` views or changes default models and reasoning effort globally or per command.

### Subagent panes and live monitoring

In Antigravity CLI, reviews and delegations can run inside `codex-handoff` and `claude-handoff` subagents so each engine gets its own entry under `/agents` (`Alt+J`) with live tool/command progress.

Note that Antigravity's subagent header displays the wrapper model (`flash`) next to the agent name; the actual external model and effort are placed in the subagent role label and printed on launch.

To watch live events from another terminal tab or tmux pane:

```bash
node src/cli.mjs watch           # live dashboard across active and recent jobs
node src/cli.mjs watch <jobId>   # follow one job until it finishes
node src/cli.mjs watch --once    # single snapshot
```

## Default models

Out of the box, calls that do not specify a model or effort use:

- Codex: `gpt-6.2-sol` (`high`)
- Claude Code: `claude-opus-5-5` (`high`)

You can override defaults globally or per command (`review`, `delegate`, `cross-review`) with `/agy-handoff:handoff-models` or the CLI:

```bash
node src/cli.mjs models show
node src/cli.mjs models set review codex gpt-6.2-sol xhigh
node src/cli.mjs models set cross-review --codex-model gpt-6.2-sol --codex-effort high --claude-model opus5.5 --claude-effort high
node src/cli.mjs models set delegate claude cli-default
node src/cli.mjs models reset all
```

Setting `cli-default` omits the model/effort flags and lets the underlying CLI use `~/.codex/config.toml` or `~/.claude/settings.json`. Config is saved to `~/.config/agy-handoff/config.json` (`%APPDATA%\agy-handoff\config.json` on Windows).

## Safety notes

- Reviews are always read-only; delegations default to `read-only`.
- Codex explicitly enforces `sandbox_mode="read-only"` (or the requested mode) across `exec`, `exec resume`, and `review`, and adds `--skip-git-repo-check` automatically for custom reviews and delegations outside Git repos.
- Claude Code read-only runs pass `--permission-mode dontAsk --restricted --strict-mcp-config --tools Read,Grep,Glob,Bash` along with `--allowedTools` and `--disallowedTools` blocking `Edit`, `Write`, `NotebookEdit`, and git flags that write files or run external diff drivers (`--output*`, `--ext-diff*`, `--textconv*`).
- In `workspace-write` mode, Codex uses its OS sandbox (`-s workspace-write`), whereas Claude Code allows general `Bash` execution without a filesystem/network sandbox. Never use `workspace-write` unless you explicitly want edits.
- Neither CLI is ever invoked with `--dangerously-bypass-approvals-and-sandbox` or `--dangerously-skip-permissions`. Binaries are resolved to absolute paths and spawned with `shell: false`; prompts are sent over `stdin`.
- Output streams are capped, UTF-8 truncation respects character boundaries, timeouts and cancellations kill the process tree, and job logs are stored in a `0700`/`0600` user-private directory.

## MCP tools

| Tool | Description |
| :--- | :--- |
| `handoff_doctor` | Check Node version, CLI binaries, auth hints, and effective defaults |
| `handoff_review` | Run a read-only `standard` or `adversarial` code review |
| `handoff_delegate` | Delegate a scoped task (`read-only` default, `workspace-write` opt-in) |
| `handoff_cross_review` | Run Codex and Claude Code in parallel on the same scope |
| `handoff_config` | Get, set, or reset global and per-command model/effort defaults |
| `handoff_job_status` | List jobs or inspect/wait on a job's live activity events |
| `handoff_job_result` | Fetch final output and metadata for a background job |
| `handoff_job_cancel` | Cancel a running background job |

## Environment variables

| Variable | Description |
| :--- | :--- |
| `AGY_HANDOFF_CODEX_BIN` | Path to `codex` if it is outside `PATH` |
| `AGY_HANDOFF_CLAUDE_BIN` | Path to `claude` if it is outside `PATH` |
| `AGY_HANDOFF_CONFIG` | Custom path for the model config JSON file |
| `AGY_HANDOFF_JOBS_DIR` | Custom directory for job logs and live event timelines (`watch` auto-detects Antigravity's `plugin_data/agy-handoff/jobs`) |

## Development

```bash
npm test
agy plugin validate --strict .
node src/cli.mjs doctor
```

## License

[MIT](./LICENSE)

Korean docs: [README.ko.md](./README.ko.md)
