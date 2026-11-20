# agy-handoff

**agy-handoff** connects Google Antigravity (`agy` CLI, Antigravity IDE, and Antigravity 2.0) to local **OpenAI Codex** and **Anthropic Claude Code** CLIs over a zero-dependency stdio MCP server.

Rather than configuring another API proxy or installing runtime packages, it reuses whatever `codex` and `claude` sessions you are already signed into locally—adding parallel dual-engine cross-reviews, strict read-only safety by default, inspectable Antigravity subagent panes (`/agents`, `Alt+J`), and a live terminal activity dashboard.

## Why agy-handoff

- **Zero npm dependencies**: Pure Node.js (`>= 18.18.0`) standard library modules; installs cleanly without `npm install`.
- **Both engines side by side**: Run Codex alone, Claude Code alone, or both in parallel with `handoff_cross_review` (automatically skipping whichever CLI is absent).
- **Read-only by default**: Reviews are always read-only; task delegations start in `read-only` mode and never pass `--dangerously-bypass-approvals-and-sandbox` or `--dangerously-skip-permissions`.
- **Inspectable live progress**: Bundles dedicated `codex-handoff` and `claude-handoff` subagents for Antigravity's `/agents` (`Alt+J`) view, plus `agy-handoff watch` for live terminal monitoring.
- **Version and flag self-checks**: `handoff_doctor` validates installed CLI versions and required security/streaming flags before a run fails mid-flight.

---

## Quick Start

### 1. Install

```bash
agy plugin install https://github.com/CourageHW/agy-handoff
```

Or from a local clone:

```bash
git clone https://github.com/CourageHW/agy-handoff.git
agy plugin validate --strict ./agy-handoff
agy plugin install ./agy-handoff
```

### 2. Verify local CLIs (`doctor`)

In Antigravity:

```text
/agy-handoff:handoff-doctor
```

Or directly in your terminal:

```bash
node src/cli.mjs doctor
```

### 3. Run a read-only review

```text
Review my uncommitted changes with Codex using standard style.
```

Or via CLI:

```bash
node src/cli.mjs review --engine codex --style standard --scope uncommitted
```

### 4. Run a dual-engine cross-review

```text
Run an adversarial cross-review on my changes against main using both Codex and Claude Code.
```

Or via CLI:

```bash
node src/cli.mjs cross-review --style adversarial --scope base --base main
```

---

## Slash Commands & Subagents

The plugin bundles five slash commands/skills (`handoff-doctor`, `handoff-review`, `handoff-cross-review`, `handoff-delegate`, `handoff-models`) and two subagents (`codex-handoff`, `claude-handoff`):

- `/agy-handoff:handoff-doctor`: Inspects Node.js, local `codex`/`claude` binary paths, versions, required flag compatibility, auth hints, and model defaults.
- `/agy-handoff:handoff-review`: Runs a read-only `standard` or `adversarial` review on `uncommitted`, `base`, `commit`, or `custom` targets.
- `/agy-handoff:handoff-cross-review`: Runs Codex and Claude Code in parallel and synthesizes **Consensus Findings**, **Unique Findings**, **Conflicts / Trade-offs**, and **Verified Findings** (verified directly against local files).
- `/agy-handoff:handoff-delegate`: Delegates focused investigations, debugging, or scoped edits (`read-only` by default; `workspace-write` requires explicit user confirmation). Supports session resume (`sessionId`).
- `/agy-handoff:handoff-models`: Views or sets default models and reasoning efforts globally or per command (`review`, `delegate`, `cross-review`).

### Live Monitoring (`Alt+J` / `watch` / `stats`)

In Antigravity CLI, running reviews or delegations through `codex-handoff` and `claude-handoff` creates inspectable panes under `/agents` (`Alt+J`) showing live tool calls (`Read`, `Grep`, `Glob`, `Bash`) via `handoff_job_status` long-polling (`waitSec` / `sinceSeq`). Note that Antigravity's subagent header displays the wrapper model (`flash`) next to the agent name; the active external model and effort are placed in the role label and printed on launch.

From any other terminal tab or tmux pane:

```bash
node src/cli.mjs watch           # Live dashboard for active and recent jobs
node src/cli.mjs watch <jobId>   # Follow a single job until completion
node src/cli.mjs watch --once    # Single snapshot
node src/cli.mjs stats           # Job counts, success rates, engine shares, reported tokens/cost
```

