# Cursor Goal Guardian

**A drift flight-recorder for AI coding sessions in Cursor.** It records what
the agent did, scores it against your declared goal, and shows you the tape.
Advisory forever: it never blocks, and it never nags.

Published on Open VSX: [khalidsaidi/cursor-goal-guardian-extension](https://open-vsx.org/extension/khalidsaidi/cursor-goal-guardian-extension)

## The problem

An agent's commitment to a goal lives in its context window, and context
decays. The agent's *effective* goal silently mutates: scope creeps, tasks
switch without justification, and after an interruption nobody can cheaply
reconstruct what the session was for.

## The mechanism

Move the goal and the work-state out of the model's memory and onto disk, then
close the loop at every point where drift happens:

| Loop point | Mechanism |
|---|---|
| Session start | A Cursor rule anchors every session: load the contract, record progress via MCP tools |
| During work | Hooks (~60 ms) observe every shell/MCP/edit action; a lexical scorer flags off-vocabulary work |
| At the moment of drift | One calm sentence per episode re-anchors the agent — context injection, not ceremony |
| After the fact | An AI judge (consent-gated, your Cursor account) confirms/dismisses flagged drift AND periodically reviews the raw tape against the goal — catching in-vocabulary drift |
| Persistent, confirmed drift | Opt-in: `permission: "ask"` hands the call to the human via Cursor's own UI |
| Any time | The panel shows the tape: drift ↔ realignment pairs, session health, task board, AI verdict |

The task board is a Redux-style store: append-only action log, one pure
reducer, deterministic replay (`state === replay(actions)`, exactly — v2 moved
all id/timestamp generation into the actions to make that guarantee real),
hash-guarded state, decision-gated task switches.

## Repo layout (pnpm monorepo, all packages 1.0.0)

```
packages/
  core/         @goal-guardian/core   — all logic: schemas, state machine, policy,
                                        drift scoring, episodes, judge, telemetry, migration
  mcp/          MCP server (5 guardian_* tools), thin adapter over core
  hook/         Cursor hook, single ~200KB CJS bundle, p95 < 150ms budget
  extension/    the published Cursor extension (panel, setup, rescorer host)
  testkit/      shared test scaffolding
  e2e/          12-scenario end-to-end suite driving real headless Cursor agents
```

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test          # ~200 unit + contract tests (free, runs in CI)
pnpm test:e2e:offline # deterministic e2e scenarios against built binaries (free)
pnpm test:e2e         # full suite: real cursor-agent runs + a live AI judge (billed)
```

CI runs build, typecheck, unit/contract tests, the free e2e scenarios, and a
version-sync check. The billable suite runs manually before releases.

Release: `pnpm package:vsix` builds the VSIX; `OVSX_TOKEN=... pnpm publish:ovsx`
publishes to Open VSX (Cursor's registry — no other marketplace).

## History

v0.4.x (permit-era) is preserved at tag `v0.4.11-final`; the old A/B evaluation
harness lives on branch `legacy/ab-study`, to be rebuilt on v2 telemetry.
Migration from 0.4.x workspaces is automatic, with backups.
