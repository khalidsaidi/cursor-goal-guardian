//! Codex's continuation scheduling, run as it is, with one adaptation: what it would send its own agent is handed
//! back to Guardian as data, because in Cursor only the stop hook can start the agent's next turn.
//!
//! Codex decides whether to continue, and with what, inside `GoalRuntimeHandle::continue_if_idle`
//! (codex-rs/ext/goal/src/runtime.rs): it reads the goal, checks its status and any deferral, renders its steering
//! prompt (steering.rs `continuation_request`) and submits a turn to its own live thread. None of that is public,
//! so it can't be called piece by piece, and it isn't copied. Instead a real Codex thread is started here, the way
//! Codex's own tests start one (`core_test_support::test_codex`), with its model endpoint pointed at a local
//! capture server instead of a model. Codex's goal extension is installed for that thread with the real thread
//! manager, the workspace's goal is put in that thread's store through Codex's store, and the thread is reported
//! idle. Codex then does everything itself. The request it sends "the model" is the continuation turn: its
//! steering prompt and its goal_objective context are read out of that request and returned.
//!
//! The same route serves Codex's two other steering prompts, which it injects into a running turn: the
//! objective-updated notice (the user edits the goal mid-turn) and the budget-limit notice (usage crosses the
//! budget mid-turn).
use crate::whole::Extension;
use codex_extension_api::{ThreadIdleCause, ThreadIdleInput};
use codex_core::{CodexThread, TurnInputRequest};
use codex_protocol::protocol::{EventMsg, TokenUsage};
use codex_protocol::user_input::UserInput;
use codex_state::{GoalAccountingMode, ThreadGoal, ThreadGoalStatus as StoreStatus};
use core_test_support::responses::{ev_assistant_message, ev_completed, ev_response_created, mount_response_sequence, sse, sse_response, start_mock_server};
use core_test_support::test_codex::test_codex;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

const GOAL_CONTEXT: &str = "<codex_internal_context source=\"goal\">";

/// Every text part of every input item of one captured model request, in order.
fn input_texts(body: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for item in body.get("input").and_then(Value::as_array).into_iter().flatten() {
        let role = item.get("role").and_then(Value::as_str).unwrap_or("").to_string();
        for part in item.get("content").and_then(Value::as_array).into_iter().flatten() {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                out.push((role.clone(), text.to_string()));
            }
        }
    }
    out
}

fn strip_marker(text: &str) -> String {
    let inner = text.trim();
    let inner = inner.strip_prefix(GOAL_CONTEXT).unwrap_or(inner);
    let inner = inner.strip_suffix("</codex_internal_context>").unwrap_or(inner);
    inner.trim().to_string()
}

/// What Codex put in a request about the goal: its steering fragments, and the item carrying the objective
/// (Codex's "goal_objective" additional context, which reaches the model as an agent function-call output).
fn goal_parts(body: &Value) -> (Vec<String>, Option<Value>) {
    let steering = input_texts(body).iter().filter(|(_, t)| t.contains(GOAL_CONTEXT)).map(|(_, t)| strip_marker(t)).collect();
    let context = body.get("input").and_then(Value::as_array).into_iter().flatten().rev().find(|item| item.get("name").and_then(Value::as_str) == Some("goal_objective")).map(|item| json!({ "type": item.get("type"), "namespace": item.get("namespace"), "name": item.get("name"), "output": item.get("output") }));
    (steering, context)
}

pub struct Steering {
    /// "continuation", "objective_updated" or "budget_limit".
    pub kind: String,
    pub update_plan: bool,
    /// For objective_updated: the objective the user changed it to.
    pub new_objective: Option<String>,
}

