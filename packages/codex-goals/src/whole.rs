//! Codex's whole goal extension, run as it is.
//!
//! Everything here goes through Codex's own public entry points, the way its own tests
//! (codex-rs/ext/goal/tests/goal_extension_backend.rs) and its app-server do: `install_with_backend` puts the
//! goal extension into an extension registry; the registry's contributors are then driven with the same
//! lifecycle calls Codex's agent makes (thread start, turn start, token usage, tool finish, turn stop), its tool
//! executors handle the tool calls, and its `GoalService` applies user-facing goal changes.
//!
//! Nothing of Codex's is reimplemented. This file only builds the inputs those calls take and turns their
//! outputs into JSON.
use codex_analytics::AnalyticsEventsClient;
use codex_extension_api::{
    ExtensionData, ExtensionEventSink, ExtensionRegistry, ExtensionRegistryBuilder, ExtensionWarning, FunctionCallError, NoopTurnItemEmitter, ThreadStartInput, ToolCall, ToolCallOutcome, ToolCallSource, ToolExecutor, ToolFinishInput, ToolPayload,
    TurnStartInput, TurnStopInput,
};
use codex_goal_extension::{GoalExtensionConfig, GoalObjectiveUpdate, GoalService, GoalSetRequest, GoalTokenBudgetUpdate, install_with_backend};
use codex_protocol::ThreadId;
use codex_protocol::config_types::{CollaborationMode, ModeKind, Settings};
use codex_protocol::protocol::{Event, EventMsg, SessionSource, ThreadGoalStatus, TokenUsage, TokenUsageInfo, TruncationPolicy};
use codex_state::StateRuntime;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, PoisonError, Weak};

type Tool = Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>;

/// Keeps what Codex's extension emits, so the caller sees it.
#[derive(Debug, Default)]
struct Sink {
    events: Mutex<Vec<Event>>,
    warnings: Mutex<Vec<String>>,
}

impl ExtensionEventSink for Sink {
    fn emit(&self, event: Event) {
        self.events.lock().unwrap_or_else(PoisonError::into_inner).push(event);
    }
    fn emit_warning(&self, warning: ExtensionWarning) {
        self.warnings.lock().unwrap_or_else(PoisonError::into_inner).push(format!("{warning:?}"));
    }
}

/// Codex's goal extension installed for one thread, as its own test harness installs it.
pub struct Extension {
    registry: Arc<ExtensionRegistry<()>>,
    session_store: ExtensionData,
    thread_store: ExtensionData,
    pub goal_service: Arc<GoalService>,
    sink: Arc<Sink>,
    pub runtime: Arc<StateRuntime>,
    pub thread: ThreadId,
}

impl Extension {
    /// `thread_manager` is Codex's own thread manager when one is running (see continuation.rs); `Weak::new()`
    /// otherwise, which is what Codex's own extension tests pass.
    pub async fn install(runtime: Arc<StateRuntime>, thread: ThreadId, max_goal_token_budget: Option<i64>, thread_manager: Weak<codex_core::ThreadManager>) -> anyhow::Result<Self> {
        seed_thread(&runtime, thread).await?;
        let sink = Arc::new(Sink::default());
        let mut builder = ExtensionRegistryBuilder::<()>::with_event_sink(sink.clone());
        let goal_service = Arc::new(GoalService::new());
        install_with_backend(&mut builder, Arc::clone(&runtime), AnalyticsEventsClient::disabled(), None, thread_manager, Arc::clone(&goal_service), move |_| GoalExtensionConfig { enabled: true, max_goal_token_budget });
        let registry = Arc::new(builder.build());
        let session_store = ExtensionData::new(thread.to_string());
        let thread_store = ExtensionData::new(thread.to_string());
        let session_source = SessionSource::Cli;
        for contributor in registry.thread_lifecycle_contributors() {
            contributor
                .on_thread_start(ThreadStartInput { config: &(), session_source: &session_source, persistent_thread_state_available: true, environments: &[], mcp_resource_client: None, extension_metrics: None, session_store: &session_store, thread_store: &thread_store })
                .await;
        }
        Ok(Self { registry, session_store, thread_store, goal_service, sink, runtime, thread })
    }