*(Note: `stats` and `handoff_job_status({ includeStats: true })` report only exact counts and metrics emitted by the underlying CLIs over retained job records—missing tokens or costs are never estimated.)*

---

## Default Models

Built-in defaults when no override is supplied:

- **Codex**: `gpt-6.2-sol` (`high`)
- **Claude Code**: `claude-opus-5-5` (`high`)

Change defaults globally or per command with `/agy-handoff:handoff-models` or the CLI:

```bash
node src/cli.mjs models show
node src/cli.mjs models set review codex gpt-6.2-sol xhigh
node src/cli.mjs models set cross-review --codex-model gpt-6.2-sol --codex-effort high --claude-model opus5.5 --claude-effort high
node src/cli.mjs models set delegate claude cli-default
node src/cli.mjs models reset all
```

Passing `cli-default` omits `--model`/`--effort` flags and falls back to `~/.codex/config.toml` or `~/.claude/settings.json`. Config is persisted in `~/.config/agy-handoff/config.json` (`%APPDATA%\agy-handoff\config.json` on Windows).

---

## Sandbox & Permission Model

| Mode | OpenAI Codex (`codex`) | Anthropic Claude Code (`claude`) |
| :--- | :--- | :--- |
| **`read-only`** *(default)* | Explicit `-s read-only` (or `sandbox_mode="read-only"` on `review` / `resume`). OS-enforced read-only sandbox. | `--permission-mode dontAsk --restricted --strict-mcp-config --permission-prompts none --tools Read,Grep,Glob,Bash` + allowlist for read-only `git` commands and `--disallowedTools` blocking `Edit`, `Write`, `NotebookEdit`, and file-writing `git` flags (`--output*`, `--ext-diff*`, `--textconv*`). |
| **`workspace-write`** *(explicit opt-in)* | Explicit `-s workspace-write` (OS sandbox confined to `cwd`, network restricted). | `--permission-mode acceptEdits --restricted --strict-mcp-config --tools Read,Edit,Write,Grep,Glob,Bash` + `--disallowedTools "Bash(sudo *),Bash(git push),Bash(git push *)"`. Confines built-in file tools to `cwd` and ignores repo settings/MCPs, **but `Bash` itself runs without an OS filesystem/network sandbox**. |

**Shared guarantees:**
- Neither engine is ever invoked with `--dangerously-bypass-approvals-and-sandbox` or `--dangerously-skip-permissions`.
- Prompts go over `stdin`; binaries resolve to absolute paths and spawn with `shell: false` (Windows `.cmd` shims unwrap directly to Node.js or quoted `cmd.exe /d /s /c`).
- Job metadata and logs use private permissions (`0700`/`0600` on POSIX), bounded capture caps, UTF-8 codepoint-safe truncation, and process-tree termination on timeout or cancel.

---

## OS & CLI Compatibility

| Platform | Runtime / Minimum CLI Versions | Tested Baseline | CI Coverage |
| :--- | :--- | :--- | :--- |
| **Linux** (Ubuntu) | Node.js `>= 18.18.0`, Codex `>= 0.160.0`, Claude Code `>= 2.1.259` | Node `22.22.1`, Codex `0.171.0`, Claude `2.1.325` | Node `18`, `20`, `22` |
| **macOS** | Node.js `>= 18.18.0`, Codex `>= 0.160.0`, Claude Code `>= 2.1.259` | CI verified (`macos-latest`) | Node `18`, `20`, `22` |
| **Windows** | Node.js `>= 18.18.0`, Codex `>= 0.160.0`, Claude Code `>= 2.1.259` | CI verified (`windows-latest`) | Node `18`, `20`, `22` |

> **Why Claude Code `>= 2.1.259`?** `agy-handoff` requires `--restricted` (introduced in Claude Code `2.1.248`) and `--permission-prompts none` (introduced in `2.1.259`) to guarantee unattended read-only execution cannot hang on permission prompts or load untrusted repo settings. Run `node src/cli.mjs doctor` to verify both `compatible` status and required flags.

---

## How It Compares

