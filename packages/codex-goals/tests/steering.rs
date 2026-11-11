//! Codex's continuation scheduling through the built binary: one process per request, as Guardian runs it.
use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};

fn ask(home: &std::path::Path, request: Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_goal-guardian-codex-goals")).arg("--home").arg(home).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(request.to_string().as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(text.lines().last().unwrap_or("")).unwrap_or_else(|_| panic!("no JSON answer: {text}"))
}

fn template(name: &str) -> Option<String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../third_party/codex/codex-rs/ext/goal/templates/goals").join(name);
    std::fs::read_to_string(path).ok()
}

fn temp_home(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("gg-codex-steering-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn codex_decides_to_continue_and_its_own_prompt_comes_back() {
    let home = temp_home("continue");
    assert_eq!(ask(&home, json!({"op": "steering"}))["steering"], Value::Null);
    ask(&home, json!({"op": "user_goal", "objective": "Add CSV export", "token_budget": 5000}));
    ask(&home, json!({"op": "turn", "turn_id": "t1", "usage": {"input_tokens": 400, "output_tokens": 50}}));
    let answer = ask(&home, json!({"op": "steering", "kind": "continuation"}));
    let got = &answer["steering"]["answer"];
    assert_eq!(got["continue"], true);
    assert_eq!(got["goal_objective_context"]["name"], "goal_objective");
    assert_eq!(got["goal_objective_context"]["output"], "Add CSV export");
    let prompt = got["prompt"].as_str().unwrap();
    assert!(prompt.contains("- Tokens used: 450\n- Token budget: 5000\n- Tokens remaining: 4550"));
    assert!(!prompt.contains("update_plan"));
    // Word for word Codex's template, less the update_plan paragraph it drops itself, when the vendored copy is there.
    if let Some(template) = template("continuation.md") {
        let expected = template.replace("{{ tokens_used }}", "450").replace("{{ token_budget }}", "5000").replace("{{ remaining_tokens }}", "4550");
        let start = expected.find("Progress visibility:").unwrap();
        let end = start + expected[start..].find("\n\n").unwrap() + 2;
        let expected = format!("{}{}", &expected[..start], &expected[end..]);
        assert_eq!(prompt, expected.trim());
    }
    // With update_plan available Codex keeps that paragraph.
    let with_plan = ask(&home, json!({"op": "steering", "kind": "continuation", "update_plan": true}));
    assert!(with_plan["steering"]["answer"]["prompt"].as_str().unwrap().contains("If update_plan is available"));
    // A goal that isn't active is not continued: Codex's decision.
    ask(&home, json!({"op": "user_goal", "status": "paused"}));
    assert_eq!(ask(&home, json!({"op": "steering", "kind": "continuation"}))["steering"]["answer"]["continue"], false);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn codex_steers_a_running_turn_when_the_objective_changes_or_the_budget_runs_out() {
    let home = temp_home("midturn");
    ask(&home, json!({"op": "user_goal", "objective": "Add CSV export", "token_budget": 5000}));
    let edited = ask(&home, json!({"op": "steering", "kind": "objective_updated", "new_objective": "Add CSV and JSON export"}));
    let prompt = edited["steering"]["answer"]["prompt"].as_str().unwrap();
    assert!(prompt.starts_with("The active thread goal objective was edited by the user."));
    assert!(prompt.contains("<untrusted_objective>\nAdd CSV and JSON export\n</untrusted_objective>"));
    let limited = ask(&home, json!({"op": "steering", "kind": "budget_limit"}));
    assert_eq!(limited["steering"]["answer"]["status"], "budget_limited");
    let prompt = limited["steering"]["answer"]["prompt"].as_str().unwrap();
    assert!(prompt.starts_with("The active thread goal has reached its token budget."));
    if let Some(template) = template("budget_limit.md") {
        let expected = template.replace("{{ objective }}", "Add CSV export").replace("{{ time_used_seconds }}", "0").replace("{{ tokens_used }}", "5001").replace("{{ token_budget }}", "5000");
        assert_eq!(prompt, expected.trim());
    }
    let _ = std::fs::remove_dir_all(&home);
}
