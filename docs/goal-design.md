# How CGG helps finish a goal

CGG keeps one user-owned goal per workspace, carries useful work across chats and sends unfinished work back to Cursor. Completion gets an independent project review and an ADK evaluation. Specific corrections help current reviews and become inputs to bounded RRSI learning.

## Complementary responsibilities

| Part | Responsibility |
|---|---|
| CGG | The user's goal text, finish conditions and boundaries; captured work; Cursor integration; independent project reviewer; feedback and learning adapters. |
| DeepSeek Harness goal packages | Goal lifecycle, revision/authority checks and round admission. CGG reads phase from their folded events. |
| OpenAI Codex goal extension/store | Usage accounting, optional token budget, objective-change context and continuation instructions. Accepted lifecycle changes synchronize its accounting copy without another approval. |
| Google ADK | A separate rubric-based evaluation of the recorded run and project evidence CGG supplies. It does not inspect the filesystem itself. |
| Google Research RRSI | Search over the consumed reviewer prompt, with candidate evaluation, selection, history and qualification. It does not change the user's goal, fixed checks or evaluator. |
| Cursor | The implementation agent and the model service used by review, evaluation and learning. |

The integration uses the upstream code alongside CGG's adapters; it does not launch Codex or DeepSeek as a second coding agent. See [NOTICE](../NOTICE) for sources, licenses and adaptations.

## Goal and context

The contract lives in `.cursor/goal-guardian/contract.json`; event records live beside it under telemetry. Project questions alone do not create a goal. For requested changes, `create_goal` records the user's request before inspection/edits, with first-change capture as a fallback. The recorded request supplies any listed finish conditions and trailing instructions. When there are no finish conditions, the agent may add them; it cannot append its own items to an existing checklist.

Goal changes and requested budgets/pauses are checked against the latest captured human message. DeepSeek owns lifecycle changes. Codex receives the accepted objective/status for accounting and continuation context and retains its budget stops. A missing partner runtime or failed synchronization is reported as unverified rather than treated as independent success.

The full goal survives a temporary turn instruction such as “only the first part for now.” A later request to continue concerns the remaining goal; persistent user boundaries still apply. User pause cannot be lifted by the agent. The user can resume from the panel or an explicit goal command.

## Continuing useful work

Cursor hooks capture user messages, edits and command results. The agent receives the goal plus relevant prior checks, concrete findings and remaining work. `get_goal.work` exposes the same context. Current project content is checked so stale evidence is not presented as fresh.

Desktop Cursor's stop hook returns a follow-up message when useful work remains. Continuation is bounded by progress, rounds, user pause/turn scope and any goal budget. No hook blocks the agent; it can still stop. The tested headless CLI emits useful tool/file events but not this desktop continuation hook.

## Completion checks

CGG compares the completion request with its recorded work. It does not require copied output quotations, file labels or removal of supporting work as a reporting ritual. Relevant tests and checks can be reused while their inputs, project content and evidence remain unchanged; a commit or wording change alone is not invalidation.

CGG's independent reviewer works in a throwaway project copy. It checks requested behavior on ordinary in-domain inputs, applicable tests/builds and affected public entry points. Findings must concern unfinished requirements, demonstrated bugs or meaningful unrequested changes. Types, tests, docs and minimal build fixes supporting the goal belong to the work. Harmless formatting and extra speculative requirements are not reasons to send the agent back unless the user explicitly required them.

ADK separately judges the recorded trajectory, finish conditions and source observations CGG supplies. Missing evidence remains missing. Both checks are consulted; when one objects and the other disagrees, a focused project check can resolve the disputed claim. ADK cannot independently see source that the adapter did not supply.

An unresolved failed check prevents a checked completion. Incomplete checks receive a bounded recovery attempt while useful goal work can continue; if verification still cannot finish, the result says unchecked. A concrete unresolved finding remains disputed. Repeating the same report does not create a new review of unchanged work.

## User-facing outcomes

