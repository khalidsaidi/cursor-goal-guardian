# Performance and usage

CGG is useful when keeping the goal, reusing valid work or finding an omission saves the user from having to restart or redirect the agent. There is no general measured percentage improvement for every task.

## What was observed

Earlier Linux lab studies measured hook/tool overhead and used stand-in models for repeatable integration checks. Their timings belong to their recorded builds and environments; they are not guarantees for the current package, other platforms or a real model.

A bounded native Cursor comparison reused a saved documentation-omission task. Both runs finished correctly. The CGG-context run reused recorded successful checks rather than rerunning them after a docs-only change and used fewer tool calls. This was one pair, with possible ordering/cache effects: it does not establish a general speed or quality gain.

Other real Cursor records cover goal retention, review-driven repair, specific corrections and use of a qualified reviewer prompt. See [verification](verification.md) for those scopes. No global improvement percentage or fraction of bundled code executed is claimed.

## What consumes your plan

- A continuation is another agent turn.
- Completion uses the project reviewer and an ADK evaluator sample by default. A disagreement can require a focused additional check.
- Learning replays saved work and runs RRSI's search roles and any needed issue matching through Cursor.

A headless Cursor invocation can contain several model turns. Invocation allowances do not cap currency, tokens or provider-internal turns. Reported reviewer usage is supplied to RRSI when available; missing usage is left unknown.

## User controls

The Command Center offers Off, Light and Standard for automatic learning. Background learning yields to active work and shares a rolling workspace allowance across attempts. Unqualified candidates and allowance exhaustion leave the current reviewer in place. Optional goal token budgets are accounted for by Codex's goal store; they are separate from learning's invocation allowance.

Current platform validation is Linux x64, including WSL Ubuntu. Detailed measurement provenance remains in the [maintainer release record](release-status.md). Earlier benchmark tables are preserved in Git history, not presented as current package measurements.
