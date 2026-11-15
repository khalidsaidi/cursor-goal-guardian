# Example CGG workspace

Use **Goal Guardian: Set Up Workspace** for normal installation. It writes the rule, chat skills, hooks and MCP configuration with the actual paths to the bundled programs.

This example shows the file structure, not a separately runnable installation:

```text
.cursor/
  goal-guardian/
    contract.json       # your goal, finish conditions and boundaries
    config.json         # local settings
  hooks.json            # Cursor events connected to CGG
  mcp.json              # six goal/feedback tools
  rules/goal-guardian.mdc
```

The real setup also generates `/guardian` and `/guardian-goal` skills and registers a user-level MCP entry for agent-hub chats, preserving unrelated entries. Enable the goal-guardian MCP server in Cursor's settings and use a trusted workspace. Ask for the work normally; questions alone do not create a goal.

CGG keeps the goal across chats, sends the agent back with unfinished work and checks requested completion. Correct specific review findings in chat or the panel. Learning is bounded and only qualified reviewer updates are adopted.

The example rule is generated from the current source, not a separate protocol to maintain. The JSON files are illustrative; their executable paths must be supplied by the extension. Current build validation is Linux x64, including WSL Ubuntu. See the [main guide](../../README.md).
