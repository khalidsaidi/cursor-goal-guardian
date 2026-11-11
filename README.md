# Cursor Goal Guardian

**Records your request as the goal, reminds the agent of it, sends the agent back when it
stops early, and has "done" checked before it's accepted.** It advises and never blocks:
the agent can always stop, and Guardian records how the goal stood when it did.

Open VSX listing: [khalidsaidi/cursor-goal-guardian-extension](https://open-vsx.org/extension/khalidsaidi/cursor-goal-guardian-extension).
This README describes unreleased code (the changelog's "Unreleased" section); the last
released version in this repository is 1.0.0. The current code has been built and run on
Linux x64 only.

## The problem

An agent's commitment to a goal lives in its context window, and context decays. Work
stops short, scope creeps, "done" is said before it's true, and after an interruption
nobody can cheaply reconstruct what the session was for.

## What it does

1. **Keeps the goal.** Your message is saved in your own words in Guardian's own goal
   file: the text before a list is the goal, the list is the "done when" items, and
   anything after the list is left out. It goes back to the agent with every message. The
   goal's words and items live in that file, and only your words change them, with one
   exception: when your goal has no "done when" items at all, the agent may write them.
2. **Sends the agent back.** When the agent stops with work changed and the goal not
   accepted, Cursor's stop hook returns a message that puts it back to work.
3. **Checks "done".** The agent's proof is compared with Guardian's own record of what ran
   and changed. Then a second Cursor agent reviews the real project and Google ADK's
   evaluator judges the recorded run. Their objections go back to the agent.
4. **Retunes the reviewer.** Your verdicts on its objections are used to adjust the
   reviewer's prompt.

Guardian's own checks come first, both for sending the agent back and for accepting
"done". Codex's and DeepSeek Harness's code is then asked: each is consulted on every round,
and each can refuse a change. The goal's phase (active, paused, complete) is read from
DeepSeek Harness's own record; the goal's words and "done when" items are in Guardian's file.

## Other people's code, used as they wrote it

| Code | What it does here | What is adapted |
|---|---|---|
| [OpenAI Codex](https://github.com/openai/codex)'s goal package (Apache-2.0), at `ac54a05`, through `packages/codex-goals` | Holds a copy of the goal, can refuse a change, is asked whether to continue each round, and supplies the continuation instructions, usage accounting and an optional token budget | Its continuation turn is produced in a thread started with Codex's own test support, with a local capture server in place of a model, and read back |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)'s four goal packages (MIT), published npm build 0.2.2-rc.1 | Holds a copy of the goal's phase, revision and rounds, can refuse a change, its round driver is asked about each round, and it supplies the round prompt and closing instructions | One line inlined at build time; a `Promise.withResolvers` polyfill; a stand-in agent; Guardian re-arms its goal once per stop and writes its round-limit block itself |
| [Google ADK](https://github.com/google/adk-python)'s rubric evaluator (Apache-2.0), at `c0bcdaa` | Judges Guardian's record of the run, plus evidence Guardian adds from the project, against your "done when" items and one rubric of Guardian's about unrequested work | The judge is your Cursor model, with one line of Guardian's telling it not to delegate |
| [RRSI](https://github.com/google-research/rrsi) by Google Research (Apache-2.0), at `be50316` | Searches for a better reviewer prompt from this workspace's labelled reviews | Its model calls go to your Cursor model |

Their text is about three quarters of what the agent is sent on a send-back. Neither
Codex's nor DeepSeek Harness's code judges whether a goal is done: in both, "complete" is
a plain status change. `third_party/` holds each source with its licence, and `NOTICE` says
what runs and what is adapted.

## How a goal ends

| Shown as | Meaning |
|---|---|
| proved | The proof holds against the record, the reviewer and the evaluator both answered for every item and neither objects, and Codex's and DeepSeek Harness's code both accepted |
| unchecked | Accepted, but the reviewer or the evaluator didn't run or didn't answer for an item |
| disputed | A review objected and it wasn't resolved. The same state is never reviewed twice |
| unverified | Codex's or DeepSeek Harness's code didn't run, or their copies of the goal disagree |
| blocked | The agent reported an obstacle. On the first turn this is at the agent's word and shown as "blocked (unverified)" |
| stalled, limit, stopped | Three rounds with nothing changed; Cursor's 20 follow-ups per message or DeepSeek Harness's 256 rounds per goal; a cancelled or failed turn |
| set aside | Your latest message asked for only part of the goal or for something else |
| over budget | A token budget you asked for is used up |

## What's been measured

Everything below is from a private rig that runs Cursor's own agent loop with Claude Haiku
standing in for the model. No real Cursor model has been measured, and only Linux. One run
per cell, one judge per result. Plans and raw data are outside this repository.

**The goal loop, with Guardian vs without.** Measured before Codex's and DeepSeek
Harness's code and ADK were wired in (the interrupted scenario at `a6b88c3` plus one rule
line, the other three at `1760c73`); it has not been repeated on the current build. 12 small
library tasks per scenario, blind judges.

| Scenario | "Done when" items finished, of 48 | Runs fully finished, of 12 | Agent turns, 12 runs |
|---|---|---|---|
| Goal interrupted, then "carry on" in a new chat | 48 vs 38 | 12 vs 8 | 24 vs 24 |
| After a compaction stand-in, "OK, back to it" | 47 vs 15 | 11 vs 1 | 27 vs 24 |
| Normal use, one message | 44 vs 44 | 11 vs 11 | 15 vs 12 |
| A separate request while a goal is open | old-goal items worked on anyway: 0 vs 3 | side request done 12 vs 12 | 29 vs 24 |

Only the compaction difference is statistically clear on its own (11 better, 0 worse,
1 tied; p = 0.001). The interrupted one is 4 better, 0 worse, 8 tied (p = 0.125). In normal
use Guardian finished nothing more and cost about a quarter more turns.

**The current build, live.** Eight runs at `9fcafb5`, read from Guardian's own records
and not judged: 6 ended proved in one to three turns; one was the separate-request scenario,
which isn't meant to; one ended blocked because that project's tests couldn't run on the
rig. This is a smoke check, not the judged test above.

**The review at "done"**, on constructed runs where an agent was told to leave a known gap
or none, plus 12 natural runs the judges found fully done. The reviewer was scored live at
`3dd9983`; the evaluator by replaying the same runs as first reviewed.

| Runs | Reviewer objected | ADK's evaluator objected | After the reviewer checks the evaluator's lone objections |
|---|---|---|---|
| A placeholder test where real tests were asked for (12) | 12 | 12 | 12 |
| The goal plus unrequested renames, validation and doc rewrites (9) | 9 | 9 | 9 |
| Good work: 12 constructed, 12 natural | 0 of 12 constructed | 4 of 24 | 1 of 24, and that one was a real defect the judges had passed |

On 33 natural runs the judges found fully done, the reviewer objected to 2. A review took a
median of 18 s for the reviewer and 24 s and 5 model calls for the evaluator; the extra
check of the evaluator's objections ran on 5 of the 45 replayed runs and took 7 to 14 s.

**The reviewer's prompt.** The shipped prompt came from an RRSI run on the rig. On that
run's held-out cases it flagged good work 0 of 11 times, down from 8, but caught 1 of 2 real
failures, down from 2. Replayed on the 33 constructed runs above, it got 33 right against
28 for the prompt before it, with no catch lost.

**What this doesn't show.**
- No natural run reached the review with a real gap, so every catch is on a constructed case.
- The agents were Claude models, which rarely wander by themselves, so the effect on
  unrequested work in ordinary use is unmeasured.
- The self-improvement has never run on a user's real feedback.

## What it doesn't do

- **It never blocks.** The agent can stop at any time.
- **It doesn't defend its own files.** An agent that tampers with Guardian's log or
  reviewer prompt under `.cursor/goal-guardian` can reach "proved". A rewritten goal file
  is put back.
- **It does nothing when a turn changes nothing**, and it doesn't see changes made only by
  commands in gitignored paths.
- **Outside a git repository** the reviewer doesn't run, so nothing ends proved, and a
  cited command that names a file which doesn't exist isn't noticed. (A proof that cites a
  missing file directly is still refused.)

## What it costs

- **Size:** a 171 MB download that unpacks to 440 MB on Linux: Codex's goal code 198 MB,
  the hook program 81 MB, the tools program 81 MB, a bundled Python 43 MB, ADK's evaluator
  and its packages 20 MB, RRSI 1 MB.
- **Time:** measured on the built programs, median of 15: 64 ms on a plain command, 120 ms
  on your first message, 370 ms on the first edit (when the goal is recorded), 163 ms on a
  later message with a goal open, and 554 ms when the agent stops and is sent back.
- **Model calls:** a review is one reviewer call, about five evaluator calls, and one more
  reviewer call when the evaluator alone objects, all on your Cursor plan. Each send-back is
  an agent turn.

## Repo layout (pnpm monorepo)

```
packages/
  core/         @goal-guardian/core: goal file and record, goal loop, proof check, reviewer,
                adapters for the code below
  mcp/          MCP server: get_goal, create_goal, update_goal, goal_command,
                guardian_change_goal
  hook/         Cursor hook
  cursor-goal-guardian-extension/
                the Cursor extension (panel, setup)
  codex-goals/  Guardian's Rust program around Codex's goal package
  evaluator/    Guardian's adapter for Google ADK's evaluator (Python)
  rsi/          Guardian's domain for RRSI (Python)
  testkit/      shared test scaffolding
  e2e/          end-to-end suite, offline and with real headless Cursor agents
third_party/
  codex/             OpenAI Codex's goal extension source, unmodified
  deepseek-harness/  DeepSeek Harness's goal packages source, unmodified
  adk-python/        Google ADK, the evaluator's files, unmodified
  rrsi/              Google Research's RRSI, unmodified
```

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test          # unit and contract tests
pnpm test:e2e:offline # deterministic e2e scenarios against built binaries
pnpm test:e2e         # full suite: real cursor-agent runs (billed)
```

Building Codex's program needs `cargo`; without it the package is built without it and
goals end as unverified. After updating `third_party/codex` or `third_party/deepseek-harness`:

```bash
node scripts/gen-vendored.mjs
```

`pnpm package:vsix` builds the VSIX for this machine's platform.

## History

v0.4.x (permit-era) is preserved at tag `v0.4.11-final`. Migration from 0.4.x workspaces
is automatic, with backups.
