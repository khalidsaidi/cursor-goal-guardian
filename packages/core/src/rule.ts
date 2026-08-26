import path from "node:path";

/**
 * The session-start anchor. The hook can only reach the agent AFTER it drifts;
 * this always-applied Cursor rule anchors every session to the contract BEFORE
 * any work happens, and turns the MCP tool surface from available into used.
 */
export const GUARDIAN_RULE_RELATIVE_PATH = path.join(".cursor", "rules", "goal-guardian.mdc");

export function guardianRuleContent(): string {
  return [
    "---",
    "description: Goal Guardian session protocol — keeps agent work anchored to the declared goal",
    "alwaysApply: true",
    "---",
    "",
    "This workspace uses Goal Guardian (advisory only — it never blocks you).",
    "Follow this protocol:",
    "",
    "1. At the start of a session, call the `goal-guardian` MCP tool `guardian_get_contract`",
    "   to load the goal, success criteria, constraints, and the active task.",
    "2. Before starting multi-file or multi-step work, call `guardian_declare_intent`",
    "   with a one-line summary (and the taskId it serves).",
    "3. When you finish a task, call `guardian_record_progress` with action `complete_task`.",
    "   To work on a different task, call it with action `start_task` — switching away from",
    "   an active task requires a `decision` (text + rationale); that is intentional.",
    "4. If a Goal Guardian message notes your work looks off-goal, re-read the active task",
    "   and either realign or record a decision explaining the pivot.",
    "5. Stay within the declared constraints. If the user's request conflicts with the",
    "   contract, say so and suggest updating the contract instead of silently diverging.",
    "",
  ].join("\n");
}
