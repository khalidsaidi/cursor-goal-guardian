# Cursor Goal Guardian Extension

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/banner.png" alt="Goal Guardian Banner" width="700" />

Goal Guardian keeps the AI aligned by **anchoring it to explicit state**, then **warning, guiding, and only hard-blocking truly dangerous actions**.
It installs Cursor Hooks + an MCP server config **into your workspace**.

**In one line:** Goal-first Cursor. Warn on drift, guide back to the goal, and only hard-block catastrophic actions.

## What it actually does (in plain English)

When the agent tries to:
- run a shell command
- call an MCP tool
- read a file

the hook **delegates to the Goal‑Guardian MCP server** (single source of truth), which checks policy + goal alignment. It will:
- allow safe actions
- warn on risky actions
- recommend permits for sensitive actions
- hard-block only catastrophic commands

## Why people install it

- **Stop silent scope creep** without killing momentum
- **Make the goal visible** in a sidebar panel and status bar
- **Turn risky actions into guided decisions** instead of hard stops
- **Keep an audit trail** of warnings and permits
- **Maintain a single source of truth** with a Redux-style state store (anti-drift core)

## Anti-drift core (Redux loop)

This extension treats the agent like an app with explicit state, not a chat that “forgets”:

- **Store:** `.cursor/goal-guardian/state.json` (single source of truth)
- **Actions:** `.cursor/goal-guardian/actions.jsonl` (append‑only log)
- **Reducer:** `.cursor/goal-guardian/reducer.js` (optional JS reducer)
- **Rules:** `.cursor/goal-guardian/rules.json` (strictness + invariants)

Loop: **Read state → Dispatch action → Reducer → Next state**.  
This forces the agent to update goals/tasks/decisions in the store instead of drifting in chat history.

## Redux-style state store (on by default)

This extension also creates a state store so the agent's plan lives in a single, explicit file (not chat history):

- Store: `.cursor/goal-guardian/state.json`
- Actions: `.cursor/goal-guardian/actions.jsonl`
- Reducer: `.cursor/goal-guardian/reducer.js`
- Rules: `.cursor/goal-guardian/rules.json`

Flow: read state -> dispatch action -> reducer -> next state. Files are created automatically when the extension activates.

Commands:
- **Dispatch Action**
- **Rebuild State From Actions**
- **Open State Store / Action Log / Reducer / Rules**

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
- **Goal Guardian: Dispatch Action**
- **Goal Guardian: Rebuild State From Actions**
- **Goal Guardian: Open State Store / Action Log / Reducer / Rules**

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

## State-of-the-art anti-drift workflow (recommended)

1) **Dispatch `SET_GOAL`** (goal + definition of done + constraints)  
2) **Dispatch `ADD_TASKS`** (small, concrete steps)  
3) **Dispatch `START_TASK`** (exactly one active task)  
4) **Do the work** (hooks will warn if you drift)  
5) **Dispatch `COMPLETE_TASK`**  
6) **If you change direction:** dispatch `ADD_DECISION` *before* switching tasks

This creates a reproducible, auditable chain from state → action → result.

## Reducer modes (JSON vs JS)

`rules.json` controls the reducer behavior:

- **JSON reducer (default):** safe, deterministic, invariant‑enforced
- **JS reducer:** advanced mode for custom logic (set `"preferredReducer": "js"`)

If you use the JS reducer, **you are responsible** for updating `_meta` fields and preserving schema validity.

## Testing & verification

Automated checks:

```bash
pnpm -r test
pnpm -r build
```

Manual smoke test:

1) Run **Install/Configure**  
2) Dispatch `SET_GOAL`, `ADD_TASKS`, `START_TASK`  
3) Try `git reset --hard` → warning  
4) Try `rm -rf /` → hard block  
5) Open Goal Panel → state + warnings update

## Redux state screenshot

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/redux-state.png?v=0.3.2" alt="Redux state view" width="900" />

## Troubleshooting

- **Nothing happens:** run Install/Configure again, then reopen the workspace.
- **Too many warnings:** edit `.cursor/goal-guardian/policy.json` to loosen rules.
- **Need to reset:** run "Remove from Workspace" and reinstall.
