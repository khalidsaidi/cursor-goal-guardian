import fs from "node:fs/promises";
import { getGuardianPaths, getLegacyPaths } from "./paths.js";
import { fileExists, readJsonFile, writeJsonAtomic } from "./fsutil.js";
import { contractSchema, defaultContract, type Contract } from "./schema/contract.js";
import { appendAudit } from "./audit/log.js";

/**
 * contract.json is the one record of the goal. Writes are whole-file and atomic, so a reader sees the old goal or
 * the new one, never part of either.
 */

/** Create what a connected workspace needs. Leaves an existing contract alone. */
export async function ensureGuardianFiles(workspaceRoot: string): Promise<void> {
  const p = getGuardianPaths(workspaceRoot);
  await fs.mkdir(p.telemetryDir, { recursive: true });
  if (!(await fileExists(p.contract))) await writeJsonAtomic(p.contract, defaultContract());
}

/**
 * Every caller writes on the user's authority (their request, their change in chat checked against their words, the
 * panel), so each write is also put on Guardian's record. A contract file that later differs from the last such
 * record was changed by something else, and is put back (goal/guard.ts).
 */
export async function writeContract(workspaceRoot: string, contract: Contract): Promise<Contract> {
  const parsed = contractSchema.parse(contract);
  await writeJsonAtomic(getGuardianPaths(workspaceRoot).contract, parsed);
  await appendAudit(workspaceRoot, { ts: new Date().toISOString(), kind: "goal.authorized", goal: parsed.goal, successCriteria: parsed.successCriteria.map((c) => ({ id: c.id, text: c.text })), constraints: parsed.constraints }).catch(() => undefined);
  return parsed;
}

/**
 * Workspaces from 1.0 kept the goal in state.json too. If the contract lost it, the goal moves across. Either way
 * the file is set aside, so a goal the user clears later can't come back from it.
 */
export async function carryForwardLegacyGoal(workspaceRoot: string, contract: Contract): Promise<Contract> {
  const stateFile = getLegacyPaths(workspaceRoot).state;
  if (!(await fileExists(stateFile))) return contract;
  try {
    const state = (await readJsonFile(stateFile)) as Partial<Contract>;
    // Older state belongs to the v1 migration, which keeps its own backups.
    if (state.schemaVersion !== 2) return contract;
    let current = contract;
    if (!contract.goal.trim() && typeof state.goal === "string" && state.goal.trim()) {
      current = await writeContract(workspaceRoot, { ...contract, goal: state.goal, successCriteria: state.successCriteria ?? [], constraints: state.constraints ?? [] });
    }
    await fs.rename(stateFile, `${stateFile}.bak`);
    return current;
  } catch {
    // Never fail a reader over an old file.
    return contract;
  }
}
