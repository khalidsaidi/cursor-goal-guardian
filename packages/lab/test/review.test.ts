import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deferPlainStatements, doneCheckRuleContent, evaluateDoneCheck, turnDiff } from "@goal-guardian/core";
import {
  buildReviewPrompt,
  changedTestExpectations,
  parseReviewOutput,
  resolveAgentCommand,
  reviewFollowup,
  runCursorAgentReviewer,
  sweepStaleScratch,
  type ReviewPromptInput,
  type ReviewerRun,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}

const HONEST = [
  "Fixed the parser.",
  "",
  "## Done check",
  '1. `pnpm test` → "214 passed"',
  "2. does not apply: single small change, nothing superseded",
  "3. does not apply: no heuristic decides inclusion in this change",
  "4. src/a.ts:12 is the only function touched",
  '5. `pnpm test` reproduces it in one command, output "214 passed (214)"',
  "6. does not apply: nothing left unfinished in this task",
  "7. does not apply: no numbers reported in this change",
].join("\n");

async function makeRoot(mode: "advisory" | "enforce", review: Record<string, unknown> = { enabled: true }): Promise<string> {
  const root = await tmp("gg-review-root-");
  const p = getGuardianPaths(root);
  await fs.mkdir(p.telemetryDir, { recursive: true });
  await fs.writeFile(p.config, JSON.stringify({ doneCheck: { mode, review: { agentPath: "/bin/true", ...review } } }));
  await fs.writeFile(p.contract, JSON.stringify({ ...defaultContract(), goal: "Fix the CSV parser", successCriteria: criteriaFromTexts([]), constraints: ["no new deps"] }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "x\n".repeat(40));
  return root;
}

async function tapeShell(root: string, conversationId: string, command: string, output?: string): Promise<void> {
  await appendAudit(root, { ts: nowIso(), kind: "hook.event", event: "beforeShellExecution", conversationId });
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: command, conversationId });
  if (output !== undefined) await recordShellOutput(root, { conversationId, command, output });
}

/** A scripted reviewer: replies in order, records every prompt it was given. */
function scripted(replies: Array<string | { error: string }>): ReviewerRun & { prompts: string[]; calls: number } {
  const prompts: string[] = [];
  const fn = (async (prompt: string) => {
    // First-pass calls (pieces, claims) and per-objection checks are not the reviewer's verdict:
    // answer them neutrally (nothing suspicious; keep every objection), off the script.
    if (prompt.includes("few small pieces")) return { ok: true as const, stdout: '{"pieces":[]}' };
    if (prompt.includes("few factual claims")) return { ok: true as const, stdout: '{"claims":[]}' };
    if (prompt.includes("You check one objection")) return { ok: true as const, stdout: '{"true":true,"material":true,"why":"x"}' };
    if (prompt.includes("change anything its task does not need")) return { ok: true as const, stdout: '{"unneeded":[]}' };
    if (prompt.includes("try to prove a single claim false")) return { ok: true as const, stdout: '{"refuted":false,"command":"x","printed":"x","explains":"x"}' };
    prompts.push(prompt);
    const next = replies[Math.min(prompts.length - 1, replies.length - 1)]!;
    return typeof next === "string" ? { ok: true as const, stdout: next } : { ok: false as const, error: next.error };
  }) as ReviewerRun & { prompts: string[]; calls: number };
  fn.prompts = prompts;
  Object.defineProperty(fn, "calls", { get: () => prompts.length });
  return fn;
}

const envelope = (objections: Array<{ line: string; objection: string }>): string =>
  JSON.stringify({ type: "result", is_error: false, result: "```json\n" + JSON.stringify({ objections }) + "\n```" });

const OBJ = { line: "1", objection: "`pnpm test` never exercises the quoted-comma path the change is about." };

const stop = (loopCount: number) => ({ status: "completed", loopCount });

