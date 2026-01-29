# Changelog

## 0.2.0
- **"Guardrail Not Gate" redesign**: Graduated severity system replaces binary allow/deny
- **New severity levels**: HARD_BLOCK, WARN, PERMIT_REQUIRED, ALLOWED
- **Warning accumulation**: Risky commands warn first, block after 3 warnings (configurable)
- **Soft permits**: Permit-required actions warn and continue instead of hard-blocking
- **Auto‑Permit Last Action**: One‑click permit issuance from the Goal Panel
- **Goal Panel**: New sidebar panel showing goal, criteria, permits, and warnings
- **Status Bar**: Shows goal state, permit count, and warning count
- **Audit Output Channel**: View audit.log entries in VS Code
- **New MCP tools**: `guardian_preview_action` (dry-run) and `guardian_get_status`
- **Lower permit threshold**: 0.5 instead of 0.6 for clearly on-goal actions
- **New commands**: Show Panel, Show Audit, Request Permit, Refresh
- **Auto-refresh**: UI updates when contract files change

## 0.1.0
- Initial release.
