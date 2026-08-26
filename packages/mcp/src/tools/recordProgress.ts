import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dispatch, StateError } from "@goal-guardian/core";
import { workspaceRoot } from "../workspace.js";

export function registerRecordProgress(server: McpServer): void {
  server.registerTool(
    "guardian_record_progress",
    {
      description:
        "Record a task transition on the session tape: start a task or complete one. Switching away from an active task requires a decision (text + rationale) — the state machine rejects undocumented pivots. This records progress; it grants nothing.",
      inputSchema: {
        action: z.enum(["start_task", "complete_task"]).describe("The transition to record."),
        taskId: z.string().min(1).describe("The task id (see guardian_get_status for the board)."),
        decision: z
          .object({
            text: z.string().min(1).describe("What you decided."),
            rationale: z.string().min(1).describe("Why."),
          })
          .optional()
          .describe("Required when starting a task while a different one is active."),
      },
    },
    async ({ action, taskId, decision }) => {
      const root = workspaceRoot();
      try {
        if (action === "start_task") {
          let decisionId: string | undefined;
          if (decision) {
            const state = await dispatch(root, {
              type: "ADD_DECISION",
              actor: "agent",
              payload: { text: decision.text, rationale: decision.rationale },
            });
            decisionId = state.decisions[state.decisions.length - 1]?.id;
          }
          const state = await dispatch(root, {
            type: "START_TASK",
            actor: "agent",
            payload: { taskId, ...(decisionId ? { decisionId } : {}) },
          });
          return ok({ activeTaskId: state.activeTaskId });
        }
        const state = await dispatch(root, { type: "COMPLETE_TASK", actor: "agent", payload: { taskId } });
        return ok({
          completed: taskId,
          remainingTodo: state.tasks.filter((t) => t.status === "todo").map((t) => ({ id: t.id, title: t.title })),
        });
      } catch (err) {
        const message =
          err instanceof StateError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    },
  );
}

function ok(payload: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}
