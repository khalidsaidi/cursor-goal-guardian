# packages/rsi: Guardian's domain for Google's RRSI

Guardian retunes its reviewer's prompt with RRSI (Regularized Recursive Self-Improvement,
github.com/google-research/rrsi), vendored unmodified in `third_party/rrsi`. The extension starts a run by itself
when enough feedback covers both real gaps and false alarms in both training and held-out cases, and again after new corrections; a result is applied
only if it loses no catch and gets more right on held-out cases, and the panel has an Undo. It changes the
reviewer's prompt only, not the evaluator. Background learning waits while a goal is active or paused. It uses a recent batch, one search candidate, and a shared limit of 32 Cursor agent invocations across search roles and replays. `CGG_RSI_AUTO_CALL_LIMIT` configures that limit; zero prevents background model invocations. This counts headless Cursor invocations, not currency or internal model turns. Hitting the limit keeps the current reviewer and does not retry the same feedback. It has not yet run on a user's real verdicts: the only runs so far are
on a study rig and against a stand-in agent. This folder is our side:

- `cgg/`: an RRSI domain. Guardian copies it to `domains/cgg/` of a throwaway RRSI checkout it assembles
  under `.cursor/goal-guardian/rsi/` (see `packages/core/src/goal/improve.ts`).
  - `adapter.py`: the Domain. Tasks are the workspace's labelled review cases (`data/tasks.json`, written by
    Guardian), split by a stable hash into evolve and held-out. Running a task replays one review with the
    candidate prompt through Guardian's own binary (`goal-guardian-hook replay-review`).
  - `cursor_llm.py`: sends RRSI's search roles (analyst, digester, proposer, critic) to `cursor-agent`, the
    user's own Cursor model, by replacing `rrsi.llm.generate` at import. RRSI's files are untouched.
  - `model_budget.py`: the allowance shared across concurrent search and replay workers.
  - `harness/`: filled at run time with the workspace's current `reviewer.md`.
- `tests/`: the domain against a temp workspace and a fake `cursor-agent`, and one RRSI smoke run.

The domain also supplies RRSI's native non-compensatory `guards`: removing false complaints cannot pay for losing a useful finding on the search cases. Its `TaskResult.extra` retains specific issue observations, and counts/weights describe the actual user judgments. The consumed reviewer file is classified under RRSI's real `prompt` category, so edit history and credit counts remain usable. Stable supported workspace knowledge is allowed consistently in the constitution and role briefs. Background search remains bounded; its single-round mode does not exercise multi-round stagnation-triggered exploration. No claim is made that all RRSI modes run in that mode.
