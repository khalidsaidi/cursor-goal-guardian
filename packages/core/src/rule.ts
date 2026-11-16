import path from "node:path";
import { DEEPSEEK_GOAL_POLICY } from "./goal/originals.js";

/**
 * The session-start anchor. The hook can only reach the agent after it acts;
 * this always-applied Cursor rule anchors every session to the contract BEFORE
 * any work happens — and makes the user's own first request the way the goal
 * gets declared. Chat is the interface; the guardian is the record.
 */
export const GUARDIAN_RULE_RELATIVE_PATH = path.join(".cursor", "rules", "goal-guardian.mdc");

export function guardianRuleContent(): string {
  return [
    "---",
    "description: Goal Guardian — remember the request, finish the remaining work and check the result",
    "alwaysApply: true",
    "---",
    "",
    "This workspace uses Goal Guardian to help you finish the user's goal. It advises; it cannot block you.",
    "The user steers through chat. Reuse the recorded goal, work and checks so you can finish efficiently:",
    "Use Guardian quietly. Routine updates describe the user's work, useful findings, or a decision they need to make.",
    "Do not narrate tool setup, arming states, goal stores, or which checking component is running or unavailable.",
    "",
    "1. **Start requested project work with a goal.** If no goal is on record and the user asks you to",
    "   implement, fix or otherwise change the project, call `create_goal` before inspecting or editing.",
    "   Quote their request; Guardian retains the full recorded message. Questions alone don't create goals.",
    "   Guardian also captures the request on the first change as a fallback. Never reword the goal.",
    "   Only if the request lists no 'done when' items, add 2–4 with `guardian_change_goal` (add_criteria).",
    "   Never interrogate the user about goals.",
    "2. **A limit in one message ends with that message.** \"Just item 1 for now\" means do that, call",
    "   `update_goal` with status `set_aside` quoting the limit, and stop this time. It never binds a",
    "   later message.",
    "3. If the user asks to continue or finish, that means the whole goal: work through everything left.",
    "   If they ask for something separate from the goal, do only that and leave the goal alone.",
    "   An empty record doesn't mean there's no work: look in past chats and recent commits before asking.",
    "4. Do what the goal asks and nothing more.",
    "5. If something stands in the way of one item, such as a broken tool, try another way to check it and",
    "   keep going on the rest. Tell the user about it when you close. Ask only when nothing is left to do.",
    "6. When every 'done when' item is done, call `update_goal` with status `complete`.",
    "   Guardian uses its recorded command results and actual project changes; copied output quotes",
    "   and file labels are optional, not extra work to complete. Its reviewer and ADK check the finished",
    "   work. Fix missing requirements, demonstrated bugs, broken tests/builds or meaningful unrelated",
    "   changes. Leave harmless formatting, wording and supporting types/docs alone unless the user",
    "   explicitly required otherwise. Reuse passing checks while the relevant work is unchanged.",
    "   DeepSeek owns goal status and rounds; Codex supplies budgets and continuation instructions.",
    "   Accepted changes notify Codex without another approval. Use get_goal.work for prior checks and findings. If verification could not finish, follow the recovery instructions and keep",
    "   doing useful work. For `unchecked`, describe the delivered changes and checks that actually passed; never claim full verification.",
    "   Keep component failures and diagnostic statuses out of routine replies. If a limitation affects how the user can use the result, explain that practical limitation without internal tool names. For",
    "   `disputed` or `unverified`, tell the user the concrete reason and stop. Never remove finished",
    "   work merely to satisfy report bookkeeping.",
    "7. When the user changes direction ('actually, let's...'), call `guardian_change_goal` with their",
    "   words in `user_words`: those words become the goal. Only the user changes the goal.",
    "8. When the user asks about progress or 'where were we', answer from `get_goal`, not memory. Stay",
    "   within any boundaries the user set.",
    "9. If the user explicitly judges a CGG finding right or wrong, save it with guardian_review_feedback",
    "   using their actual latest words and the finding from get_goal.work. A vague reply is not a label.",
    "   Do not ask them to rate the review. Keep working on what they requested.",
    "",
    "The goal tools are DeepSeek Harness's own (`get_goal`, `create_goal`, `update_goal`). Its goal policy, word for word:",
    "",
    DEEPSEEK_GOAL_POLICY,
    "",
  ].join("\n");
}

/** Project skills: guardian actions surfaced natively in the chat input's `/` menu. */
export const GUARDIAN_SKILLS: Array<{ relativeDir: string; content: string }> = [
  {
    relativeDir: path.join(".cursor", "skills", "guardian"),
    content: [
      "---",
      "name: guardian",
      "description: See the session goal and progress — and steer from chat.",
      "disable-model-invocation: true",
      "---",
      "# Guardian",
      "",
      "Accept `/guardian [question]`.",
      "",
      "1. Call the `goal-guardian` MCP tool `get_goal`.",
      "2. With no question: present a short, readable briefing — the goal, its 'done when' items,",
      "   what is complete, what was checked and what remains. Plain prose, no JSON, no field names.",
      "3. With a question ('what's left?'): answer it from that tool and the project itself.",
      "4. If the user asked to continue, keep working; do not stop at a status report or an offer.",
      "   Use `guardian_change_goal` only when the user actually changes the goal.",
      "",
    ].join("\n"),
  },
  {
    relativeDir: path.join(".cursor", "skills", "guardian-goal"),
    content: [
      "---",
      "name: guardian-goal",
      "description: Declare or change the goal Guardian tracks for this session.",
      "disable-model-invocation: true",
      "---",
      "# Guardian goal",
      "",
      "Accept `/guardian-goal [<objective>|clear|edit <objective>|pause|resume]`. This is DeepSeek Harness's",
      "own `/goal` command.",
      "",
      "Call the `goal-guardian` MCP tool `goal_command` with everything the user typed after",
      "`/guardian-goal`, exactly as typed (empty to show the goal), and show them its answer as it is.",
      "After a new or edited objective that lists no 'done when' items, add 2–4 practical items with",
      "`guardian_change_goal` (add_criteria), then continue. Do not interrupt with a goal interview.",
      "",
    ].join("\n"),
  },
];