describe("buildReviewPrompt", () => {
  const base: ReviewPromptInput = {
    goal: "Fix the CSV parser",
    successCriteria: [{ id: "sc_1", text: "parser handles quoted commas" }],
    constraints: ["no new deps"],
    message: HONEST,
    tape: [{ command: "pnpm test" }, { command: "pnpm test", output: "Tests 214 passed" }],
    edits: ["src/a.ts"],
    history: [],
    round: 1,
    maxRounds: 5,
    final: false,
    workspaceRoot: "/work/repo",
  };

  it("carries the goal, criteria, tape output, edits, the message and the read-only scope", () => {
    const p = buildReviewPrompt(base);
    for (const s of ["Fix the CSV parser", "sc_1: parser handles quoted commas", "no new deps", "$ pnpm test", "Tests 214 passed", "- src/a.ts", "<<<MESSAGE", "214 passed (214)", "/work/repo", "read-only", "round 1 of at most 5"]) {
      expect(p).toContain(s);
    }
    // The audit copy without output is folded into the copy with it.
    expect(p.match(/\$ pnpm test/g)).toHaveLength(1);
  });

  it("asks for objections in both directions and forbids inventing one", () => {
    const p = buildReviewPrompt(base);
    expect(p).toMatch(/BOTH directions/);
    expect(p).toMatch(/understatement is material/);
    expect(p).toMatch(/message itself admits something was not done/);
    expect(p).toMatch(/Do not invent one/);
    expect(p).toMatch(/plain, true sentence is a/);
    expect(p).toMatch(/strongest answer the agent/);
    // A user's own routing rules/hooks must not hand the review to another model (seen live).
    expect(p).toMatch(/do not delegate it to a subagent/);
  });

  it("later rounds show earlier objections and answers, and ask to drop what settled", () => {
    const p = buildReviewPrompt({
      ...base,
      round: 3,
      history: [
        { objections: [{ line: "4", objection: "scope criterion is not stated" }], answer: "Scope: the files the bug report names." },
        { objections: [{ line: "6", objection: "the Windows path is untested" }] },
      ],
    });
    expect(p).toContain("Round 1 — your objections:");
    expect(p).toContain("[4] scope criterion is not stated");
    expect(p).toContain("Scope: the files the bug report names.");
    expect(p).toContain("[6] the Windows path is untested");
    expect(p).toMatch(/Drop every objection the answer settled/);
  });

  it("the closing call says nobody will answer", () => {
    expect(buildReviewPrompt({ ...base, final: true, round: 6 })).toMatch(/closing review after 5 rounds: nobody will answer/);
  });

  it("stays inside the argv budget however large the session", () => {
    const big = "y".repeat(50_000);
    const p = buildReviewPrompt({
      ...base,
      message: big + HONEST,
      tape: Array.from({ length: 400 }, (_, i) => ({ command: `cmd-${i}`, output: big })),
      history: Array.from({ length: 5 }, () => ({ objections: [OBJ], answer: big })),
    });
    expect(p.length).toBeLessThanOrEqual(90_000);
    expect(p).toContain("Reply with ONLY a JSON object");
  });
});

describe("parseReviewOutput", () => {
  it("reads the cursor-agent envelope, fenced JSON inside", () => {
    expect(parseReviewOutput(envelope([OBJ]))).toEqual({ objections: [OBJ] });
  });
  it("an empty list is a clean review, not a failure", () => {
    expect(parseReviewOutput(envelope([]))).toEqual({ objections: [] });
  });
  it("prose around the object, numeric line ids, missing line", () => {
    const raw = 'Here you go: {"objections":[{"line":3,"objection":"a"},{"objection":"b"},{"line":"x","objection":""}]} thanks';
    expect(parseReviewOutput(raw)).toEqual({ objections: [{ line: "3", objection: "a" }, { line: "general", objection: "b" }] });
  });
  it("errors and garbage are null (recorded as an error, nothing sent)", () => {
    expect(parseReviewOutput(JSON.stringify({ is_error: true, result: '{"objections":[]}' }))).toBeNull();
    expect(parseReviewOutput("not json")).toBeNull();
    expect(parseReviewOutput('{"verdict":"ok"}')).toBeNull();
  });
  it("caps the list at four", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ line: String(i), objection: `o${i}` }));
    expect(parseReviewOutput(envelope(many))!.objections).toHaveLength(4);
  });
});

describe("reviewFollowup", () => {
  it("names the round, each objection, and tells the agent not to concede to end it", () => {
    const f = reviewFollowup([OBJ, { line: "sc_1", objection: "no run shows quoted commas" }], 2, 5);
    expect(f).toMatch(/round 2 of 5/);
    expect(f).toContain("1. [line 1]");
    expect(f).toContain("2. [sc_1] no run shows quoted commas");
    expect(f).toMatch(/do not concede just to end the review/);
    expect(f).toMatch(/updated `## Done check`/);
  });
});

