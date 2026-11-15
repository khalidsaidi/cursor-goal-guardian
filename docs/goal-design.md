# The goal: design

One goal per workspace, owned by the user. The goal's words and its "done when" items live in Guardian's own file, `.cursor/goal-guardian/contract.json`, and what happened lives in the audit log beside it. The goal's phase is read from DeepSeek Harness's fold over its events, which Guardian saves in that log (`goalPhaseOf` in `loop.ts`); when one of their tools or their `/goal` command changes the objective, the contract follows their log (`contractFollowsEngine`). The goal's hash is its identity, so changing it starts everything over. Linux x64 is the only platform the current build has been run on.

Guardian's own checks gate first, both for sending the agent back and for accepting "done". The upstream goal code remains unmodified. DeepSeek Harness owns goal-phase changes, authority checks and round admission. Codex owns usage accounting and budget limits and supplies goal-change context and continuation instructions. CGG notifies Codex's store after DeepSeek accepts a phase change; it does not ask Codex's create/update handlers for a second approval or roll back DeepSeek because of such a refusal. A missing accounting ledger or failed completion notification is still unverified. A stale ordinary Codex phase is brought into line with DeepSeek before turn accounting without creating a missing ledger or overriding a Codex budget/usage limit. Neither upstream engine judges finished work: CGG's reviewer and ADK do.

## Phases

| Phase | Entered by | Left by |
|---|---|---|
| active | a goal being set, or the user resuming | see below |
| paused | the user from the panel, the user's own `/goal pause` message, or the agent quoting a request to pause from the user's latest message | the user only: from the panel, or by sending `/goal resume` as their message |
| complete | a report accepted as below, or the user marking it done | the user changing the goal |

DeepSeek Harness's "blocked" phase is shown as an open goal; the user's next message in an agent mode resumes it, which is Guardian's rule.

## How a run ends

A run is the agent's work on the goal in one chat. `goal.end` in the audit log records one of:

| Outcome | When |
|---|---|
| proved | The reviewer and the evaluator both checked every requested item and neither objects, DeepSeek accepted completion and Codex's accounting copy was synchronized |
| unchecked | As proved, but the reviewer or the evaluator didn't run or didn't answer for an item (no `cursor-agent`, not a git repository, over time, unreadable answer), or the project changed after the last review and no review was left |
| disputed | A concrete review objection remains unresolved. Repeating a completion report alone does not clear it; applicable changed work or corrected review configuration requires a fresh check |
| unverified | Codex's binary or DeepSeek Harness's packages didn't run, Codex's accounting ledger is missing or cannot record completion, the goal log was busy, or Guardian's stop handler failed |
| blocked | The agent reported blocked and DeepSeek Harness's tool accepted it: from its third goal round, or at once in a turn the user's message opened, which is recorded as accepted at the agent's word and shown as "blocked (unverified)" |
| set_aside | The agent quoted, from the user's latest message, a request for only part of the goal or for something else. It covers that message only |
| stalled | Guardian's rule: three rounds in a row with no change, the same files and the same open items |
| limit | Cursor's 20 follow-ups for one message, or DeepSeek Harness's cap of 256 rounds for one goal |
| stopped | The turn was cancelled or failed, or DeepSeek Harness's round driver declined to start a round |
| budget_limited | A token budget was set at the user's request and Codex's store says it is used up |

Nothing here blocks the agent. Every outcome but proved still lets it stop; the outcome is what the panel and the record show.

## The loop

Only Cursor's `stop` hook can send an agent back, and only as a visible message. At each stop:

1. A cancelled or failed turn closes the run and is never restarted.
2. No active goal, a mode that isn't agent work, or nothing changed since the user's latest message with no report: silence.
3. If the goal file differs from the last goal the user authorised, it is put back and the agent is told (`guard.ts`).
4. An accepted `set_aside` or `blocked` ends the run.
5. Guardian's stall rule and Cursor's follow-up limit end it.
6. Otherwise DeepSeek Harness's round driver is asked to admit a round and Codex is asked for its continuation. If DeepSeek Harness's code can't run, or Codex's goal is in a state it won't continue from while DeepSeek Harness's is active, the run ends unverified. If Codex's binary didn't run at all, the agent is still sent back, with a note that the goal can't be recorded as proved until it does. If the driver declines, the run ends stopped or at its round limit.
7. The agent is sent back. Each `goal.round` records what Guardian's gates, DeepSeek Harness's driver and Codex's scheduling each decided.

