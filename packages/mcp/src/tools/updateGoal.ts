import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CODEX_TOOLS, EVALUATOR_BUDGET_WITH_PROGRESS_MS, submitGoalReport, updateGoalByTool, type EngineToolDefinition } from "@goal-guardian/core";
import { theirField } from "./theirs.js";
import { workspaceRoot } from "../workspace.js";

/** Guardian's own status: neither original has it. */
const SET_ASIDE = "set_aside";
const STATUSES: [string, ...string[]] = [CODEX_TOOLS.update.statuses[0]!, ...CODEX_TOOLS.update.statuses.slice(1), SET_ASIDE];

/** Goes first: without it agents stop on a limited request without reporting, and each such stop costs a send-back. */
const GUARDIAN_LEAD = "Guardian: report on the goal with this tool before you stop, whenever you changed something: when it's done, when you're truly blocked, or (status `set_aside`) when the user's latest message asked for only part of the goal or for something else.";

const GUARDIAN_PART = [
  "Guardian uses its recorded commands, results and actual project changes. An independent reviewer checks the finished project and an evaluator judges the work against the user's request. Objections concern unfinished work, demonstrated failures or meaningful unrelated changes; harmless formatting and supporting work are allowed unless the user explicitly constrained them.",
  "A goal is completed only by this report being accepted by both goal keepers' own code, Codex's and DeepSeek Harness's: what either refuses is the answer you get. The answer's `outcome` says how the run ended: `proved` (both accepted, both checks passed), `unchecked` (both accepted, but a check didn't run), `disputed` (the review still objects to the same state after its reviews ran out) or `unverified` (a goal keeper's code didn't run). After `disputed` or `unverified`, don't report again: tell the user and stop.",
  "With status `complete`, ask Guardian to check the finished work. Proofs and changes are optional hints; do not copy output quotes or rerun passing commands merely to repair this report.",
  "With status `blocked`, pass reason.",
  "Guardian adds status `set_aside`: the user's latest message limited the work to part of the goal or asked for something else. Pass their words in user_words. It covers that message only, and a request to continue or finish never counts.",
  "With status `paused`, pass the user's request to pause in user_words.",
  "The call then goes to DeepSeek Harness's own update_goal, which decides by its own rules and whose answer comes back in `their`. You can call it in its own shape too (goal_id, revision, action); goal_id and revision default to the current goal's. For `complete`, its tool runs after the finished-work checks accept the goal.",
].join("\n");

/**
 * update_goal: Codex's name, description and statuses and DeepSeek Harness's description and parameters, side by
 * side, plus what Guardian needs to check the claim. The call is carried out by DeepSeek's own tool.
 */
export function registerUpdateGoal(server: McpServer, theirs: EngineToolDefinition): void {
  server.registerTool(
    CODEX_TOOLS.update.name,
    {
      description: `${GUARDIAN_LEAD}\n\n${CODEX_TOOLS.update.description}\n\nDeepSeek Harness: ${theirs.description}\n\n${GUARDIAN_PART}`,
      inputSchema: {
        status: z.enum(STATUSES).optional().describe(`${CODEX_TOOLS.update.statusDescription} Guardian adds \`${SET_ASIDE}\`, see the tool description. Give this or DeepSeek's \`action\`.`),
        goal_id: theirField(theirs, "goal_id"),
        revision: theirField(theirs, "revision"),
        action: theirField(theirs, "action"),
        objective: theirField(theirs, "objective"),
        max_goal_rounds: theirField(theirs, "max_goal_rounds"),
        blocked_reason: theirField(theirs, "blocked_reason"),
        proofs: z
          .array(
            z.object({
              criterion: z.string().describe("The done-when id, such as sc_1, or \"goal\" if the goal has none."),
              command: z.string().optional().describe("Optional command hint; Guardian already records executed commands and their results."),
              quote: z.string().optional().describe("Optional legacy hint. Guardian uses the captured command result; no copied output is required."),
              file: z.string().optional().describe("Or a project file that shows it."),
              contains: z.string().optional().describe("Text in that file."),
            }),
          )
          .default([])
          .describe("Optional legacy hints. Guardian uses its recorded commands and actual project changes, then checks every requested item."),
        changes: z
          .array(z.object({ file: z.string().describe("Path from the project root."), serves: z.string().describe("The done-when id it serves, or \"extra\".") }))
          .default([])
          .describe("Optional changed-file hints; Guardian also observes the actual project changes."),
        removed: z.array(z.string()).optional().describe("Optional notes about intentional removals. Checks assess meaningful loss of work, not line counts alone."),
        reason: z.string().optional().describe("blocked: the obstacle, what you tried, what you need."),
        user_words: z.string().optional().describe("set_aside or paused: the user's request, quoted exactly from their latest message."),
      },
    },
    async ({ status, proofs, changes, removed, reason, user_words, goal_id, revision, action, objective, max_goal_rounds, blocked_reason }, extra) => {
      const root = await workspaceRoot();
      // DeepSeek's action, or Codex's status read as one. Their edit and resume have no report to check: they go
      // straight to their tool, which decides.
      const act = (action as string | undefined) ?? (status === "paused" ? "pause" : status);
      if (!act) return { isError: true, content: [{ type: "text" as const, text: "Give a status (Codex's shape) or an action (DeepSeek's shape)." }] };
      if (act === "edit" || act === "resume") {
        const out = await updateGoalByTool(root, { action: act, ...(typeof goal_id === "string" ? { goal_id } : {}), ...(typeof revision === "number" ? { revision } : {}), ...(typeof objective === "string" ? { objective } : {}), ...(typeof max_goal_rounds === "number" ? { max_goal_rounds } : {}) });
        return { ...(out.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: out.text }] };
      }
      const reported = act === "pause" ? "paused" : act;
      // A review can outlast Cursor's 120 s of silence: where the client asked for progress, keep the call alive.
      const token = extra._meta?.progressToken;
      let beats = 0;
      const beat = token === undefined ? null : setInterval(() => {
        beats += 1;
        void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: beats, message: "Guardian is checking the report" } }).catch(() => undefined);
      }, 20_000);
      const clean = proofs.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))) as Array<{ criterion: string }>;
      const answer = await submitGoalReport(root, {
        status: reported as "complete" | "blocked" | "set_aside" | "paused",
        proofs: clean,
        changes,
        ...(removed !== undefined ? { removed } : {}),
        ...(reason !== undefined ? { reason } : typeof blocked_reason === "string" ? { reason: blocked_reason } : {}),
        ...(user_words !== undefined ? { userWords: user_words } : {}),
      }, token === undefined ? {} : { evaluatorBudgetMs: EVALUATOR_BUDGET_WITH_PROGRESS_MS }).finally(() => {
        if (beat) clearInterval(beat);
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(answer) }] };
    },
  );
}
