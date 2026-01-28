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
