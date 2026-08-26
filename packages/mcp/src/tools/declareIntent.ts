import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appendAudit, newId, nowIso, taskScopeKeywords } from "@goal-guardian/core";
import { readStateSafe, workspaceRoot } from "../workspace.js";

export function registerDeclareIntent(server: McpServer): void {
  server.registerTool(
    "guardian_declare_intent",
    {
      description:
        "Optionally record what you are about to do and why, so the session tape shows your intent next to your actions. Pure telemetry: nothing is granted or gated. Returns the active task's scope keywords for a quick self-check.",
      inputSchema: {
        summary: z.string().min(1).describe("One sentence: what you are about to do."),
        taskId: z.string().optional().describe("The task this work serves, if known."),
        plannedActions: z.array(z.string()).optional().describe("Optional list of concrete actions you expect to take."),
      },
    },
    async ({ summary, taskId, plannedActions }) => {
      const root = await workspaceRoot();
      const intentId = newId("int");
      await appendAudit(root, {
        ts: nowIso(),
        kind: "intent.declared",
        intentId,
        ...(taskId ? { taskId } : {}),
        summary,
        ...(plannedActions && plannedActions.length ? { plannedActions } : {}),
      });
      const state = await readStateSafe(root);
      const activeTask = state.activeTaskId
        ? state.tasks.find((t) => t.id === state.activeTaskId) ?? null
        : null;
      const result = {
        intentId,
        activeTask: activeTask ? { id: activeTask.id, title: activeTask.title } : null,
        taskScopeKeywords: taskScopeKeywords(state),
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