/// Run Codex's own scheduling for `goal` and return what it sent.
pub async fn steering(goal: &ThreadGoal, want: Steering) -> anyhow::Result<Value> {
    // Codex's test server checks on drop that every answer it was given was asked for, and panics otherwise. How
    // many requests Codex makes is Codex's decision here, so the server is never dropped; the process ends anyway.
    let server = std::mem::ManuallyDrop::new(start_mock_server().await);
    let done = |id: &str| sse(vec![ev_response_created(id), ev_assistant_message(&format!("m-{id}"), "ok"), ev_completed(id)]);
    // The first answer is slow, so a turn is still running when a mid-turn change is made.
    let slow = if want.kind == "continuation" { Duration::ZERO } else { Duration::from_millis(1500) };
    let mock = mount_response_sequence(&server, vec![sse_response(done("r1")).set_delay(slow), sse_response(done("r2")), sse_response(done("r3"))]).await;
    let update_plan = want.update_plan;
    let test = test_codex().with_config(move |config| config.update_plan_enabled = update_plan).build(&server).await?;
    let thread = test.session_configured.thread_id;
    let runtime = test.codex.state_db().ok_or_else(|| anyhow::anyhow!("Codex's thread has no state store"))?;

    // The workspace's goal, put in this thread's store by Codex's store, with its usage.
    let goals = runtime.thread_goals();
    goals.replace_thread_goal(thread, &goal.objective, StoreStatus::Active, goal.token_budget).await?;
    if goal.tokens_used > 0 || goal.time_used_seconds > 0 {
        goals.account_thread_goal_usage(thread, goal.time_used_seconds, goal.tokens_used, GoalAccountingMode::ActiveOnly, None).await?;
    }
    if goal.status != StoreStatus::Active {
        goals.update_thread_goal(thread, codex_state::GoalUpdate { objective: None, status: Some(goal.status), token_budget: None, expected_goal_id: None }).await?;
    }

    let extension = Extension::install(Arc::clone(&runtime), thread, None, Arc::downgrade(&test.thread_manager)).await?;
    let answer = match want.kind.as_str() {
        "continuation" => {
            extension.thread_idle().await;
            let sent = wait_for_request(&mock, 1, Duration::from_secs(8)).await;
            match sent {
                None => {
                    let now = goals.get_thread_goal(thread).await?;
                    json!({ "continue": false, "status": now.map(|g| g.status.as_str().to_string()) })
                }
                Some(body) => {
                    let (steering, context) = goal_parts(&body);
                    json!({ "continue": true, "prompt": steering.last(), "goal_objective_context": context, "update_plan": update_plan })
                }
            }
        }
        "objective_updated" | "budget_limit" => {
            // Codex injects these into a turn that is running: start one, then make the change while it runs.
            test.codex.start_or_steer_turn(TurnInputRequest::user_input(vec![UserInput::Text { text: "work on the goal".to_string(), text_elements: Vec::new() }])).await?;
            let turn = match next_matching(&test.codex, Duration::from_secs(5), |event| matches!(event, EventMsg::TurnStarted(_))).await {
                Some(EventMsg::TurnStarted(e)) => e.turn_id,
                _ => anyhow::bail!("Codex's thread didn't start a turn"),
            };
            extension.start_turn(&turn, &TokenUsage::default()).await;
            if want.kind == "objective_updated" {
                let objective = want.new_objective.clone().ok_or_else(|| anyhow::anyhow!("objective_updated needs new_objective"))?;
                extension.user_set(Some(&objective), None, None, None).await?;
            } else {
                let budget = goal.token_budget.ok_or_else(|| anyhow::anyhow!("budget_limit needs a goal with a token budget"))?;
                let over = (budget - goal.tokens_used).max(0) + 1;
                extension.record_usage(&turn, &TokenUsage { input_tokens: over, total_tokens: over, ..TokenUsage::default() }).await;
                // Codex accounts usage when a tool call finishes (or the turn stops), which is when it steers.
                extension.finish_tool(&turn, "guardian-call", "shell", true).await;
            }
            let _ = next_matching(&test.codex, Duration::from_secs(12), |event| matches!(event, EventMsg::TurnComplete(_))).await;
            let mut prompts = Vec::new();
            for request in mock.requests() {
                prompts.extend(goal_parts(&request.body_json()).0);
            }
            let now = goals.get_thread_goal(thread).await?;
            json!({ "prompt": prompts.last(), "status": now.map(|g| g.status.as_str().to_string()), "requests": mock.requests().len() })
        }
        other => anyhow::bail!("unknown steering kind {other:?}"),
    };
    let _ = tokio::time::timeout(Duration::from_secs(5), test.codex.shutdown_and_wait()).await;
    Ok(json!({ "kind": want.kind, "from": "Codex's own thread, runtime and steering code; its model endpoint was a local capture", "answer": answer }))
}

/// The next event from Codex's thread that matches, or none within the time.
async fn next_matching(codex: &CodexThread, within: Duration, mut wanted: impl FnMut(&EventMsg) -> bool) -> Option<EventMsg> {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        match tokio::time::timeout_at(deadline, codex.next_event()).await {
            Ok(Ok(event)) if wanted(&event.msg) => return Some(event.msg),
            Ok(Ok(_)) => continue,
            _ => return None,
        }
    }
}

async fn wait_for_request(mock: &core_test_support::responses::ResponseMock, count: usize, within: Duration) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        let requests = mock.requests();
        if requests.len() >= count {
            return Some(requests[count - 1].body_json());
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

impl Extension {
    /// Tell Codex's extension its thread is idle: the moment it decides whether to continue the goal.
    pub async fn thread_idle(&self) {
        for contributor in self.lifecycle() {
            contributor.on_thread_idle(ThreadIdleInput { cause: ThreadIdleCause::Completed, session_store: self.session_store(), thread_store: self.thread_store() }).await;
        }
    }
}
