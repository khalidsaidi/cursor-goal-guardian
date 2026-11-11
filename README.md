# Cursor Goal Guardian

**Keeps an AI coding agent in Cursor on your goal.** It doesn't lose the goal, it gets
sent back when it stops early, and "done" is checked before it's accepted. Advisory
forever: it never blocks a tool.

Published on Open VSX: [khalidsaidi/cursor-goal-guardian-extension](https://open-vsx.org/extension/khalidsaidi/cursor-goal-guardian-extension)

## The problem

An agent's commitment to a goal lives in its context window, and context decays. Work
stops short, scope creeps, "done" is said before it's true, and after an interruption
nobody can cheaply reconstruct what the session was for.

## Three techniques, each used as its authors wrote it

| | What it does | Where it comes from | How it's used |
|---|---|---|---|
| **Goal loop** | Your message is saved word for word as the goal and goes back with every message. When the agent stops, it is sent back until its report holds against Guardian's own record of commands and files. | The goal features of [OpenAI Codex](https://github.com/openai/codex) (Apache-2.0) and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT) | Their prompts and tool definitions go to the agent word for word. Their runtimes can't run inside Cursor, so Cursor's hooks play that part. |
| **Review at "done"** | Before "complete" is accepted, a reviewer tries to prove each item isn't done in a throwaway copy of the project, and a monitor reads the run step by step and scores how far it strayed. | The monitor is the code of "Reliable Weak-to-Strong Monitoring of LLM Agents", [MRT](https://github.com/scaleapi/mrt) by Scale AI (MIT). The item reviewer is Guardian's own. | MRT's Python files run unmodified, with MRT's prompts, on a bundled Python. |
| **Self-improvement** | The reviewer's prompt is improved from this workspace's own labelled reviews, tested on cases it didn't learn from, and applied only when you say so. | [RRSI](https://github.com/google-research/rrsi) by Google Research (Apache-2.0) | RRSI's Python files run unmodified on the same bundled Python. |

What Guardian itself adds: recording your words as the goal, the record of what really
ran and changed, the proof check against it, putting your latest message first in every
send-back, `set_aside` for a message that asks for something else, and the glue that
points the borrowed parts at your own Cursor model.

`third_party/` holds each original as it is, with its licence; `NOTICE` says what is
used, what is left out, and what isn't run. Tests fail if any borrowed text differs from
its source (`packages/core/test/originals.test.ts`).

## What's been measured

On a private rig that runs Cursor's own agent loop with Claude Haiku standing in for the
model. No real Cursor model has been measured yet. 12 small library tasks per scenario, one
run each, scored by blind judges; the code is this repository at `1760c73`.

**The goal loop**, with Guardian vs without:

| Scenario | "Done when" items finished, of 48 | Runs fully finished, of 12 | Agent turns, 12 runs |
|---|---|---|---|
| Goal interrupted, then "carry on" in a new chat | 48 vs 38 | 12 vs 8 | 24 vs 24 |
| After a compaction stand-in, "OK, back to it" | 47 vs 15 | 11 vs 1 | 27 vs 24 |
| Normal use, one message | 44 vs 44 | 11 vs 11 | 15 vs 12 |
| A separate request while a goal is open | old goal left alone in both | side request done 12 vs 12 | 29 vs 24 |

The compaction difference is the only one that is statistically clear on its own (11 better,
0 worse, 1 tied; p = 0.001). The interrupted one is 4 better, 0 worse, 8 tied (p = 0.125).
In normal use Guardian finished nothing more and cost about a quarter more turns.

**The review at "done"**, on 36 constructed runs where an agent was told to leave a known
gap, with Claude Haiku as reviewer and monitor:

| Constructed run | Item reviewer objected | Monitor objected | Either |
|---|---|---|---|
| A placeholder test where real tests were asked for (12) | 12 | 4 | 12 |
| The goal plus unrequested renames, validation and doc rewrites (9) | 9 | 8 | 9 |
| The goal and nothing else (12) | 0 | 0 | 0 |

On the 33 natural runs above that the judges found fully done, the reviewer objected to 2
and the monitor to none. A review took a median of 18 s for the reviewer and 40 s and 9
model calls for the monitor.

**What this doesn't show.** No natural run reached the review with a real gap, so the
catches are on constructed cases only. The agents were Claude models, which rarely wander
by themselves, so Guardian's effect on unrequested work in ordinary use is unmeasured. An
agent that refuses to fix an objection still ends with the record's proof accepted: the
panel shows it as "disputed", and nothing is blocked. Guardian only acts once the agent has
changed something: a turn that stops before any change is not sent back. The in-product
self-improvement has run only against a stand-in agent. One run per cell, one judge per
result. Plans and raw data are outside this repository.

## Where it acts

| Moment | Mechanism |
|---|---|
| First change after a request | The hook saves your message as the goal; a list in it becomes the "done when" items |
| Each message | The goal goes back to the agent with it, so a new or compacted chat still has it |
| During work | Hooks (~60 ms) record every command with its output and every edit, and say nothing |
| When the agent stops | The goal loop sends it back, up to 20 rounds, until each item is proved against the record |
| When the record agrees | The reviewer and the monitor check independently; objections go back as a round, at most twice |
| Any time | The panel shows where the goal stands, its items, the receipts and any objection |

The goal lives in one file, `.cursor/goal-guardian/contract.json`. Only the user changes it.

## Repo layout (pnpm monorepo)

```
packages/
  core/         @goal-guardian/core: goal record, goal loop, proof check, reviewer,
                monitor runner, self-improvement launcher
  mcp/          MCP server: get_goal, update_goal, guardian_change_goal
  hook/         Cursor hook, one bundle, p95 < 150 ms
  extension/    the published Cursor extension (panel, setup)
  monitor/      Guardian's adapter for MRT's monitor (Python)
  rsi/          Guardian's domain for RRSI (Python)
  testkit/      shared test scaffolding
  e2e/          end-to-end suite, offline and with real headless Cursor agents
third_party/
  codex/             OpenAI Codex's goal extension, unmodified
  deepseek-harness/  DeepSeek Harness's goal packages, unmodified
  mrt/               the monitoring paper's code, unmodified
  rrsi/              Google Research's RRSI, unmodified
scripts/
  gen-vendored.mjs   copies the originals' text and functions into core
```

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test          # unit and contract tests (free, runs in CI)
pnpm test:e2e:offline # deterministic e2e scenarios against built binaries (free)
pnpm test:e2e         # full suite: real cursor-agent runs (billed)
```

After updating anything in `third_party/codex` or `third_party/deepseek-harness`:

```bash
node scripts/gen-vendored.mjs
```

Release: `pnpm package:vsix` builds the VSIX; `OVSX_TOKEN=... pnpm publish:ovsx`
publishes to Open VSX (Cursor's registry, no other marketplace).

## History

v0.4.x (permit-era) is preserved at tag `v0.4.11-final`. Migration from 0.4.x workspaces
is automatic, with backups.
