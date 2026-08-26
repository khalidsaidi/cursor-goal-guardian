# Changelog

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