| Interface meaning | Internal record |
|---|---|
| Work complete; independent checks passed | `proved` |
| Reported complete; independent checks incomplete | `unchecked` |
| Work needs attention; unresolved finding | `disputed` |
| Goal tracking could not finish | `unverified` |
| An external obstacle remains | `blocked` |
| Goal kept for later in that chat | `set_aside` |
| No useful progress | `stalled` |
| Continuation limit reached | `limit` |
| Goal token budget reached | `budget_limited` |
| Run stopped | `stopped` |

“Proved” is the stored outcome for the observed checked state, not mathematical proof or a statement about the agent's honesty. A block accepted on a human-opened first turn is marked unverified in the panel. Marking a goal done yourself is a user decision, not a new independent review.

## Corrections and learning

Panel buttons or `guardian_review_feedback` retain specific useful findings and rejected complaints. The chat route checks the actual latest human words, current review and finding index; vague replies and the agent's own opinion are not learning labels. It does not ask the user to rate every finding. A rejection of a clean review can reopen the original goal. Specific feedback and its reason reach the next check; rejecting one complaint does not declare all work correct.

With enough saved examples covering useful findings and unnecessary complaints in both splits, automatic learning uses the real RRSI domain. A stable case hash determines the withheld examples. Search can adjust only the reviewer prompt. Per-issue scoring distinguishes the same useful finding from an unrelated new flag; RRSI's search guard prevents a measured loss of an observed useful issue, and the final withheld comparison must improve without losing a confirmed catch. Ambiguous or incomplete issue matching cannot qualify a candidate. Adoption is recorded and can be undone.

The current automatic configuration searches one candidate in one round. It does not exercise all RRSI modes or promise a new improvement whenever feedback arrives. If current judgments already satisfy the withheld feedback, no search is needed.

Learning waits during active/paused goal work and yields if foreground work resumes. A per-attempt limit and rolling workspace allowance default to 32 headless invocations; the Command Center offers Off, Light and Standard. These are invocation limits, not currency, provider-internal turn or token caps. Compatible replay results, interrupted search and history can be reused; changed feedback invalidates scores, and changed prompts/runtime invalidate incompatible reuse. Unknown model identity prevents cross-attempt replay reuse.

## Interface and tools

The panel offers setup, goal controls, review feedback and learning Undo. `/guardian` briefs the user; `/guardian-goal` runs the explicit goal command. Six MCP tools connect the chat: `get_goal`, `create_goal`, `update_goal`, `goal_command`, `guardian_change_goal`, `guardian_review_feedback`.

The panel uses Cursor commands to cancel the current chat or start a new one. Those host commands can change and have fallbacks; they are not public Cursor API guarantees. Hooks require a trusted workspace. Other stop hooks can replace a follow-up.

## Evidence and limits

Current build/run validation is Linux x64, including WSL Ubuntu. Real Cursor and local stand-in checks establish different behaviors; see [verification](verification.md) and the [maintainer release record](release-status.md). Naturally accumulated user feedback and a fresh whole-chain native search/adoption gain have not been demonstrated. Earlier goal, review and real-model RRSI evidence still counts; another winning prompt is not a new release gate.

CGG cannot force continuation, guarantee review correctness, observe every ignored-path shell change or defend its own records against deliberate tampering. Outside Git the project review does not run. Its job is helping an ordinary agent finish useful work.


## Platform build path

The repository retains builders for Linux, macOS and Windows on x64 and ARM64. Bun compiles the hook/MCP programs for five targets; Windows ARM64 uses Node SEA. A checksum-pinned Python runtime is specified for each target. This is reusable cross-platform build infrastructure, not proof of complete product support.

The Codex goal runtime is built natively per target and can be supplied through a cached CI artifact. The current package-test CI jobs explicitly skip that runtime and do not download its separate job's artifacts. ADK's dependency-wheel mapping is currently Linux x64 only; other target packages omit the evaluator. Therefore a passing core-binary job alone cannot validate the advertised complete goal/review/learning workflow on another platform. The current public release remains Linux x64.
