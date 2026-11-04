import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { consecutiveRepeats, criteriaFromTexts, defaultContract, getGuardianPaths, loopNudge, runPipeline, type AuditRecord } from "../src/index.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
const act = (actionType: "shell" | "edit" | "mcp", actionValue: string, conversationId = "c1"): AuditRecord => ({ ts: new Date().toISOString(), kind: "action.observed", actionType, actionValue, conversationId });

describe("loop detection (no model)", () => {
  it("counts the same command in a row; whitespace aside; any other action or edit resets; other conversations ignored", () => {
    const recs = [act("shell", "npm test"), act("edit", "a.js"), act("shell", "npm  test"), act("shell", "ls", "c2"), act("shell", "npm test ")];
    expect(consecutiveRepeats(recs, "c1", "npm test")).toBe(2);
    expect(consecutiveRepeats([...recs, act("shell", "git status")], "c1", "git status")).toBe(1);
  });

  it("light first, firmer after", () => {
    expect(loopNudge("npm test", 3).agent).toMatch(/^you've run this exact command several times in a row/);
    expect(loopNudge("npm test", 5).agent).toMatch(/5 runs in a row with nothing different in between: npm test[\s\S]*stop running it as is/);
    expect(loopNudge("x".repeat(400), 8).agent).toContain("(+100 more chars)");
  });

  async function ws(notify = "balanced"): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-loop-"));
    made.push(root);
    const p = getGuardianPaths(root);
    await fs.mkdir(p.telemetryDir, { recursive: true });
    await fs.writeFile(p.config, JSON.stringify({ notify }));
    await fs.writeFile(p.contract, JSON.stringify({ ...defaultContract(), goal: "Fix the test runner", successCriteria: criteriaFromTexts(["npm test passes"]), constraints: [] }));
    return root;
  }
  async function audit(root: string): Promise<Array<Record<string, unknown>>> {
    return (await fs.readFile(getGuardianPaths(root).audit, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  const ids = { conversationId: "c1" };

  it("through the hook pipeline: nudges at the 3rd and 5th identical run, records the loop and how it ended", async () => {
    const root = await ws();
    const msgs: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await runPipeline(root, "beforeShellExecution", "shell", "npm test", ids);
      msgs.push(JSON.stringify(r));
    }
    expect(msgs[2]).toMatch(/run this exact command several times/);
    expect(msgs[4]).toMatch(/5 runs in a row/);
    expect(msgs[3]).not.toMatch(/runs in a row|several times/);
    await runPipeline(root, "afterFileEdit", "edit", "src/runner.js", ids);
    const recs = await audit(root);
    expect(recs.filter((r) => r.kind === "loop.repeat").map((r) => r.count)).toEqual([3, 5]);
    expect(recs.filter((r) => r.kind === "flag.outcome").map((r) => [r.flag, r.outcome])).toEqual([["loop", "ignored"], ["loop", "fixed"]]);
  });

  it("quiet mode records the loop but says nothing", async () => {
    const root = await ws("quiet");
    let last = "";
    for (let i = 0; i < 3; i += 1) last = JSON.stringify(await runPipeline(root, "beforeShellExecution", "shell", "npm test", ids));
    expect(last).not.toMatch(/several times/);
    expect((await audit(root)).some((r) => r.kind === "loop.repeat")).toBe(true);
  });
});
