import fs from "node:fs/promises";
import { getGuardianPaths } from "../paths.js";
import { auditRecordSchema, type AuditRecord } from "../schema/audit.js";
import { appendLine } from "../fsutil.js";

export async function appendAudit(workspaceRoot: string, record: AuditRecord): Promise<void> {
  const p = getGuardianPaths(workspaceRoot);
  await appendLine(p.audit, JSON.stringify(auditRecordSchema.parse(record)));
}

/**
 * Read the audit tail, skipping malformed or unknown lines. The audit log is
 * telemetry: readers must tolerate damage, never crash on it.
 */
export async function readAuditTail(workspaceRoot: string, maxRecords = 500): Promise<AuditRecord[]> {
  const p = getGuardianPaths(workspaceRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p.audit, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const out: AuditRecord[] = [];
  for (const line of lines.slice(-maxRecords)) {
    try {
      out.push(auditRecordSchema.parse(JSON.parse(line)));
    } catch {
      // skip malformed telemetry lines
    }
  }
  return out;
}

export async function readAuditSince(workspaceRoot: string, sinceIso: string, maxRecords = 2000): Promise<AuditRecord[]> {
  const since = Date.parse(sinceIso);
  const records = await readAuditTail(workspaceRoot, maxRecords);
  if (!Number.isFinite(since)) return records;
  return records.filter((r) => {
    const ts = Date.parse(r.ts);
    return Number.isFinite(ts) && ts >= since;
  });
}
