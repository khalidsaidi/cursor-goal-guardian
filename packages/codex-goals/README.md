# packages/codex-goals: Guardian's door to Codex's goal store

OpenAI Codex keeps a thread's goal in its own store, with usage accounting, a token budget and a
`budget_limited` status (`codex-state`, `GoalStore` in `codex-rs/state/src/runtime/goals.rs`). This crate is a
small command-line binary, `goal-guardian-codex-goals`, that runs that store, unmodified, for Guardian.

- **Codex's code** comes straight from github.com/openai/codex at the commit vendored in `third_party/codex`
  (`ac54a05`), as git dependencies pinned by `Cargo.lock`. None of it is copied here.
- **Ours** is `src/main.rs`: one JSON request on stdin, one JSON line on stdout, each request one call into
  `GoalStore` (`get`, `set`, `status`, `account`, `clear`; see the top of the file).
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

Not run from Codex: its tool handlers (`ext/goal/src/tool.rs`) and its continuation scheduling
(`ext/goal/src/runtime.rs`), which starts Codex's own turns.
