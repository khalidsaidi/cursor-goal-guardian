# packages/codex-goals: Guardian's door to Codex's goal package

OpenAI Codex's goal feature is its goal extension (`codex-rs/ext/goal`: tool handlers, accounting, steering,
the user-facing goal service) over its goal store (`codex-state`, `GoalStore` in
`codex-rs/state/src/runtime/goals.rs`). This crate is a command-line binary, `goal-guardian-codex-goals`,
that runs all of it, unmodified, for Guardian.

- **Codex's code** comes straight from github.com/openai/codex at the commit vendored in `third_party/codex`
  (`ac54a05`), as git dependencies pinned by `Cargo.lock`. None of it is copied here.
- **Ours** is the wrapper: one JSON request on stdin, one JSON line on stdout (the requests are listed at the top
  of `src/main.rs`).
  - `src/main.rs`: the store requests, each one call into `GoalStore` (`get`, `set`, `status`, `account`, `clear`).
  - `src/whole.rs`: Codex's goal extension installed with its own `install_with_backend` and driven through the
    lifecycle calls Codex's agent makes, as Codex's own tests do. `tool` runs its real `get_goal`, `create_goal`
    and `update_goal` handlers; `tool_specs` returns their definitions; `turn` runs its turn accounting;
    `user_goal` goes through its `GoalService`, as its app-server's `thread/goal/set` and `clear` do, and returns
    its "User set the goal" context fragment.
  - `src/continuation.rs`: Codex's continuation scheduling. See below.
- The store's sqlite files live in `<workspace>/.cursor/goal-guardian/codex/`, kept out of git. Codex's
  runtime creates its other databases there too (state, logs, memories, queue); Guardian uses only the goals.
- DeepSeek Harness's goal service stays the authority for the goal's phase, revision and rounds. Codex's store
  is told the same changes and keeps the usage and the budget (`packages/core/src/goal/codexGoals.ts`).

```bash
cargo build --release --locked
cargo test --release --locked
echo '{"op":"set","objective":"Add CSV export","token_budget":50000}' | target/release/goal-guardian-codex-goals --home /tmp/gg-codex
```

`scripts/compile-binaries.mjs` builds it for this machine's target when cargo is installed. Rust isn't
cross-compiled: CI's `codex-goals` job builds it natively on all six shipped architectures and uploads each
binary; unpack one to `.cache/codex-goals/<target>/` and the packaging picks it up. A package built without
the binary works as before, without token budgets.

## The one adaptation: the continuation turn comes back as data

Codex decides whether to continue a goal, and with what prompt, inside its own runtime, and then starts a turn
on its own thread. In Cursor only the stop hook can start the agent's next turn. So the `steering` request
starts a real Codex thread, the way Codex's own tests do (`core_test_support`), with its model endpoint pointed
at a local capture server; puts the workspace's goal in that thread's store; and reports the thread idle.
Codex then does everything itself, and the request it sends "the model" is read and returned: its steering
prompt and its `goal_objective` context. Nothing of Codex's is changed or reimplemented, no model is called,
and the throwaway thread lives in a temporary Codex home.

The same request returns Codex's two mid-turn notices, which it injects into a running turn: `objective_updated`
(the user edits the goal) and `budget_limit` (usage crosses the budget).

Three environment variables Codex's test support insists on (`CARGO_BIN_EXE_codex`, `-code-mode-host`,
`-linux-sandbox`) are pointed at this binary at startup; the capture never runs them.

What Codex's package also holds and this binary runs without surfacing: its analytics and metrics clients are
given Codex's own disabled or absent forms, as in its tests. Its goal-updated events are returned in `events`.
