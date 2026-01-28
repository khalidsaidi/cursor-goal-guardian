# Cursor Goal Guardian Extension

This VS Code/Cursor extension installs and configures Goal Guardian (MCP + Hooks) in the current workspace.

## Commands

- **Goal Guardian: Install/Configure in Workspace**
- **Goal Guardian: Open Contract**
- **Goal Guardian: Remove from Workspace**

## What it writes

- `.cursor/goal-guardian/contract.json`
- `.cursor/goal-guardian/policy.json`
- `.cursor/hooks.json`
- `.cursor/mcp.json`

The hook and MCP server binaries are bundled with the extension and invoked via `node`.

## Safe install behavior

- Existing files are not overwritten by default.
- If `.cursor/hooks.json` or `.cursor/mcp.json` already exist, the extension merges Goal‑Guardian entries.
- When a merge occurs, a backup is created (e.g., `hooks.json.bak-<timestamp>`).
