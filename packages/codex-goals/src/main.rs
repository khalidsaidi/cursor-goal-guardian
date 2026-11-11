//! goal-guardian-codex-goals: one JSON request on stdin, one JSON line on stdout.
//!
//! Every request runs OpenAI Codex's own goal code, unmodified. Guardian keeps one goal per workspace, so
//! Codex's store holds one fixed thread.
//!
//! Requests on Codex's whole goal extension (codex-rs/ext/goal), driven the way Codex's agent and app-server
//! drive it (src/whole.rs):
//!
//!   {"op":"tool_specs"}                          Codex's tool definitions, from its own executors
//!   {"op":"tool","name":"get_goal|create_goal|update_goal","arguments":{...},"turn_id":"t1","usage":{...}}
//!       Codex's real tool handler. "usage" is the turn's token usage so far (input_tokens, cached_input_tokens,
//!       output_tokens, reasoning_output_tokens, total_tokens), accounted by Codex before the call.
//!   {"op":"turn","turn_id":"t1","usage":{...},"seconds":40}
//!       One finished agent turn through Codex's own accounting: turn start, token usage, turn stop.
//!   {"op":"user_goal","objective":"...","status":"paused","token_budget":50000,"clear":false}
//!       A change made by the user, through Codex's GoalService as its app-server's thread/goal/set does, with
//!       Codex's own "User set the goal" context fragment.
//!   {"op":"steering","kind":"continuation|objective_updated|budget_limit","update_plan":false,"new_objective":"..."}
//!       What Codex's own scheduling sends its agent for this goal (src/continuation.rs).
//!
//! Requests straight on Codex's goal store (`codex-state`, `GoalStore` in codex-rs/state/src/runtime/goals.rs):
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
mod continuation;
mod whole;

use codex_core::context::{ContextualUserFragment, UserGoalUpdate};
use codex_protocol::ThreadId;
use std::sync::Weak;
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

fn protocol_status(name: &str) -> anyhow::Result<codex_protocol::protocol::ThreadGoalStatus> {
    serde_json::from_value(Value::String(name.to_string())).map_err(|_| anyhow::anyhow!("unknown status {name:?}"))
}

/// Requests that run Codex's goal extension as a whole. None: not one of them.
async fn run_extension(runtime: &std::sync::Arc<StateRuntime>, thread: ThreadId, op: &str, request: &Value) -> anyhow::Result<Option<Value>> {
    let goals = runtime.thread_goals();
    let max_budget = request.get("max_goal_token_budget").and_then(Value::as_i64);
    let turn_id = request.get("turn_id").and_then(Value::as_str).unwrap_or("guardian-turn").to_string();
    let answer = match op {
        "tool_specs" => {
            let extension = whole::Extension::install(runtime.clone(), thread, max_budget, Weak::new()).await?;
            json!({ "ok": true, "tools": extension.tool_specs()? })
        }
        "tool" => {
            let name = request.get("name").and_then(Value::as_str).ok_or_else(|| anyhow::anyhow!("tool needs a name"))?;
            let arguments = request.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let extension = whole::Extension::install(runtime.clone(), thread, max_budget, Weak::new()).await?;
            extension.start_turn(&turn_id, &codex_protocol::protocol::TokenUsage::default()).await;
            if let Some(usage) = request.get("usage") {
                extension.record_usage(&turn_id, &whole::usage_of(usage)).await;
            }
            let call = extension.call_tool(&turn_id, name, &arguments).await?;
            json!({ "ok": true, "call": call, "goal": goal_json(goals.get_thread_goal(thread).await?), "events": extension.events() })
        }
        "turn" => {
            let extension = whole::Extension::install(runtime.clone(), thread, max_budget, Weak::new()).await?;
            extension.start_turn(&turn_id, &codex_protocol::protocol::TokenUsage::default()).await;
            if let Some(usage) = request.get("usage") {
                extension.record_usage(&turn_id, &whole::usage_of(usage)).await;
            }
            extension.stop_turn(&turn_id).await;
            // Codex times a turn with its own clock inside its own process. Guardian's turn ran in Cursor, so the
            // seconds it took go to the same store call Codex's accounting ends in.
            let seconds = request.get("seconds").and_then(Value::as_i64).unwrap_or(0);
            if seconds > 0 {
                goals.account_thread_goal_usage(thread, seconds, 0, GoalAccountingMode::ActiveOnly, None).await?;
            }
            json!({ "ok": true, "goal": goal_json(goals.get_thread_goal(thread).await?), "events": extension.events() })
        }
        "user_goal" => {
            let extension = whole::Extension::install(runtime.clone(), thread, max_budget, Weak::new()).await?;
            if request.get("clear").and_then(Value::as_bool).unwrap_or(false) {
                let cleared = extension.user_clear().await?;
                let fragment = serde_json::to_value(ContextualUserFragment::into(UserGoalUpdate::Clear))?;
                json!({ "ok": true, "cleared": cleared, "goal": Value::Null, "fragment": fragment, "events": extension.events() })
            } else {
                let objective = request.get("objective").and_then(Value::as_str);
                let status = match request.get("status").and_then(Value::as_str) {
                    Some(name) => Some(protocol_status(name)?),
                    None => None,
                };
                let goal = extension.user_set(objective, status, budget_of(request)?, max_budget).await?;
                let fragment = serde_json::to_value(ContextualUserFragment::into(UserGoalUpdate::Set { objective: objective.map(str::to_owned), status }))?;
                json!({ "ok": true, "protocol_goal": serde_json::to_value(&goal)?, "goal": goal_json(goals.get_thread_goal(thread).await?), "fragment": fragment, "events": extension.events() })
            }
        }
        "steering" => {
            let Some(goal) = goals.get_thread_goal(thread).await? else {
                return Ok(Some(json!({ "ok": true, "goal": Value::Null, "steering": Value::Null })));
            };
            let want = continuation::Steering {
                kind: request.get("kind").and_then(Value::as_str).unwrap_or("continuation").to_string(),
                update_plan: request.get("update_plan").and_then(Value::as_bool).unwrap_or(false),
                new_objective: request.get("new_objective").and_then(Value::as_str).map(str::to_owned),
            };
            let steering = continuation::steering(&goal, want).await?;
            json!({ "ok": true, "goal": goal_json(Some(goal)), "steering": steering })
        }
        _ => return Ok(None),
    };
    Ok(Some(answer))
}

