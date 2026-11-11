# Changelog

## Unreleased

### The goal loop speaks the originals' own words

Guardian's send-back instructions were a rewording of other projects' goal features. They are now those projects' own text, unmodified, with credit in `NOTICE`:

- **OpenAI Codex** (Apache-2.0): its continuation prompt goes out with every round, as Codex sends it; a changed goal is announced with its objective-updated prompt.
- **DeepSeek Harness** (MIT): its `<goal_round>` prompt heads every round and its closing instructions end a run, both from its own functions; an early "blocked" is refused in its words.

Guardian's own part is what neither has: your latest message first, the facts from its record, and how to report proof.

### Tools renamed to the originals'

The agent's tools are now `get_goal` and `update_goal`, with Codex's names, descriptions and statuses, plus Guardian's proof fields and `set_aside`. `guardian_change_goal` replaces `guardian_update_goal`. `guardian_get_contract`, `guardian_get_status` and `guardian_report_goal` are gone. The workspace rule is rewritten on upgrade. The agent can now pause a goal, but only by quoting your request to pause.

### Google's evaluator at "done"

Alongside the item review, the evaluator from Google's Agent Development Kit (Apache-2.0, bundled unmodified) judges the run from Guardian's own record of commands, outputs and edits, on your own Cursor model: one yes-or-no rubric for each of your "done when" lines, word for word, and one for work you didn't ask for. Each rubric it judges not met goes back to the agent like a reviewer objection, in the judge's words, and shows on the panel. It costs five short model calls per review, and is skipped, never blocking, when it can't run or takes too long. Guardian now also records what each edit changed (`telemetry/edits.jsonl`, kept out of git). Only the Linux x64 build carries the evaluator so far.

### Independent review at "done"

When the agent reports the goal complete and Guardian's record backs every item, one independent review runs before Guardian accepts it. A separate headless agent on your own Cursor login and default model (`cursor-agent`) works in a throwaway copy of the project. It tries to prove each "done when" item isn't really done, and lists changes no item needs. Its objections go back to the agent as part of the same loop, at most twice per run. After that the record decides, and any objection still standing is shown on the panel as the reviewer's opinion. Without `cursor-agent`, or if the review fails or takes longer than 90 seconds, it's skipped and noted, never blocking. Each review costs one agent request on your Cursor plan.

### The reviewer learns from this workspace

Each review that runs saves a copy of what it looked at under `.cursor/goal-guardian/cases/` (kept out of git; the newest 200, none over 2 MB). Each objection on the panel has **Right call** and **Reviewer was wrong**. Guardian also counts an objection the agent then fixed as right, and one you overrode by marking the goal done as wrong.

Once at least 8 reviews have a verdict, with both kinds, the panel offers **Improve the reviewer**. It runs Google
Research's RRSI (Regularized Recursive Self-Improvement, Apache-2.0), bundled unmodified with a Python of its own,
on your labelled cases: a third are held out, RRSI searches on the rest with your own Cursor model in its analyst,
proposer and critic roles, and its winner is replayed on the held-out third. Before it starts you see roughly how
many reviews and model calls it will spend. A winner that gets more right there without missing a gap the current
reviewer caught waits on the panel with its diff and scores until you press **Apply**; **Undo** goes back to the
built-in reviewer. The VSIX grows by about 40 MB for the bundled Python.

### Removed
- AI review. Scored on real agent runs for the first time, it found no real drift, so it no
  longer runs or spends your plan. Older workspaces keep working; its old settings are ignored.

- Word-matching drift flags, with their nudges, the "off the track" section and the
  on-course lamp. On 72 scored agent runs they fired 131 times: the one run a blind judge
  found drifted got none, and 29 clean runs got at least one. Cursor also ignores nudge text
  on allowed actions, so the agent never saw them. The lamp now shows where the goal stands.
  Also gone: the no-active-task reminder and the `vocal` mode, which now acts as `balanced`.
  Old settings and old log entries are still read, and ignored.

- The task board: tasks, the active task, decisions, open questions, pinned context and
  intents, with the event log and state machine behind them, the tools
  `guardian_record_progress`, `guardian_declare_intent` and `guardian_check_action`, the
  task commands, the panel's "Now" section and the auto-start and auto-pin settings. Agents
  used them to ask for task ids they couldn't find, and no test showed they helped.
  `contract.json` now holds the goal alone. A goal found only in an older `state.json` moves
  into it, and the old files are ignored. "Done when" lines tick only when a run proved them.

- Risky-command advisories, loop detection, the `notify` setting and quiet mode. Their notes
  went out in fields Cursor ignores on allowed actions, so they reached nobody, and safety isn't
  Guardian's job: it's about the goal. While the agent works, Guardian records and says nothing.
  Rules from an older `policy.json` aren't carried over, though its backup is kept.

- The native Windows observer (file watcher, process watcher, lease). It was built on a wrong
  diagnosis: Cursor's hooks do fire on Windows, and the real bugs were in how Guardian's hook read
  them. It only recorded, the goal loop needs hooks anyway, and it taped the person's saves as
  agent edits. Reads and Tab completions are no longer hooked either.

### Added
- The goal loop. When the agent stops after editing files, it's sent back with your
  goal and what Guardian's record shows until the goal is proved, truly blocked, set
  aside, stalled, or out of rounds (20). Proof is checked against commands and output
  Guardian recorded itself, for any language or tool. Each changed file must be tied to
  a "done when" line or called extra. No AI calls; each round is an agent turn. Not yet
  measured.
- New tool `guardian_report_goal`. Pause (which also stops the running chat), resume
  and mark done are in the panel. Only you can use them.
- Only the user changes an existing goal: `guardian_update_goal` now needs their words.
- Fixed: Guardian's hook couldn't read Cursor's payload on native Windows, or its workspace path.
- Updates now refresh the rule in connected workspaces, so the agent's instructions can't go stale.

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
