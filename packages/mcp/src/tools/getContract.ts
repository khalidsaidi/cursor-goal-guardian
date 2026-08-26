import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readContractSafe, readStateSafe, workspaceRoot } from "../workspace.js";

export function registerGetContract(server: McpServer): void {
  server.registerTool(
    "guardian_get_contract",
    {
      description:
        "Read the goal contract: goal, success criteria (with ids), constraints, the active task, and pinned context. Call this to prime yourself on what this session is for.",
      inputSchema: {},
    },
    async () => {
      const root = await workspaceRoot();
      const contract = await readContractSafe(root);
      const state = await readStateSafe(root);
      const activeTask = state.activeTaskId
        ? state.tasks.find((t) => t.id === state.activeTaskId) ?? null
        : null;
      const result = {
        goal: contract.goal,
        successCriteria: contract.successCriteria,
        constraints: contract.constraints,
        activeTask: activeTask ? { id: activeTask.id, title: activeTask.title, criterionId: activeTask.criterionId ?? null } : null,
        pinnedContext: state.pinnedContext,
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
