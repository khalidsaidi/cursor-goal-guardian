import fs from "node:fs/promises";
import path from "node:path";
import { getGuardianPaths, getLegacyPaths } from "../paths.js";
import { systemClock, nowIso, type Clock } from "../clock.js";
import { criteriaFromTexts, type Contract } from "../schema/contract.js";
import { defaultConfig } from "../schema/config.js";
import { fileExists, readJsonFile, writeJsonAtomic } from "../fsutil.js";
import { detectWorkspaceFormat } from "./detect.js";

export interface MigrationResult {
  migrated: boolean;
  reason?: "already-v2" | "nothing-to-migrate";
  backups: string[];
}

interface V1Contract {
  goal?: unknown;
  success_criteria?: unknown;
  constraints?: unknown;
}

/** Only the goal survives from v1 state; tasks, decisions and the rest stay in the backups. */
interface V1State {
  goal?: unknown;
  constraints?: unknown;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? "")).filter(Boolean) : []);

async function tryReadJson<T>(filePath: string): Promise<T | null> {
  try {
    return (await readJsonFile(filePath)) as T;
  } catch {
    return null;
  }
}

async function backup(filePath: string, backupPath: string, backups: string[]): Promise<void> {
  if (await fileExists(filePath)) {
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(filePath, backupPath);
    backups.push(backupPath);
  }
}

/**
 * One-shot v1 -> v2 migration. Backups first, transforms second, deletions
 * last, marker at the very end — a crash at any point leaves the backups
 * intact and the migration re-runnable.
 */
export async function migrateV1toV2(
  workspaceRoot: string,
  options: { migratedBy?: string; clock?: Clock } = {},
): Promise<MigrationResult> {
  const clock = options.clock ?? systemClock;
  const format = await detectWorkspaceFormat(workspaceRoot);
  if (format === "v2") return { migrated: false, reason: "already-v2", backups: [] };
  if (format === "none") return { migrated: false, reason: "nothing-to-migrate", backups: [] };

  const p = getGuardianPaths(workspaceRoot);
  const legacy = getLegacyPaths(workspaceRoot);
  const backups: string[] = [];

  // 1. Backups.
  for (const file of [legacy.contract, legacy.state, legacy.policy, legacy.rules, legacy.actions, legacy.snapshot, legacy.reducer]) {
    await backup(file, `${file}.v1.bak`, backups);
  }
  await fs.mkdir(p.telemetryDir, { recursive: true });
  await backup(legacy.auditLog, path.join(p.telemetryDir, "audit-v1.log.bak"), backups);

  // 2. Transforms.
  const v1Contract = await tryReadJson<V1Contract>(legacy.contract);
  const v1State = await tryReadJson<V1State>(legacy.state);
  const contract: Contract = {
    schemaVersion: 2,
    goal: String(v1State?.goal ?? v1Contract?.goal ?? ""),
    successCriteria: criteriaFromTexts(strings(v1Contract?.success_criteria)),
    constraints: strings(v1State?.constraints ?? v1Contract?.constraints),
  };

  const config = defaultConfig();

  await writeJsonAtomic(p.contract, contract);
  await writeJsonAtomic(p.config, config);

  // 4. Deletions (originals; the .v1.bak copies remain).
  await fs.rm(legacy.state, { force: true });
  await fs.rm(legacy.actions, { force: true });
  await fs.rm(legacy.snapshot, { force: true });
  await fs.rm(legacy.reducer, { force: true });
  await fs.rm(legacy.rules, { force: true });
  await fs.rm(legacy.policy, { force: true });
  await fs.rm(legacy.aiDir, { recursive: true, force: true });

  // 5. Marker.
  await writeJsonAtomic(p.migrationMarker, {
    from: 1,
    to: 2,
    ts: nowIso(clock),
    migratedBy: options.migratedBy ?? "goal-guardian",
  });

  return { migrated: true, backups };
}