For a new implementation or repair request, the agent is instructed to create the goal before inspection or edits. A task started this turn is eligible for continuation even without a first edit; questions alone do not start goals. Automatic capture remains a fallback when a turn has changed the project: an edit, or a command after which the tree, the commit, or (outside git) the folder listing differs from when the user's message arrived. Shell-only changes in gitignored paths aren't seen. A newly started task can be sent back before its first edit; a question that starts no task is not.

## What the agent is sent

| Part of a send-back | From |
|---|---|
| The user's latest message, and "decide from their words first" | Guardian |
| `<goal_round>`: objective, round n of 256, how to continue | DeepSeek Harness's round driver |
| The "done when" list and what Guardian's record shows | Guardian |
| Continuation behaviour, work from evidence, no-progress check, fidelity, completion audit, blocked audit, with usage and budget | Codex's own continuation, in the form it gives an agent without `update_plan` |
| How to request completion checks and use `set_aside` | Guardian |

Their text is about three quarters of a send-back. A changed goal is announced with Codex's objective-updated notice and its "User set the goal" fragment; an accepted `complete` or `blocked` answers with DeepSeek Harness's closing instruction. When Codex's binary isn't present, Codex's text comes from the copies `scripts/gen-vendored.mjs` reads out of `third_party/codex`, and the run can't end proved.

The MCP tools are `get_goal`, `create_goal` and `update_goal` (get_goal reads Codex's own handler; create/update phase changes go through DeepSeek's authority checks, then notify Codex's accounting store), `goal_command` (DeepSeek Harness's `/goal` command, run only when the user's latest message is that command) and Guardian's `guardian_change_goal` and `guardian_review_feedback`. The feedback tool accepts explicit latest-message judgments of identified findings; it shares the panel's records and can reopen work a clean review accepted. Finding indexes are in `get_goal.work.last_review.feedback_targets`. `update_goal` carries Codex's statuses, DeepSeek Harness's parameters, and optional compatibility evidence hints (`proofs`, `changes`, `removed`) and the control fields (`reason`, `user_words`) with its own status `set_aside`.

## How the originals run

**DeepSeek Harness** (`packages/core/src/goal/engine.ts`): its four goal packages from the published npm build 0.2.2-rc.1, bundled into the hook and MCP programs, with a stand-in agent as its own tests use. Guardian tells its session when the user speaks, with the user's real message, and when the agent stops. Its events are saved as `goal.engine` records and replayed in each new process. When the contract and its goal differ, Guardian edits its goal to match; if its log can't be replayed, Guardian resets it. Adapted: one line of `dsh-llm` inlined at build time (`scripts/dsh-bundle.mjs`); a `Promise.withResolvers` polyfill; the driver's prompt delivered by Cursor's stop hook; and, because its "armed" state lasts one process, Guardian re-arms the goal with its `resume` once per stop and records its round-limit block itself when `resume` refuses at the cap.

**Codex** (`packages/codex-goals`, `codexGoals.ts`): a small Rust program of Guardian's linking Codex's goal extension and store at `ac54a05`, fetched by git at build time. Guardian calls its get_goal handler and tool definitions, its turn accounting, its handling of a goal the user changes, and its continuation. DeepSeek owns phase transitions; Codex is notified through its accounting store instead of being asked for duplicate create/update approval. Adapted: the continuation is produced in a thread started with Codex's own test support, whose model endpoint is a local capture server, and read back. Its goal is not re-created behind the user's back: a missing ledger leaves completion unverified until a real user message restores it. Stale ordinary phases are synchronized from DeepSeek; Codex's usage and budget limits remain in force.

## Captured evidence

Completion uses CGG's recorded command results and actual project changes, not an agent-written proof gate. Proof references and file labels in `update_goal` remain optional compatibility hints. A missing or miscopied quote, a changed label, or a line-count drop does not by itself send the agent back. Recent captured results, including failures, and actual source excerpts are supplied to the checks. The checks still have to establish every requested item on the current project.

Cached project reviews use a bounded content fingerprint, including generated package entries. The evaluator cache also includes recorded results. Both checks include the latest human request in their cache keys, so an earlier temporary limit cannot govern a later completion review. Commit ids, file timestamps and report wording do not invalidate unchanged work. A changed reviewer template or correcting feedback invalidates the affected cached review. If the state cannot be read or bounded, checks are not reused. If the project changes during verification, the goal stays open for the current state to be checked.

## Independent review

When completion is requested, two checks run before "complete" is accepted, both on the user's own Cursor model through `cursor-agent`.

**The reviewer** (`review.ts`) is Guardian's own: a headless agent in a throwaway copy of the project (a shared clone with the working tree laid over it, no `.cursor`, credentials stripped except Cursor's own), with Guardian's prompt. It performs the check directly, without delegating to subagents or helpers. It checks the requested behavior and identifies unfinished work, demonstrated defects and meaningful unrelated changes. Harmless formatting, wording and supporting tests/types/docs/build fixes are not objections unless the user explicitly constrained them. It must give a clear, evidenced verdict on every item and report build, public API and focused behavior checks. A failed verification check objects even when added source tests pass; a missing or unclear check keeps the goal active for one recovery pass before it can end unchecked. The agent is asked to finish relevant local tests, builds and public-entry-point checks, fixing actual failures rather than handing those commands to the user. Guardian retries unfinished independent checks once within its review cap. Usable reviewer results are retained only when the recorded project fingerprint is unchanged; evaluator results also require unchanged recorded evidence. Concrete objections are not retried to obtain a different verdict. If verification remains unavailable, completion is recorded unchecked without another recovery pass. These requirements are appended outside the learned template, so self-improvement cannot remove them. Cached verdicts are scoped to the verification policy version.

