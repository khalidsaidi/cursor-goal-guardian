# The goal: design

One goal per workspace, owned by the user. It lives in the contract; its hash is its identity, so changing it starts everything over.

## Phases

| Phase | Entered by | Left by |
|---|---|---|
| active | a goal being set, or the user resuming | see below |
| paused | the user, or the agent quoting the user's words | the user only, from the panel |
| complete | Guardian's record proving it, or the user marking it done | the user changing the goal |

A run is the agent's work on the goal in one chat. It ends proved, blocked, set aside, stalled, out of rounds, or stopped.

## The loop

Only Cursor's `stop` hook can send an agent back, and only as a visible message. At each stop, in order:

1. A cancelled or failed turn closes the run and is never restarted.
2. Not active: silence.
3. Nothing changed since the user's latest message and no report: silence. Asking or answering isn't goal work.
4. A report on a different goal doesn't count. Otherwise judge the latest report.
5. Three rounds with no edit, the same files and the same open items: stalled.
6. 20 rounds for one user message: out of rounds.
7. Otherwise send the agent back with the goal and the facts.

The agent's report is judged again at each stop because the project may have moved since.

## Whose words the agent hears

The goal loop's instructions are the original projects' own, unmodified. Their sources are vendored in `third_party/` and `scripts/gen-vendored.mjs` copies the text, and transpiles the two TypeScript functions, into `packages/core/src/goal/vendored.generated.ts`; `originals.test.ts` fails if that file is stale or any text differs from its source.

| Part of a send-back | From |
|---|---|
| The user's latest message, and "decide from their words first" | Guardian |
| `<goal_round>`: objective, round n of 20, how to continue | DeepSeek Harness, `goal-round-driver/src/prompt.ts`, its own function |
| The "done when" list and what Guardian's record shows | Guardian |
| Continuation behaviour, work from evidence, no-progress check, fidelity, completion audit, blocked audit | OpenAI Codex, `ext/goal/templates/goals/continuation.md`, rendered as Codex does for an agent without `update_plan` |
| How to report proof, account for changed files, and `set_aside` | Guardian |

A changed goal is announced with Codex's `objective_updated.md`. An accepted `complete` or `blocked` answers with DeepSeek Harness's closing instruction (`tool-goal/src/wrapup.ts`); so does a run that ran out of rounds or stalled, with DeepSeek's `round-limit` blocker code or Guardian's `no-progress`. An early `blocked` is refused in DeepSeek's words, at DeepSeek's threshold of 3 rounds, which is also the number Codex's prompt names.

The MCP tools are Codex's: `get_goal` and `update_goal`, with Codex's names, descriptions and statuses (`complete`, `blocked`, `paused`). Guardian adds what it needs to check a claim (`proofs`, `changes`, `removed`, `reason`, `user_words`) and the status `set_aside`. `guardian_change_goal` is Guardian's own: neither original lets the user redirect an open goal from chat.

The goal's state is kept by DeepSeek Harness's real goal service, from its published packages at the vendored version, run with a stand-in agent as its own tests do (`packages/core/src/goal/engine.ts`). Every change of phase, objective, revision or round count is one of its `GoalService` calls, saved as `goal.engine` records and replayed in each new process; `goalPhaseOf` reads its `foldGoal`. A send-back is admitted as one of its goal rounds, against its cap of 256 per goal; Cursor's 20 per message still applies. Its "blocked" phase is resumed by the user's next agent-mode message, which is Guardian's policy; "paused" only from the panel, which is also its own rule.

Not run yet: DeepSeek Harness's round driver and tool plumbing, and Codex's Rust code. Codex's goal crate builds and passes its tests unmodified, and its goal store runs standalone; its continuation scheduling starts Codex's own turns, so in Cursor the stop hook plays that part. DeepSeek Harness's own tool file calls its tools "Codex-shaped": Codex is the upstream of both.

## Proof

No model and no assumption about language or tools. The agent names the proof; Guardian compares text against what it recorded itself:

- A command must be on the record, have started after the last edit, have printed the quoted line, and the project must not have changed since (`git status` and `git diff`).
- A file must be inside the project, exist, and hold the quoted line.

## Independent review

When the record backs every item, one review runs before "complete" is accepted (`packages/core/src/goal/review.ts`). `cursor-agent`, on the user's own login and default model, runs headless in a throwaway copy (a shared clone with the working tree laid over it, no `.cursor`, credentials stripped except Cursor's own). It is asked to prove each item isn't done and to list changes no item needs, and answers in JSON. Its objections go back through the same loop. There are at most 2 reviews per run; after that the record decides and a standing objection goes on `goal.end` for the user. No reviewer, an error, unreadable output or more than 90 s means skipped, recorded as `goal.review` with `ran: false`. For tests, `GOAL_GUARDIAN_REVIEWER` replaces the binary and `GOAL_GUARDIAN_REVIEW_PROMPT` the prompt.