describe("runCursorAgentReviewer (real process, fake agent)", () => {
  async function fakeAgent(body: string): Promise<{ cmd: string; log: string }> {
    const dir = await tmp("gg-fake-agent-");
    const log = path.join(dir, "log.json");
    const cmd = path.join(dir, "cursor-agent");
    await fs.writeFile(
      cmd,
      `#!/usr/bin/env node\nconst fs=require("fs");fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env.GOAL_GUARDIAN_REVIEWER}));\n${body}\n`,
      { mode: 0o755 },
    );
    return { cmd, log };
  }

  it.skipIf(process.platform === "win32")("read-only ask mode, scratch workspace, repo added for reading, marked env, scratch removed", async () => {
    const root = await tmp("gg-repo-");
    const { cmd, log } = await fakeAgent(`process.stdout.write(${JSON.stringify(envelope([]))});`);
    const out = await runCursorAgentReviewer("PROMPT", { command: cmd, workspaceRoot: root, timeoutMs: 20_000, model: "m1" });
    expect(out).toEqual({ ok: true, stdout: envelope([]) });
    const seen = JSON.parse(await fs.readFile(log, "utf8")) as { args: string[]; cwd: string; env: string };
    const arg = (flag: string): string | undefined => seen.args[seen.args.indexOf(flag) + 1];
    expect(arg("-p")).toBe("PROMPT");
    expect(arg("--mode")).toBe("ask");
    expect(arg("--add-dir")).toBe(root);
    expect(arg("--model")).toBe("m1");
    expect(arg("--workspace")).not.toBe(root);
    expect(arg("--workspace")).toBe(await fs.realpath(seen.cwd).catch(() => seen.cwd));
    expect(seen.args).not.toContain("--force");
    expect(seen.args).not.toContain("--yolo");
    expect(seen.env).toBe("1");
    await expect(fs.stat(arg("--workspace")!)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("timeout and non-zero exit come back as errors", async () => {
    const root = await tmp("gg-repo-");
    const slow = await fakeAgent("setTimeout(()=>{}, 30000);");
    expect(await runCursorAgentReviewer("P", { command: slow.cmd, workspaceRoot: root, timeoutMs: 500 })).toEqual({ ok: false, error: "reviewer timed out after 1s" });
    const failing = await fakeAgent('process.stderr.write("Not logged in\\n"); process.exit(2);');
    expect(await runCursorAgentReviewer("P", { command: failing.cmd, workspaceRoot: root, timeoutMs: 20_000 })).toEqual({ ok: false, error: "reviewer exited 2: Not logged in" });
  });

  it("resolveAgentCommand: configured path wins, then PATH", async () => {
    expect(resolveAgentCommand("/opt/x/cursor-agent")).toBe("/opt/x/cursor-agent");
    const dir = await tmp("gg-path-");
    const name = process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent";
    await fs.writeFile(path.join(dir, name), "", { mode: 0o755 });
    const prev = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(resolveAgentCommand()).toBe(path.join(dir, name));
    } finally {
      process.env.PATH = prev;
    }
  });
});

describe("parseReviewOutput — replies seen live", () => {
  it("JSON followed by a stray brace (cursor-agent, 2026-11-02) still parses", () => {
    const raw = JSON.stringify({ type: "result", is_error: false, result: 'Verifying the claims.\n{"objections":[{"line":"1","objection":"a {b} c"}]}\n{' });
    expect(parseReviewOutput(raw)).toEqual({ objections: [{ line: "1", objection: "a {b} c" }] });
  });
  it("unescaped quotes inside an objection (CSV's \"\", seen live 2026-11-02) are repaired", () => {
    const inner = '{"objections":[{"line":"sc_2","objection":"smoke only parses `Ada,"London, UK"` with no "" sequences","strongest_answer":"x","survives_because":"y"}]}';
    const raw = JSON.stringify({ type: "result", is_error: false, result: 'He said "check it".\n' + inner + "\n" });
    expect(parseReviewOutput(raw)).toEqual({ objections: [{ line: "sc_2", objection: 'smoke only parses `Ada,"London, UK"` with no "" sequences' }] });
  });
  it("valid JSON is never rewritten", () => {
    const ok = '{"objections":[{"line":"1","objection":"says \\"a\\", b"}]}';
    expect(parseReviewOutput(ok)).toEqual({ objections: [{ line: "1", objection: 'says "a", b' }] });
  });
  it("skips an earlier non-matching object", () => {
    expect(parseReviewOutput('{"note":"x"} then {"objections":[]}')).toEqual({ objections: [] });
  });
});

describe("stale reviewer scratch", () => {
  it("removes gg-review-* folders older than an hour, keeps fresh ones and anything else", async () => {
    const dir = await tmp("gg-sweep-");
    for (const n of ["gg-review-old", "gg-review-new", "other-old"]) await fs.mkdir(path.join(dir, n));
    const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(path.join(dir, "gg-review-old"), hourAgo, hourAgo);
    await fs.utimes(path.join(dir, "other-old"), hourAgo, hourAgo);
    await sweepStaleScratch(dir);
    expect((await fs.readdir(dir)).sort()).toEqual(["gg-review-new", "other-old"]);
  });
});

describe("the reviewer sees what actually changed", () => {
  it("turnDiff: tracked changes as a diff, new files by content, nothing outside git", async () => {
    const { execFileSync } = await import("node:child_process");
    const root = await tmp("gg-diff-");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
    git("init", "-q"); git("config", "user.email", "x@x"); git("config", "user.name", "x");
    await fs.writeFile(path.join(root, "test.js"), "assert.equal(f('h2w'), 'h2W');\n");
    git("add", "."); git("commit", "-qm", "base");
    await fs.writeFile(path.join(root, "test.js"), "assert.equal(f('h2w'), 'h2w');\n");
    await fs.writeFile(path.join(root, "new.js"), "export const x = 1;\n");
    const d = turnDiff(root, ["test.js", "new.js"]);
    expect(d).toContain("-assert.equal(f('h2w'), 'h2W');");
    expect(d).toContain("+assert.equal(f('h2w'), 'h2w');");
    expect(d).toContain("--- new file: new.js");
    expect(turnDiff(await tmp("gg-nogit-"), ["a.js"])).toBe("");
    expect(turnDiff(root, [])).toBe("");
  });

  it("the prompt carries the diff and the rule about rewritten test expectations", () => {
    const p = buildReviewPrompt({
      goal: "g", successCriteria: [], constraints: [], message: HONEST, tape: [], edits: ["test.js"], history: [],
      round: 1, maxRounds: 5, final: false, workspaceRoot: "/w", diff: "-a 'h2W'\n+a 'h2w'",
    });
    expect(p).toContain("<<<DIFF");
    expect(p).toContain("+a 'h2w'");
    expect(p).toMatch(/editing\s+what an existing test expects/);
    expect(buildReviewPrompt({ goal: "g", successCriteria: [], constraints: [], message: HONEST, tape: [], edits: [], history: [], round: 1, maxRounds: 5, final: false, workspaceRoot: "/w" })).not.toContain("<<<DIFF");
  });
});

describe("rewritten test expectations are named in the prompt", () => {
  const base: ReviewPromptInput = {
    goal: "Fix camelCase", successCriteria: [], constraints: [], message: HONEST, tape: [], edits: ["test.js"],
    history: [], round: 1, maxRounds: 5, final: false, workspaceRoot: "/work/repo",
  };
  const diff = [
    "diff --git a/test.js b/test.js",
    "--- a/test.js",
    "+++ b/test.js",
    "@@ -10,3 +10,3 @@",
    "-assert.equal(camelCase('h2w'), 'h2W');",
    "+assert.equal(camelCase('h2w'), 'h2w');",
    "-// a comment that is not an assertion",
    "diff --git a/index.js b/index.js",
    "--- a/index.js",
    "+++ b/index.js",
    "-  assert.equal(x, 1); // in source, not a test file",
  ].join("\n");

  it("finds removed assertions in test files only (camelcase-54: 8 rewritten; the 83 other real turns: none)", () => {
    expect(changedTestExpectations(diff)).toEqual([{ file: "test.js", line: "assert.equal(camelCase('h2w'), 'h2W');" }]);
    expect(changedTestExpectations("+++ b/test/a.test.ts\n+expect(a).toBe(1)")).toEqual([]);
    expect(changedTestExpectations("+++ b/src/__tests__/x.ts\n-  expect(f()).toEqual([1])")).toHaveLength(1);
    expect(changedTestExpectations("+++ b/src/parse.spec.mjs\n-t.is(parse('a'), 1)")).toHaveLength(1);
  });

  it("the prompt lists them and asks whether the message tells the user", () => {
    const p = buildReviewPrompt({ ...base, diff } as ReviewPromptInput);
    expect(p).toMatch(/removed or rewrote 1 existing assertion line in test files/);
    expect(p).toContain("- test.js: assert.equal(camelCase('h2w'), 'h2W');");
    expect(buildReviewPrompt({ ...base, diff: "+++ b/src/a.ts\n-x" } as ReviewPromptInput)).not.toMatch(/existing assertion/);
  });
});
