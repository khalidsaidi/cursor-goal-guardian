import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createGoalByTool, type EngineToolDefinition } from "@goal-guardian/core";
import { workspaceRoot } from "../workspace.js";
import { theirField } from "./theirs.js";

/**
 * DeepSeek Harness's create_goal: its own tool, run through its own tool pipeline, by its own name, description and
 * parameters. Guardian's rule comes first: the objective has to be the user's own words.
 */
export function registerCreateGoal(server: McpServer, def: EngineToolDefinition): void {
  server.registerTool(
    def.name,
    {
      description: `${def.description}\n\nGuardian: it records the user's request as the goal by itself when you first change something, so you rarely need this. The objective must be the user's own words, quoted from their message.`,
      inputSchema: { objective: theirField(def, "objective"), max_goal_rounds: theirField(def, "max_goal_rounds") },
    },
    async ({ objective, max_goal_rounds }) => {
      const out = await createGoalByTool(await workspaceRoot(), String(objective ?? ""), typeof max_goal_rounds === "number" ? max_goal_rounds : undefined);
      return { ...(out.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: out.text }] };
    },
  );
}
