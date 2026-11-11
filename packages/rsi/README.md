# packages/rsi: Guardian's domain for Google's RRSI

Guardian retunes its reviewer's prompt with RRSI (Regularized Recursive Self-Improvement,
github.com/google-research/rrsi), vendored unmodified in `third_party/rrsi`. The extension starts a run by itself
once a workspace has at least 8 labelled reviews of both kinds, and again for every 4 new ones; a result is applied
only if it loses no catch and gets more right on held-out cases, and the panel has an Undo. It changes the
reviewer's prompt only, not the evaluator. It has not yet run on a user's real verdicts: the only runs so far are
on a study rig and against a stand-in agent. This folder is our side:

- `cgg/`: an RRSI domain. Guardian copies it to `domains/cgg/` of a throwaway RRSI checkout it assembles
  under `.cursor/goal-guardian/rsi/` (see `packages/core/src/goal/improve.ts`).
  - `adapter.py`: the Domain. Tasks are the workspace's labelled review cases (`data/tasks.json`, written by
    Guardian), split by a stable hash into evolve and held-out. Running a task replays one review with the
    candidate prompt through Guardian's own binary (`goal-guardian-hook replay-review`).
  - `cursor_llm.py`: sends RRSI's search roles (analyst, digester, proposer, critic) to `cursor-agent`, the
    user's own Cursor model, by replacing `rrsi.llm.generate` at import. RRSI's files are untouched.
  - `harness/`: filled at run time with the workspace's current `reviewer.md`.
- `tests/`: the domain against a temp workspace and a fake `cursor-agent`, and one RRSI smoke run.