async fn run(home: &Path, request: &Value) -> anyhow::Result<Value> {
    std::fs::create_dir_all(home)?;
    let home = AbsolutePathBuf::from_absolute_path(std::fs::canonicalize(home)?)?;
    let runtime = StateRuntime::init(SqliteConfig::from_sqlite_home_with_nfs_enforcement(home, false), "goal-guardian".to_string()).await?;
    let goals = runtime.thread_goals();
    let thread = ThreadId::from_string(THREAD)?;
    let op = request.get("op").and_then(Value::as_str).unwrap_or("");
    if let Some(answer) = run_extension(&runtime, thread, op, request).await? {
        return Ok(answer);
    }
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

async fn answer_stdin() -> Value {
    let args: Vec<String> = std::env::args().collect();
    let home = args.iter().position(|a| a == "--home").and_then(|i| args.get(i + 1));
    match home {
        None => json!({ "ok": false, "error": "usage: goal-guardian-codex-goals --home <dir>, with one JSON request on stdin" }),
        Some(home) => {
            let mut input = String::new();
            match std::io::stdin().read_to_string(&mut input) {
                Ok(_) => handle(Path::new(home), &input).await,
                Err(e) => json!({ "ok": false, "error": format!("stdin couldn't be read: {e}") }),
            }
        }
    }
}

/// Codex's own programs run on threads with a large stack (its futures are big); so does this one.
const STACK_BYTES: usize = 64 * 1024 * 1024;

fn main() {
    // Codex's test support, which src/continuation.rs uses to start a real Codex thread, looks up Codex's helper
    // programs through these variables and panics when one is missing. The continuation capture never runs them,
    // so they point at this program.
    if let Ok(me) = std::env::current_exe() {
        for name in ["CARGO_BIN_EXE_codex", "CARGO_BIN_EXE_codex-code-mode-host", "CARGO_BIN_EXE_codex-linux-sandbox"] {
            if std::env::var_os(name).is_none() {
                // Safe: nothing else is running yet.
                unsafe { std::env::set_var(name, &me) };
            }
        }
    }
    let answer = std::thread::Builder::new()
        .stack_size(STACK_BYTES)
        .spawn(|| match tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(STACK_BYTES).build() {
            Ok(runtime) => runtime.block_on(answer_stdin()),
            Err(e) => json!({ "ok": false, "error": format!("the runtime couldn't start: {e}") }),
        })
        .ok()
        .and_then(|worker| worker.join().ok())
        .unwrap_or_else(|| json!({ "ok": false, "error": "Codex's goal code stopped unexpectedly" }));
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
    async fn codexs_own_tool_handlers_and_specs_answer_the_calls() {
        let home = temp_home("tools");
        let specs = ask(&home, json!({"op": "tool_specs"})).await;
        let names: Vec<&str> = specs["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["get_goal", "create_goal", "update_goal"]);
        assert!(specs["tools"][2]["spec"]["description"].as_str().unwrap().starts_with("Update the existing goal."));
        assert_eq!(specs["tools"][2]["spec"]["parameters"]["properties"]["status"]["enum"], json!(["complete", "blocked", "paused"]));

        let none = ask(&home, json!({"op": "tool", "name": "get_goal", "arguments": {}})).await;
        assert_eq!(none["call"]["accepted"], true);
        assert_eq!(none["call"]["result"]["goal"], Value::Null);
        let created = ask(&home, json!({"op": "tool", "name": "create_goal", "arguments": {"objective": "Add CSV export"}})).await;
        assert_eq!(created["call"]["accepted"], true);
        assert_eq!(created["call"]["result"]["goal"]["status"], "active");
        assert_eq!(created["goal"]["objective"], "Add CSV export");
        // Codex's rule, in Codex's words: no second goal while one is unfinished.
        let second = ask(&home, json!({"op": "tool", "name": "create_goal", "arguments": {"objective": "Another"}})).await;
        assert_eq!(second["call"]["accepted"], false);
        assert_eq!(second["call"]["refusal"], "cannot create a new goal because this thread has an unfinished goal; complete the existing goal first");
        // The model can't resume or set the system's statuses.
        let bad = ask(&home, json!({"op": "tool", "name": "update_goal", "arguments": {"status": "active"}})).await;
        assert_eq!(bad["call"]["accepted"], false);
        let done = ask(&home, json!({"op": "tool", "name": "update_goal", "arguments": {"status": "complete"}, "turn_id": "t9", "usage": {"input_tokens": 120, "output_tokens": 30}})).await;
        assert_eq!(done["call"]["accepted"], true);
        assert_eq!(done["goal"]["status"], "complete");
        assert_eq!(done["goal"]["tokens_used"], 150);
        assert_eq!(ask(&home, json!({"op": "tool", "name": "teleport", "arguments": {}})).await["ok"], false);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn a_turn_is_accounted_by_codexs_own_runtime_and_a_user_change_goes_through_its_goal_service() {
        let home = temp_home("turn");
        let set = ask(&home, json!({"op": "user_goal", "objective": "Add CSV export", "token_budget": 1000})).await;
        assert_eq!(set["goal"]["status"], "active");
        assert_eq!(set["goal"]["token_budget"], 1000);
        assert_eq!(set["fragment"]["content"][0]["text"], "<codex_internal_context source=\"user_goal\">\nUser set the goal: \"Add CSV export\"\n</codex_internal_context>");
        let first = ask(&home, json!({"op": "turn", "turn_id": "t1", "usage": {"input_tokens": 400, "cached_input_tokens": 100, "output_tokens": 50}, "seconds": 12})).await;
        // Codex counts input less cached input, plus output.
        assert_eq!(first["goal"]["tokens_used"], 350);
        assert_eq!(first["goal"]["time_used_seconds"], 12);
        assert_eq!(first["events"]["goal_updated"][0]["goal"]["tokensUsed"], 350);
        let over = ask(&home, json!({"op": "turn", "turn_id": "t2", "usage": {"input_tokens": 700}})).await;
        assert_eq!(over["goal"]["status"], "budget_limited");
        // Codex's rule: a goal over its budget stays budget_limited even when paused.
        let paused = ask(&home, json!({"op": "user_goal", "status": "paused"})).await;
        assert_eq!(paused["goal"]["status"], "budget_limited");
        assert!(paused["fragment"]["content"][0]["text"].as_str().unwrap().contains("User set goal status: \"paused\"."));
        let cleared = ask(&home, json!({"op": "user_goal", "clear": true})).await;
        assert_eq!(cleared["cleared"], true);
        assert!(cleared["fragment"]["content"][0]["text"].as_str().unwrap().contains("User cleared the goal."));
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
