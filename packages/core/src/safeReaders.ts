import { getGuardianPaths } from "./paths.js";
import { readJsonFile } from "./fsutil.js";
import { parseContract, defaultContract, type Contract } from "./schema/contract.js";
import { parseConfig, defaultConfig, type GuardianConfig } from "./schema/config.js";
import { defaultState, type GuardianState } from "./schema/state.js";
import { loadState } from "./store/store.js";
import { computeHash } from "./store/hash.js";

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

export async function readStateSafe(workspaceRoot: string): Promise<GuardianState> {
  try {
    return await loadState(workspaceRoot);
  } catch {
    const state = defaultState();
    state.meta.hash = computeHash(state);
    return state;
  }
}

export async function readConfigSafe(workspaceRoot: string): Promise<GuardianConfig> {
  try {
    return parseConfig(await readJsonFile(getGuardianPaths(workspaceRoot).config));
  } catch {
    return defaultConfig();
  }
}
