# CGG's adapter to Codex goal code

This Rust executable connects selected capabilities of OpenAI Codex's real goal extension and goal store to CGG. DeepSeek Harness owns goal lifecycle/round authority; Codex complements it with usage accounting, optional token budgets, objective-change context and continuation instructions. It is not a second implementation agent.

Codex's source is pinned to `ac54a05` by the Git dependencies and Cargo lockfile. The wrapper accepts one JSON request on stdin and returns one JSON response. See the request definitions in `src/main.rs` for the protocol.

- `main.rs` exposes goal-store operations.
- `whole.rs` drives Codex's goal extension through its own lifecycle and tool interfaces, preserving its accounting and budget rules.
- `continuation.rs` captures Codex's own continuation request and objective/budget notices for delivery through Cursor.

Accepted lifecycle changes notify Codex's accounting copy without requesting a second lifecycle approval. Missing accounting state, unavailable runtimes or failed synchronization remain explicit integration failures. CGG's own checks and independent reviewers establish completion evidence; a partner status change does not itself judge the finished project.

## Continuation adaptation

Codex's goal extension normally starts a turn in its own runtime. Cursor's stop hook owns the next implementation turn here. The wrapper uses Codex's own test-support runtime with a local capture endpoint, reads the continuation request and delivers the instructions through Cursor. It does not call another implementation model or reimplement the upstream prompt logic. Temporary runtime state belongs to the wrapper's isolated Codex home.

## Development and packaging

```sh
cargo build --release --locked
cargo test --release --locked
```

The packaging script includes a compatible native binary. This build has been built and run on Linux x64. CI source or cached artifacts for other targets are not evidence of current cross-platform validation. Without the required runtime, goal integration is unverified rather than recorded as a checked completion.

Upstream licenses, notices, source scope and adaptations are recorded in [NOTICE](../../NOTICE). See the [design](../../docs/goal-design.md) for the complete responsibility split.
