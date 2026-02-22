# Cursor Goal Guardian Extension

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/banner.png" alt="Goal Guardian Banner" width="700" />

Goal Guardian is a **Redux‑based agent system**: it keeps the AI aligned by **anchoring it to explicit state** and a deterministic action log.
It does **not** install blocking Cursor hooks.

**In one line:** Redux‑based anti‑drift for Cursor. A real state store + action log.

## Redux‑based, not chat‑based

This extension replaces “the plan in chat history” with a **Redux‑style state machine**:

- **Store (single source of truth):** `.cursor/goal-guardian/state.json`
- **Actions (append‑only log):** `.cursor/goal-guardian/actions.jsonl`
- **Reducer (deterministic updates):** `.cursor/goal-guardian/reducer.js`
- **Rules (invariants/strictness):** `.cursor/goal-guardian/rules.json`

Everything the agent does should map to an action → reducer → next state.

## What it actually does (in plain English)

When the agent works, Goal Guardian keeps a durable state loop:
- read state
- dispatch action
- update state deterministically
- keep an auditable action history
- auto-pin edited files into context while a task is active
- provide quick lifecycle commands for start/complete task flow

## Why people install it

- **Stop silent scope creep** without killing momentum
- **Make the goal visible** in a sidebar panel and status bar
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
- **Dispatch Action (optional/manual)**
- **Start Next Task**
- **Complete Active Task**
- **Rebuild State From Actions**
- **Open State Store / Action Log / Reducer / Rules**

## Quick start (1 minute)

1) Open your project in Cursor  
2) Run Command Palette -> **"Goal Guardian: Install/Configure State Files"**  
3) Open the panel in **Explorer sidebar -> Goal Guardian** (or run **"Goal Guardian: Show Goal Panel"**)  
4) Set a concrete goal and success criteria in `contract.json`  
5) Work normally; Goal Guardian auto-syncs goal/tasks from contract and auto-captures edited file context

## Commands

- **Goal Guardian: Install/Configure State Files**
- **Goal Guardian: Open Contract**
- **Goal Guardian: Remove from Workspace**
- **Goal Guardian: Dispatch Action**
- **Goal Guardian: Start Next Task**
- **Goal Guardian: Complete Active Task**
- **Goal Guardian: Rebuild State From Actions**
- **Goal Guardian: Open State Store / Action Log / Reducer / Rules**

## What it writes

- `.cursor/goal-guardian/contract.json`
- `.cursor/goal-guardian/state.json`
- `.cursor/goal-guardian/actions.jsonl`
- `.cursor/goal-guardian/reducer.js`
- `.cursor/goal-guardian/rules.json`

## Safe install behavior

- Existing files are not overwritten by default.
- Goal Guardian state files are managed independently from your hook/MCP wiring.

## What users will see when it's working

- **State visibility** in the Goal Panel and status bar
- **Deterministic task flow** through actions + reducer
- **Automatic task bootstrapping** from success criteria in `contract.json`
- **Automatic active-task + context capture** during normal editing
- **No hook-based execution stopping (advisory-only)**

## How it works (short version)

1) Goal + constraints live in `contract.json`  
2) Work is captured as explicit actions in `actions.jsonl`  
3) Reducer builds a durable state in `state.json`  

## State-of-the-art anti-drift workflow (recommended)

1) Set goal + success criteria in `contract.json`  
2) Goal Guardian auto-syncs state and creates criteria-based tasks  
3) As you edit, Goal Guardian auto-starts the next todo task (if needed)  
4) Edited files are auto-pinned into context while task is active  
5) Use manual dispatch commands only for advanced/exception paths

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
3) Dispatch `ADD_DECISION` before switching active tasks  
4) Run **Rebuild State From Actions**  
5) Open Goal Panel → state and timeline stay in sync

## Validation evidence (included)

This repo also ships user-facing validation assets:

- 20 real user-style React tasks: `examples/ab-live-react/task_set_20.json`
- Blinded A/B workflow scripts:
  - `scripts/scaffold-live-react-env.js`
  - `scripts/init-live-ab.js`
  - `scripts/unblind-live-ab.js`
  - `scripts/evaluate-ab.js`
- Long panel replay recorder:
  - `scripts/record-panel-demo-20tasks.mjs`
  - run with `pnpm panel:demo:20tasks`

Animated preview of the panel running through the 20-task replay:

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/docs/media/goal-guardian-panel-demo-20tasks.gif" alt="Goal Guardian panel demo animation" width="960" />

## Redux state screenshot

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/redux-state.png?v=0.4.10" alt="Redux state view" width="900" />

## Troubleshooting

- **Nothing happens:** run Install/Configure again, then reopen the workspace.
- **Need to reset:** run "Remove from Workspace" and reinstall.
