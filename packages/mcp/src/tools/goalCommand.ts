import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runUserGoalCommand } from "@goal-guardian/core";
import { workspaceRoot } from "../workspace.js";

/** DeepSeek Harness's /goal command, run by its own command handler. The answer is its own text. */
export function registerGoalCommand(server: McpServer): void {
  server.registerTool(
    "goal_command",
    {
      description:
        "Run DeepSeek Harness's /goal command for the user and return its answer. Pass what the user typed after the command: empty shows the goal, or `<objective>`, `edit <objective>`, `pause`, `resume`, `clear`. Anything but the empty status view must be in the user's latest message.",
      inputSchema: { input: z.string().default("").describe("The text after /goal (or /guardian-goal), exactly as the user typed it. Empty to show the goal.") },
    },
    async ({ input }) => {
      const out = await runUserGoalCommand(await workspaceRoot(), input);
      return { ...(out.kind === "success" ? {} : { isError: true }), content: [{ type: "text" as const, text: out.text }] };
    },
  );
}
