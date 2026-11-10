import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { submitGoalReport } from "@goal-guardian/core";
import { workspaceRoot } from "../workspace.js";

export function registerReportGoal(server: McpServer): void {
  server.registerTool(
    "guardian_report_goal",
    {
      description:
        "Report on the goal when you are done, truly blocked, or the user asked for only part of the goal or something else. Guardian checks the report against its own record of this session and answers at once with anything that doesn't hold.",
      inputSchema: {
        status: z.enum(["complete", "blocked", "set_aside"]).describe("complete: every done-when item is proved. blocked: something outside your reach has stopped you for 3 turns in a row. set_aside: the user's latest message limited the work to part of the goal or asked for something else; covers that message only, and a request to continue or finish never counts."),
        proofs: z
          .array(
            z.object({
              criterion: z.string().describe("The done-when id, such as sc_1, or \"goal\" if the goal has none."),
              command: z.string().optional().describe("A command exactly as you ran it, after your last edit."),
              quote: z.string().optional().describe("Text that command printed. Use its closing lines: long output is trimmed in the middle."),
              file: z.string().optional().describe("Or a project file that shows it."),
              contains: z.string().optional().describe("Text in that file."),
            }),
          )
          .default([])
          .describe("One or more proofs per done-when item."),
        changes: z
          .array(z.object({ file: z.string().describe("Path from the project root."), serves: z.string().describe("The done-when id it serves, or \"extra\".") }))
          .default([])
          .describe("Every file you changed."),
        removed: z.array(z.string()).optional().describe("Files that lost most of their lines because the goal or the user asked for it. Leave out anything lost by accident: put that back instead."),
        reason: z.string().optional().describe("blocked: the obstacle, what you tried, what you need."),
        user_words: z.string().optional().describe("set_aside: the user's request, quoted exactly from their latest message."),
      },
    },
    async ({ status, proofs, changes, removed, reason, user_words }) => {
      const root = await workspaceRoot();
      const clean = proofs.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))) as Array<{ criterion: string }>;
      const answer = await submitGoalReport(root, { status, proofs: clean, changes, ...(removed !== undefined ? { removed } : {}), ...(reason !== undefined ? { reason } : {}), ...(user_words !== undefined ? { userWords: user_words } : {}) });
      return { content: [{ type: "text" as const, text: JSON.stringify(answer) }] };
    },
  );
}
