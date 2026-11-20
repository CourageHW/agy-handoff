# Contributing

Contributions and bug reports are welcome.

## Guidelines

- Keep `src/` on Node.js built-in modules (`>= 18.18.0`) so the plugin installs without a build or `npm install` step.
- Keep all reviews read-only and leave `read-only` as the default mode for delegations. Only `read-only` jobs may be replayed via `handoff_job_retry`.
- Never claim verification or estimates without factual runtime evidence.
- Add or update tests under `test/` for behavioral changes, and update `README.md` when changing tools, CLI flags, or skills.

## Checks

```bash
npm test
agy plugin validate --strict .
node src/cli.mjs doctor && node src/cli.mjs stats --table
npm run test:live   # optional live E2E when codex/claude CLIs are signed in
```

## Recording Demo GIF (`assets/demo.gif`)

1. Install [VHS](https://github.com/charmbracelet/vhs) (`brew install vhs` or `go install github.com/charmbracelet/vhs@latest`).
2. Run `vhs assets/demo.tape` from the repository root.
