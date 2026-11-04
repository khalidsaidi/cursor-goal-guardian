# Changelog

## Unreleased

### Added
- Done check (opt-in: off / advisory / enforce). Turns that changed something
  end with a `## Done check` or `## Blocked` block; Guardian checks it in code
  against the session tape — commands that never ran, quoted output that was
  never printed, and `file:line` references past the end of a file are marked
  contradicted. The panel shows the latest check; `enforce` sends the agent
  back with the failing lines via Cursor's stop hook. New hook events:
  `afterShellExecution` (output capture), `afterAgentResponse`, `stop`;
  existing workspaces pick them up automatically on the next activation.
- Done check, real-turn fixes: quoted output counts if the session printed it
  anywhere or a cited file contains it; a command missing from the shell tape
  is unverified, not fabricated; quoted definitions and mispaired quotes are
  not treated as output; a gap "held by: me" is accepted; an unbalanced code
  fence no longer hides the block. Honest real turns falsely marked
  "contradicted": 13 of 31 before, 0 of 23 on a fresh set after.
- The goal keeps going until it is done (done check in `enforce`). The
  goal and its "done when" list become one goal record with a status
  (in progress, paused, blocked, done, out of rounds), a round budget
  (`doneCheck.goalRounds`, 50) and a version history on the tape. When the
  agent stops with "done when" items still open that it could finish
  itself, Guardian sends it back for another round (at most
  `doneCheck.continueRounds`, 3, per message you send). Each round tells
  it to pursue the whole goal, not a smaller or easier version, to check
  the project as it is now, and to prove every item with evidence before
  calling it done. Only Guardian marks a goal done: every "done when"
  item backed by evidence, nothing open, the tests intact. The agent's own
  "done" is recorded as a claim. A first "blocked" the agent could get
  past is challenged once. Two rounds with no command and no edit stop the
  goal as blocked ("no progress"), and the agent writes one last message
  saying what's done, what's in the way, and what it needs from you. At
  the round budget it hands off instead of starting new work. If you
  change the goal, the next round says so. The panel shows the goal's
  status, its rounds and any blocker, with pause, resume and stop.
  New MCP tools: `guardian_get_goal` and `guardian_set_goal_status` ("complete" is only
  a claim, "blocked" only after three rounds, "paused" only when you
  asked).
- Loops are caught, with no model: the same command run 3, 5 or 8 times
  in a row with nothing in between gets a short note to the agent (look
  at the last result, change the approach, or wrap up). Advisory, never
  blocking, silent in `quiet` mode. Each loop records whether the agent
  broke it.
- Every flag records how it turned out (`flag.outcome` on the tape, no
  model): a send-back the agent fixed by changing files, a claim it
  corrected without changing any, broken tests that went green again, a flag still
  there after the agent's answer. Each flag in the panel has a "wrong
  flag?" button. The panel shows the week's track record ("Guardian's
  flags this week: 4 fixed by the agent · 1 marked wrong by you"). A case
  file joins every flag with its outcome, drift nudges included.
- Guardian re-runs your tests itself, with no model, on by default
  (`doneCheck.tests`). After a turn that edited files, it re-runs the
  agent's own last test command, whatever the language, in a throwaway
  copy with credentials stripped. It guesses no toolchain: if the agent
  ran no tests, nothing is re-run. `doneCheck.tests.command` overrides it.
  If the tests fail, it runs them again without the turn's
  changes, so it can tell "this turn broke them" from "already failing".
  The panel shows the result. With the done check in `enforce`, a
  `## Done check` over tests the turn broke fails and the agent is sent
  back, unless the block declares the gap. In `off` and `advisory` the
  check finishes in the background, so Cursor never waits for it. The
  stop hook keeps a 300 s timeout and a loop cap of 20.

## 1.0.0

Ground-up rewrite. Identity: a drift flight-recorder for AI coding sessions —
it records what the agent did, scores it against the declared goal, and shows
the tape. It never blocks, and it never nags.

### Added
- Setup is a form in the panel: goal in your own words, "done when" lines
  added with Enter (each becomes a task, × removes), boundaries, one Connect
  button. No input boxes, no separators, no palette anywhere in the journey.
- Guardian introduces itself exactly once: the panel opens on its own after
  install (remote-safe — it retries until the view actually lands).
- Cursor's one-time per-project MCP enable is guided: a notification with an
  "Open MCP Settings" button lands you on the exact screen with the switch.
- Done means verified: the session protocol has the agent run the proof
  (tests, build) before recording a task complete — and when the machine
  blocks the proof (say, a missing runtime), the agent offers to fix it or
  record the gap, and waits for your call.
- Recording works on native Windows: Guardian's extension observes edits and
  every launched command at the OS level (single recorder elected per
  workspace, editor plumbing filtered, wrappers unwrapped) — the tape fills
  even where Cursor's own hook runtime cannot reach the workspace.
- Ships as self-contained native binaries for all six platforms (Linux,
  macOS, Windows × x64/arm64); wiring points at absolute paths — no Node.js,
  no PATH assumptions, nothing to install first.
- Get-started tour in the panel: a six-step first-ten-minutes checklist whose
  steps complete from evidence in the actual session (goal declared, task
  finished, `/guardian` used, review consented…) — never from clicking "next".
  Dismissible; retires itself when finished.
- Session anchor: setup writes `.cursor/rules/goal-guardian.mdc` so every agent
  session loads the contract and records progress unprompted (verified e2e with
  a real, uninstructed Cursor agent).
