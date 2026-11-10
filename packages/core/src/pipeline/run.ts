import { appendAudit } from "../audit/log.js";
import { nowIso } from "../clock.js";
import type { HookEventName } from "../schema/audit.js";
import { advisoryAllow, type HookResponse } from "./outcome.js";

export interface PipelineMeta {
  conversationId?: string;
  generationId?: string;
}

export type PipelineActionType = "shell" | "mcp" | "edit";

/** One pipeline for every action: record it, say nothing, allow. The goal loop reads this tape. */
export async function runPipeline(
  root: string,
  event: HookEventName,
  actionType: PipelineActionType,
  actionValue: string,
  ids: PipelineMeta = {},
): Promise<HookResponse> {
  await appendAudit(root, { ts: nowIso(), kind: "hook.event", event, ...ids });
  if (actionValue.trim()) {
    await appendAudit(root, {
      ts: nowIso(),
      kind: "action.observed",
      actionType,
      actionValue: actionValue.slice(0, 300),
      ...(ids.conversationId ? { conversationId: ids.conversationId } : {}),
    });
  }
  return advisoryAllow();
}
