import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit,
  readAuditTail,
  readAuditSince,
  getGuardianPaths,
  type AuditRecord,
} from "../src/index.js";

const roots: string[] = [];
async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-audit-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

const record = (ts: string): AuditRecord => ({ ts, kind: "hook.event", event: "beforeShellExecution" });

describe("audit log IO", () => {
  it("appends typed records and reads them back", async () => {
    const root = await makeRoot();
    await appendAudit(root, record("2026-01-01T10:00:00.000Z"));
    await appendAudit(root, record("2026-01-01T10:01:00.000Z"));
    const records = await readAuditTail(root);
    expect(records).toHaveLength(2);
    expect(records[0]?.kind).toBe("hook.event");
  });

  it("skips malformed and unknown lines instead of crashing", async () => {
    const root = await makeRoot();
    await appendAudit(root, record("2026-01-01T10:00:00.000Z"));
    const p = getGuardianPaths(root);
    await fs.appendFile(p.audit, 'garbage\n{"ts":"x","kind":"permit.issued"}\n', "utf8");
    await appendAudit(root, record("2026-01-01T10:02:00.000Z"));
    expect(await readAuditTail(root)).toHaveLength(2);
  });

  it("respects the tail cap and the since filter", async () => {
    const root = await makeRoot();
    for (let i = 0; i < 10; i++) {
      await appendAudit(root, record(`2026-01-01T10:0${Math.min(i, 9)}:00.000Z`));
    }
    expect(await readAuditTail(root, 3)).toHaveLength(3);
    expect(await readAuditSince(root, "2026-01-01T10:07:00.000Z")).toHaveLength(3);
  });

  it("returns empty for a missing log", async () => {
    const root = await makeRoot();
    expect(await readAuditTail(root)).toEqual([]);
  });

  it("skips old AI review records when reading an older tape", async () => {
    const root = await makeRoot();
    const file = getGuardianPaths(root).audit;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", kind: "drift.verdict", driftId: "d", verdict: "confirmed", judge: "j", confidence: 0.9, rationale: "" }),
      JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", kind: "action.observed", actionType: "edit", actionValue: "a.js" }),
    ].join("\n"));
    expect((await readAuditTail(root)).map((r) => r.kind)).toEqual(["action.observed"]);
  });

  it("rejects malformed records at write time", async () => {
    const root = await makeRoot();
    await expect(
      appendAudit(root, { ts: "x", kind: "policy.advisory", severity: "nope" } as unknown as AuditRecord),
    ).rejects.toThrow();
  });
});
