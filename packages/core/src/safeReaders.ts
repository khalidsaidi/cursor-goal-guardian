import { getGuardianPaths } from "./paths.js";
import { readJsonFile } from "./fsutil.js";
import { parseContract, defaultContract, type Contract } from "./schema/contract.js";
import { parseConfig, defaultConfig, type GuardianConfig } from "./schema/config.js";
import { defaultState, type GuardianState } from "./schema/state.js";
import { loadState } from "./store/store.js";
import { computeHash, isManuallyEdited } from "./store/hash.js";

/**
 * Tolerant readers for processes that must never fail because a workspace file
 * is missing or damaged (the hook sits in the editor's hot path; the MCP
 * server answers agents mid-session). Damage degrades to defaults.
 */

export async function readContractSafe(workspaceRoot: string): Promise<Contract> {
  try {
    return parseContract(await readJsonFile(getGuardianPaths(workspaceRoot).contract));
  } catch {
    return defaultContract();
  }
}

export interface StateReport {
  state: GuardianState;
  /** True when the on-disk state failed to load (missing, damaged, or hand-edited past its hash). */
  broken: boolean;
}

/** Like readStateSafe, but tells the caller the file was damaged — so a UI can offer repair instead of silently showing an empty session. */
export async function readStateReport(workspaceRoot: string): Promise<StateReport> {
  try {
    const state = await loadState(workspaceRoot);
    // A parse that succeeds can still be a hand-edit: the hash guard is the
    // detector, and the reader is where a UI learns to offer repair.
    return { state, broken: isManuallyEdited(state) };
  } catch {
    const state = defaultState();
    state.meta.hash = computeHash(state);
    return { state, broken: true };
  }
}

export async function readStateSafe(workspaceRoot: string): Promise<GuardianState> {
  return (await readStateReport(workspaceRoot)).state;
}

export async function readConfigSafe(workspaceRoot: string): Promise<GuardianConfig> {
  try {
    return parseConfig(await readJsonFile(getGuardianPaths(workspaceRoot).config));
  } catch {
    return defaultConfig();
  }
}
