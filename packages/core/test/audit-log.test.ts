import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit,
  readAuditTail,
  readAuditSince,
  getGuardianPaths,
  loadEpisodes,
  saveEpisodes,
  emptyEpisodeStore,
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

  it("rejects malformed records at write time", async () => {
    const root = await makeRoot();
    await expect(
      appendAudit(root, { ts: "x", kind: "drift.verdict", driftId: "d", verdict: "confirmed", judge: "j", confidence: 2, rationale: "" } as AuditRecord),
    ).rejects.toThrow();
  });
});

describe("episode store IO", () => {
  it("round-trips and falls back to empty on damage", async () => {
    const root = await makeRoot();
    expect(await loadEpisodes(root)).toEqual(emptyEpisodeStore());
    const store = emptyEpisodeStore();
    store.episodes.push({ id: "ep_1", taskId: "t1", terms: ["a"], firstSeenTs: "2026-01-01T10:00:00.000Z", lastSeenTs: "2026-01-01T10:00:00.000Z", lastNudgeTs: null });
    await saveEpisodes(root, store);
    expect(await loadEpisodes(root)).toEqual(store);
    const p = getGuardianPaths(root);
    await fs.writeFile(p.episodes, "{broken", "utf8");
    expect(await loadEpisodes(root)).toEqual(emptyEpisodeStore());
  });
});
