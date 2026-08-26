export { readAudit, auditOfKind, readState, readActions } from "cursor-goal-guardian-testkit";
import { readAudit, auditOfKind } from "cursor-goal-guardian-testkit";
import type { AuditRecord } from "@goal-guardian/core";

/** Wait for an audit record kind to appear — for async paths like the rescorer. */
export async function pollForAuditKind<K extends AuditRecord["kind"]>(
  root: string,
  kind: K,
  opts: { timeoutMs?: number; intervalMs?: number; minCount?: number } = {},
): Promise<Extract<AuditRecord, { kind: K }>[]> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const minCount = opts.minCount ?? 1;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = auditOfKind(await readAudit(root), kind);
    if (records.length >= minCount) return records;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${minCount}x ${kind} in ${root}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
