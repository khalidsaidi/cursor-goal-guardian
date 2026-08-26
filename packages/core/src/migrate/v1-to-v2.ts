import fs from "node:fs/promises";
import path from "node:path";
import { getGuardianPaths, getLegacyPaths } from "../paths.js";
import { systemClock, newId, nowIso, type Clock } from "../clock.js";
import { criteriaFromTexts, type Contract, type SuccessCriterion } from "../schema/contract.js";
import { configSchema, type GuardianConfig, type PolicyRule } from "../schema/config.js";
import { defaultState, guardianStateSchema, type GuardianAction, type GuardianState, type Task } from "../schema/state.js";
import { fileExists, readJsonFile, writeJsonAtomic } from "../fsutil.js";
import { replay } from "../store/store.js";
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

interface V1State {
  goal?: unknown;
  definition_of_done?: unknown;
  constraints?: unknown;
  active_task?: unknown;
  tasks?: unknown;
  queue?: unknown;
  open_questions?: unknown;
  decisions?: unknown;
  pinned_context?: unknown;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? "")).filter(Boolean) : []);

async function tryReadJson<T>(filePath: string): Promise<T | null> {
  try {
    return (await readJsonFile(filePath)) as T;
  } catch {
    return null;
  }
}

/** v1 titles encoded the criterion link as "SCn: text"; v2 stores criterionId. Last-ever use of this convention. */
function taskFromV1(raw: Record<string, unknown>, criteria: SuccessCriterion[]): Task | null {
  const id = String(raw.id ?? "").trim();
  let title = String(raw.title ?? "").trim();
  const status = raw.status === "doing" || raw.status === "done" ? raw.status : "todo";
  if (!id || !title) return null;

  let criterionId: string | undefined;
  const m = title.match(/^SC(\d+):\s*(.*)$/i);
  if (m) {
    const idx = Number.parseInt(m[1]!, 10);
    const criterion = criteria[idx - 1];
    if (criterion && m[2]) {
      criterionId = criterion.id;
      title = m[2].trim() || title;
    }
  }
  return { id, title, status, ...(criterionId ? { criterionId } : {}) };
}

function mapSeverity(v1: unknown): PolicyRule["severity"] | null {
  switch (String(v1 ?? "")) {
    case "HIGH_RISK":
    case "PERMIT_REQUIRED":
      return "alert";
    case "WARN":
      return "caution";
    case "ALLOWED":
      return "ok";
    default:
      return null;
  }
}

/**
 * Patterns that shipped inside v1's default alwaysAllow/highRiskPatterns sets.
 * Example policies copied those sets verbatim, so carrying them into config.json
 * would freeze stale defaults over v2's. Only the pattern *sets* are filtered —
 * explicit user rule arrays always carry over, even when they reuse a default
 * pattern with a different severity.
 */
