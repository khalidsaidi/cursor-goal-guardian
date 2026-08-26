import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeWorkspace, type TestWorkspace } from "cursor-goal-guardian-testkit";
import { fileExists, getGuardianPaths } from "@goal-guardian/core";
import { recorded, workspace, makeContext } from "./mocks/vscode.js";
import { activate } from "../src/extension.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/v1");

const EXPECTED_COMMANDS = [
  "goalGuardian.setup",
  "goalGuardian.commandCenter",
  "goalGuardian.showPanel",
  "goalGuardian.refresh",
  "goalGuardian.openContract",
  "goalGuardian.openConfig",
  "goalGuardian.openState",
  "goalGuardian.openActions",
  "goalGuardian.openAuditLog",
  "goalGuardian.startNextTask",
  "goalGuardian.completeActiveTask",
  "goalGuardian.rebuildState",
  "goalGuardian.dispatchAction",
  "goalGuardian.rescoreDrift",
  "goalGuardian.uninstall",
];

const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
  recorded.reset();
  // Every path through activation/doctor must stay away from the real ~/.cursor.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-home-"));
  process.env.GOAL_GUARDIAN_TEST_HOME = home;
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
});
afterEach(async () => {
  delete process.env.GOAL_GUARDIAN_TEST_HOME;
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function snapshotDir(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const entry of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, entry.name);
      out.push(path.relative(dir, full));
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(dir);
  return out.sort();
}

describe("activation surface", () => {
  it("inertness contract: bare workspace -> commands registered, zero writes, zero notifications", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-inert-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "index.ts"), "export {}\n", "utf8");
    const before = await snapshotDir(root);

    workspace.workspaceFolders = [{ uri: { fsPath: root } }];
    await activate(makeContext() as never);

    expect([...recorded.commands.keys()].sort()).toEqual([...EXPECTED_COMMANDS].sort());
    expect(recorded.windowMessages).toEqual([]);
    expect(await snapshotDir(root)).toEqual(before);
    expect(await fileExists(path.join(root, ".cursor"))).toBe(false);
  });

  it("introduces itself once per install: first bare-workspace activation reveals the panel, later ones don't", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-greet-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    workspace.workspaceFolders = [{ uri: { fsPath: root } }];

    const context = makeContext();
    await activate(context as never);
    expect(recorded.executed).toContain("goalGuardian.goalPanel.focus");
    // Still no popups and no files — the reveal is the whole introduction.
    expect(recorded.windowMessages).toEqual([]);
    expect(await fileExists(path.join(root, ".cursor"))).toBe(false);

    recorded.executed.length = 0;
    await activate(context as never);
    expect(recorded.executed).not.toContain("goalGuardian.goalPanel.focus");
  });

  it("no workspace folder at all -> still registers commands, still silent", async () => {
    workspace.workspaceFolders = undefined;
    await activate(makeContext() as never);
    expect(recorded.commands.size).toBe(EXPECTED_COMMANDS.length);
    expect(recorded.windowMessages).toEqual([]);
  });

  it("v2 workspace -> services start (watchers), no notifications", async () => {
    const w: TestWorkspace = await makeWorkspace();
    cleanups.push(() => w.cleanup());
    workspace.workspaceFolders = [{ uri: { fsPath: w.root } }];

    await activate(makeContext() as never);
    expect(recorded.windowMessages).toEqual([]);
    expect(recorded.watchers).toContain(".cursor/goal-guardian/**");
    expect(recorded.watchers).toContain(".cursor/goal-guardian/telemetry/audit.jsonl");
    // Connected workspaces are never auto-revealed — the introduction is for
    // fresh installs only.
    expect(recorded.executed).not.toContain("goalGuardian.goalPanel.focus");
  });

  it("setup writes the session-anchoring rule; uninstall removes it", async () => {
    const { applySetup, runUninstall } = await import("../src/setup.js");
    const { GUARDIAN_RULE_RELATIVE_PATH } = await import("@goal-guardian/core");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-setup-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

    process.env.GOAL_GUARDIAN_TEST_HOME = root; // never touch the real ~/.cursor
    await applySetup(root, makeContext(root) as never, {
      goal: "Ship it",
      criteria: ["criterion one", "criterion two"],
      constraints: ["no new deps"],
      gitignore: false,
    });

    // Hub support: the user-level MCP registration landed in the (test) home.
    const userMcp = JSON.parse(await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8"));
    expect(userMcp.mcpServers["goal-guardian"]).toBeDefined();

    const rulePath = path.join(root, GUARDIAN_RULE_RELATIVE_PATH);
    const rule = await fs.readFile(rulePath, "utf8");
    expect(rule).toContain("alwaysApply: true");
    expect(rule).toContain("guardian_get_contract");
    expect(rule).toContain("guardian_record_progress");
    expect(await fileExists(path.join(root, ".cursor", "hooks.json"))).toBe(true);
    expect(await fileExists(path.join(root, ".cursor", "mcp.json"))).toBe(true);

    await runUninstall(root);
    expect(await fileExists(rulePath)).toBe(false);
    // The offered .gitignore line comes back out too — file and all when
    // guardian's line was its only content (covered further below).
    expect(await fileExists(path.join(root, ".cursor", "goal-guardian"))).toBe(false);
    // No trace means no empty shells either: when nothing but guardian
    // scaffolding existed, the wiring files and folders disappear entirely.
    expect(await fileExists(path.join(root, ".cursor", "hooks.json"))).toBe(false);
    expect(await fileExists(path.join(root, ".cursor", "rules"))).toBe(false);
    expect(await fileExists(path.join(root, ".cursor", "skills"))).toBe(false);
  });

  it("gitignore round-trip: setup's offered line is removed on uninstall; other lines survive", async () => {
    const { applySetup, runUninstall } = await import("../src/setup.js");
    const form = { goal: "Ship it", criteria: ["one"], constraints: [], gitignore: true };

    // Case 1: setup created the file -> uninstall deletes it entirely.
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), "gg-gi1-"));
    cleanups.push(() => fs.rm(fresh, { recursive: true, force: true }));
    process.env.GOAL_GUARDIAN_TEST_HOME = fresh;
    await applySetup(fresh, makeContext(fresh) as never, form);
    expect(await fs.readFile(path.join(fresh, ".gitignore"), "utf8")).toContain(".cursor/goal-guardian/telemetry/");
    await runUninstall(fresh);
    expect(await fileExists(path.join(fresh, ".gitignore"))).toBe(false);

    // Case 2: the user already had a .gitignore -> only our line is removed.
    const shared = await fs.mkdtemp(path.join(os.tmpdir(), "gg-gi2-"));
    cleanups.push(() => fs.rm(shared, { recursive: true, force: true }));
    process.env.GOAL_GUARDIAN_TEST_HOME = shared;
    await fs.writeFile(path.join(shared, ".gitignore"), "node_modules/\n", "utf8");
    await applySetup(shared, makeContext(shared) as never, form);
    await runUninstall(shared);
    const gi = await fs.readFile(path.join(shared, ".gitignore"), "utf8");
    expect(gi).toContain("node_modules/");
    expect(gi).not.toContain("goal-guardian");
  });

  it("v1 workspace -> auto-migrates with backups and exactly one passive notice", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-v1act-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.cp(path.join(FIXTURES, "case-basic"), root, { recursive: true });
    workspace.workspaceFolders = [{ uri: { fsPath: root } }];

    await activate(makeContext() as never);

    const p = getGuardianPaths(root);
    expect(await fileExists(p.migrationMarker)).toBe(true);
    expect(await fileExists(`${p.contract}.v1.bak`)).toBe(true);
    const notices = recorded.windowMessages.filter((m) => m.kind === "information");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toMatch(/upgraded this workspace/);
    expect(recorded.windowMessages).toHaveLength(1);

    // An upgraded user must land fully connected, not with transformed files
    // and a dead product: recorder wiring, agent rule, and skills all present.
    expect(await fileExists(path.join(root, ".cursor", "hooks.json"))).toBe(true);
    expect(await fileExists(path.join(root, ".cursor", "mcp.json"))).toBe(true);
    expect(await fileExists(path.join(root, ".cursor", "rules", "goal-guardian.mdc"))).toBe(true);
    expect(await fileExists(path.join(root, ".cursor", "skills", "guardian", "SKILL.md"))).toBe(true);
  });
});
