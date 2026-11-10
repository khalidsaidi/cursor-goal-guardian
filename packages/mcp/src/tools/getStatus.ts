import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { goalPhaseOf, readContractSafe, readGoalRecords } from "@goal-guardian/core";
import { workspaceRoot } from "../workspace.js";

export function registerGetStatus(server: McpServer): void {
  server.registerTool(
    "guardian_get_status",
    {
      description:
        "Read where the session stands: the goal, and whether it is active, paused or complete.",
      inputSchema: {},
    },
    async () => {
      const root = await workspaceRoot();
      const contract = await readContractSafe(root);
      const goalPhase = goalPhaseOf(await readGoalRecords(root), contract);
      return { content: [{ type: "text", text: JSON.stringify({ goal: contract.goal, goalPhase }) }] };
    },
  );
}
