import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fss from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendAudit,
  criteriaFromTexts,
  defaultContract,
  getGuardianPaths,
  makeReviewCopy,
  nowIso,
  testCommandFromTape,
  recordShellOutput,
  runDoneCheck,
  runProjectTests,
  runTestsWithoutChanges,
  strippedEnv,
} from "../src/index.js";

const made: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
afterEach(async () => {
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const root = await tmp("gg-sbx-root-");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "x@x");
  git("config", "user.name", "x");
  await fs.writeFile(path.join(root, "a.js"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "gone.js"), "x\n");
  await fs.writeFile(path.join(root, ".gitignore"), "node_modules\ndist\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node test.js" } }));
  await fs.writeFile(path.join(root, "test.js"), "import { a } from './a.js'; if (a !== 2) { console.log('FAIL a=' + a); process.exit(1) } console.log('ok 1 passed')\n");
  git("add", ".");
  git("commit", "-qm", "base");
  // The agent's turn: an edit, a new file, a deletion, ignored build output, deps, Cursor wiring.
  await fs.writeFile(path.join(root, "a.js"), "export const a = 2;\n");
  await fs.writeFile(path.join(root, "new.js"), "new\n");
  await fs.rm(path.join(root, "gone.js"));
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "big.js"), "built\n");
  await fs.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
  await fs.mkdir(path.join(root, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(root, ".cursor", "hooks.json"), "{}");
  return root;
}

describe("the throwaway copy", () => {
  it("is the working tree as the agent left it, over HEAD; deps linked; Cursor wiring and ignored output left out", async () => {
    const root = await repo();
    const copy = (await makeReviewCopy(root, await tmp("gg-sbx-tmp-")))!;
    expect(copy).not.toBeNull();
    const at = (p: string) => path.join(copy.dir, p);
    expect(await fs.readFile(at("a.js"), "utf8")).toContain("a = 2");
    expect(fss.existsSync(at("new.js"))).toBe(true);
    expect(fss.existsSync(at("gone.js"))).toBe(false);
    expect(fss.existsSync(at("dist/big.js"))).toBe(false);
    expect(fss.existsSync(at(".cursor/hooks.json"))).toBe(false);
    expect((await fs.lstat(at("node_modules"))).isSymbolicLink()).toBe(true);
    // git sees the same change set as in the real workspace, so `git stash` / `git show HEAD:` work.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: copy.dir, encoding: "utf8" });
    expect(status).toMatch(/ M a\.js/);
    expect(status).toMatch(/ D gone\.js/);
    expect(status).toMatch(/\?\? new\.js/);
    expect(execFileSync("git", ["show", "HEAD:a.js"], { cwd: copy.dir, encoding: "utf8" })).toContain("a = 1");
    // The user's repository is untouched.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toMatch(/ M a\.js/);
    expect(execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
  });

  it("runs the tests without the turn's changes, then restores the copy exactly", async () => {
    const root = await repo();
    const copy = (await makeReviewCopy(root, await tmp("gg-sbx-tmp-")))!;
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: copy.dir, encoding: "utf8" });
    const b = await runTestsWithoutChanges(copy.dir, copy.scratch, "node test.js", 20_000);
    expect(b.restored).toBe(true);
    expect(b.run).toMatchObject({ exit: 1 });
    expect(b.run!.output).toContain("FAIL a=1");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: copy.dir, encoding: "utf8" })).toBe(before);
    expect(await fs.readFile(path.join(copy.dir, "a.js"), "utf8")).toContain("a = 2");
    expect((await fs.lstat(path.join(copy.dir, "node_modules"))).isSymbolicLink()).toBe(true);
  });

  it("re-runs the test command the agent itself ran, whatever the tool; guesses none", () => {
    const pick = (runs: Array<string | { command: string; output?: string }>, configured?: string) => testCommandFromTape(runs, "/w/proj", "/copy", configured);
    expect(pick([])).toBeNull();
    expect(pick(["ls", "cat src/test/FooTest.java", "git diff"])).toBeNull();
    expect(pick(["mvn -q test"])).toBe("mvn -q test");
    expect(pick(["./gradlew check 2>&1 | tail -30"])).toBe("./gradlew check 2>&1");
    expect(pick(["cd /w/proj/api && pytest -q > /tmp/out.log 2>&1"])).toBe('cd "api" && pytest -q 2>&1');
    expect(pick(["cargo build && cargo test --offline; echo done"])).toBe("cargo test --offline");
    // A runner with no "test" in its name counts when what it printed reads like a test report.
    expect(pick([{ command: "npx ava 2>&1 | tail -5", output: "  12 tests passed" }])).toBe("npx ava 2>&1");
    expect(pick([{ command: "npx ava", output: "compiled" }])).toBeNull();
    // One-off probes and work outside the workspace are not the project's tests.
    expect(pick(['node -e "console.log(checked)"'])).toBeNull();
    expect(pick(["cd /tmp/x && npm test", "cd $HOME && make test", "node /tmp/check.mjs"])).toBeNull();
    // The latest wins; configured overrides.
    expect(pick(["npm test", "dotnet test"])).toBe("dotnet test");
    expect(pick(["npm test"], "just check")).toBe("just check");
  });

  it("is null outside a git repository", async () => {
    expect(await makeReviewCopy(await tmp("gg-sbx-nogit-"))).toBeNull();
  });

  it("re-runs the tests with credentials stripped; a hung test is killed at the budget", async () => {
    const root = await repo();
    const copy = (await makeReviewCopy(root, await tmp("gg-sbx-tmp-")))!;
    const pass = await runProjectTests(copy.dir, copy.scratch, "node test.js", 20_000);
    expect(pass).toMatchObject({ exit: 0 });
    expect(pass.output).toContain("ok 1 passed");
    process.env.GG_FAKE_NPM_TOKEN = "secret";
    try {
      const env = await runProjectTests(copy.dir, copy.scratch, "node -e \"console.log('tok=' + (process.env.GG_FAKE_NPM_TOKEN ?? 'none'), process.env.npm_config_offline)\"", 20_000);
      expect(env.output).toContain("tok=none true");
    } finally {
      delete process.env.GG_FAKE_NPM_TOKEN;
    }
    const t0 = Date.now();
    const hung = await runProjectTests(copy.dir, copy.scratch, "node -e \"setInterval(() => {}, 1000)\"", 1_000);
    expect(hung.exit).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("strippedEnv drops credential-looking variables, keeps the ones asked for", () => {
    process.env.GG_X_SECRET = "s";
    process.env.CURSOR_API_KEY = "c";
    try {
      const scratch = fss.mkdtempSync(path.join(os.tmpdir(), "gg-sbx-env-"));
      made.push(scratch);
      const env = strippedEnv(scratch, /^CURSOR/);
      expect(env.GG_X_SECRET).toBeUndefined();
      expect(env.CURSOR_API_KEY).toBe("c");
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.DOCKER_HOST).toMatch(/nonexistent/);
      expect(strippedEnv(scratch).CURSOR_API_KEY).toBeUndefined();
    } finally {
      delete process.env.GG_X_SECRET;
      delete process.env.CURSOR_API_KEY;
    }
  });
});

