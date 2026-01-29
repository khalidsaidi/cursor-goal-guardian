# Cursor Goal Guardian Extension

![Goal Guardian Banner](https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/banner.png)

Goal Guardian keeps the AI aligned by **warning, guiding, and only hard-blocking truly dangerous actions**.
It installs Cursor Hooks + an MCP server config **into your workspace**.

**In one line:** Goal-first Cursor. Warn on drift, guide back to the goal, and only hard-block catastrophic actions.

## What it actually does (in plain English)

When the agent tries to:
- run a shell command
- call an MCP tool
- read a file

the hook **checks policy + goal alignment**. It will:
- allow safe actions
- warn on risky actions
- recommend permits for sensitive actions
- hard-block only catastrophic commands

## Why people install it

- **Stop silent scope creep** without killing momentum
- **Make the goal visible** in a sidebar panel and status bar
- **Turn risky actions into guided decisions** instead of hard stops
- **Keep an audit trail** of warnings and permits

## Quick start (1 minute)

1) Open your project in Cursor  
2) Run Command Palette -> **"Goal Guardian: Install/Configure in Workspace"**  
3) Try `git reset --hard` or ask the agent to read a sensitive file  
   - You should see a **warning** (not a hard block)  
4) Click **Goal Guardian: Auto-Permit Last Action**  
5) Retry the action -> **it's allowed without warnings**

## Commands

- **Goal Guardian: Install/Configure in Workspace**
- **Goal Guardian: Open Contract**
- **Goal Guardian: Remove from Workspace**
- **Goal Guardian: Auto-Permit Last Action**

## What it writes

- `.cursor/goal-guardian/contract.json`
- `.cursor/goal-guardian/policy.json`
- `.cursor/hooks.json`
- `.cursor/mcp.json`

The hook and MCP server binaries are bundled with the extension and invoked via `node`.

## Safe install behavior

- Existing files are not overwritten by default.
- If `.cursor/hooks.json` or `.cursor/mcp.json` already exist, the extension merges Goal-Guardian entries.
- When a merge occurs, a backup is created (e.g., `hooks.json.bak-<timestamp>`).

## What users will see when it's working

- **Warnings** for risky actions and goal check reminders
- **Hard blocks** only for catastrophic commands (e.g. `rm -rf /`)
- One-click **Auto-Permit Last Action** to stay productive

If you don't see blocks, make sure:
- `.cursor/hooks.json` exists in the workspace root
- It includes the Goal-Guardian hook command

## How it works (short version)

1) MCP server validates steps and issues short-lived permits  
2) Cursor hooks enforce a **graduated guardrail** policy  
3) Permit files live in `.ai/` (gitignored) so the model can't read them

## Troubleshooting

- **Nothing happens:** run Install/Configure again, then reopen the workspace.
- **Too many warnings:** edit `.cursor/goal-guardian/policy.json` to loosen rules.
- **Need to reset:** run "Remove from Workspace" and reinstall.