- New MCP tool surface: `guardian_get_contract`, `guardian_declare_intent`,
  `guardian_record_progress` (task transitions on the tape; switching away from
  an active task requires a decision), `guardian_check_action`,
  `guardian_get_status`.
- Episode-governed nudges: at most one calm sentence per drift episode per
  cooldown; `notify` modes `quiet | balanced | vocal` (quiet injects nothing,
  ever).
- AI drift review (consent-gated, uses your Cursor account): a judge confirms
  or dismisses flagged drift, and periodically reviews the raw session tape
  against the goal — catching in-vocabulary drift lexical scoring cannot see.
- Opt-in escalation `escalateConfirmedDrift: "ask"`: confirmed drift that
  continues after its nudge is handed to the human via Cursor's confirmation
  UI. The guardian itself still never denies.
- Setup now actually wires `.cursor/hooks.json` and `.cursor/mcp.json` to the
  bundled binaries; a doctor pass repoints them after extension updates;
  uninstall removes everything.
- One-shot migration from 0.4.x with `*.v1.bak` backups and a single passive
  notice.

### Changed
- Panel rebuilt: message-based incremental updates (no more 5-second full-HTML
  re-render), welcome/setup view, drift feed with review status, AI session
  verdict, numeric view badge. Status bar is hidden until set up and never uses
  an error background.
- Auto-behaviors (auto-start task, auto-pin on save) are now opt-in and
  default off.
- Policy severities renamed to advisory vocabulary: `ok / caution / alert`.
  Shell rules now match chained commands per segment (`git status && rm -rf /`
  no longer hides behind the ok prefix) and `*` crosses `/` in commands.
- Task↔criterion linking uses stable `criterionId`s instead of parsing
  "SC1:"-prefixed titles.
- State schema v2 (camelCase); ids/timestamps come from the persisted action,
  making replay exactly deterministic.

### Removed
- The permit system (`guardian_check_step`, `guardian_issue_permit`,
  `guardian_commit_result`, TTL tokens, warning-count escalation): it gated
  nothing since the advisory shift and cost real ceremony.
- Custom JS reducers (`reducer.js`) and `rules.json` knobs — invariants are the
  product's opinion, and dynamic workspace code broke replay determinism.
- The `.ai/goal-guardian/` split; telemetry now lives under
  `.cursor/goal-guardian/telemetry/`.
- `autoRevertUnauthorizedEdits` — an advisory product does not touch your
  working tree.


## 0.4.11
- Publish follow-up for advisory-only policy/docs refresh.
- Trim panel demo GIF intro so the animation starts on visible panel content.

## 0.4.10
- Improve Goal Panel UX for first-time users:
  - add "How To Read This Panel" onboarding section
  - add "Session Pulse" summary and "Next Best Action"
  - keep Action Timeline visually central with clearer legend
- Add reproducible 20-task panel replay recorder (`scripts/record-panel-demo-20tasks.mjs`).
- Add user-facing validation documentation and animated panel demo references.
- Remove legacy policy compatibility paths (`alwaysDeny`, `HARD_BLOCK`); policy now uses `highRiskPatterns` and `HIGH_RISK` only.

## 0.3.5
- Stop wiring Cursor hooks/MCP from the extension; extension is now state-driven anti-drift only.
- On activation/install, remove legacy Goal Guardian hook entries from `.cursor/hooks.json` and legacy `goal-guardian` from `.cursor/mcp.json` (with backups).
- Remove permit-oriented commands/UI actions from the extension surface.

## 0.3.4
- Fix MCP-preview hook path so permit-required and warning-limit cases stay warning-first and advisory-only.
- Relax default workspace policy: `requirePermitForShell` and `requirePermitForMcp` now default to `false`.

## 0.3.3
- Make Redux-based positioning explicit in the overview.

## 0.3.2
- Fix action timeline layout so diff panel never overlaps.
- Refresh Redux screenshot and publication assets.
- Harden packaging script paths for reliable builds.

## 0.3.1
- MCP‑controlled hooks: all action decisions flow through the Goal‑Guardian MCP server
- New status badge in Goal Panel (“MCP‑controlled”)
- Timeline graph + latest state diff panel
- Redux state screenshot added to marketplace README

## 0.3.0
- Redux-style state store (state.json + actions.jsonl) enabled by default
- Deterministic reducer with invariants and time-travel rebuild
- Auto snapshots and strict hash validation
- New commands: Dispatch Action, Rebuild State, Open State/Actions/Reducer/Rules
- Goal panel shows state summary and last action

## 0.2.0
- **"Guardrail Not Gate" redesign**: Graduated severity system replaces binary pass/fail behavior
- **New severity levels**: HIGH_RISK, WARN, PERMIT_REQUIRED, ALLOWED
- **Warning accumulation**: Risky commands warn first, then escalate permit recommendations after 3 warnings (configurable)
- **Soft permits**: Permit-required actions warn and continue (advisory-only)
- **Auto-Permit Last Action**: One-click permit issuance from the Goal Panel
- **Goal Panel**: New sidebar panel showing goal, criteria, permits, and warnings
- **Status Bar**: Shows goal state, permit count, and warning count
- **Audit Output Channel**: View audit.log entries in VS Code
- **New MCP tools**: `guardian_preview_action` (dry-run) and `guardian_get_status`
- **Lower permit threshold**: 0.5 instead of 0.6 for clearly on-goal actions
- **New commands**: Show Panel, Show Audit, Request Permit, Refresh
- **Auto-refresh**: UI updates when contract files change

## 0.1.0
- Initial release.
