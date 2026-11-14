# Changelog

## Unreleased

- Give the goal engines complementary roles: DeepSeek owns phase/round authority; Codex supplies budgets and continuation instructions. State changes notify Codex without duplicate approvals or rollback.

Built and run on Linux x64 only so far.

### Completion verification

- Run the independent reviewer directly, without another helper layer that can delay its verdict past the tool-call budget.

- Check finished work rather than copied proof text or file labels. Use recorded command results and actual source; do not send the agent back over harmless formatting, supporting docs/types or a line-count heuristic.
- Keep objections for missing requirements, demonstrated failures and meaningful unrelated changes. Explicit user restrictions still apply to every checker.
- Reuse checks by project content and recorded results, independently of report wording or commits. Respect changed reviewer templates and feedback corrections, and invalidate checks when relevant work changes.

- Keep the goal active for a bounded recovery pass when independent verification cannot finish. Send the agent back to finish local checks and retry unfinished independent checks, preserving usable results on unchanged work. Persistent failures end unchecked; concrete objections still require a fix.

- Require evidenced build, public API and focused behavior checks. Missing or inconclusive checks cannot produce proved; a failed check can reject completion even when source tests pass.
- Check reviewer-only objections against the project when the evaluator disagrees, including false objections to declarations supporting the requested export. Evidence-backed dismissals are recorded without sending the agent back to change correct work.
- Include actual cited source in evaluator evidence, even when an earlier turn committed it. Retain per-item review evidence and separate cached verdicts by policy version.
- Incomplete review replays cannot score as clean passes during prompt improvement.

The earlier study figures below predate this verification policy; they are not measurements of these changes.


### Other projects' goal code runs beside Guardian's own

The goal's words and "done when" items stay in Guardian's own goal file, and Guardian's own checks still come first when the agent is sent back and when "done" is accepted. Two projects' goal code now runs beside it, unmodified, with credit in `NOTICE`; each is consulted on every round and can refuse a change, and the goal's phase is read from DeepSeek Harness's record:

- **OpenAI Codex**'s goal package (Apache-2.0): holds a copy of the goal, can refuse a change, is asked whether to continue each round, and supplies the continuation instructions, usage accounting and an optional token budget.
- **DeepSeek Harness**'s four goal packages (MIT): hold a copy of the goal's phase and rounds, can refuse a change, its round driver is asked about each round, and it supplies the round prompt and closing instructions. An early "blocked" is refused by its rule.

Their text is most of what the agent is sent on a send-back. Guardian's own part is your latest message first, the facts from its record, and how to report proof. Neither project's code judges whether a goal is done. The Linux package is a 171 MB download that unpacks to 440 MB, and the moment the agent stops and is sent back takes about 0.55 seconds of Guardian's own time (measured on the built programs).

### Tools

The agent's tools are now `get_goal`, `create_goal` and `update_goal` (each call goes through Codex's and DeepSeek Harness's own tool code as well as Guardian's checks), `goal_command` (DeepSeek Harness's `/goal` command, only when your message is that command) and `guardian_change_goal`, which replaces `guardian_update_goal`. `guardian_get_contract`, `guardian_get_status` and `guardian_report_goal` are gone. The workspace rule is rewritten on upgrade. The agent can pause a goal only by quoting a request to pause from your latest message.

### Two checks at "done", and honest outcomes

When the agent reports the goal complete, two checks run on your own Cursor model before it is accepted:

- **The reviewer**, Guardian's own: a separate headless agent (`cursor-agent`) in a throwaway copy of the project checks each requested outcome and identifies unfinished work, demonstrated defects and meaningful unrelated changes. It must give a clear verdict on every item.
- **The evaluator**, from Google's Agent Development Kit (Apache-2.0, bundled unmodified): it judges Guardian's record of the run, with the real diff and each cited proof added as evidence, against each "done when" item and for unrequested work. It doesn't see the project itself, so disagreements in either direction get a fresh project check before an objection counts.

A goal now ends as one of: **proved** (both checks established every requested item and neither objected), **unchecked** (a check didn't run or didn't answer for an item), **disputed** (an objection wasn't resolved; the same work isn't reviewed twice), **unverified** (part of Guardian couldn't run), **blocked**, **set aside**, **stalled**, out of rounds, or **over budget**. Optional proof hints do not replace checking the actual work, and a goal file rewritten without you is put back. A review costs one reviewer call, about five evaluator calls, and one more reviewer call when the reviewer and evaluator disagree. Guardian also records what each edit changed (`telemetry/edits.jsonl`, kept out of git).

### The reviewer is retuned from your verdicts

Each review that runs saves a copy of what it looked at under `.cursor/goal-guardian/cases/` (kept out of git; the newest 200, none over 2 MB). Each objection on the panel has **Right call** and **Reviewer was wrong**, and a goal the review passed has **This wasn't done**. Guardian also counts an objection the agent then fixed as right.

Once at least 8 reviews have a verdict, with both kinds, and again for every 4 new ones, Guardian runs Google Research's RRSI (Apache-2.0, bundled unmodified with a Python of its own) by itself on your labelled cases: a third are held out, RRSI searches on the rest with your own Cursor model, and its winner is replayed on the held-out third. A winner that gets more right there without missing a gap the current reviewer caught is applied, and the panel shows it with **Undo**. It changes the reviewer's prompt only. It has not yet run on anyone's real verdicts.

### Removed
- The session AI review from 1.0 (a different feature from the reviewer above). Scored on real agent runs for
  the first time, it found no real drift. Older workspaces keep working; its old settings are ignored.

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

### Fixed
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
