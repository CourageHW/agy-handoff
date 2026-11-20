---
name: handoff-doctor
description: Check the host, available Codex, Claude Code, and Antigravity CLIs, and their model settings. Diagnose handoff failures.
---

# Handoff Doctor

1. Call the `handoff_doctor` MCP tool. Report `host`, `defaultExternalAgents`, and `defaultGroupEngines` from its response.
2. Report the Node.js version, each CLI's installed version and flag compatibility, model defaults, and any install or authentication hints.
3. If the tool is unavailable, check the host's MCP connection and permission settings. The terminal fallback is `node <plugin-root>/src/cli.mjs doctor` with `AGY_HANDOFF_HOST` set to the intended host.
