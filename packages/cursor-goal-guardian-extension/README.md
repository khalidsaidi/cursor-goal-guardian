# Cursor Goal Guardian

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/banner.png" alt="Goal Guardian Banner" width="700" />

**A drift flight-recorder for AI coding sessions.** Goal Guardian records what
the agent did, scores it against your declared goal, and shows you the tape.
It never blocks, and it never nags.

**In one line:** declare the goal once, on disk — then watch every session stay
anchored to it, with the receipts to prove it.

## Why

An agent's commitment to your goal lives in its context window, and context
decays: it gets compacted, diluted by tool output, or reset. The agent's
*effective* goal silently mutates — scope creeps, tasks switch without
justification, and after an interruption nobody can cheaply reconstruct "what
was I doing and why."

Goal Guardian moves the goal and the work-state **out of the model's memory and
onto disk**, where they cannot decay:

- **Goal contract** — goal, success criteria, constraints (`contract.json`)
- **Redux-style task board** — a real store with an append-only action log and
  one pure reducer: state is always exactly `replay(actions)` (ids and
  timestamps live in the actions, so time-travel/rebuild is deterministic);
  task switches require a recorded decision
- **The tape** — typed telemetry of hooks, actions, drift signals, and reviews

## How it stays on goal

1. **Anchor** — setup writes a Cursor rule so every agent session starts by
   loading the contract and knows to record progress through the guardian's
   MCP tools (`guardian_get_contract`, `guardian_declare_intent`,
   `guardian_record_progress`, `guardian_check_action`, `guardian_get_status`).
2. **Observe** — lightweight hooks (~60 ms) record every shell command, MCP
   call, and file edit. A lexical scorer flags actions that share no vocabulary
   with the active task.
3. **Nudge, calmly** — at most **one** quiet sentence per drift episode is
   injected into the conversation, re-anchoring the agent at the exact moment
   it drifts. `quiet` mode records everything and says nothing.
4. **Review with AI (with your consent)** — flagged drift is confirmed or
   dismissed by a judge running on your Cursor account, and the judge
   periodically reads the raw session tape against the goal — catching drift
   that shares vocabulary with the task but serves something else. Never runs
   without a one-time opt-in.
5. **Show the tape** — the panel pairs each drift with its realignment, shows
   session health, the task board, and an AI session verdict. The status bar
   stays subtle; nothing ever uses an error state.

### Advisory forever

Every hook response allows. The strongest opt-in escalation
(`escalateConfirmedDrift: "ask"`) hands *confirmed, persistent* drift to **you**
via Cursor's own confirmation UI — the guardian itself never denies anything.

## Getting started

1. Install from Open VSX (Cursor's registry).
2. Open the **Goal Guardian** panel in the Explorer sidebar and click
   **Set up this workspace** (or run `Goal Guardian: Set Up Workspace`).
3. Declare a goal, success criteria, and constraints — each criterion becomes a
   trackable task.

Until you set it up, the extension is inert: no files written, no status bar,
no notifications.

## Files it owns

```
.cursor/goal-guardian/
  contract.json      # the goal contract
  config.json        # notify mode, drift sensitivity, advisory rules
  state.json         # event-sourced task board (hash-guarded)
  actions.jsonl      # append-only action log
  telemetry/         # the tape (gitignored): audit.jsonl, verdicts.json
.cursor/rules/goal-guardian.mdc   # the session anchor
```

`Goal Guardian: Remove from Workspace` deletes all of it, including the hook
and MCP wiring.

## Upgrading from 0.4.x

Old workspaces migrate automatically on activation: files are backed up as
`*.v1.bak`, the permit-era state is retired, and one passive notice confirms
the upgrade. The permit system (check/permit/commit) is gone — it gated nothing
and cost ceremony; its replacement is honest telemetry plus the decision-gated
task switch.

## Validation

- 190+ unit and contract tests, including a quietness contract (one nudge per
  episode, zero in quiet mode), a hook latency budget, and migration golden
  tests against real 0.4.x workspaces.
- A 12-scenario end-to-end suite drives **real** headless Cursor agents against
  the built binaries — including an uninstructed agent cooperating purely from
  the session rule, and a live AI judge separating real drift from false
  positives.
