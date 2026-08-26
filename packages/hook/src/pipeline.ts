import {
  appendAudit,
  assignEpisode,
  evaluateLexicalDrift,
  evaluatePolicy,
  loadEpisodes,
  saveEpisodes,
  newId,
  nowIso,
  readConfigSafe,
  readStateSafe,
  type DriftActionType,
  type GuardianConfig,
  type GuardianState,
  type HookEventName,
  type PolicyActionKind,
} from "@goal-guardian/core";
import { advisoryAllow, advisoryNudge, type HookResponse } from "./respond.js";

function hasActiveDoingTask(state: GuardianState): boolean {
  if (!state.activeTaskId) return false;
  return state.tasks.some((t) => t.id === state.activeTaskId && t.status === "doing");
}

function truncate(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * One pipeline for every event. Everything is recorded; at most one calm
 * sentence is ever injected, chosen by priority: policy alert, then a new
 * drift episode, then the no-active-task reminder. Every path allows.
 */
export async function runPipeline(
  root: string,
  event: HookEventName,
  actionType: DriftActionType,
  actionValue: string,
): Promise<HookResponse> {
  await appendAudit(root, { ts: nowIso(), kind: "hook.event", event });

  const config = await readConfigSafe(root);
  const state = await readStateSafe(root);

  const advisory =
    actionType === "edit" ? null : evaluatePolicy(actionType as PolicyActionKind, actionValue, config);
  if (advisory && advisory.severity !== "ok") {
    await appendAudit(root, {
      ts: nowIso(),
      kind: "policy.advisory",
      severity: advisory.severity,
      actionType: actionType as PolicyActionKind,
      actionValue,
      rule: advisory.rule,
      reason: advisory.reason,
    });
  }

  const drift = evaluateLexicalDrift(state, config, actionType, actionValue);
  let driftNudge = false;
  if (drift) {
    const episodes = await loadEpisodes(root);
    const assignment = assignEpisode(episodes, { taskId: drift.activeTaskId, terms: drift.actionTerms }, config);
    await saveEpisodes(root, assignment.store);
    driftNudge = assignment.shouldNudge;
    await appendAudit(root, {
      ts: nowIso(),
      kind: "drift.lexical",
      driftId: newId("drift"),
      episodeId: assignment.episodeId,
      actionType,
      actionValue,
      activeTaskId: drift.activeTaskId,
      activeTaskTitle: drift.activeTaskTitle,
      taskTerms: drift.taskTerms,
      actionTerms: drift.actionTerms,
      confidence: drift.confidence,
    });
  }

  if (config.notify === "quiet") return advisoryAllow();

  if (advisory && advisory.severity === "alert") {
    return advisoryNudge(`heads up — "${truncate(actionValue)}" matches a high-risk pattern${advisory.reason ? `: ${advisory.reason.toLowerCase()}` : ""}`);
  }

  if (drift && driftNudge) {
    return advisoryNudge(`this looks outside "${truncate(drift.activeTaskTitle, 40)}" — worth a quick check`);
  }

  const bootstrapPath = (actionType === "read" || actionType === "edit") && actionValue.startsWith(".cursor/");
  if (config.advisories.remindWhenNoActiveTask && !hasActiveDoingTask(state) && !bootstrapPath) {
    const reminder = await reminderNudge(root, config);
    if (reminder) return reminder;
  }

  return advisoryAllow();
}

/** The no-active-task reminder shares the episode governor so it can never spam. */
async function reminderNudge(root: string, config: GuardianConfig): Promise<HookResponse | null> {
  const episodes = await loadEpisodes(root);
  const assignment = assignEpisode(episodes, { taskId: "", terms: ["no-active-task"] }, config);
  await saveEpisodes(root, assignment.store);
  if (!assignment.shouldNudge) return null;
  return advisoryNudge("no task is active — start one so this session's work has a home");
}
