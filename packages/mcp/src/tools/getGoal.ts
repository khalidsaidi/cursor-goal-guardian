import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guardContract, CODEX_TOOLS, codexGetGoal, goalBudget, goalPhaseOf, readGoalRecords, runGoalTool, type EngineToolDefinition } from "@goal-guardian/core";
import { readContractSafe, workspaceRoot } from "../workspace.js";

/** Codex's get_goal, by its own name and description. Guardian's goal also carries the user's "done when" list. */
export function registerGetGoal(server: McpServer, theirs: EngineToolDefinition): void {
  server.registerTool(
    CODEX_TOOLS.get.name,
    {
      description: `${CODEX_TOOLS.get.description}\n\nDeepSeek Harness: ${theirs.description}\n\nGuardian: the "their" field is DeepSeek's own get_goal answer, and "codex" is Codex's own, from its real handler. the goal is the user's own request, recorded word for word, with its 'done when' items and their ids. Usage and any token budget come from Codex's own goal store.`,
      inputSchema: {},
    },
    async () => {
      const root = await workspaceRoot();
      // The goal is the user's: a goal file changed by anything else is put back before it is read or built on.
      await guardContract(root).catch(() => false);
      const contract = await readContractSafe(root);
      const records = await readGoalRecords(root);
      const status = goalPhaseOf(records, contract);
      if (status === "none") return { content: [{ type: "text", text: JSON.stringify({ goal: null }) }] };
      // Usage as Codex's store counted it; where the store isn't installed, the tokens Guardian saw and no budget.
      const stored = await goalBudget(root);
      const usage = stored
        ? { tokens_used: stored.tokens_used, token_budget: stored.token_budget, time_used_seconds: stored.time_used_seconds, remaining_tokens: stored.token_budget === null ? null : Math.max(stored.token_budget - stored.tokens_used, 0), budget_status: stored.status }
        : { tokens_used: records.reduce((sum, r) => sum + (r.kind === "goal.round" ? (r.tokens ?? 0) : 0), 0), token_budget: null };
      const goal = { objective: contract.goal, done_when: contract.successCriteria, status, constraints: contract.constraints, ...usage };
      // DeepSeek Harness's own get_goal, through its tool pipeline: the id and revision its update_goal takes.
      const theirs = await runGoalTool(root, "get_goal", {});
      let their: unknown = theirs.text;
      try {
        their = JSON.parse(theirs.text);
      } catch {
        // their error text, as it is
      }
      // Codex's own get_goal, through its real handler, where its extension is installed.
      const codex = await codexGetGoal(root);
      return { content: [{ type: "text", text: JSON.stringify({ goal, their, ...(codex !== undefined ? { codex } : {}) }) }] };
    },
  );
}
