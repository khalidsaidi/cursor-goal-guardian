export { readContractSafe, readStateSafe, readConfigSafe } from "@goal-guardian/core";

export function workspaceRoot(): string {
  return process.env.GOAL_GUARDIAN_WORKSPACE_ROOT || process.env.CURSOR_WORKSPACE_ROOT || process.cwd();
}
