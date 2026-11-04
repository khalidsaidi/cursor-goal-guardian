/**
 * Loop detection: the agent running the exact same command again and again with nothing in between is
 * busy without progress — the rabbit-hole kind of drift a goal-vocabulary match cannot see. Advisory:
 * it never blocks a legitimate repeat. Consecutive identical commands count; any other action resets the
 * run; a light reminder at the first threshold, a firmer one at the later ones (3, 5, 8).
 */
import type { AuditRecord } from "../schema/audit.js";

export const LOOP_THRESHOLDS = [3, 5, 8] as const;
const PREVIEW = 300;

function same(a: string): string {
  return a.trim().replace(/\s+/g, " ");
}

/**
 * How many times in a row, ending with the latest action, this conversation ran exactly this command.
 * Edits and other commands break the run; reads are not on the tape, so they never do.
 */
export function consecutiveRepeats(records: AuditRecord[], conversationId: string | undefined, command: string): number {
  const want = same(command);
  let n = 0;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i]!;
    if (r.kind !== "action.observed") continue;
    if (conversationId && r.conversationId && r.conversationId !== conversationId) continue;
    if (r.actionType !== "shell" && r.actionType !== "mcp" && r.actionType !== "edit") continue;
    if ((r.actionType === "shell" || r.actionType === "mcp") && same(r.actionValue) === want) n += 1;
    else break;
  }
  return n;
}

export function loopNudge(command: string, count: number): { user: string; agent: string } {
  const preview = command.length > PREVIEW ? `${command.slice(0, PREVIEW)}… (+${command.length - PREVIEW} more chars)` : command;
  if (count <= LOOP_THRESHOLDS[0]) {
    return {
      user: `the agent has run the same command ${count} times in a row`,
      agent:
        "you've run this exact command several times in a row. Read what it printed last time before running it again; if the work isn't finished, change the approach or the arguments instead.",
    };
  }
  return {
    user: `the agent has run the same command ${count} times in a row — it looks stuck`,
    agent: `same command, ${count} runs in a row with nothing different in between: ${preview}. Repeating it isn't getting anywhere, so stop running it as is. Look at its latest output, then do something different, or wrap up if you already have what you need; if something is in your way, tell the user.`,
  };
}
