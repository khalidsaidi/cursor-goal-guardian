//! goal-guardian-codex-goals: one JSON request on stdin, one JSON line on stdout.
//!
//! Every request is one call into OpenAI Codex's own goal store (`codex-state`, `GoalStore` in
//! codex-rs/state/src/runtime/goals.rs), unmodified. Guardian keeps one goal per workspace, so the store holds
//! one fixed thread. The token budget, the usage accounting and the `budget_limited` status are Codex's.
//!
//!   goal-guardian-codex-goals --home <dir>     (the store's sqlite files live in <dir>)
//!
//!   {"op":"get"}
//!   {"op":"set","objective":"...","token_budget":50000,"fresh":true}
//!       fresh: a new goal (usage back to zero): replace_thread_goal.
//!       otherwise: insert_thread_goal when there is none or it is complete, else update_thread_goal, which
//!       keeps usage. token_budget absent keeps the budget; null removes it.
//!   {"op":"status","status":"active|paused|blocked|usage_limited|budget_limited|complete"}   update_thread_goal
//!   {"op":"account","tokens":1200,"seconds":40}                                                account_thread_goal_usage
//!   {"op":"clear"}                                                                             delete_thread_goal
//!
//! Answer: {"ok":true,"goal":{...Codex's fields...}|null} or {"ok":false,"error":"..."}.
use codex_protocol::ThreadId;
use codex_state::{GoalAccountingMode, GoalAccountingOutcome, GoalUpdate, SqliteConfig, StateRuntime, ThreadGoal, ThreadGoalStatus};
use codex_utils_absolute_path::AbsolutePathBuf;
use serde_json::{Value, json};
use std::io::Read;
use std::path::Path;

/// Guardian keeps one goal per workspace: one thread in Codex's store.
const THREAD: &str = "00000000-0000-4000-8000-00000000cc66";

fn goal_json(goal: Option<ThreadGoal>) -> Value {
    match goal {
        None => Value::Null,
        Some(g) => json!({
            "goal_id": g.goal_id,
            "objective": g.objective,
            "status": g.status.as_str(),
            "token_budget": g.token_budget,
            "tokens_used": g.tokens_used,
            "time_used_seconds": g.time_used_seconds,
            "created_at_ms": g.created_at.timestamp_millis(),
            "updated_at_ms": g.updated_at.timestamp_millis(),
        }),
    }
}

/// `token_budget` absent: None (keep). null: Some(None) (remove). A number: Some(Some(n)).
fn budget_of(request: &Value) -> anyhow::Result<Option<Option<i64>>> {
    match request.get("token_budget") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(v) => match v.as_i64() {
            Some(n) if n > 0 => Ok(Some(Some(n))),
            _ => anyhow::bail!("token_budget must be a positive whole number or null"),
        },
    }
}

async fn run(home: &Path, request: &Value) -> anyhow::Result<Value> {
    std::fs::create_dir_all(home)?;
    let home = AbsolutePathBuf::from_absolute_path(std::fs::canonicalize(home)?)?;
    let runtime = StateRuntime::init(SqliteConfig::from_sqlite_home_with_nfs_enforcement(home, false), "goal-guardian".to_string()).await?;
    let goals = runtime.thread_goals();
    let thread = ThreadId::from_string(THREAD)?;
    let op = request.get("op").and_then(Value::as_str).unwrap_or("");
    let goal = match op {
        "get" => goals.get_thread_goal(thread).await?,
        "set" => {
            let objective = request.get("objective").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| anyhow::anyhow!("set needs an objective"))?;
            let budget = budget_of(request)?;
            let fresh = request.get("fresh").and_then(Value::as_bool).unwrap_or(false);
            if fresh {
                Some(goals.replace_thread_goal(thread, objective, ThreadGoalStatus::Active, budget.flatten()).await?)
            } else if let Some(created) = goals.insert_thread_goal(thread, objective, ThreadGoalStatus::Active, budget.flatten()).await? {
                // There was no goal, or the old one was complete.
                Some(created)
            } else {
                goals.update_thread_goal(thread, GoalUpdate { objective: Some(objective.to_string()), status: None, token_budget: budget, expected_goal_id: None }).await?
            }
        }
        "status" => {
            let wanted = request.get("status").and_then(Value::as_str).unwrap_or("");
            let status = ThreadGoalStatus::try_from(wanted).map_err(|_| anyhow::anyhow!("unknown status {wanted:?}"))?;
            goals.update_thread_goal(thread, GoalUpdate { objective: None, status: Some(status), token_budget: None, expected_goal_id: None }).await?
        }
        "account" => {
            let tokens = request.get("tokens").and_then(Value::as_i64).unwrap_or(0);
            let seconds = request.get("seconds").and_then(Value::as_i64).unwrap_or(0);
            match goals.account_thread_goal_usage(thread, seconds, tokens, GoalAccountingMode::ActiveOnly, None).await? {
                GoalAccountingOutcome::Updated(goal) => Some(goal),
                GoalAccountingOutcome::Unchanged(goal) => goal,
            }
        }
        "clear" => {
            goals.delete_thread_goal(thread).await?;
            None
        }
        other => anyhow::bail!("unknown op {other:?}"),
    };
    Ok(json!({ "ok": true, "goal": goal_json(goal) }))
}

