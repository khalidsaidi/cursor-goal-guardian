# Cursor Goal Guardian Extension

Goal Guardian makes Cursor **block risky actions unless a permit is issued** by the MCP server. It does this by installing
Cursor Hooks + an MCP server config **into your workspace**.

## What it actually does (in plain English)

When the agent tries to:
- run a shell command
- call an MCP tool
- read a file

the hook **checks for a valid permit**. If there isn’t one, it blocks the action and tells the agent how to get a permit.

## Quick start (1 minute)

1) Open your project in Cursor  
2) Run Command Palette → **“Goal Guardian: Install/Configure in Workspace”**  
3) Try `echo hi` in the terminal or ask the agent to read a file  
   - You should see a **block message**  
4) In Agent chat, run:
   - `guardian_check_step`
   - `guardian_issue_permit`
5) Retry the action → **it’s allowed**

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

## What users will see when it’s working

- **Blocked action message** for shell/MCP/file reads without a permit
- A suggested recovery path: “Call guardian_check_step → guardian_issue_permit”

If you don’t see blocks, make sure:
- `.cursor/hooks.json` exists in the workspace root
- It includes the Goal‑Guardian hook command

## How it works (short version)

1) MCP server validates steps and issues short‑lived permits  
2) Cursor hooks gate every action and enforce those permits  
3) Permit files live in `.ai/` (gitignored) so the model can’t read them

## Troubleshooting

- **Nothing happens:** run Install/Configure again, then reopen the workspace.
- **Blocks everything:** edit `.cursor/goal-guardian/policy.json` to loosen rules.
- **Need to reset:** run “Remove from Workspace” and reinstall.
