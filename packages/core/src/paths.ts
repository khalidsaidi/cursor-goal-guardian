import path from "node:path";

export interface GuardianPaths {
  workspaceRoot: string;
  dir: string;
  contract: string;
  config: string;
  telemetryDir: string;
  audit: string;
  shellOutput: string;
  edits: string;
  responses: string;
  prompts: string;
  migrationMarker: string;
}

export function getGuardianPaths(workspaceRoot: string): GuardianPaths {
  const dir = path.join(workspaceRoot, ".cursor", "goal-guardian");
  const telemetryDir = path.join(dir, "telemetry");
  return {
    workspaceRoot,
    dir,
    contract: path.join(dir, "contract.json"),
    config: path.join(dir, "config.json"),
    telemetryDir,
    audit: path.join(telemetryDir, "audit.jsonl"),
    shellOutput: path.join(telemetryDir, "shell-output.jsonl"),
    edits: path.join(telemetryDir, "edits.jsonl"),
    responses: path.join(telemetryDir, "responses.json"),
    prompts: path.join(telemetryDir, "prompts.json"),
    migrationMarker: path.join(dir, "migration.json"),
  };
}

export interface LegacyGuardianPaths {
  dir: string;
  contract: string;
  policy: string;
  rules: string;
  reducer: string;
  state: string;
  actions: string;
  snapshot: string;
  aiDir: string;
  auditLog: string;
  checks: string;
  permits: string;
  violations: string;
}

/** Files of older workspaces: v0.x, and the task store of 1.0. Read only to carry a goal forward. */
export function getLegacyPaths(workspaceRoot: string): LegacyGuardianPaths {
  const dir = path.join(workspaceRoot, ".cursor", "goal-guardian");
  const aiDir = path.join(workspaceRoot, ".ai", "goal-guardian");
  return {
    dir,
    contract: path.join(dir, "contract.json"),
    policy: path.join(dir, "policy.json"),
    rules: path.join(dir, "rules.json"),
    reducer: path.join(dir, "reducer.js"),
    state: path.join(dir, "state.json"),
    actions: path.join(dir, "actions.jsonl"),
    snapshot: path.join(dir, "snapshot.json"),
    aiDir,
    auditLog: path.join(aiDir, "audit.log"),
    checks: path.join(aiDir, "checks.json"),
    permits: path.join(aiDir, "permits.json"),
    violations: path.join(aiDir, "violations.json"),
  };
}
