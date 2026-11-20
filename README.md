# agy-handoff

Review a change with Codex, Claude Code, and Antigravity from one Antigravity session. Each CLI inspects the same working tree independently. Your session gets the findings and file references so you can check disagreements against the code.

The plugin also supports single-engine reviews, implementation planning, and delegated edits. It runs on Node.js and uses your existing CLI sign-ins.

## Install and run a review

You need Node.js 18.18 or later. Sign in to the CLIs you want to use. The minimum supported versions are 0.160.0 for Codex, 2.1.259 for Claude Code, and 1.5.0 for the Antigravity reviewer.

```sh
git clone https://github.com/CourageHW/agy-handoff.git
agy plugin install ./agy-handoff
```

Open Antigravity in the repository you want to review. Run the doctor first, then request a review.

```text
/agy-handoff:handoff-doctor
/agy-handoff:handoff-cross-review Review my uncommitted changes.
```

The doctor checks which binaries it can find and whether they support the required flags. The cross-review uses the available engines and reports any it skipped.

## Reading a review

A structured cross-review groups findings that appear to describe the same defect. Each group lists the reviewers that reported it. Findings from a single reviewer and disagreements about severity are also included.

The plugin checks whether each cited file exists and whether the line number is in range. To confirm a bug, open the cited line and check the behavior the reviewer describes. For example, two engines can agree that a function accepts an empty list and both miss a guard in its caller.

For a narrower review, use `/agy-handoff:handoff-review` and specify the engine, files, or commit. To see what a reviewer inspected, open its subagent pane with `/agents` in Antigravity CLI. [View the workflow](./assets/demo.gif)

## Planning and delegation

| Command in Antigravity | When to use it |
| --- | --- |
| `/agy-handoff:handoff-grill-me` | Work through open design questions before writing a plan. |
| `/agy-handoff:handoff-plan` | Compare proposed file changes, implementation steps, and tests. The plugin checks the proposed file paths against the working tree. |
| `/agy-handoff:handoff-delegate` | Give one engine a focused task, such as tracing a failing test. Request `workspace-write` explicitly if it should make edits. |
| `/agy-handoff:handoff-models` | Inspect or change the model and reasoning effort for each engine and command. |

## Terminal usage

From the plugin checkout, pass the target repository with `--cwd`. For example, to review a feature branch against its local `main` branch, run the following command.

```sh
node src/cli.mjs cross-review --cwd ../my-project --scope base --base main --structured
```

For a focused review, pass the file path and the question you want answered.

```sh
node src/cli.mjs review --cwd ../my-project --engine codex --scope custom \
  --files src/jobs.mjs --prompt "Check how failed jobs are retried."
```

Use `node src/cli.mjs watch` to follow active jobs and `node src/cli.mjs stats --table` to see outcomes, duration, and CLI-reported usage. Run `node src/cli.mjs --help` for other commands.

## Permissions and retries

Reviews and plans run in read-only mode. Delegation defaults to read-only as well.

| Engine | Read-only | Workspace write |
| --- | --- | --- |
| Codex | Codex read-only sandbox | Codex workspace-write sandbox |
| Claude Code | Restricted file tools and an allowlist of read-only Git commands | File tools are confined to the working directory. **Bash runs without an OS sandbox.** |
| Antigravity | `--sandbox --mode plan` | `--sandbox --mode accept-edits` |

After a failed read-only job, check its status for `retryable` before calling `handoff_job_retry`. If a write fails partway through, inspect the working tree before starting another job. On foreground read-only runs, Antigravity can switch from Neon to Argon once if Neon reports a quota error.

## Configuration

Run `node src/cli.mjs models show` to see the active defaults. For a single-engine request, `engine: "auto"` selects between Codex and Claude Code using availability, recent failures, and your routing preferences. To use Antigravity for that request, select `engine: "agy"`.

| Environment variable | Purpose |
| --- | --- |
| `AGY_HANDOFF_CODEX_BIN`, `AGY_HANDOFF_CLAUDE_BIN`, `AGY_HANDOFF_AGY_BIN` | Set an executable path for one engine. Set `AGY_HANDOFF_AGY_BIN=none` to disable the Antigravity reviewer. |
| `AGY_HANDOFF_CONFIG` | Use a different model and routing configuration file. |
| `AGY_HANDOFF_JOBS_DIR` | Choose where to store job logs and event streams. |

<details>
<summary>MCP tool reference</summary>

| Task | Tools |
| --- | --- |
| Check the installation or change settings | `handoff_doctor`, `handoff_config` |
| Review, plan, or delegate | `handoff_review`, `handoff_cross_review`, `handoff_plan`, `handoff_delegate` |
| Follow a job or retrieve its output | `handoff_job_status`, `handoff_job_result` |
| Cancel a background job or retry an eligible job | `handoff_job_cancel`, `handoff_job_retry` |

</details>

## Development

Run `npm test` for unit tests and MCP integration tests. The suite uses local CLI fixtures and requires no account credentials. Run `agy plugin validate --strict .` to check the plugin manifest and bundled skills.

[Contributing](./CONTRIBUTING.md) · [Changelog](./CHANGELOG.md) · [MIT license](./LICENSE)