describe("Guardian re-runs the tests itself (no model)", () => {
  const DONE = [
    "Changed a.",
    "",
    "## Done check",
    '1. `npm test` → "ok 1 passed"',
    "2. does not apply: single small change, nothing superseded",
    "3. does not apply: no heuristic decides inclusion in this change",
    "4. a.js:1 is the only line touched",
    '5. `npm test` reproduces it in one command, output "ok 1 passed"',
    "6. does not apply: nothing left unfinished in this task",
    "7. does not apply: no numbers reported in this change",
  ].join("\n");

  /** HEAD has a = `head`; the agent's turn leaves a = `turn`. The tests pass when a === 2. */
  async function project(head: number, turn: number, doneCheck: Record<string, unknown>, counter?: string): Promise<string> {
    const root = await tmp("gg-rerun-");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "x@x");
    git("config", "user.name", "x");
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules\n.cursor\n");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node test.js" } }));
    const count = counter ? `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(counter)}, 'x');` : "";
    await fs.writeFile(path.join(root, "test.js"), `${count} import { a } from './a.js'; if (a !== 2) { console.log('FAIL expected 2, got ' + a); process.exit(1) } console.log('ok 1 passed')\n`);
    await fs.writeFile(path.join(root, "a.js"), `export const a = ${head};\n`);
    git("add", ".");
    git("commit", "-qm", "base");
    await fs.writeFile(path.join(root, "a.js"), `export const a = ${turn};\n`);
    const p = getGuardianPaths(root);
    await fs.mkdir(p.telemetryDir, { recursive: true });
    await fs.writeFile(p.config, JSON.stringify({ doneCheck }));
    await fs.writeFile(p.contract, JSON.stringify({ ...defaultContract(), goal: "Change a", successCriteria: criteriaFromTexts([]), constraints: [] }));
    await appendAudit(root, { ts: nowIso(), kind: "hook.event", event: "beforeShellExecution", conversationId: "c1" });
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: "npm test", conversationId: "c1" });
    await recordShellOutput(root, { conversationId: "c1", command: "npm test", output: "ok 1 passed" });
    return root;
  }

  async function reruns(root: string): Promise<Array<Record<string, unknown>>> {
    const text = await fs.readFile(getGuardianPaths(root).audit, "utf8").catch(() => "");
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "tests.rerun");
  }

  const stop = { status: "completed", loopCount: 0 };

  it("on by default, even with the done check off: a passing re-run is recorded", async () => {
    const root = await project(1, 2, {});
    expect(await runDoneCheck(root, { message: "Changed a.", conversationId: "c1", stop })).toBeNull();
    expect(await reruns(root)).toMatchObject([{ command: "npm test", exit: 0, broke: false, conversationId: "c1" }]);
    expect((await reruns(root))[0]!.baselineExit).toBeUndefined();
  });

  it("a turn that breaks passing tests: recorded as broke; in enforce, its Done check fails and the agent is sent back", async () => {
    const root = await project(2, 3, { mode: "enforce" });
    const out = await runDoneCheck(root, { message: DONE, conversationId: "c1", stop });
    expect(await reruns(root)).toMatchObject([{ exit: 1, baselineExit: 0, broke: true }]);
    expect(out!.result.verdict).toBe("fail");
    expect(out!.result.problems.join("\n")).toMatch(/fails with this turn's changes \(exit 1\) and passes without them — this turn broke it\. Last output: .*FAIL expected 2, got 3/);
    expect(out!.followup).toContain("this turn broke it");
    // The copy was cleaned up; the user's working tree is untouched.
    expect(await fs.readFile(path.join(root, "a.js"), "utf8")).toContain("a = 3");
  });

  it("tests already failing before the turn are not blamed on it", async () => {
    const root = await project(1, 3, { mode: "enforce" });
    const out = await runDoneCheck(root, { message: DONE, conversationId: "c1", stop });
    expect(await reruns(root)).toMatchObject([{ exit: 1, baselineExit: 1, broke: false }]);
    expect(out!.result.verdict).toBe("pass");
    expect(out!.followup).toBeNull();
  });

  it("a declared gap is honest: broken tests are recorded, the block is not contradicted", async () => {
    const root = await project(2, 3, { mode: "enforce" });
    const gap = DONE.replace("6. does not apply: nothing left unfinished in this task", "6. gap: test.js still expects 2 · closes with: update the test to 3 · held by: me");
    const out = await runDoneCheck(root, { message: gap, conversationId: "c1", stop });
    expect(await reruns(root)).toMatchObject([{ broke: true }]);
    expect(out!.result.verdict).toBe("pass");
  });

  it("no edit this turn, no re-run; tests.enabled false, no re-run", async () => {
    const root = await project(1, 2, { tests: { enabled: false } });
    await runDoneCheck(root, { message: "x", conversationId: "c1", stop });
    expect(await reruns(root)).toHaveLength(0);
    const again = await project(1, 2, {});
    await runDoneCheck(again, { message: "x", conversationId: "c1", stop });
    await runDoneCheck(again, { message: "x", conversationId: "c1", stop }); // nothing edited since the last re-run
    expect(await reruns(again)).toHaveLength(1);
  });

  async function outcomes(root: string): Promise<Array<Record<string, unknown>>> {
    const text = await fs.readFile(getGuardianPaths(root).audit, "utf8").catch(() => "");
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "flag.outcome");
  }

  it("records how each flag turned out: broken tests sent back, the agent fixes the code, tests go green", async () => {
    const root = await project(2, 3, { mode: "enforce" });
    const first = await runDoneCheck(root, { message: DONE, conversationId: "c1", stop });
    expect(first!.followup).toContain("this turn broke it");
    // The agent answers: fixes a.js back to 2.
    await fs.writeFile(path.join(root, "a.js"), "export const a = 2;\n");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
    const second = await runDoneCheck(root, { message: DONE, conversationId: "c1", stop: { status: "completed", loopCount: 1 } });
    expect(second!.result.verdict).toBe("pass");
    expect(await outcomes(root)).toMatchObject([
      { flag: "tests_broke", outcome: "tests_green", editsAfter: 1 },
      { flag: "followup", outcome: "fixed", editsAfter: 1 },
    ]);
  });

});
