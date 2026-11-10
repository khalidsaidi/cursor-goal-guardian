import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit, applyImprovement, candidatePath, changedLines, defaultContract, getGuardianPaths, harnessPath, improveReviewer, isHeldOut, keepDecision,
  loadCases, materializeCase, noiseMargin, nowIso, readAuditTail, reviewLabels, reviewTemplate, saveCase, undoImprovement, REVIEW_PROMPT,
  type AuditRecord,
} from "../src/index.js";

const made: string[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  process.env = { ...savedEnv };
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

const contract = { ...defaultContract(), goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "the export test passes" }] };

async function repo(): Promise<string> {
  const root = await tmp("gg-improve-ws-");
  const p = getGuardianPaths(root);
  await fs.mkdir(p.telemetryDir, { recursive: true });
  await fs.writeFile(p.contract, JSON.stringify(contract));
  sh(root, "init", "-q");
  await fs.writeFile(path.join(root, "a.js"), "one\n");
  await fs.writeFile(path.join(root, ".gitignore"), ".cursor/\n");
  sh(root, "add", "a.js", ".gitignore");
  sh(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
  // The agent's work: an edit, a new text file and a new binary file.
  await fs.writeFile(path.join(root, "a.js"), "one\ntwo\n");
  await fs.writeFile(path.join(root, "new.txt"), "fresh\n");
  await fs.writeFile(path.join(root, "blob.bin"), Buffer.from([0, 255, 1, 254]));
  return root;
}

const OBJECTION = { fails: [{ id: "sc_1", evidence: "the export is a comment" }], extra: [{ file: "util.js", what: "renamed helpers" }] };
const review = (id: string, goalHash: string, objections = OBJECTION): AuditRecord =>
  ({ ts: nowIso(), kind: "goal.review", goalHash, reportTs: nowIso(), id, caseSaved: true, ran: true, seconds: 1, ...objections }) as AuditRecord;
const tick = () => new Promise((r) => setTimeout(r, 3));

describe("a review's case", () => {
  it("saves what the review saw and rebuilds it elsewhere: edits, new files, binaries", async () => {
    const root = await repo();
    expect(await saveCase(root, "rev_1", contract, { prompt: "p", ...OBJECTION }, nowIso())).toBeNull();
    const [c] = await loadCases(root);
    expect(c).toMatchObject({ id: "rev_1", goal: "Add CSV export", flagged: true, prompt: "p" });
    // The case never reaches a commit.
    expect(sh(root, "status", "--porcelain", "--ignored", ".cursor")).not.toContain("cases/rev_1/case.json\n?? ");
    const copy = await materializeCase(root, c!);
    made.push(copy!.scratch);
    expect(await fs.readFile(path.join(copy!.dir, "a.js"), "utf8")).toBe("one\ntwo\n");
    expect(await fs.readFile(path.join(copy!.dir, "new.txt"), "utf8")).toBe("fresh\n");
    expect([...(await fs.readFile(path.join(copy!.dir, "blob.bin")))]).toEqual([0, 255, 1, 254]);
    expect(sh(copy!.dir, "diff", "HEAD", "--stat")).toContain("a.js");
  });

  it("isn't saved when the work is too big, or there's no commit to replay it on", async () => {
    const root = await repo();
    expect(await saveCase(root, "rev_big", contract, { prompt: "p", ...OBJECTION }, nowIso(), 10)).toMatch(/over/);
    const bare = await tmp("gg-improve-bare-");
    sh(bare, "init", "-q");
    expect(await saveCase(bare, "rev_x", contract, { prompt: "p", ...OBJECTION }, nowIso())).toMatch(/no commit/);
    expect(await loadCases(root)).toEqual([]);
  });
});

describe("labels come from what people did", () => {
  it("the user's verdict wins; a fixed objection was right; marking done over one was wrong; arguing back is nothing", async () => {
    const records: AuditRecord[] = [];
    records.push(review("fixed", "h1"));
    records.push({ ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js" } as AuditRecord);
    records.push(review("fixed-pass", "h1", { fails: [], extra: [] }));
    records.push(review("overruled", "h2"));
    records.push({ ts: nowIso(), kind: "goal.control", goalHash: "h2", operation: "done", actor: "user" } as AuditRecord);
    records.push(review("argued", "h3"));
    records.push(review("argued-again", "h3"));
    records.push(review("user-right", "h4"));
    records.push({ ts: nowIso(), kind: "review.feedback", reviewId: "user-right", index: 1, label: "right" });
    records.push(review("user-wrong", "h5"));
    records.push({ ts: nowIso(), kind: "review.feedback", reviewId: "user-wrong", index: 0, label: "wrong" });
    records.push({ ts: nowIso(), kind: "review.feedback", reviewId: "user-wrong", index: 1, label: "wrong" });
    records.push(review("half-said", "h6"));
    records.push({ ts: nowIso(), kind: "review.feedback", reviewId: "half-said", index: 0, label: "wrong" });
    // The user overrides an implicit label.
    records.push({ ts: nowIso(), kind: "review.feedback", reviewId: "overruled", index: 0, label: "right" });
    const labels = reviewLabels(records);
    expect(labels.get("fixed")).toEqual({ label: "right", source: "fixed" });
    expect(labels.get("overruled")).toEqual({ label: "right", source: "user" });
    expect(labels.get("user-right")).toEqual({ label: "right", source: "user" });
    expect(labels.get("user-wrong")).toEqual({ label: "wrong", source: "user" });
    expect(labels.has("argued")).toBe(false);
    expect(labels.has("half-said")).toBe(false);
    expect(labels.has("fixed-pass")).toBe(false);
  });

  it("a passing review with no change in between labels nothing", () => {
    const labels = reviewLabels([review("a", "h"), review("b", "h", { fails: [], extra: [] })]);
    expect(labels.has("a")).toBe(false);
  });
});

describe("the split and the keep rule", () => {
  it("a case always lands on the same side, about a third held out", () => {
    const ids = Array.from({ length: 600 }, (_, i) => `rev_${i}`);
    expect(ids.map(isHeldOut)).toEqual(ids.map(isHeldOut));
    const share = ids.filter(isHeldOut).length / ids.length;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.42);
  });

  const runs = (flags: boolean[], labels: Array<"right" | "wrong">) => flags.map((flagged, i) => ({ caseId: `c${i}`, label: labels[i]!, flagged }));
  const labels: Array<"right" | "wrong"> = ["right", "right", "wrong", "wrong", "wrong"];

  it("worse or equal is not kept; better by the noise margin is; a lost catch never is", () => {
    const old = runs([true, true, true, true, false], labels);
    expect(keepDecision(old, runs([true, false, true, true, false], labels)).keep).toBe(false);
    expect(keepDecision(old, runs([true, true, true, false, true], labels)).keep).toBe(false);
    const better = keepDecision(old, runs([true, true, false, false, false], labels));
    expect(better).toMatchObject({ keep: true, old: { correct: 3, catches: 2 }, new: { correct: 5, catches: 2 } });
    const lost = keepDecision(old, runs([true, false, false, false, false], labels));
    expect(lost).toMatchObject({ keep: false, lostCatches: 1 });
    expect(noiseMargin(5)).toBe(1);
    expect(noiseMargin(25)).toBe(3);
  });

  it("counts changed lines both ways", () => {
    expect(changedLines("a\nb\nc", "a\nb\nc")).toBe(0);
    expect(changedLines("a\nb\nc", "a\nB\nc\nd")).toBe(3);
  });
});

describe("applying and undoing an improvement", () => {
  it("the workspace's own reviewer replaces the built-in one until undone", async () => {
    const root = await repo();
    await fs.mkdir(path.dirname(candidatePath(root, "improve_1")), { recursive: true });
    await fs.writeFile(candidatePath(root, "improve_1"), `${REVIEW_PROMPT}\nOnly object to what the goal needs.`);
    expect(reviewTemplate(root)).toBe(REVIEW_PROMPT);
    await applyImprovement(root, "improve_1");
    expect(reviewTemplate(root)).toContain("Only object to what the goal needs.");
    await undoImprovement(root);
    expect(reviewTemplate(root)).toBe(REVIEW_PROMPT);
    const kinds = (await readAuditTail(root, 100)).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["improve.apply", "improve.undo"]));
  });

  it("a version that drops a placeholder is ignored", async () => {
    const root = await repo();
    await fs.mkdir(path.dirname(harnessPath(root, "reviewer")), { recursive: true });
    await fs.writeFile(harnessPath(root, "reviewer"), "no placeholders here");
    expect(reviewTemplate(root)).toBe(REVIEW_PROMPT);
  });
});

