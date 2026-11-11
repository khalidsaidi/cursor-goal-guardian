/**
 * The goal is the user's. Guardian writes the contract only on their authority, and records each such write. If the
 * contract file says something else (rewritten by a command, or edited by the agent), nobody authorised it: the file
 * is put back to the recorded goal before anything is judged against it, and the attempt goes on the record.
 */
import { appendAudit, readGoalRecords } from "../audit/log.js";
import { nowIso } from "../clock.js";
import { writeContract } from "../contractStore.js";
import { readContractSafe } from "../safeReaders.js";
import type { AuditRecord } from "../schema/audit.js";
import type { Contract } from "../schema/contract.js";

type Authorized = Extract<AuditRecord, { kind: "goal.authorized" }>;

const same = (c: Contract, a: Authorized): boolean =>
  c.goal.trim() === a.goal.trim() &&
  JSON.stringify(c.successCriteria.map((x) => [x.id, x.text])) === JSON.stringify(a.successCriteria.map((x) => [x.id, x.text])) &&
  JSON.stringify(c.constraints) === JSON.stringify(a.constraints);

/**
 * True when the contract had been changed without the user and was put back. A workspace with no authorised record
 * yet (one from before this, or a goal typed into the file before Guardian first ran) takes the file as it is.
 */
export async function guardContract(root: string, conversationId?: string): Promise<boolean> {
  const contract = await readContractSafe(root);
  const records = await readGoalRecords(root);
  const last = [...records].reverse().find((r): r is Authorized => r.kind === "goal.authorized");
  if (!last) {
    if (contract.goal.trim()) await appendAudit(root, { ts: nowIso(), kind: "goal.authorized", goal: contract.goal, successCriteria: contract.successCriteria.map((c) => ({ id: c.id, text: c.text })), constraints: contract.constraints });
    return false;
  }
  if (same(contract, last)) return false;
  const found = `${contract.goal.trim().slice(0, 200)} | ${contract.successCriteria.map((c) => c.text).join(" ; ").slice(0, 300)}`;
  await writeContract(root, { ...contract, goal: last.goal, successCriteria: last.successCriteria, constraints: last.constraints });
  await appendAudit(root, { ts: nowIso(), kind: "goal.restored", ...(conversationId ? { conversationId } : {}), found });
  return true;
}

export const GOAL_RESTORED = "Guardian's goal file had been changed by something other than the user, so it has been put back to the goal the user set. Only the user changes the goal. Work and report against the goal as it is below.";