## The evaluator

Alongside that review, Google's Agent Development Kit judges the run (`packages/core/src/goal/evaluator.ts`). The code is ADK's own `RubricBasedMultiTurnTrajectoryEvaluator`, vendored unmodified in `third_party/adk-python` (github.com/google/adk-python, Apache-2.0); Guardian's adapter is `packages/evaluator`, and it runs on the bundled Python.

- **What it reads.** The run as Guardian saw it (`trajectory.ts`): each command with its output and each edit with its text, from `telemetry/shell-output.jsonl` and `telemetry/edits.jsonl`, given to ADK as one invocation whose events are those tool calls and results, with the user's request as the user turn and the agent's own completion report as the final response.
- **What it judges.** ADK's rubrics are properties answered yes or no. Each of the user's "done when" items is one rubric, word for word; Guardian adds one of its own: "The agent changed nothing that the user's request does not need."
- **How.** ADK's judge prompt, five samples per judgement (its default) and its aggregation of them. The samples run side by side, which is ADK's own `parallelism_limit` option. The judge model is a `BaseLlm` registered with ADK's registry that asks the user's Cursor model through `cursor-agent`.
- **What comes back.** Each rubric judged not met goes to the agent as an objection in the judge's own words, through the same loop as the reviewer's.
- **Cost.** Five calls to the user's Cursor model per review, where the item review is one. Cursor ends a tool call that is silent for 120 s, and progress notices reset that clock, so `update_goal` sends them when the client asks for progress; the evaluator then gets 300 s, otherwise 100 s. Over budget, no model, or no verdict means skipped and recorded, never blocking.

ADK is built on pydantic and google-genai, so it needs real packages, not only the standard library: the 17 it loads are pinned in `packages/evaluator/requirements.txt` and installed as wheels beside the bundled Python when the extension is packaged (about 37 MB on linux-x64, the only platform wired so far). ADK's `MultiTurnTrajectoryQuality` and `MultiTurnTaskSuccess` evaluators hand the judging to Vertex AI and need a Google Cloud project, so they aren't used.

RRSI improves the item reviewer's prompt only. The evaluator's prompt is ADK's and is not tuned.

## Learning from this workspace

Every review that ran is saved as a case: goal, items, base commit, the work as a binary patch plus new files, the prompt and the verdict (`packages/core/src/goal/cases.ts`). Labels come from what people did (`improve.ts`, `reviewLabels`): the user's verdict on an objection wins; otherwise an objection the agent fixed before a passing review counts as right, and one the user overrode by marking the goal done counts as wrong. The agent arguing back is not a label.

