# Cursor Goal Guardian (MCP + Hooks)

This repo implements **anti-goal-drift** enforcement for Cursor by combining:

- an **MCP server** that acts as a **goal authority** (the “contract” lives outside the model)
- a **Cursor Hooks guardrail** that warns on risky/off-goal actions (advisory-only by default)

Why this works in practice:
- The model gets **runtime guidance** when it drifts without interrupting flow.
- The goal contract is **external and canonical** (stored on disk).
- The agent can use permits when needed: **check step → get permit → perform action → commit result**.
- Execution can be tied to Redux state: missing/invalid active task produces warnings.

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
  - hook events:
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

## A/B value evaluation

Use the built-in evaluator to compare `with_cgg` vs `without_cgg` on the same task set:

```bash
pnpm eval:ab
```

This computes:
- scope drift incidents per task
- rework caused by misunderstanding
- time to resume after context switch
- task completion vs original success criteria
- unplanned task switches

See `examples/ab-study/README.md` for the input format.

For real-run evidence (blinded operator/judge workflow), use:

```bash
node scripts/scaffold-live-react-env.js \
  --env /tmp/cgg-live-react-env \
  --study /tmp/cgg-live-react-20 \
  --tasks examples/ab-live-react/task_set_20.json
# ... run both arms and fill runs.blinded.json ...
node scripts/unblind-live-ab.js --study /tmp/cgg-live-react-20 --evaluate
```

See `examples/ab-live-react/README.md` for protocol and rubric.

## Validation included (user-facing)

These checks are included in the repo and were run as part of release validation:

- Full automated test suite:
  - `pnpm -r test`
  - covers extension state store + cleanup, hook CLI/policy behavior, MCP preview behavior.
- Full build verification:
  - `pnpm -r build`
- A/B evaluator (sample study):
  - `pnpm eval:ab`
- Live blinded A/B protocol assets:
  - `examples/ab-live-react/task_set_20.json`
  - `scripts/scaffold-live-react-env.js`, `scripts/init-live-ab.js`, `scripts/unblind-live-ab.js`
- Panel replay demo from the real 20-task set:
  - `pnpm panel:demo:20tasks`
  - generates a long WebM in `artifacts/panel-demo/` (gitignored) and a docs GIF preview.

### Panel demo (animated)

This animation is generated from the real 20-task panel replay:

![Goal Guardian panel demo (20-task replay)](docs/media/goal-guardian-panel-demo-20tasks.gif)

To regenerate:

```bash
pnpm panel:demo:20tasks
ffmpeg -y -ss 4 -t 24 -i artifacts/panel-demo/goal-guardian-panel-demo-20tasks.webm \
  -vf "fps=8,scale=960:-1:flags=lanczos,palettegen=max_colors=96" /tmp/cgg-panel-palette.png
ffmpeg -y -ss 4 -t 24 -i artifacts/panel-demo/goal-guardian-panel-demo-20tasks.webm \
  -i /tmp/cgg-panel-palette.png \
  -lavfi "fps=8,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5" \
  docs/media/goal-guardian-panel-demo-20tasks.gif
```

## Wiring into a project

1) Build this repo so the binaries are in `dist/`.
2) Copy the example configs from `examples/cursor-project/.cursor` into your target project.
3) Edit:
   - `.cursor/goal-guardian/contract.json` (goal + criteria)
   - `.cursor/goal-guardian/policy.json` (policy toggles + allow/high-risk patterns)
   - `.cursor/mcp.json` (absolute paths to the built MCP server and workspace root)

## Typical flow (agent)

1) `guardian_get_contract`
2) `guardian_check_step` with explicit mapping to success criteria IDs
3) `guardian_issue_permit` with explicit allowed actions
4) do the action
5) `guardian_commit_result`

## Notes

- The MCP server writes runtime data to `.ai/` (gitignored) to avoid exposing permits to the model.
- The hook defaults to **warning-first, advisory-only** for shell/MCP/read.
- The hook can enforce Redux control checks (`enforceReduxControl: true`) and task-scope alignment (`enforceTaskScope: true`) on every shell/MCP/read action.
- Tune scope strictness with `taskScopeSensitivity`: `strict`, `balanced` (default), or `lenient`.
- You can set `requirePermitForShell`, `requirePermitForMcp`, and `requirePermitForRead` to `true` in `policy.json` for stricter permit recommendations.
- Policy schema is now explicit: use `highRiskPatterns` + `HIGH_RISK` (legacy `alwaysDeny` / `HARD_BLOCK` are not recognized).

## The Redux mental model for agents

| Redux concept | Agent equivalent in Cursor |
| --- | --- |
| Store | `state.json` (single source of truth) |
| Actions | JSON events like `{ "type": "START_TASK", "taskId": "..." }` |
| Reducer | Deterministic function that turns `(state, action)` into `nextState` |
| Middleware | Cursor Rules (guardrails) + checklists via Commands |
| DevTools / time travel | `actions.jsonl` log + git history |

Why it matters: agents drift when the "current plan" only lives in chat history. Treating state and actions as first-class artifacts makes drift visible, debuggable, and preventable.