**The evaluator** (`evaluator.ts`, `packages/evaluator`) is Google ADK's `RubricBasedMultiTurnTrajectoryEvaluator`, vendored unmodified in `third_party/adk-python`, with ADK's judge prompt and aggregation, configured for one sample by default, on the bundled Python. It never sees the project itself. It judges Guardian's record of the run (each command with its output, each edit with its text) plus evidence Guardian adds (`evidence.ts`): the real `git status` and diff, recent recorded results and bounded excerpts of actual source even when it was committed in an earlier turn, with anything missing marked absent. The rubrics are the user's "done when" items word for word and one of Guardian's about unrequested work. Guardian also prepends one line telling the judge not to delegate. ADK's evaluators that call Vertex AI are not used.

When the two checkers disagree, a fresh call checks the disputed claims against the project, in either direction. This includes a reviewer-only objection to a supporting declaration when the evaluator judged the scope rubric met. Shared item failures stand. Each claimed unrelated change is checked individually even when both checkers object to scope, because an aggregate scope verdict does not confirm every finding. Only confirmed scope issues are sent back as changes to make; an inconclusive scope check leaves verification incomplete. A confirmed or unclear claim still objects; an evidence-backed dismissal stays on the record but is not sent back. A missing evaluator verdict cannot overrule the reviewer, and ADK cannot overrule a failed build/API execution check it did not perform. Aggregate behavior claims are adjudicated with their item claims when every evaluator rubric was answered positively.

Objections go back through the same loop. There are at most 2 reviews per run, or up to 4 when the work or applicable review configuration changes. Cost per review: one reviewer call, one evaluator sample by default, and one more reviewer call when the two checkers disagree. Cursor ends a tool call that is silent for 120 s, and progress notices reset that clock, so `update_goal` sends them when the client asks for progress; the evaluator then gets 300 s, otherwise 100 s, and the reviewer 90 s. ADK needs real packages: the 17 it loads are pinned in `packages/evaluator/requirements.txt` and installed beside the bundled Python when the extension is packaged.

