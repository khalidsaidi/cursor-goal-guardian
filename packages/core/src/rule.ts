import path from "node:path";

/**
 * The session-start anchor. The hook can only reach the agent AFTER it drifts;
 * this always-applied Cursor rule anchors every session to the contract BEFORE
 * any work happens — and makes the user's own first request the way the goal
 * gets declared. Chat is the interface; the guardian is the record.
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
    "The user steers through chat; Guardian keeps the record. Follow this protocol:",
    "",
    "1. At the start of a session, call the `goal-guardian` MCP tool `guardian_get_contract`.",
    "2. **The user's request is the goal.** If no goal is on record (or the goal is empty)",
    "   and the user asks for something substantive, derive the goal and 2–4 'done when'",
    "   criteria from their request and record them with `guardian_update_goal` — then",
    "   confirm in ONE line (e.g. \"Tracking: <goal> — done when <criteria>.\") and get to",
    "   work. Never interrogate the user about goals; never block work on ceremony.",
    "3. When you finish a task, call `guardian_record_progress` (action `complete_task`).",
    "   To work on a different task, use action `start_task` — switching away from an",
    "   active task requires a `decision` (text + rationale); that is intentional.",
    "4. **Complete means verified.** Before recording a task complete, run whatever",
    "   proves it (the tests, the build, the program). If the proof cannot run or does",
    "   not pass — a missing tool, a broken environment, a failing test, anything — do",
    "   NOT record completion yet. Say in one plain sentence what stands in the way,",
    "   offer the practical ways forward (fixing the obstacle for them if they agree,",
    "   with the exact command when there is one), or recording the task with the gap",
    "   explicitly on the record via `guardian_declare_intent` — then WAIT for the",
    "   user's choice. The record must never say done when the proof didn't run.",
    "5. If a Goal Guardian message notes your work looks off-goal, pause and give the user",
    "   the choice in chat: continue this direction (record it via guardian_declare_intent",
    "   or a decision) or return to the active task. Never proceed silently past a nudge.",
    "6. When the user changes direction in chat ('actually, let's...'), reflect it on the",
    "   record: update the goal with `guardian_update_goal` or switch tasks with a decision",
    "   — one line of acknowledgment, then continue.",
    "7. When the user asks about progress, drift, the goal, or 'where were we', answer from",
    "   `guardian_get_status` and `guardian_get_contract` — the session tape — not memory.",
    "8. Stay within the declared boundaries (constraints). If a request conflicts with",
    "   them, say so and suggest updating the record instead of silently diverging.",
    "9. Before multi-file or multi-step work, call `guardian_declare_intent` with a",
    "   one-line summary so the tape shows intent next to actions.",
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
      "description: See the session goal, progress, and any drift — and steer from chat.",
      "disable-model-invocation: true",
      "---",
      "# Guardian",
      "",
      "Accept `/guardian [question]`.",
      "",
      "1. Call the `goal-guardian` MCP tools `guardian_get_status` and `guardian_get_contract`.",
      "2. With no question: present a short, readable briefing — the goal, the active task,",
      "   what's done and what's left, and any drift with its review status. Plain prose,",
      "   no JSON, no field names.",
      "3. With a question ('why did we drift?', 'what's left?'): answer it from the tape.",
      "4. End by offering the useful next moves: mark the task done, switch task, update",
      "   the goal, or review drift with AI. Execute whichever the user picks via the",
      "   guardian tools (guardian_record_progress / guardian_update_goal).",
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
      "Accept `/guardian-goal <goal>`.",
      "",
      "- Empty: show the current goal and 'done when' list from `guardian_get_contract`,",
      "  then `Usage: /guardian-goal <goal>`.",
      "- With a goal: call `guardian_update_goal` with it, propose 2–4 'done when' criteria",
      "  derived from the goal, and add the ones the user confirms via `guardian_update_goal`",
      "  (add_criteria). Confirm the record in one line and continue with the work.",
      "",
    ].join("\n"),
  },
];