const V1_DEFAULT_PATTERNS = new Set([
  "rm -rf /", "rm -rf /*", "*:(){ :|:& };:*", "*> /dev/sda*", "*dd if=*of=/dev/*", "*mkfs.*",
  "*curl*|*sh*", "*wget*|*sh*", "*curl*|*bash*", "*wget*|*bash*",
  "rm -rf *", "rm -r *", "*--force*", "*-f *", "git reset --hard*", "git clean -fd*",
  "git push --force*", "git push -f*", "npm publish*", "yarn publish*", "pnpm publish*",
  "chmod 777*", "*sudo *", "docker rm -f*", "docker system prune*",
  "git status*", "git diff*", "git log*", "git branch*", "git rev-parse*", "ls*", "pwd",
  "echo *", "cat *", "head *", "tail *", "node -v", "npm -v", "pnpm -v", "yarn -v",
  "which *", "type *", "goal-guardian/*",
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", ".git/**", ".ai/goal-guardian/**",
  ".cursor/goal-guardian/**", ".cursor/hooks.json", ".cursor/mcp.json",
]);

function userRules(raw: unknown): PolicyRule[] {
  if (!Array.isArray(raw)) return [];
  const out: PolicyRule[] = [];
  for (const entry of raw) {
    const pattern = String((entry as Record<string, unknown>)?.pattern ?? "").trim();
    const severity = mapSeverity((entry as Record<string, unknown>)?.severity);
    if (!pattern || !severity) continue;
    const reason = (entry as Record<string, unknown>)?.reason;
    out.push({ pattern, severity, ...(typeof reason === "string" && reason ? { reason } : {}) });
  }
  return out;
}

function patternSetRules(raw: unknown, severity: PolicyRule["severity"]): PolicyRule[] {
  return strings(raw)
    .filter((pattern) => !V1_DEFAULT_PATTERNS.has(pattern))
    .map((pattern) => ({ pattern, severity }));
}

function configFromV1(policy: Record<string, unknown> | null): GuardianConfig {
  const p = policy ?? {};
  const sensitivityRaw = String(p.taskScopeSensitivity ?? "balanced");
  const sensitivity = sensitivityRaw === "strict" || sensitivityRaw === "lenient" ? sensitivityRaw : "balanced";
  const alwaysAllow = (p.alwaysAllow ?? {}) as Record<string, unknown>;
  const highRisk = (p.highRiskPatterns ?? {}) as Record<string, unknown>;

  const collect = (key: "shell" | "mcp" | "read", ruleKey: "shellRules" | "mcpRules" | "readRules"): PolicyRule[] => [
    ...userRules(p[ruleKey]),
    ...patternSetRules(highRisk[key], "alert"),
    ...patternSetRules(alwaysAllow[key], "ok"),
  ];

  return configSchema.parse({
    drift: { lexical: { enabled: p.enforceTaskScope !== false, sensitivity } },
    advisories: {
      remindWhenNoActiveTask: p.enforceReduxControl !== false,
      shellRules: collect("shell", "shellRules"),
      mcpRules: collect("mcp", "mcpRules"),
      readRules: collect("read", "readRules"),
    },
  });
}

function stateFromV1(v1: V1State | null, contract: Contract): Omit<GuardianState, "meta"> {
  const { meta: _meta, ...base } = defaultState();
  const criteria = contract.successCriteria;

  if (!v1) {
    return { ...base, goal: contract.goal, successCriteria: criteria, constraints: contract.constraints };
  }

  const tasks = (Array.isArray(v1.tasks) ? v1.tasks : [])
    .map((t) => taskFromV1((t ?? {}) as Record<string, unknown>, criteria))
    .filter((t): t is Task => t !== null);
  const taskIds = new Set(tasks.map((t) => t.id));
  const activeTaskId = String(v1.active_task ?? "").trim();

  const openQuestions = (Array.isArray(v1.open_questions) ? v1.open_questions : [])
    .map((q) => q as Record<string, unknown>)
    .filter((q) => q && String(q.id ?? "") && String(q.text ?? ""))
    .map((q) => ({
      id: String(q.id),
      text: String(q.text),
      ts: String(q.ts ?? ""),
      status: q.status === "closed" ? ("closed" as const) : ("open" as const),
    }));

  const decisions = (Array.isArray(v1.decisions) ? v1.decisions : [])
    .map((d) => d as Record<string, unknown>)
    .filter((d) => d && String(d.id ?? "") && String(d.text ?? ""))
    .map((d) => ({
      id: String(d.id),
      text: String(d.text),
      rationale: String(d.rationale ?? ""),
      ts: String(d.ts ?? ""),
    }));

  return {
    ...base,
    goal: String(v1.goal ?? contract.goal),
    successCriteria: criteria,
    constraints: strings(v1.constraints ?? contract.constraints),
    activeTaskId: activeTaskId && taskIds.has(activeTaskId) ? activeTaskId : null,
    tasks,
    queue: strings(v1.queue).filter((id) => taskIds.has(id)),
    openQuestions,
    decisions,
    pinnedContext: strings(v1.pinned_context),
  };
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
  const contract: Contract = {
    schemaVersion: 2,
    goal: String(v1Contract?.goal ?? ""),
    successCriteria: criteriaFromTexts(strings(v1Contract?.success_criteria)),
    constraints: strings(v1Contract?.constraints),
  };

  const v1State = await tryReadJson<V1State>(legacy.state);
  const imported = stateFromV1(v1State, contract);

  const config = configFromV1(await tryReadJson<Record<string, unknown>>(legacy.policy));

  // 3. Fresh event log: one MIGRATE_IMPORT so state === replay(actions) from action #1.
  const action: GuardianAction = {
    id: newId("act"),
    ts: nowIso(clock),
    actor: "system",
    type: "MIGRATE_IMPORT",
    payload: { state: imported },
  };
  const state = replay([action]);
  guardianStateSchema.parse(state);

  await fs.writeFile(p.actions, JSON.stringify(action) + "\n", "utf8");
  await writeJsonAtomic(p.state, state);
  await writeJsonAtomic(p.contract, contract);
  await writeJsonAtomic(p.config, config);
  await fs.rm(p.snapshot, { force: true });

  // 4. Deletions (originals; the .v1.bak copies remain).
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