    pub fn lifecycle(&self) -> &[Arc<dyn codex_extension_api::ThreadLifecycleContributor<()>>] {
        self.registry.thread_lifecycle_contributors()
    }
    pub fn session_store(&self) -> &ExtensionData {
        &self.session_store
    }
    pub fn thread_store(&self) -> &ExtensionData {
        &self.thread_store
    }

    fn tools(&self) -> Vec<Tool> {
        self.registry.tool_contributors().iter().flat_map(|c| c.tools(&self.session_store, &self.thread_store)).collect()
    }

    /// Codex's tool definitions, from its own executors: names, descriptions and JSON schemas.
    pub fn tool_specs(&self) -> anyhow::Result<Value> {
        let mut specs = Vec::new();
        for tool in self.tools() {
            specs.push(json!({ "name": tool.tool_name().name, "spec": serde_json::to_value(tool.spec())? }));
        }
        Ok(Value::Array(specs))
    }

    pub async fn start_turn(&self, turn_id: &str, usage: &TokenUsage) {
        let turn_store = ExtensionData::new(turn_id);
        let collaboration_mode = CollaborationMode { mode: ModeKind::Default, settings: Settings { model: "cursor".to_string(), reasoning_effort: None, developer_instructions: None } };
        for contributor in self.registry.turn_lifecycle_contributors() {
            contributor
                .on_turn_start(TurnStartInput { turn_id, collaboration_mode: &collaboration_mode, token_usage_at_turn_start: Some(usage), session_store: &self.session_store, thread_store: &self.thread_store, turn_store: &turn_store })
                .await;
        }
    }

    pub async fn record_usage(&self, turn_id: &str, total: &TokenUsage) {
        let turn_store = ExtensionData::new(turn_id);
        let info = TokenUsageInfo { total_token_usage: total.clone(), last_usage_includes_reasoning: None, last_token_usage: TokenUsage::default(), model_context_window: None };
        for contributor in self.registry.token_usage_contributors() {
            contributor.on_token_usage(&self.session_store, &self.thread_store, &turn_store, &info).await;
        }
    }

    pub async fn finish_tool(&self, turn_id: &str, call_id: &str, tool_name: &str, success: bool) {
        let turn_store = ExtensionData::new(turn_id);
        let tool_name = codex_extension_api::ToolName::plain(tool_name);
        for contributor in self.registry.tool_lifecycle_contributors() {
            contributor
                .on_tool_finish(ToolFinishInput { session_store: &self.session_store, thread_store: &self.thread_store, turn_store: &turn_store, turn_id, call_id, tool_name: &tool_name, source: ToolCallSource::Direct, outcome: ToolCallOutcome::Completed { success } })
                .await;
        }
    }

    pub async fn stop_turn(&self, turn_id: &str) {
        let turn_store = ExtensionData::new(turn_id);
        for contributor in self.registry.turn_lifecycle_contributors() {
            contributor.on_turn_stop(TurnStopInput { session_store: &self.session_store, thread_store: &self.thread_store, turn_store: &turn_store }).await;
        }
    }

