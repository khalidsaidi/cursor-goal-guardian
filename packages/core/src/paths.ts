import path from "node:path";

export interface GuardianPaths {
  workspaceRoot: string;
  dir: string;
  contract: string;
  config: string;
  state: string;
  actions: string;
  snapshot: string;
  telemetryDir: string;
  audit: string;
  verdicts: string;
  episodes: string;
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
    state: path.join(dir, "state.json"),
    actions: path.join(dir, "actions.jsonl"),
    snapshot: path.join(dir, "snapshot.json"),
    telemetryDir,
    audit: path.join(telemetryDir, "audit.jsonl"),
    verdicts: path.join(telemetryDir, "verdicts.json"),
    episodes: path.join(telemetryDir, "episodes.json"),
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

/** File layout of v0.x workspaces; used only by migration detection/transform. */
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
