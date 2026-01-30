# Cursor Goal Guardian (MCP + Hooks)

This repo implements **anti-goal-drift** enforcement for Cursor by combining:

- an **MCP server** that acts as a **goal authority** (the “contract” lives outside the model)
- a **Cursor Hooks gatekeeper** that blocks shell/MCP/file-read actions unless a **short-lived permit** exists

Why this works in practice:
- The model can talk off-goal, but it **cannot do off-goal actions** if hooks block them.
- The goal contract is **external and canonical** (stored on disk).
- The agent must: **check step → get permit → perform action → commit result**.

## Repo contents

- `packages/cursor-goal-guardian-mcp`
  - MCP stdio server built with `@modelcontextprotocol/sdk`
  - tools:
    - `guardian_get_contract`
    - `guardian_initialize_contract`
    - `guardian_check_step`
    - `guardian_issue_permit`
    - `guardian_commit_result`

- `packages/cursor-goal-guardian-hook`
  - Cursor Hooks gatekeeper (stdio JSON in/out)
  - blocks:
    - `beforeShellExecution`
    - `beforeMCPExecution`
    - `beforeReadFile`
  - audits:
    - `afterFileEdit`, `stop`
  - uses `fallback-chain-js` for robust fallback selection

- `.ai/` (gitignored)
  - intended for agent scratch + runtime state
  - runtime state files written by MCP server:
    - `.ai/goal-guardian/checks.json`
    - `.ai/goal-guardian/permits.json`

## Local dev

```bash
pnpm install
pnpm -r build
pnpm -r test
```

## Wiring into a project

1) Build this repo so the binaries are in `dist/`.
2) Copy the example configs from `examples/cursor-project/.cursor` into your target project.
3) Edit:
   - `.cursor/goal-guardian/contract.json` (goal + criteria)
   - `.cursor/goal-guardian/policy.json` (policy toggles + allow/deny patterns)
   - `.cursor/mcp.json` (absolute paths to the built MCP server and workspace root)

## Typical flow (agent)

1) `guardian_get_contract`
2) `guardian_check_step` with explicit mapping to success criteria IDs
3) `guardian_issue_permit` with explicit allowed actions
4) do the action
5) `guardian_commit_result`

## Notes

- The MCP server writes runtime data to `.ai/` (gitignored) to avoid exposing permits to the model.
- The hook defaults to **permit-required** for shell and MCP calls, and optional for reads.
- You can set `requirePermitForRead` to `true` in `policy.json` for a stricter mode.

## The Redux mental model for agents

| Redux concept | Agent equivalent in Cursor |
| --- | --- |
| Store | `state.json` (single source of truth) |
| Actions | JSON events like `{ "type": "START_TASK", "taskId": "..." }` |
| Reducer | Deterministic function that turns `(state, action)` into `nextState` |
| Middleware | Cursor Rules (guardrails) + checklists via Commands |
| DevTools / time travel | `actions.jsonl` log + git history |

Why it matters: agents drift when the "current plan" only lives in chat history. Treating state and actions as first-class artifacts makes drift visible, debuggable, and preventable.
