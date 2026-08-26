# Example: a Goal Guardian v2 workspace

The recommended path is the extension's **"Goal Guardian: Set Up Workspace"**
command, which writes all of these files for you (with correct absolute paths
to the bundled binaries). This directory exists so you can see what a wired
workspace looks like.

```
.cursor/
  goal-guardian/
    contract.json    # the goal contract (v2 schema)
    config.json      # notify mode, drift sensitivity, advisory rules
  rules/
    goal-guardian.mdc  # session anchor: agents load the contract at session start
  hooks.json         # observation hooks -> bundled goal-guardian-hook.cjs
  mcp.json           # goal-guardian MCP server -> bundled goal-guardian-mcp.mjs
```

Replace `/ABSOLUTE/PATH/TO/EXTENSION` with your installed extension directory
(something like `~/.cursor/extensions/khalidsaidi.cursor-goal-guardian-extension-<version>`)
if you wire manually — or just run the setup command.

Runtime state (`state.json`, `actions.jsonl`, `telemetry/`) is created on first
use; `telemetry/` is machine-written and belongs in `.gitignore`.