| Tool | Direction | Scope | How It Differs |
| :--- | :--- | :--- | :--- |
| **`agy-handoff`** | **Antigravity → Codex & Claude Code** | Dual-engine MCP server, subagents, skills, live `watch` & `stats` | Orchestrates both Codex and Claude Code from inside Antigravity with parallel cross-reviews, `--restricted` read-only safety, and zero npm dependencies. |
| **`codex-plugin-cc`** | Claude Code → Codex | Official OpenAI plugin inside Claude Code | Great if Claude Code is your primary host calling Codex; single-engine, does not expose Claude Code + Codex to Antigravity. |
| **`cc-suite`** | Cross-CLI Workspace Sync | Unifies `AGENTS.md` and `.agents/skills/` across Claude, Codex, and `agy` | Complements `agy-handoff` by sharing rules/skills across tools rather than executing dual-engine MCP handoffs and live subagent panels. |

---

## MCP Tools

| Tool | Description |
| :--- | :--- |
| `handoff_doctor` | Check Node version, CLI paths/versions, flag compatibility, auth hints, and model defaults |
| `handoff_review` | Run a read-only `standard` or `adversarial` code review |
| `handoff_delegate` | Delegate a scoped task (`read-only` default, `workspace-write` opt-in; supports `sessionId`) |
| `handoff_cross_review` | Run Codex and Claude Code in parallel and return results plus timing summary |
| `handoff_config` | Get, set, or reset global and per-command model/effort defaults |
| `handoff_job_status` | List jobs, long-poll live events (`waitSec`, `sinceSeq`), or compute stats (`includeStats`) |
| `handoff_job_result` | Fetch final output, `sessionId`, `costUsd`, and `usage` for a background job |
| `handoff_job_cancel` | Cancel a running background job owned by the active server |

## Environment Variables

| Variable | Description |
| :--- | :--- |
| `AGY_HANDOFF_CODEX_BIN` | Override path to `codex` executable if outside `PATH` |
| `AGY_HANDOFF_CLAUDE_BIN` | Override path to `claude` executable if outside `PATH` |
| `AGY_HANDOFF_CONFIG` | Custom path for the model config JSON file |
| `AGY_HANDOFF_JOBS_DIR` | Custom directory for job logs and event streams (`watch` auto-detects Antigravity's `plugin_data/agy-handoff/jobs`) |

---

## Development & Testing

```bash
npm test                        # Unit + mock MCP E2E suite (runs in CI, no auth needed)
agy plugin validate --strict .  # Validate Antigravity plugin manifest, skills, agents, rules
node src/cli.mjs doctor         # Check local Codex/Claude binary & flag compatibility
npm run test:live               # Optional local E2E suite against real signed-in Codex/Claude CLIs
```

`test/e2e-mcp.test.mjs` covers end-to-end MCP dispatch, single-engine fallback, parallel cross-review, job start/status/cancel, and session resume using deterministic fake binaries. `scripts/e2e-live.mjs` is kept separate from `npm test` so CI stays offline while letting contributors verify real CLI invocations against an isolated temp Git repo.

---

## Troubleshooting & Known Limitations

- **`unknown option: --restricted` or `--permission-prompts`**: Your installed Claude Code binary is older than `2.1.259`. Run `claude update` (or `npm install -g @anthropic-ai/claude-code@latest`) and re-check with `node src/cli.mjs doctor`.
- **Binary not found in sandboxed environments**: Check symlink accessibility with `node src/cli.mjs doctor`, or set `AGY_HANDOFF_CODEX_BIN` / `AGY_HANDOFF_CLAUDE_BIN`.
- **Claude `workspace-write` Bash boundary**: Built-in file tools are confined to `cwd` via `--restricted`, and `sudo` / `git push` are blocked, but other `Bash` commands do not run inside a container or OS filesystem jail. Keep `read-only` unless edits are explicitly requested.
- **Process tree cleanup on crash**: Normal timeouts and cancellations terminate child process trees on Linux, macOS, and Windows (`taskkill /T /F`), and jobs from a crashed MCP server are automatically marked `failed` on subsequent status queries. If an external subprocess forks detached processes that outlive `SIGKILL`/`taskkill`, manual cleanup may still be needed.

## License

[MIT](./LICENSE) · [Changelog](./CHANGELOG.md) · [Korean docs (한국어)](./README.ko.md)
