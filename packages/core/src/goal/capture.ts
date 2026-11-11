/**
 * The goal is the user's own words, recorded by Guardian rather than retold by the agent. An agent that rewrote the
 * goal could drop an item and then honestly prove what was left. Nothing here knows any language: a list is a list.
 */
import { appendAudit, readAuditTail } from "../audit/log.js";
import { nowIso } from "../clock.js";
import { writeContract } from "../contractStore.js";
import { readContractSafe } from "../safeReaders.js";
import { criteriaFromTexts } from "../schema/contract.js";
import { goalHash, goalPhaseOf, setEngineGoal } from "./loop.js";
import { readUserPrompts } from "./record.js";

const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+(\S.*)$/;
const MIN_ITEMS = 2;
const CAPTURE_WINDOW = 20_000;

function listLines(message: string): { goal: string; items: string[] } | null {
  const lines = message.split(/\r?\n/);
  let fenced = false;
  let start = -1;
  const items: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      if (start >= 0) break;
      continue;
    }
    if (fenced) continue;
    const item = LIST_ITEM.exec(line);
    if (item) {
      if (start < 0) start = i;
      items.push(item[1]!.trim());
    } else if (start >= 0) {
      // An indented line carries on the item above; anything else ends the list.
      if (line.trim() && /^\s/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
      else break;
    }
  }
  return items.length >= MIN_ITEMS ? { goal: lines.slice(0, start).join("\n").trim(), items } : null;
}

function inlineNumbers(message: string): { goal: string; items: string[] } | null {
  const found: Array<{ at: number; end: number }> = [];
  for (let n = 1; ; n += 1) {
    const from = found.length ? found[found.length - 1]!.end : 0;
    const match = new RegExp(`(?:^|\\s)${n}[.)]\\s+`).exec(message.slice(from));
    if (!match) break;
    found.push({ at: from + match.index, end: from + match.index + match[0].length });
  }
  if (found.length < MIN_ITEMS) return null;
  const items = found.map((f, i) => message.slice(f.end, found[i + 1]?.at ?? message.length).trim());
  // The last item ends with its sentence: what follows is about the message, not the list.
  items[items.length - 1] = items[items.length - 1]!.replace(/([.!?])\s.*$/s, "$1");
  return { goal: message.slice(0, found[0]!.at).trim(), items };
}

/**
 * What a message says the goal is, word for word. A list becomes the "done when" items, and only what comes before
 * it the goal: what follows a list tends to be about this one message ("only the first for now").
 */
export function parseRequest(message: string): { goal: string; items: string[] } {
  const text = message.trim();
  const parsed = listLines(text) ?? inlineNumbers(text);
  if (!parsed) return { goal: text, items: [] };
  return { goal: parsed.goal || text, items: parsed.items };
}

/**
 * With no open goal, the message that led to the first change is the goal: the first one, or the next one once the
 * last goal is closed. An open or paused goal stays until the user changes it. Returns whether it recorded one.
 */
export async function captureGoal(root: string, conversationId: string | undefined): Promise<boolean> {
  const contract = await readContractSafe(root);
  const records = await readAuditTail(root, CAPTURE_WINDOW);
  const phase = goalPhaseOf(records, contract);
  if (phase !== "none" && phase !== "complete") return false;
  const prompts = await readUserPrompts(root);
  const latest = prompts?.[prompts.length - 1];
  if (!latest?.trim()) return false;
  if (phase === "complete") {
    // The work closing a goal isn't a new request: only a message sent after it closed can start the next goal.
    const closed = [...records].reverse().find((r) => r.kind === "goal.end" || r.kind === "goal.control");
    const asked = [...records].reverse().find((r) => r.kind === "user.message");
    if (!asked || !closed || Date.parse(asked.ts) <= Date.parse(closed.ts)) return false;
  }
  const { goal, items } = parseRequest(latest);
  // DeepSeek's goal service creates the goal first; what it refuses isn't recorded.
  if (!(await setEngineGoal(root, goal, true))) return false;
  const saved = await writeContract(root, { ...contract, goal, successCriteria: criteriaFromTexts(items) });
  await appendAudit(root, { ts: nowIso(), kind: "goal.set", goalHash: goalHash(saved), ...(conversationId ? { conversationId } : {}) });
  return true;
}
