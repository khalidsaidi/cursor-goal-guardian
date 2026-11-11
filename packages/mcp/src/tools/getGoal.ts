import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CODEX_TOOLS, goalPhaseOf, readGoalRecords } from "@goal-guardian/core";
import { readContractSafe, workspaceRoot } from "../workspace.js";

/** Codex's get_goal, by its own name and description. Guardian's goal also carries the user's "done when" list. */
export function registerGetGoal(server: McpServer): void {
  server.registerTool(
    CODEX_TOOLS.get.name,
    {
      description: `${CODEX_TOOLS.get.description}\n\nGuardian: the goal is the user's own request, recorded word for word, with its 'done when' items and their ids. There is no token budget.`,
      inputSchema: {},
    },
    async () => {
      const root = await workspaceRoot();
      const contract = await readContractSafe(root);
      const records = await readGoalRecords(root);
      const status = goalPhaseOf(records, contract);
      if (status === "none") return { content: [{ type: "text", text: JSON.stringify({ goal: null }) }] };
      const tokensUsed = records.reduce((sum, r) => sum + (r.kind === "goal.round" ? (r.tokens ?? 0) : 0), 0);
      const goal = { objective: contract.goal, done_when: contract.successCriteria, status, constraints: contract.constraints, tokens_used: tokensUsed, token_budget: null };
      return { content: [{ type: "text", text: JSON.stringify({ goal }) }] };
    },
  );
}
