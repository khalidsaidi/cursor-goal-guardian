import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CODEX_TOOLS, createGoalByTool, type EngineToolDefinition } from "@goal-guardian/core";
import { workspaceRoot } from "../workspace.js";
import { theirField } from "./theirs.js";

/**
 * create_goal, under both projects' descriptions: Codex's own handler and DeepSeek Harness's own tool (through its
 * tool pipeline) each run the call. Guardian's rule comes first: the objective has to be the user's own words.
 */
export function registerCreateGoal(server: McpServer, def: EngineToolDefinition): void {
  server.registerTool(
    def.name,
    {
      description: `${CODEX_TOOLS.create.description}\n\nDeepSeek Harness: ${def.description}\n\nGuardian: the call goes to Codex's own create_goal handler and to DeepSeek's own create_goal tool, and a goal is created only if both accept; their answers come back as "codex" and "their". Guardian records the user's request as the goal by itself when you first change something, so you rarely need this. The objective must be the user's own words, quoted from their message. No token budget is set through this tool.`,
      inputSchema: { objective: theirField(def, "objective"), max_goal_rounds: theirField(def, "max_goal_rounds") },
    },
    async ({ objective, max_goal_rounds }) => {
      const out = await createGoalByTool(await workspaceRoot(), String(objective ?? ""), typeof max_goal_rounds === "number" ? max_goal_rounds : undefined);
      return { ...(out.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: out.text }] };
    },
  );
}
