import fs from "node:fs/promises";
import { getGuardianPaths } from "../paths.js";
import { auditRecordSchema, type AuditRecord } from "../schema/audit.js";
import { appendLine } from "../fsutil.js";
import { loadEngineFold } from "../goal/engineFold.js";

const ENGINE = '"goal.engine"';

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
  // The goal engine's log is read whole, however long the tape: a fold over part of it would be wrong.
  const cut = Math.max(0, lines.length - maxRecords);
  const kept = [...lines.slice(0, cut).filter((line) => line.includes(ENGINE)), ...lines.slice(cut)];
  if (kept.some((line) => line.includes(ENGINE))) await loadEngineFold().catch(() => undefined);
  for (const line of kept) {
    try {
      out.push(auditRecordSchema.parse(JSON.parse(line)));
    } catch {
      // skip malformed telemetry lines
    }
  }
  return out;
}

/** Only the goal loop's records, however far back: receipts must outlive a long session's tape window. */
export async function readGoalRecords(workspaceRoot: string): Promise<AuditRecord[]> {
  const raw = await fs.readFile(getGuardianPaths(workspaceRoot).audit, "utf8").catch(() => "");
  const out: AuditRecord[] = [];
  if (raw.includes(ENGINE)) await loadEngineFold().catch(() => undefined);
  for (const line of raw.split("\n")) {
    if (!line.includes(ENGINE) && !line.includes('"goal.round"') && !line.includes('"goal.end"') && !line.includes('"goal.control"') && !line.includes('"goal.notice"') && !line.includes('"goal.set"') && !line.includes('"goal.authorized"') && !line.includes('"goal.restored"') && !line.includes('"goal.review"') && !line.includes('"goal.recovery"') && !line.includes('"review.feedback"') && !line.includes('"improve.')) continue;
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
