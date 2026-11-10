import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureGuardianFiles, getGuardianPaths, getLegacyPaths, fileExists, readContractSafe, writeContract } from "../src/index.js";

const legacyState = (goal: string) => ({ schemaVersion: 2, goal, successCriteria: [{ id: "sc_1", text: "it works" }], constraints: ["no deps"], tasks: [], activeTaskId: null });

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-contract-"));
  await ensureGuardianFiles(root);
  return root;
}

describe("the contract is the one record of the goal", () => {
  it("setup leaves an existing goal alone", async () => {
    const root = await workspace();
    const written = await writeContract(root, { schemaVersion: 2, goal: "Ship it", successCriteria: [], constraints: [] });
    await ensureGuardianFiles(root);
    expect(await readContractSafe(root)).toEqual(written);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("a damaged contract reads as empty", async () => {
    const root = await workspace();
    await fs.writeFile(getGuardianPaths(root).contract, "{not json", "utf8");
    expect((await readContractSafe(root)).goal).toBe("");
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("older workspaces keep their goal", () => {
  const stateFile = (root: string) => getLegacyPaths(root).state;

  it("a goal only in the old state file moves into the contract, once", async () => {
    const root = await workspace();
    await fs.writeFile(stateFile(root), JSON.stringify(legacyState("From the old store")), "utf8");
    const contract = await readContractSafe(root);
    expect(contract).toMatchObject({ goal: "From the old store", successCriteria: [{ id: "sc_1", text: "it works" }], constraints: ["no deps"] });
    expect(await fileExists(stateFile(root))).toBe(false);
    expect(JSON.parse(await fs.readFile(getGuardianPaths(root).contract, "utf8")).goal).toBe("From the old store");

    // The user clears it: it stays cleared.
    await writeContract(root, { ...contract, goal: "" });
    expect((await readContractSafe(root)).goal).toBe("");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("the contract wins over the old state, and the old file is set aside", async () => {
    const root = await workspace();
    await writeContract(root, { schemaVersion: 2, goal: "Newer goal", successCriteria: [], constraints: [] });
    await fs.writeFile(stateFile(root), JSON.stringify(legacyState("Older goal")), "utf8");
    expect((await readContractSafe(root)).goal).toBe("Newer goal");
    expect(await fileExists(stateFile(root))).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("a damaged or v1 state file changes nothing and breaks nothing", async () => {
    const root = await workspace();
    await fs.writeFile(stateFile(root), "{truncated", "utf8");
    expect((await readContractSafe(root)).goal).toBe("");
    await fs.writeFile(stateFile(root), JSON.stringify({ goal: "v1 goal", active_task: null }), "utf8");
    expect((await readContractSafe(root)).goal).toBe("");
    expect(await fileExists(stateFile(root))).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });
});
