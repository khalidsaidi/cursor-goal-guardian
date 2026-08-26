import {
  defaultConfig,
  defaultState,
  loadState,
  parseConfig,
  parseContract,
  defaultContract,
  getGuardianPaths,
  readJsonFile,
  computeHash,
  type Contract,
  type GuardianConfig,
  type GuardianState,
} from "@goal-guardian/core";

export function workspaceRoot(): string {
  return process.env.GOAL_GUARDIAN_WORKSPACE_ROOT || process.env.CURSOR_WORKSPACE_ROOT || process.cwd();
}

export async function readContractSafe(root: string): Promise<Contract> {
  try {
    return parseContract(await readJsonFile(getGuardianPaths(root).contract));
  } catch {
    return defaultContract();
  }
}

export async function readStateSafe(root: string): Promise<GuardianState> {
  try {
    return await loadState(root);
  } catch {
    const state = defaultState();
    state.meta.hash = computeHash(state);
    return state;
  }
}

export async function readConfigSafe(root: string): Promise<GuardianConfig> {
  try {
    return parseConfig(await readJsonFile(getGuardianPaths(root).config));
  } catch {
    return defaultConfig();
  }
}
