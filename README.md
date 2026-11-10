# Cursor Goal Guardian

**A drift flight-recorder for AI coding sessions in Cursor.** It records what
the agent did, holds it to your declared goal, and shows you the tape.
Advisory forever: it never blocks, and it never nags.

Published on Open VSX: [khalidsaidi/cursor-goal-guardian-extension](https://open-vsx.org/extension/khalidsaidi/cursor-goal-guardian-extension)

## The problem

An agent's commitment to a goal lives in its context window, and context
decays. The agent's *effective* goal silently mutates: scope creeps, work
stops short, and after an interruption nobody can cheaply
reconstruct what the session was for.

## The mechanism

Move the goal and the work-state out of the model's memory and onto disk, then
close the loop at every point where drift happens:

| Loop point | Mechanism |
|---|---|
| Session start | A Cursor rule anchors every session: load the contract, report on the goal via MCP tools |
| During work | Hooks (~60 ms) record every shell/MCP/edit action and say nothing |
| Each message | The goal goes back to the agent with every message you send |
| When the agent stops | The goal loop sends it back until each "done when" item is proved against Guardian's own record |
| Any time | The panel shows where the goal stands, its "done when" list and the goal receipts |

The goal lives in one file, `contract.json`. Drift happens because the plan
normally lives in the agent's context, and context leaks. Writing it down gives
the goal loop a fixed point to hold the agent to, and makes resuming after an
interruption a read instead of a guess. Only the user changes an existing goal.

## Repo layout (pnpm monorepo, all packages 1.0.0)

```
packages/
  core/         @goal-guardian/core   — all logic: schemas, goal record,
                                        goal loop, migration
  mcp/          MCP server (guardian_* tools), thin adapter over core
  hook/         Cursor hook, single ~200KB CJS bundle, p95 < 150ms budget
  extension/    the published Cursor extension (panel, setup)
  testkit/      shared test scaffolding
  e2e/          12-scenario end-to-end suite driving real headless Cursor agents
```

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test          # ~200 unit + contract tests (free, runs in CI)
pnpm test:e2e:offline # deterministic e2e scenarios against built binaries (free)
pnpm test:e2e         # full suite: real cursor-agent runs (billed)
```

CI runs build, typecheck, unit/contract tests, the free e2e scenarios, and a
version-sync check. The billable suite runs manually before releases.

Release: `pnpm package:vsix` builds the VSIX; `OVSX_TOKEN=... pnpm publish:ovsx`
publishes to Open VSX (Cursor's registry — no other marketplace).

## History

v0.4.x (permit-era) is preserved at tag `v0.4.11-final`; the old A/B evaluation
harness lives on branch `legacy/ab-study`, to be rebuilt on v2 telemetry.
Migration from 0.4.x workspaces is automatic, with backups.

## Third-party software

`third_party/rrsi` is Google Research's [RRSI](https://github.com/google-research/rrsi) (Apache-2.0), vendored
unmodified; Guardian's domain for it is `packages/rsi`. See `NOTICE`.

