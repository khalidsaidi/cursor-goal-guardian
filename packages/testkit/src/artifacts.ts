import fs from "node:fs/promises";
import {
  getGuardianPaths,
  parseState,
  parseAction,
  auditRecordSchema,
  type AuditRecord,
  type GuardianAction,
  type GuardianState,
} from "@goal-guardian/core";

/** Read and validate telemetry/audit.jsonl; malformed lines throw (tests want loud failures). */
export async function readAudit(workspaceRoot: string): Promise<AuditRecord[]> {
  const p = getGuardianPaths(workspaceRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p.audit, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => auditRecordSchema.parse(JSON.parse(line)));
}

export function auditOfKind<K extends AuditRecord["kind"]>(
  records: AuditRecord[],
  kind: K,
): Extract<AuditRecord, { kind: K }>[] {
  return records.filter((r) => r.kind === kind) as Extract<AuditRecord, { kind: K }>[];
}

export async function readState(workspaceRoot: string): Promise<GuardianState> {
  const p = getGuardianPaths(workspaceRoot);
  return parseState(JSON.parse(await fs.readFile(p.state, "utf8")));
}

export async function readActions(workspaceRoot: string): Promise<GuardianAction[]> {
  const p = getGuardianPaths(workspaceRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p.actions, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseAction(JSON.parse(line)));
}
