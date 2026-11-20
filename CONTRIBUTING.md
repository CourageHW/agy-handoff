# Contributing

Contributions and bug reports are welcome.

## Guidelines

- Keep `src/` on Node.js built-in modules (`>= 18.18.0`) so the plugin installs without a build or `npm install` step.
- Keep all reviews read-only and leave `read-only` as the default mode for delegations.
- Add or update tests under `test/` for behavioral changes, and update `README.md` / `README.ko.md` when changing tools, CLI flags, or skills.

## Checks

```bash
npm test
agy plugin validate --strict .
node src/cli.mjs doctor
```
