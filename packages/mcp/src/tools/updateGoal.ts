import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dispatch, StateError } from "@goal-guardian/core";
import { readStateSafe, workspaceRoot } from "../workspace.js";

export function registerUpdateGoal(server: McpServer): void {
  server.registerTool(
    "guardian_update_goal",
    {
      description:
        "Declare or change the session goal, add 'done when' criteria (each becomes a trackable task), or set boundaries. Use this when the user states or changes what the session is for — the chat is the interface; this puts it on the record.",
      inputSchema: {
        goal: z.string().optional().describe("The goal, one unambiguous sentence. Omit to leave unchanged."),
        add_criteria: z
          .array(z.string().min(1))
          .optional()
          .describe("New 'done when' criteria to add; each becomes a task."),
        constraints: z.array(z.string()).optional().describe("Replaces the boundaries list. Omit to leave unchanged."),
      },
    },
    async ({ goal, add_criteria, constraints }) => {
      const root = await workspaceRoot();
      try {
        const current = await readStateSafe(root);
        const payload: Record<string, unknown> = {};
        if (goal !== undefined) payload.goal = goal;
        if (constraints !== undefined) payload.constraints = constraints;

        let criteria = current.successCriteria;
        if (add_criteria && add_criteria.length > 0) {
          const next = [...criteria];
          for (const text of add_criteria) {
            next.push({ id: `sc_${next.length + 1}`, text });
          }
          payload.successCriteria = next;
          criteria = next;
        }

        let state = current;
        if (Object.keys(payload).length > 0) {
          state = await dispatch(root, { type: "SET_GOAL", actor: "agent", payload });
        }
        if (add_criteria && add_criteria.length > 0) {
          const added = criteria.slice(-add_criteria.length);
          state = await dispatch(root, {
            type: "ADD_TASKS",
            actor: "agent",
            payload: { tasks: added.map((c) => ({ id: c.id, title: c.text, criterionId: c.id })) },
          });
          if (!state.activeTaskId) {
            const first = state.tasks.find((t) => t.status === "todo");
            if (first) state = await dispatch(root, { type: "START_TASK", actor: "agent", payload: { taskId: first.id } });
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                goal: state.goal,
                criteria: state.successCriteria,
                constraints: state.constraints,
                activeTaskId: state.activeTaskId,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof StateError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    },
  );
}
