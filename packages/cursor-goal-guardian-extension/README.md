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
  one pure reducer: state is always exactly `replay(actions)`; task switches
  require a recorded decision
- **The tape** — typed telemetry of hooks, actions, drift signals, and reviews

## How the Redux store reduces drift (plain English)

Drift happens because "what we're working on" normally lives in the agent's
head — and the agent's head leaks. When the plan only exists in chat history,
it mutates silently and nobody can point to the moment it changed.

The store takes the plan out of anyone's head and makes it a **fact in a file**:

1. **One answer to "what is the current task?"** Every part of the system — the
   hooks, the panel, the AI reviewer, the agent itself — reads the same answer
   from the same file. You can't drift from something fuzzy; once it's written
   down, drifting from it becomes *visible*. The store is the fixed point that
   makes the word "drift" mean anything at all.
2. **The plan only changes through the front door.** The store never changes by
   editing it — only by dispatching an action: start this task, complete that
   one, record a decision. Switching away from an active task *without a
   written decision is refused by the state machine itself*. The agent can
   still wander with its hands, but it can never quietly rewrite what the
   session is for — and that gap between recorded purpose and actual behavior
   is exactly what every drift detector here measures.
3. **Every change is a receipt.** Actions append to a log forever, and
   replaying the log reproduces the current state exactly. When a drift
   warning fires at 3:40 PM, you can see that the CSV task was started at
   3:35 PM and no decision has been recorded since — so the dark-theme work at
   3:40 has no recorded reason to exist.
4. **Interruptions stop causing drift.** The classic drift moment is
   *resuming* — after lunch, a meeting, or a context reset, everyone
   reconstructs "where were we?" from fading memory and starts subtly wrong.
   With the store, resuming is a read, not a reconstruction: active task,
   done list, open questions, last decision.

In one line: **the store doesn't stop the agent from wandering — it makes it
impossible for the *goal* to wander.** The goal stays nailed to the floor, so
the moment the work walks away from it, everything else (the scorer, the
judge, the nudge, the panel) has a fixed spot to measure the distance from.

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

## See it work

*One real session: a web-shop checkout, driven entirely from chat.*

**The session panel — the whole story at a glance.** Goal as the title, an
instrument-style status lamp, the task board, "done when" checklist, and the
AI verdict on the session:

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s5-session.png" width="800" alt="The session panel beside the code and agent chat" />

**Your request becomes the goal.** No setup ceremony — ask for something and
Guardian tracks it, with derived "done when" criteria:

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s2-hub-tracking.png" width="800" alt="A plain request becomes a tracked goal" />

**Pivots go on the record.** Change direction in chat and the agent documents
it instead of losing the thread:

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s3-hub-pivot.png" width="800" alt="A detour is recorded on the Goal Guardian tape" />

**Ask the tape, not the model's memory.** `/guardian` briefs you from the
session record:

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s4-hub-briefing.png" width="800" alt="/guardian briefing in the agent chat" />

**Native in the chat input.** Guardian's skills live in the same `/` menu as
everything else:

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s1-slash-menu.png" width="800" alt="Guardian skills in the slash menu" />

**AI review clears false alarms — with your consent.** One opt-in, then the
judge dismisses housekeeping and confirms real drift, with reasons:

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s12-consent.png" width="800" alt="AI review consent" />

**One keystroke to steer.** The status bar opens the Command Center — switch
task (with the why on the record), update the goal, toggle notifications:

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s7-command-center.png" width="800" alt="Command Center" />

**Starts quiet, connects in one click:**

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s6-welcome.png" width="800" alt="Welcome state" />
<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s9-setup.png" width="800" alt="Setup wizard" />
<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s10-palette.png" width="800" alt="Command palette" />
