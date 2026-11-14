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
      description: `${CODEX_TOOLS.create.description}\n\nDeepSeek Harness: ${def.description}\n\nGuardian: DeepSeek owns creation and authority; the accepted goal is copied into Codex's accounting store for budgets and continuation context. For requested project changes with no goal on record, call this before inspection or edits so unfinished work can be continued even before its first change. Guardian also captures the request on the first change as a fallback. Questions alone need no goal. Quote the user's request; Guardian preserves their full recorded message. No token budget is set through this tool.`,
      inputSchema: { objective: theirField(def, "objective"), max_goal_rounds: theirField(def, "max_goal_rounds") },
    },
    async ({ objective, max_goal_rounds }) => {
      const out = await createGoalByTool(await workspaceRoot(), String(objective ?? ""), typeof max_goal_rounds === "number" ? max_goal_rounds : undefined);
      return { ...(out.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: out.text }] };
    },
  );
}
