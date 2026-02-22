# Changelog

## 0.4.10
- Improve Goal Panel UX for first-time users:
  - add "How To Read This Panel" onboarding section
  - add "Session Pulse" summary and "Next Best Action"
  - keep Action Timeline visually central with clearer legend
- Add reproducible 20-task panel replay recorder (`scripts/record-panel-demo-20tasks.mjs`).
- Add user-facing validation documentation and animated panel demo references.

## 0.3.5
- Stop wiring Cursor hooks/MCP from the extension; extension is now state-driven anti-drift only.
- On activation/install, remove legacy Goal Guardian hook entries from `.cursor/hooks.json` and legacy `goal-guardian` from `.cursor/mcp.json` (with backups).
- Remove permit-oriented commands/UI actions from the extension surface.

## 0.3.4
- Fix MCP-preview hook path so permit-required and warning-limit cases stay warning-first instead of hard blocking.
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
- **"Guardrail Not Gate" redesign**: Graduated severity system replaces binary allow/deny
- **New severity levels**: HARD_BLOCK, WARN, PERMIT_REQUIRED, ALLOWED
- **Warning accumulation**: Risky commands warn first, block after 3 warnings (configurable)
- **Soft permits**: Permit-required actions warn and continue instead of hard-blocking
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
