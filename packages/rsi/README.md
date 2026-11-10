# packages/rsi: Guardian's domain for Google's RRSI

Guardian improves its own reviewer with RRSI (Regularized Recursive Self-Improvement,
github.com/google-research/rrsi), vendored unmodified in `third_party/rrsi`. This folder is our side:

- `cgg/`: an RRSI domain. Guardian copies it to `domains/cgg/` of a throwaway RRSI checkout it assembles
  under `.cursor/goal-guardian/rsi/` (see `packages/core/src/goal/improve.ts`).
  - `adapter.py`: the Domain. Tasks are the workspace's labelled review cases (`data/tasks.json`, written by
    Guardian), split by a stable hash into evolve and held-out. Running a task replays one review with the
    candidate prompt through Guardian's own binary (`goal-guardian-hook replay-review`).
  - `cursor_llm.py`: sends RRSI's search roles (analyst, digester, proposer, critic) to `cursor-agent`, the
    user's own Cursor model, by replacing `rrsi.llm.generate` at import. RRSI's files are untouched.
  - `harness/`: filled at run time with the workspace's current `reviewer.md`.
- `tests/`: the domain against a temp workspace and a fake `cursor-agent`, and one RRSI smoke run.