The returning agent receives `get_goal.work`: prior item verdicts, useful checks, unresolved findings and recorded commands. It is a read-only view of existing records, scoped to the current goal instance and marked stale when project inputs change. Identical wording in a new goal does not inherit old completion receipts. ADK receives additional changed-source excerpts and an explicit coverage/omission record. Inconclusive evidence cannot become a pass; ADK's own complete-sample rule remains in force, with missing-check rationale retained when available.

## Learning from this workspace

Every review that ran is saved as a case: goal, items, explicit user constraints, the human request active during review, base commit, the work as a binary patch plus new files, the prompt and the verdict (`cases.ts`). Explicit chat judgments and panel verdicts enter the same feedback records. Chat feedback is conservatively eligible: the user's latest recorded words must explicitly judge an identified finding; vague replies, old quotes and the agent's own disagreement cannot label it. Missing work after a clean acceptance can reopen the original goal through the existing control path. Learning qualification retains the user's verdict on each specific reviewer finding (`improve.ts`, `reviewFeedbackTargets`). Saying a passed goal wasn't done reopens the goal immediately; without a concrete issue it does not invent a target for learning qualification. Complying with a complaint, arguing back, or marking a goal done does not establish whether an objection was useful.

Once there are at least 8 labelled reviews of both kinds, and again for every 4 new ones, the extension runs Google Research's RRSI by itself (`autoImprove`), vendored unmodified in `third_party/rrsi`, with Guardian's domain (`packages/rsi/cgg`) and its model calls sent to `cursor-agent`. A third of the cases are held out. RRSI's own `Domain.guards` now prevents a candidate average gain from compensating for a measured loss of a confirmed useful issue on its search cases. Per-trial issue matches survive `TaskResult.extra` serialization for that decision. Scores and counts represent specific judgments, with rejected complaints weighted double; a different flag is not counted as the original catch. Candidate edits to the consumed reviewer prompt use RRSI's valid `prompt` component, so its history and credit counts can use them. A new reviewer prompt is applied only if it preserves every specifically confirmed catch retained by the baseline and improves the specific held-out feedback results; an unrelated new flag cannot substitute. Ambiguous issue identity cannot qualify. A rejected complaint does not label the entire project correct; every run and apply is on the record and the panel has an Undo. It changes the reviewer's prompt only, not the evaluator. Background learning waits while a goal is active or paused, yields if foreground work resumes, uses a bounded recent batch with both labels in training and held-out cases, and searches one candidate in one round. A durable rolling 24-hour workspace allowance and a per-attempt limit each default to 32 headless Cursor invocations, shared by search, replay and any needed issue-match judgments. Set `learning.dailyCallLimit` or `learning.callLimit` in config; the command center offers Off, Light and Standard. `CGG_RSI_AUTO_CALL_LIMIT` remains a per-attempt override. These bound CLI invocations, not dollars, provider-internal turns or tokens. A process-owned lease prevents overlapping runs. Reaching an allowance or failing the final checks keeps the current reviewer unchanged. Compatible interrupted search progress can resume; durable replay caches omit feedback labels and are keyed by case contents, candidate prompt and observable model/policy/runtime/dependency identity. Unknown reviewer identity disables reuse across attempts. Feedback changes invalidate scores; prompt or runtime changes invalidate compatible search resumption. Search hypotheses and qualification outcomes survive fresh attempts, and stable supported project inspection/tool guidance is allowed. Token usage is supplied to RRSI only when the reviewer reports it; missing usage remains unknown.

It has never improved anything from a user's real feedback. Evidence includes the earlier real-model lab search and replay, local automatic-workflow integration tests, and a targeted native Cursor installation/next-review check reusing the historical candidate. The latter used a controller in place of fresh search/trigger orchestration (see the README and release status).

## What Guardian doesn't do

- It never blocks. The agent can always stop; the send-back is a message.
- It doesn't defend its own files. An agent that forges lines in the audit log, deletes it, or writes its own reviewer prompt under `.cursor/goal-guardian` can reach "proved". Only a rewritten goal file is caught and restored.
- It can't tell whether a command really tests what the agent says. The reviewer is the check on that.
- Outside a git repository the reviewer does not run, so completion cannot be recorded proved.

