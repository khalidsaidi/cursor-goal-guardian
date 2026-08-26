import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureStateFiles, getGuardianPaths, readStateReport } from "../src/index.js";

describe("readStateReport", () => {
  it("healthy state -> not broken; hand-edited state -> broken (hash mismatch on read)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-report-"));
    await ensureStateFiles(root);
    expect((await readStateReport(root)).broken).toBe(false);

    const p = getGuardianPaths(root).state;
    const state = JSON.parse(await fs.readFile(p, "utf8"));
    state.goal = "edited by hand";
    await fs.writeFile(p, JSON.stringify(state), "utf8");

    const report = await readStateReport(root);
    expect(report.broken).toBe(true);
    expect(report.state.goal).toBe("edited by hand"); // content still shown, alongside the repair offer
    await fs.rm(root, { recursive: true, force: true });
  });

  it("unparseable state -> broken with safe defaults", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-report2-"));
    await ensureStateFiles(root);
    await fs.writeFile(getGuardianPaths(root).state, "{not json", "utf8");
    const report = await readStateReport(root);
    expect(report.broken).toBe(true);
    expect(report.state.tasks).toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
  });
});