`improveReviewer` runs Google Research's RRSI, vendored unmodified in `third_party/rrsi` (commit be50316, Apache-2.0, see `NOTICE`). Guardian assembles a throwaway RRSI checkout under `.cursor/goal-guardian/rsi/`: RRSI's files, Guardian's domain (`packages/rsi/cgg`), the labelled cases split by a stable hash (a third held out), and the current reviewer prompt as the harness. The domain replays one review with a candidate prompt through `goal-guardian-hook replay-review`, and sends RRSI's analyst, digester, proposer and critic calls to `cursor-agent` by replacing `rrsi.llm.generate` at import. Guardian scores the current reviewer on the held-out cases, runs `rrsi.py run` (baseline, calibration, T rounds of m candidates with RRSI's own edit budget, history, leakage critic and selection), and scores RRSI's winner on the same held-out cases. A winner that gets more right without missing a gap the current one caught waits for the user to apply it. Defaults are small (`packages/rsi/cgg/rrsi.json`: T=2, m=2, k=1) because every evaluation and search call spends the user's plan; the panel shows the estimate before it starts. The VSIX bundles python-build-standalone 3.12.16 (release 20261026, checksum-pinned per platform, GUI toolkits, pip and the test suite pruned).

Tested end to end with a stand-in agent (`packages/core/test/improve.test.ts`, `packages/rsi/tests`). It hasn't run on real labelled cases or a real Cursor model yet.

## Decisions

- **Edits from another chat or Tab make proof stale.** The code really did change, and the rerun is cheap. Parallel chats can use up rounds this way; the cap ends it.
- **Internal Cursor commands are used only for the panel buttons.** If one disappears, the goal state is still right.
- **Hook output is plain ASCII, and outcomes are in JSON, never exit codes.** A non-zero exit makes Cursor ignore stdout.
- **User pause survives any later message.** Otherwise any "ok" would let the agent lift it. An abort only ends the run: the next message starts a new one.
- **Blocked needs 3 turns**, counted by machine. Whether it's the same obstacle stays the agent's call.
- **Stating user words is checked against what the user actually sent**, for changing the goal, pausing and setting aside. A quote too short to be a request must match the whole message.
- **The goal is workspace-level, runs are per chat.** A proved goal is proved everywhere; a set-aside is one message.

## What Cursor does

From reading Cursor 3.17.19's code, in a local copy, and its hook docs. Some commands and fields below are internal, so an update can change them; each has a fallback. Recheck this table against a new copy when Cursor updates.

**Hooks**

| Topic | Behaviour | What Guardian does |
|---|---|---|
| Send-back | `stop` returns `followup_message`, submitted as a normal visible message | The loop |
| `loop_limit` | At the limit the hook isn't run. The counter resets on any non-follow-up message | Limit 21: 20 rounds and a closing message |
| User's queued message | Runs first. The stop for that turn may be `aborted` or missing. A follow-up goes to the queue's end while generating | A missing stop is normal: the next stop picks up the run |
| Failed command | `afterShellExecution` always fires, with no exit code. Failure shows as `postToolUseFailure`, or `postToolUse` with `exitCode` in a JSON string, depending on the executor | Reads both, for tool `Shell` |
| Background command | No `afterShellExecution` | Never counts as proof |
| Context | `beforeSubmitPrompt` carries `additional_context` on each message. `postToolUse` does too (dropped over 10,000 chars). No chat display | Goal on each user message, pause and goal change mid-turn |
| `sessionStart` | New chats only, not awaited, so it races the first message | Not used |
| Tokens | `stop` carries input, output and cache counts | Panel shows them |
| Modes | Not on `stop`. `composer_mode` is on `beforeSubmitPrompt`. Cmd+K sends none, and its `conversation_id` is a prompt bar id | Skips Cmd+K, chat, plan and project modes |
| Subagents | Their edits report the child's id and they fire no `stop` | Git state still counts their files; without git they go unseen |
| Bad `hooks.json` | One unknown event name rejects the whole file | Every event wired exists in 3.17.19. An older Cursor would reject the whole file, so wiring needs a version floor before release |
| Untrusted workspace | Project hooks silently don't load | Panel says so |
| Other stop hooks | Run in parallel; the last follow-up wins, and user-level beats project-level | A user's own stop hook can replace our send-back |

**Windows**

- Hooks run through PowerShell with the payload piped from a temp file, and the pipe's output starts with a byte-order mark. The hook strips it.
- `workspace_roots` arrives as `/c:/Users/...`. The hook converts it.
- Windows PowerShell 5.1 garbles non-ASCII text in the payload. The hook prints plain ASCII, and quotes of the user's words compare ASCII only. Non-ASCII file paths can still be garbled there.
- Tested with the real `.exe` through Cursor's exact wrapper, not yet in the app.

**Command-line agent**

Interactive runs fire `stop` and honour the follow-up. Headless runs fire tool hooks but no `stop`, so there's no loop.

**Commands the panel uses**

| Button | Command | Fallback |
|---|---|---|
| Pause goal | `composer.cancelChat(conversationId)` | Pause takes effect at the next stop |
| Resume, Work on the goal | `composer.createNew` with `autoSubmit:true`, sent at once in a new chat | `workbench.action.chat.open`, filled in for the user to send |

An existing idle chat can only be woken by `vscode.cursor.enqueueBackgroundTaskCompletion`, but that turn fires no `stop`, so the loop couldn't continue. Not used.

## What the checks can't see

- Whether a command really tests what the agent says (a script that just prints "passed" gets through).
- Whether a file tied to a done-when item was truly needed.
- Changes made by commands, outside a git repository.

The panel shows the receipts so the user can judge these.

## Verified in real Cursor

Cursor 3.17.19, driven in debug mode on 2026-11-04, with the packaged VSIX on native Windows and the built hook on WSL. Every model was over its usage limit, so each turn ended in an error:

| Check | Result |
|---|---|
| Connect through the panel, wiring the hooks and `loop_limit: 21` | Works (Windows) |
| `beforeSubmitPrompt` and `stop` fire, `additional_context` accepted, the user's message and mode recorded | Works (Windows, WSL) |
| `stop` status | `error` on a failed turn, `aborted` after Pause |
| Work on the goal: `composer.createNew` sends with no Enter | Works (Windows) |
| Pause goal: `composer.cancelChat` stops a running turn | Works (Windows) |
| Resume goal, Mark goal done, panel state after each | Works (Windows) |
| A follow-up is sent as a visible message, `loop_count` goes 0, 1, 2, and the hook is skipped at the limit (test stop hook, limit 3) | Works (Windows) |
| Guardian's own messages stay out of the user's words | Works (Windows) |

## Not yet verified

These need a model that answers, so usage after 11/12:

- A `completed` stop giving a real send-back from Guardian's own hook, and the agent answering it.
- The agent calling `update_goal`, including which MCP server it reaches on native Windows.
- Whether Cursor passes a progress token on tool calls, which decides the evaluator's budget.
- Edits and failed commands from a real agent turn firing their hooks.
- How the model sees `additional_context`.
