# v1 (v0.4.11) workspace fixtures — migration goldens

These trees are **real output of the v0.4.11 binaries**, harvested by `harvest.mjs` while the
legacy packages still existed (tag `v0.4.11-final`). They are the input side of the
v1→v2 migration golden tests and the e2e migration scenario. Do not regenerate them after
the legacy packages are deleted; do not hand-edit them.

| Case | What it represents |
|---|---|
| `case-empty`   | Fresh install: default contract + `ensureStateStoreFiles` output only |
| `case-basic`   | Realistic mid-session workspace: contract via MCP, seeded state store with `SCn:`-titled tasks, active task, decision/pin/question, example policy, permit-era `.ai/` state (checks/permits/violations), real hook audit.log with drift + high-risk records |
| `case-custom`  | Non-default `rules.json`/`policy.json` (legacy severities, permit flags, warningConfig), user-customized `reducer.js` |
| `case-corrupt` | Truncated `state.json`, garbage lines in `actions.jsonl`/`audit.log` — migration must survive and fall back safely |

Note: `harvest.mjs` drives the legacy `dist/` builds and only runs against the
`v0.4.11-final` tag; it is kept for provenance, not for re-running.

Timestamps, generated ids (`act_*`, `step_*`, `permit_*`), and hashes are
run-specific — migration tests must compare structurally, not byte-for-byte, on those fields.