describe("one improvement try, start to finish", () => {
  /**
   * A stand-in for the headless agent. As the proposer it adds a QUIET line to the instructions it was given; as a
   * reviewer it objects unless its instructions hold that line.
   */
  async function stub(proposerAnswer: "good" | "drops-placeholder"): Promise<string> {
    const dir = await tmp("gg-improve-stub-");
    const file = path.join(dir, "agent");
    await fs.writeFile(
      file,
      `#!/usr/bin/env node
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const say = (o) => process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify(o) }) + "\\n");
if (prompt.startsWith("You improve the instructions")) {
  const current = prompt.split("<instructions>\\n")[1].split("\\n</instructions>")[0];
  const next = ${proposerAnswer === "good" ? '`${current}\\nQUIET: only object to what an item needs.`' : '"QUIET and nothing else"'};
  say({ changes: [{ hypothesis: "most objections here were about extras the user wanted" }], prompt: next });
} else if (prompt.includes("QUIET")) say({ items: [{ id: "sc_1", verdict: "holds", evidence: "ok" }], extra: [] });
else say({ items: [{ id: "sc_1", verdict: "fails", evidence: "nope" }], extra: [] });
`,
    );
    await fs.chmod(file, 0o755);
    return file;
  }

  /** Cases where the reviewer objected; held-out ones are all labelled wrong, so a quieter reviewer scores better. */
  async function labelledWorkspace(): Promise<string> {
    const root = await repo();
    let rights = 0;
    for (let i = 0; i < 12; i += 1) {
      const id = `rev_${i}`;
      await saveCase(root, id, contract, { prompt: REVIEW_PROMPT, ...OBJECTION }, nowIso());
      await appendAudit(root, review(id, `h${i}`));
      const label = isHeldOut(id) || rights >= 3 ? "wrong" : "right";
      if (label === "right") rights += 1;
      await appendAudit(root, { ts: nowIso(), kind: "review.feedback", reviewId: id, index: 0, label });
      await appendAudit(root, { ts: nowIso(), kind: "review.feedback", reviewId: id, index: 1, label });
      await tick();
    }
    expect(rights).toBeGreaterThan(0);
    return root;
  }

  it("keeps a proposal that does better on cases it never saw, and saves it for the user to apply", async () => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stub("good");
    const result = await improveReviewer(root, 20_000);
    expect(result.status).toBe("done");
    expect(result.run).toMatchObject({ kept: true });
    expect(result.run!.new!.correct).toBeGreaterThan(result.run!.old!.correct);
    expect(result.run!.diff).toContain("+ QUIET");
    expect(await fs.readFile(candidatePath(root, result.run!.id), "utf8")).toContain("QUIET");
    // Nothing changes until the user applies it.
    expect(reviewTemplate(root)).toBe(REVIEW_PROMPT);
  }, 60_000);

  it("rejects a proposal that breaks the template, and remembers it", async () => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stub("drops-placeholder");
    const result = await improveReviewer(root, 20_000);
    expect(result.run).toMatchObject({ kept: false, reason: "the proposal dropped {goal} or {items}" });
  }, 60_000);

  it("won't start without enough labelled cases of both kinds", async () => {
    const root = await repo();
    process.env.GOAL_GUARDIAN_REVIEWER = await stub("good");
    expect((await improveReviewer(root)).status).toBe("not-enough");
  });
});
