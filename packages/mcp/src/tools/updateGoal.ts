import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CODEX_TOOLS, MONITOR_BUDGET_WITH_PROGRESS_MS, submitGoalReport } from "@goal-guardian/core";
import { workspaceRoot } from "../workspace.js";

/** Guardian's own status: neither original has it. */
const SET_ASIDE = "set_aside";
const STATUSES: [string, ...string[]] = [CODEX_TOOLS.update.statuses[0]!, ...CODEX_TOOLS.update.statuses.slice(1), SET_ASIDE];

const GUARDIAN_PART = [
  "Guardian checks this report against its own record of the session's commands and files and answers at once with anything that doesn't hold; when the record agrees, an independent reviewer checks the project and may object.",
  "With status `complete`, pass proofs (one or more per done-when item) and changes (every file you changed).",
  "With status `blocked`, pass reason.",
  "Guardian adds status `set_aside`: the user's latest message limited the work to part of the goal or asked for something else. Pass their words in user_words. It covers that message only, and a request to continue or finish never counts.",
  "With status `paused`, pass the user's request to pause in user_words.",
].join("\n");

/** Codex's update_goal, by its own name, description and statuses, plus what Guardian needs to check the claim. */
export function registerUpdateGoal(server: McpServer): void {
  server.registerTool(
    CODEX_TOOLS.update.name,
    {
      description: `${CODEX_TOOLS.update.description}\n\n${GUARDIAN_PART}`,
      inputSchema: {
        status: z.enum(STATUSES).describe(`${CODEX_TOOLS.update.statusDescription} Guardian adds \`${SET_ASIDE}\`, see the tool description.`),
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
          .describe("complete: one or more proofs per done-when item."),
        changes: z
          .array(z.object({ file: z.string().describe("Path from the project root."), serves: z.string().describe("The done-when id it serves, or \"extra\".") }))
          .default([])
          .describe("complete: every file you changed."),
        removed: z.array(z.string()).optional().describe("Files that lost most of their lines because the goal or the user asked for it. Leave out anything lost by accident: put that back instead."),
        reason: z.string().optional().describe("blocked: the obstacle, what you tried, what you need."),
        user_words: z.string().optional().describe("set_aside or paused: the user's request, quoted exactly from their latest message."),
      },
    },
    async ({ status, proofs, changes, removed, reason, user_words }, extra) => {
      const root = await workspaceRoot();
      // A review can outlast Cursor's 120 s of silence: where the client asked for progress, keep the call alive.
      const token = extra._meta?.progressToken;
      let beats = 0;
      const beat = token === undefined ? null : setInterval(() => {
        beats += 1;
        void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: beats, message: "Guardian is checking the report" } }).catch(() => undefined);
      }, 20_000);
      const clean = proofs.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))) as Array<{ criterion: string }>;
      const answer = await submitGoalReport(root, {
        status: status as "complete" | "blocked" | "set_aside" | "paused",
        proofs: clean,
        changes,
        ...(removed !== undefined ? { removed } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(user_words !== undefined ? { userWords: user_words } : {}),
      }, token === undefined ? {} : { monitorBudgetMs: MONITOR_BUDGET_WITH_PROGRESS_MS }).finally(() => {
        if (beat) clearInterval(beat);
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(answer) }] };
    },
  );
}