## Decisions

- **Changed work invalidates checks.** Content changes from another chat, including generated package entries, require current-state verification. A commit or revised completion report alone does not.
- **Internal Cursor commands are used only for the panel buttons.** If one disappears, the goal state is still right.
- **Hook output is plain ASCII, and outcomes are in JSON, never exit codes.** A non-zero exit makes Cursor ignore stdout.
- **User pause survives any later message.** Otherwise any "ok" would let the agent lift it. An abort only ends the run: the next message starts a new one.
- **Blocked follows DeepSeek Harness's rule**: refused before the third goal round, accepted at once in a turn the user's message opened. Guardian marks the second case as accepted at the agent's word.
- **Stating user words is checked against the user's latest message**, for setting or changing the goal, its token budget, pausing and setting aside (`userSaidLatest`, `userAsked`). A quote that is merely task text is excluded unless the whole current request was captured as the goal; temporary first-turn limits must remain usable after capture. One too short to be a request must match the whole message.
- **The agent writes "done when" items in one case only**: a goal that has none at all (`guardian_change_goal` with `add_criteria`). Once a goal has any, `add_criteria` is refused.
- **The goal is workspace-level, runs are per chat.** A proved goal is proved everywhere; a set-aside is one message.

## What Cursor did, as observed

These are observations, not current guarantees. They come from reading Cursor 3.17.19's code in a local copy on Linux (WSL), and its hook docs, in the first week of November 2026. Nothing here has been rechecked against a later Cursor. Some commands and fields below are internal, so an update can change them; each has a fallback. The right-hand column says what Guardian did with each at that time.

**Hooks**

| Topic | Behaviour | What Guardian does |
|---|---|---|
| Send-back | `stop` returns `followup_message`, submitted as a normal visible message | The loop |
| `loop_limit` | At the limit the hook isn't run. The counter resets on any non-follow-up message | Limit 21: 20 follow-ups and a closing message |
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

**Windows** (seen on native Windows with Cursor 3.17.19 and builds of Guardian from before 2026-11-10; not rechecked since)

- Hooks run through PowerShell with the payload piped from a temp file, and the pipe's output starts with a byte-order mark. The hook strips it.
- `workspace_roots` arrives as `/c:/Users/...`. The hook converts it.
- Windows PowerShell 5.1 garbles non-ASCII text in the payload. The hook prints plain ASCII, and quotes of the user's words compare ASCII only. Non-ASCII file paths can still be garbled there.
- The hook `.exe` of those earlier builds was run through Cursor's exact wrapper, not inside the app. The current build has run on Linux x64 only.

**Command-line agent** (Cursor's CLI 2026.10.22, headless, on the Linux rig, November 2026)

Headless runs fire tool hooks but no `stop`, so there's no loop.

**Commands the panel uses** (Cursor 3.17.19, native Windows, 2026-11-04)

| Button | Command | Fallback |
|---|---|---|
| Pause goal | `composer.cancelChat(conversationId)` | Pause takes effect at the next stop |
| Resume, Work on the goal | `composer.createNew` with `autoSubmit:true`, sent at once in a new chat | `workbench.action.chat.open`, filled in for the user to send |

From the code reading above, not from a run: an existing idle chat can only be woken by `vscode.cursor.enqueueBackgroundTaskCompletion`, but that turn fires no `stop`, so the loop couldn't continue. Not used.

## Seen in real Cursor on 2026-11-04

Observations from that day, not current guarantees. Cursor 3.17.19, driven in debug mode, with the packaged VSIX of that date on native Windows and the built hook on WSL. That build predates the current goal loop, engines and review, and nothing below has been repeated on the current build. Every model was over its usage limit, so each turn ended in an error:

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

These need a real Cursor model that answers:

- A `completed` stop giving a real send-back from Guardian's own hook, and the agent answering it.
- The agent calling `update_goal`, including which MCP server it reaches on native Windows.
- Whether Cursor passes a progress token on tool calls, which decides the evaluator's budget.
- Edits and failed commands from a real agent turn firing their hooks.
- How the model sees `additional_context`.