/// One request in, one answer out. Never panics on bad input.
async fn handle(home: &Path, input: &str) -> Value {
    let request: Value = match serde_json::from_str(input) {
        Ok(v) => v,
        Err(e) => return json!({ "ok": false, "error": format!("the request isn't JSON: {e}") }),
    };
    match run(home, &request).await {
        Ok(v) => v,
        Err(e) => json!({ "ok": false, "error": format!("{e:#}") }),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let home = args.iter().position(|a| a == "--home").and_then(|i| args.get(i + 1));
    let answer = match home {
        None => json!({ "ok": false, "error": "usage: goal-guardian-codex-goals --home <dir>, with one JSON request on stdin" }),
        Some(home) => {
            let mut input = String::new();
            match std::io::stdin().read_to_string(&mut input) {
                Ok(_) => handle(Path::new(home), &input).await,
                Err(e) => json!({ "ok": false, "error": format!("stdin couldn't be read: {e}") }),
            }
        }
    };
    println!("{answer}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gg-codex-goals-{name}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn ask(home: &Path, request: Value) -> Value {
        handle(home, &request.to_string()).await
    }

    #[tokio::test]
    async fn a_goal_is_set_accounted_and_limited_by_codexs_own_store() {
        let home = temp_home("budget");
        assert_eq!(ask(&home, json!({"op": "get"})).await, json!({"ok": true, "goal": null}));
        let set = ask(&home, json!({"op": "set", "objective": "Add CSV export", "token_budget": 1000})).await;
        assert_eq!(set["goal"]["status"], "active");
        assert_eq!(set["goal"]["token_budget"], 1000);
        let first = ask(&home, json!({"op": "account", "tokens": 400, "seconds": 30})).await;
        assert_eq!(first["goal"]["tokens_used"], 400);
        assert_eq!(first["goal"]["time_used_seconds"], 30);
        assert_eq!(first["goal"]["status"], "active");
        let over = ask(&home, json!({"op": "account", "tokens": 700, "seconds": 5})).await;
        assert_eq!(over["goal"]["tokens_used"], 1100);
        assert_eq!(over["goal"]["status"], "budget_limited");
        // A bigger budget alone doesn't restart it; making it active again does, and usage is kept.
        let raised = ask(&home, json!({"op": "set", "objective": "Add CSV export", "token_budget": 5000})).await;
        assert_eq!(raised["goal"]["status"], "budget_limited");
        assert_eq!(raised["goal"]["tokens_used"], 1100);
        let active = ask(&home, json!({"op": "status", "status": "active"})).await;
        assert_eq!(active["goal"]["status"], "active");
        assert_eq!(active["goal"]["token_budget"], 5000);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn an_edit_keeps_usage_and_budget_and_a_new_goal_starts_from_zero() {
        let home = temp_home("edit");
        ask(&home, json!({"op": "set", "objective": "First", "token_budget": 9000})).await;
        ask(&home, json!({"op": "account", "tokens": 50, "seconds": 2})).await;
        let edited = ask(&home, json!({"op": "set", "objective": "First, reworded"})).await;
        assert_eq!(edited["goal"]["objective"], "First, reworded");
        assert_eq!(edited["goal"]["tokens_used"], 50);
        assert_eq!(edited["goal"]["token_budget"], 9000);
        let unbudgeted = ask(&home, json!({"op": "set", "objective": "First, reworded", "token_budget": null})).await;
        assert_eq!(unbudgeted["goal"]["token_budget"], Value::Null);
        for status in ["paused", "active", "blocked", "active", "complete"] {
            assert_eq!(ask(&home, json!({"op": "status", "status": status})).await["goal"]["status"], status);
        }
        // After complete, a plain set is a new goal: Codex's insert replaces a completed one.
        let next = ask(&home, json!({"op": "set", "objective": "Second"})).await;
        assert_eq!(next["goal"]["tokens_used"], 0);
        assert_eq!(next["goal"]["status"], "active");
        let fresh = ask(&home, json!({"op": "set", "objective": "Third", "fresh": true})).await;
        assert_ne!(fresh["goal"]["goal_id"], next["goal"]["goal_id"]);
        assert_eq!(ask(&home, json!({"op": "clear"})).await, json!({"ok": true, "goal": null}));
        assert_eq!(ask(&home, json!({"op": "get"})).await["goal"], Value::Null);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn bad_requests_are_answered_not_panicked() {
        let home = temp_home("bad");
        assert_eq!(handle(&home, "not json").await["ok"], false);
        assert_eq!(ask(&home, json!({"op": "teleport"})).await["ok"], false);
        assert_eq!(ask(&home, json!({"op": "set"})).await["ok"], false);
        assert_eq!(ask(&home, json!({"op": "set", "objective": "x", "token_budget": -5})).await["ok"], false);
        assert_eq!(ask(&home, json!({"op": "status", "status": "sideways"})).await["ok"], false);
        // No goal yet: a status change or accounting changes nothing and says so.
        assert_eq!(ask(&home, json!({"op": "status", "status": "paused"})).await, json!({"ok": true, "goal": null}));
        assert_eq!(ask(&home, json!({"op": "account", "tokens": 5, "seconds": 1})).await, json!({"ok": true, "goal": null}));
        let _ = std::fs::remove_dir_all(&home);
    }
}
