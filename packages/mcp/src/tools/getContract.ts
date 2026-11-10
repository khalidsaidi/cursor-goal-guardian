import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readContractSafe, workspaceRoot } from "../workspace.js";

export function registerGetContract(server: McpServer): void {
  server.registerTool(
    "guardian_get_contract",
    {
      description: "Read the goal contract: goal, 'done when' items (with ids) and boundaries. Call this to prime yourself on what this session is for.",
      inputSchema: {},
    },
    async () => {
      const contract = await readContractSafe(await workspaceRoot());
      const result = { goal: contract.goal, successCriteria: contract.successCriteria, constraints: contract.constraints };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
