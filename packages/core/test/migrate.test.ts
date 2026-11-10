import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  migrateV1toV2,
  detectWorkspaceFormat,
  getGuardianPaths,
  getLegacyPaths,
  parseContract,
  parseConfig,
  fileExists,
  type Clock,
} from "../src/index.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/v1");
const clock: Clock = { now: () => new Date("2026-08-26T00:00:00.000Z") };

const roots: string[] = [];
async function fromFixture(caseName: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `gg-mig-${caseName}-`));
  roots.push(root);
  await fs.cp(path.join(FIXTURES, caseName), root, { recursive: true });
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.set(path.relative(root, full), await fs.readFile(full, "utf8"));
    }
  }
  await walk(root);
  return out;
}

describe("migration goldens (real v0.4.11 workspaces)", () => {
  it("detects every fixture as v1 and a fresh dir as none", async () => {
    for (const c of ["case-empty", "case-basic", "case-custom", "case-corrupt"]) {
      expect(await detectWorkspaceFormat(await fromFixture(c)), c).toBe("v1");
    }
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), "gg-fresh-"));
    roots.push(fresh);
    expect(await detectWorkspaceFormat(fresh)).toBe("none");
  });

  it("case-basic: full transform — criteria ids, carried goal, config mapping", async () => {
    const root = await fromFixture("case-basic");
    const result = await migrateV1toV2(root, { migratedBy: "test", clock });
    expect(result.migrated).toBe(true);
    const p = getGuardianPaths(root);
    const legacy = getLegacyPaths(root);

    const contract = parseContract(JSON.parse(await fs.readFile(p.contract, "utf8")));
    expect(contract.goal).toBe("Ship the CSV export feature for the report table");
    expect(contract.successCriteria.map((c) => c.id)).toEqual(["sc_1", "sc_2", "sc_3"]);

    expect(parseConfig(JSON.parse(await fs.readFile(p.config, "utf8")))).toEqual({ schemaVersion: 2 });

    // backups exist; originals of dead files and the .ai split are gone
    for (const bak of [legacy.contract, legacy.state, legacy.policy, legacy.rules, legacy.reducer, legacy.actions]) {
      expect(await fileExists(`${bak}.v1.bak`), bak).toBe(true);
    }
    expect(await fileExists(path.join(p.telemetryDir, "audit-v1.log.bak"))).toBe(true);
    expect(await fileExists(legacy.state)).toBe(false);
    expect(await fileExists(legacy.actions)).toBe(false);
    expect(await fileExists(legacy.policy)).toBe(false);
    expect(await fileExists(legacy.rules)).toBe(false);
    expect(await fileExists(legacy.reducer)).toBe(false);
    expect(await fileExists(legacy.aiDir)).toBe(false);
    expect(await fileExists(p.migrationMarker)).toBe(true);
    expect(await detectWorkspaceFormat(root)).toBe("v2");
  });

  it("case-custom: old policy rules aren't carried over, but the file is backed up", async () => {
    const root = await fromFixture("case-custom");
    const legacy = getLegacyPaths(root);
    await migrateV1toV2(root, { clock });
    const p = getGuardianPaths(root);
    expect(parseConfig(JSON.parse(await fs.readFile(p.config, "utf8")))).toEqual({ schemaVersion: 2 });
    expect(await fileExists(`${legacy.policy}.v1.bak`)).toBe(true);
  });

  it("case-empty: fresh-install v1 migrates to a clean v2 baseline", async () => {
    const root = await fromFixture("case-empty");
    await migrateV1toV2(root, { clock });
    const p = getGuardianPaths(root);
    const contract = parseContract(JSON.parse(await fs.readFile(p.contract, "utf8")));
    expect(contract.goal).toContain("Replace this");
  });

  it("case-corrupt: truncated state and garbage logs fall back safely to the contract", async () => {
    const root = await fromFixture("case-corrupt");
    const result = await migrateV1toV2(root, { clock });
    expect(result.migrated).toBe(true);
    const p = getGuardianPaths(root);
    const contract = parseContract(JSON.parse(await fs.readFile(p.contract, "utf8")));
    expect(contract.goal).toBe("Corrupt workspace fixture");
    expect(await fileExists(path.join(p.telemetryDir, "audit-v1.log.bak"))).toBe(true);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const root = await fromFixture("case-basic");
    await migrateV1toV2(root, { clock });
    const before = await snapshotTree(root);
    const second = await migrateV1toV2(root, { clock });
    expect(second).toEqual({ migrated: false, reason: "already-v2", backups: [] });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("does nothing on a workspace with no guardian files", async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), "gg-fresh2-"));
    roots.push(fresh);
    const result = await migrateV1toV2(fresh, { clock });
    expect(result).toEqual({ migrated: false, reason: "nothing-to-migrate", backups: [] });
    expect(await fileExists(getGuardianPaths(fresh).dir)).toBe(false);
  });
});
