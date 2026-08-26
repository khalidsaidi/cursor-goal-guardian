import {
  appendAudit,
  assignEpisode,
  evaluateLexicalDrift,
  evaluatePolicy,
  loadEpisodes,
  loadVerdicts,
  readAuditTail,
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
import { advisoryAllow, advisoryAsk, advisoryNudge, type HookResponse } from "./respond.js";

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
  ids: { conversationId?: string; generationId?: string } = {},
): Promise<HookResponse> {
  await appendAudit(root, { ts: nowIso(), kind: "hook.event", event, ...ids });

  const config = await readConfigSafe(root);
  const state = await readStateSafe(root);

  // The raw tape: what session review judges. Reads are skipped (too noisy);
  // shell/mcp/edit is what work is made of.
  if (actionType !== "read" && actionValue.trim()) {
    await appendAudit(root, {
      ts: nowIso(),
      kind: "action.observed",
      actionType,
      actionValue: actionValue.slice(0, 300),
    });
  }

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
  let driftEpisodeId: string | null = null;
  if (drift) {
    const episodes = await loadEpisodes(root);
    const assignment = assignEpisode(episodes, { taskId: drift.activeTaskId, terms: drift.actionTerms }, config);
    await saveEpisodes(root, assignment.store);
    driftNudge = assignment.shouldNudge;
    driftEpisodeId = assignment.episodeId;
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

  // Opt-in escalation: the nudge for this episode is already spent AND the
  // judge has confirmed earlier drift in the same episode -> hand the call to
  // the human via the editor's confirmation UI (never a deny).
  if (drift && !driftNudge && driftEpisodeId && config.advisories.escalateConfirmedDrift === "ask") {
    if (await episodeHasConfirmedDrift(root, driftEpisodeId)) {
      return advisoryAsk(
        `continuing confirmed off-goal work (task: "${truncate(drift.activeTaskTitle, 40)}"). Proceed?`,
      );
    }
  }

  const bootstrapPath = (actionType === "read" || actionType === "edit") && actionValue.startsWith(".cursor/");
  if (config.advisories.remindWhenNoActiveTask && !hasActiveDoingTask(state) && !bootstrapPath) {
    const reminder = await reminderNudge(root, config);
    if (reminder) return reminder;
  }

  return advisoryAllow();
}

/** True when any lexical drift in this episode carries a confirmed judge verdict. */
async function episodeHasConfirmedDrift(root: string, episodeId: string): Promise<boolean> {
  const verdicts = await loadVerdicts(root);
  const confirmed = new Set(
    Object.entries(verdicts.entries)
      .filter(([, v]) => v.verdict === "confirmed")
      .map(([driftId]) => driftId),
  );
  if (confirmed.size === 0) return false;
  const records = await readAuditTail(root);
  return records.some((r) => r.kind === "drift.lexical" && r.episodeId === episodeId && confirmed.has(r.driftId));
}

/** The no-active-task reminder shares the episode governor so it can never spam. */
async function reminderNudge(root: string, config: GuardianConfig): Promise<HookResponse | null> {
  const episodes = await loadEpisodes(root);
  const assignment = assignEpisode(episodes, { taskId: "", terms: ["no-active-task"] }, config);
  await saveEpisodes(root, assignment.store);
  if (!assignment.shouldNudge) return null;
  return advisoryNudge("no task is active — start one so this session's work has a home");
}