    /// One tool call through Codex's real handler. A refusal is Codex's own text for the model.
    pub async fn call_tool(&self, turn_id: &str, name: &str, arguments: &Value) -> anyhow::Result<Value> {
        let tools = self.tools();
        let Some(tool) = tools.iter().find(|t| t.tool_name().namespace.is_none() && t.tool_name().name == name) else {
            anyhow::bail!("Codex's goal extension has no tool named {name:?}");
        };
        let call_id = format!("call-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        let call = ToolCall {
            turn_id: turn_id.to_string(),
            call_id: call_id.clone(),
            tool_name: codex_extension_api::ToolName::plain(name),
            model: "cursor".to_string(),
            codex_turn_metadata: None,
            truncation_policy: TruncationPolicy::Bytes(64 * 1024),
            source: ToolCallSource::Direct,
            conversation_history: codex_extension_api::ConversationHistory::default(),
            turn_item_emitter: Arc::new(NoopTurnItemEmitter),
            attachment_store: codex_core::passthrough_image_store(),
            ephemeral: false,
            environments: Vec::new(),
            payload: ToolPayload::Function { arguments: arguments.to_string() },
        };
        let payload = call.payload.clone();
        let answer = match tool.handle(call).await {
            Ok(output) => json!({ "accepted": true, "result": output.code_mode_result(&payload), "model_output": serde_json::to_value(output.to_response_item(&call_id, &payload))? }),
            Err(FunctionCallError::RespondToModel(text)) => json!({ "accepted": false, "refusal": text }),
            Err(other) => json!({ "accepted": false, "refusal": other.to_string(), "fatal": true }),
        };
        self.finish_tool(turn_id, &call_id, name, answer["accepted"] == true).await;
        Ok(answer)
    }

    /// A goal change made by the user, through Codex's `GoalService`, as its app-server's thread/goal/set does.
    pub async fn user_set(&self, objective: Option<&str>, status: Option<ThreadGoalStatus>, token_budget: Option<Option<i64>>, max_goal_token_budget: Option<i64>) -> anyhow::Result<codex_protocol::protocol::ThreadGoal> {
        let request = GoalSetRequest {
            thread_id: self.thread,
            objective: objective.map_or(GoalObjectiveUpdate::Keep, GoalObjectiveUpdate::Set),
            status,
            token_budget: token_budget.map_or(GoalTokenBudgetUpdate::Keep, GoalTokenBudgetUpdate::Set),
            max_goal_token_budget,
        };
        let outcome = self.goal_service.set_thread_goal(&self.runtime, request, async { Ok(()) }).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        outcome.apply_runtime_effects(&self.goal_service).await;
        Ok(outcome.goal)
    }

    pub async fn user_clear(&self) -> anyhow::Result<bool> {
        self.goal_service.clear_thread_goal(&self.runtime, self.thread, async { Ok(()) }).await.map_err(|e| anyhow::anyhow!("{e}"))
    }

    /// What the extension emitted since it was installed: its goal-updated events, as Codex's clients receive them.
    pub fn events(&self) -> Value {
        let events = self.sink.events.lock().unwrap_or_else(PoisonError::into_inner);
        let goals: Vec<Value> = events
            .iter()
            .filter_map(|event| match &event.msg {
                EventMsg::ThreadGoalUpdated(updated) => serde_json::to_value(updated).ok(),
                _ => None,
            })
            .collect();
        let warnings = self.sink.warnings.lock().unwrap_or_else(PoisonError::into_inner).clone();
        json!({ "goal_updated": goals, "warnings": warnings })
    }
}

/// Codex's tools fill an empty thread preview from the objective, so the thread needs its row, as in Codex's tests.
async fn seed_thread(runtime: &StateRuntime, thread: ThreadId) -> anyhow::Result<()> {
    if runtime.get_thread(thread).await?.is_some() {
        return Ok(());
    }
    let builder = codex_state::ThreadMetadataBuilder::new(thread, runtime.sqlite().home().join(format!("rollout-{thread}.jsonl")), chrono::Utc::now(), SessionSource::Cli);
    runtime.upsert_thread(&builder.build("goal-guardian")).await
}

pub fn usage_of(request: &Value) -> TokenUsage {
    let n = |key: &str| request.get(key).and_then(Value::as_i64).unwrap_or(0);
    let input = n("input_tokens");
    let output = n("output_tokens");
    TokenUsage { input_tokens: input, cached_input_tokens: n("cached_input_tokens"), output_tokens: output, reasoning_output_tokens: n("reasoning_output_tokens"), total_tokens: request.get("total_tokens").and_then(Value::as_i64).unwrap_or(input + output), ..TokenUsage::default() }
}
