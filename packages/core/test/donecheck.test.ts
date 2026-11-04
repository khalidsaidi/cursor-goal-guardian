import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit,
  criteriaFromTexts,
  defaultContract,
  doneCheckFollowup,
  doneCheckRuleContent,
  evaluateDoneCheck,
  evaluateLine,
  getGuardianPaths,
  lastAssistantTextFromTranscript,
  nowIso,
  parseDoneBlock,
  readAuditTail,
  recordShellOutput,
  runDoneCheck,
  storeLastResponse,
  readLastResponse,
  turnActionCount,
  type DoneCheckContext,
} from "../src/index.js";

const ctx = (over: Partial<DoneCheckContext> = {}): DoneCheckContext => ({
  criterionIds: [],
  shellRuns: [{ command: "pnpm test", output: "Test Files  3 passed (3)\n     Tests  214 passed (214)" }],
  turnActions: 1,
  lineCount: (rel) => (rel === "src/a.ts" ? 40 : null),
  ...over,
});

const GOOD_LINES = [
  '1. `pnpm test` → "214 passed"',
  "2. does not apply: single small change, nothing superseded",
  "3. does not apply: no heuristic decides inclusion in this change",
  "4. src/a.ts:12 is the only function touched",
  "5. `pnpm test` reproduces it in one command, output \"214 passed (214)\"",
  "6. does not apply: nothing left unfinished in this task",
  "7. does not apply: no numbers reported in this change",
];

function block(lines: string[], heading = "## Done check"): string {
  return ["Changed the parser.", "", heading, ...lines].join("\n");
}

describe("parseDoneBlock", () => {
  it("finds the block that ends the message and keys its lines", () => {
    const p = parseDoneBlock(block(GOOD_LINES));
    expect(p.kind).toBe("done");
    expect(p.lines.map((l) => l.key)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(p.problems).toEqual([]);
  });

  it("joins wrapped continuation lines onto the previous line", () => {
    const p = parseDoneBlock("## Done check\n1. `pnpm test`\n   → \"214 passed\"\n2. x");
    expect(p.lines[0]!.text).toBe('`pnpm test` → "214 passed"');
  });

  it("a later heading means the block does not end the message", () => {
    const p = parseDoneBlock(block(GOOD_LINES) + "\n\n## Next steps\nmore");
    expect(p.problems[0]).toMatch(/must end the message/);
  });

  it("ignores headings inside fenced code", () => {
    const p = parseDoneBlock("Here is the format:\n```\n## Done check\n1. x\n```\nno block really");
    expect(p.kind).toBe("none");
  });

  it("accepts sc_N criterion lines and list-bulleted numbering", () => {
    const p = parseDoneBlock("## Done check\n- 1. a\nsc_1. b\nsc_2: c");
    expect(p.lines.map((l) => l.key)).toEqual(["1", "sc_1", "sc_2"]);
  });
});

describe("evaluateLine — wrongly accepted (fakes must not pass)", () => {
  it.each(["n/a", "N/A", "verified", "see above", "Verified.", "done", "", "—"])("bare %j is unsupported", (text) => {
    expect(evaluateLine("1", text, ctx()).status).toBe("unsupported");
  });

  it("does not apply with a bare reason is unsupported", () => {
    expect(evaluateLine("1", "does not apply: n/a", ctx()).status).toBe("unsupported");
    expect(evaluateLine("1", "does not apply:", ctx()).status).toBe("unsupported");
  });

  it("prose with no evidence form is unsupported", () => {
    expect(evaluateLine("1", "All claims are backed by the work I did.", ctx()).status).toBe("unsupported");
  });

  it("a command with no output is unsupported", () => {
    const r = evaluateLine("1", "ran `pnpm test`", ctx());
    expect(r.status).toBe("unsupported");
    expect(r.note).toMatch(/not its output/);
  });

  it("a command that never ran is contradicted", () => {
    const r = evaluateLine("1", '`pnpm lint` → "0 problems"', ctx());
    // Never ran, so its quoted output was printed nowhere: still a fabrication.
    expect(r.status).toBe("contradicted");
    expect(r.note).toMatch(/"0 problems" was not printed in this session/);
  });

  it("quoted output the command never printed is contradicted", () => {
    const r = evaluateLine("1", '`pnpm test` → "215 passed"', ctx());
    expect(r.status).toBe("contradicted");
    expect(r.note).toMatch(/"215 passed" was not printed in this session/);
  });

  it("a file:line past the end of the file is contradicted", () => {
    expect(evaluateLine("1", "src/a.ts:41 holds the fix", ctx()).status).toBe("contradicted");
  });

  it("a file that does not exist is contradicted", () => {
    expect(evaluateLine("1", "src/missing.ts:3 holds the fix", ctx()).status).toBe("contradicted");
  });

  it("a sample size with only one error rate is unsupported", () => {
    expect(evaluateLine("3", "n=50 random cases, 4% wrongly included", ctx()).status).toBe("unsupported");
  });
});

describe("evaluateLine — wrongly rejected (honest evidence must pass)", () => {
  it("command + verbatim quoted output is backed", () => {
    expect(evaluateLine("1", '`pnpm test` → "214 passed"', ctx()).status).toBe("backed");
  });

  it("quote matching is whitespace- and case-insensitive and ignores ANSI colour", () => {
    const c = ctx({ shellRuns: [{ command: "pnpm test", output: "\x1b[32mTests\x1b[0m   214   PASSED" }] });
    expect(evaluateLine("1", '`pnpm test` → "tests 214 passed"', c).status).toBe("backed");
  });

  it("command matching tolerates quoting/escaping differences and wrappers", () => {
    const c = ctx({ shellRuns: [{ command: 'cd /w && pnpm -r test --filter "core"', output: "ok 12 passed" }] });
    expect(evaluateLine("1", "`pnpm -r test --filter core` → \"12 passed\"", c).status).toBe("backed");
  });

  it("command + output words (no quote) is backed when it ran", () => {
    expect(evaluateLine("1", "`pnpm test` passed, 214 tests", ctx()).status).toBe("backed");
  });

  it("without captured output (observer channel) a quote is stated-not-contradicted", () => {
    const c = ctx({ shellRuns: [{ command: "pnpm test" }] });
    expect(evaluateLine("1", '`pnpm test` → "214 passed"', c).status).toBe("backed");
    expect(evaluateLine("1", '`pnpm test` → "anything at all"', c).status).toBe("backed");
  });

  it("a valid file:line is backed; Windows separators are accepted", () => {
    expect(evaluateLine("4", "src/a.ts:12 is the change", ctx()).status).toBe("backed");
    expect(evaluateLine("4", "src\\a.ts:40 is the change", ctx()).status).toBe("backed");
  });

  it("a sample size with both error rates is stated (form-valid, not machine-checkable)", () => {
    const r = evaluateLine("3", "n=50 random cases: 2% wrongly included, 4% wrongly excluded", ctx());
    expect(r.status).toBe("stated");
  });

  it("does not apply with a real reason is waived", () => {
    expect(evaluateLine("7", "does not apply: no numbers reported", ctx()).status).toBe("waived");
  });

  it("identifiers in backticks are not mistaken for commands", () => {
    // `parseConfig` is code, not a command — it must not trigger "never ran".
    expect(evaluateLine("4", "`parseConfig` changed at src/a.ts:12", ctx()).status).toBe("backed");
  });
});

describe("evaluateDoneCheck", () => {
  it("a complete honest block passes", () => {
    const r = evaluateDoneCheck(block(GOOD_LINES), ctx());
    expect(r.verdict).toBe("pass");
    expect(r.lines.filter((l) => l.status === "backed").map((l) => l.key)).toEqual(["1", "4", "5"]);
  });

  it("a missing line fails", () => {
    const r = evaluateDoneCheck(block(GOOD_LINES.slice(0, 6)), ctx());
    expect(r.verdict).toBe("fail");
    expect(r.lines.find((l) => l.key === "7")!.status).toBe("missing");
  });

  it("an eighth numbered line fails (exactly seven)", () => {
    const r = evaluateDoneCheck(block([...GOOD_LINES, "8. extra"]), ctx());
    expect(r.verdict).toBe("fail");
    expect(r.problems.join()).toMatch(/exactly seven/);
  });

  it("a duplicated line fails", () => {
    const r = evaluateDoneCheck(block([...GOOD_LINES, "3. again"]), ctx());
    expect(r.problems.join()).toMatch(/appears twice/);
  });

  it("each contract success criterion needs its own line", () => {
    const c = ctx({ criterionIds: ["sc_1", "sc_2"] });
    const r = evaluateDoneCheck(block([...GOOD_LINES, 'sc_1. `pnpm test` → "214 passed"']), c);
    expect(r.verdict).toBe("fail");
    expect(r.lines.find((l) => l.key === "sc_2")).toMatchObject({ status: "missing", note: "criterion not addressed" });
    const ok = evaluateDoneCheck(
      block([...GOOD_LINES, 'sc_1. `pnpm test` → "214 passed"', "sc_2. does not apply: criterion is for a later task"]),
      c,
    );
    expect(ok.verdict).toBe("pass");
  });

  it("an unknown sc_ id is a problem", () => {
    const r = evaluateDoneCheck(block([...GOOD_LINES, "sc_9. x"]), ctx());
    expect(r.problems.join()).toMatch(/sc_9 is not a success criterion/);
  });

  it("no block on a turn that changed something is absent", () => {
    expect(evaluateDoneCheck("All done!", ctx()).verdict).toBe("absent");
  });

  it("no block on a Q&A turn (nothing changed) is not required", () => {
    const r = evaluateDoneCheck("The function returns a promise.", ctx({ turnActions: 0 }));
    expect(r).toMatchObject({ verdict: "not_required", required: false });
  });

  it("a well-formed Blocked block is blocked", () => {
    const msg = "Couldn't finish.\n\n## Blocked\n- What: publishing to Open VSX\n- Unblock: an OVSX_TOKEN with publish rights\n- Who: the repo owner";
    expect(evaluateDoneCheck(msg, ctx()).verdict).toBe("blocked");
  });

  it("a Blocked block missing who holds it fails", () => {
    const msg = "## Blocked\n- What: publishing\n- Unblock: a token";
    const r = evaluateDoneCheck(msg, ctx());
    expect(r.verdict).toBe("fail");
    expect(r.lines.find((l) => l.key === "who")!.status).toBe("missing");
  });
});

describe("doneCheckFollowup", () => {
  it("names exactly the failing lines", () => {
    const r = evaluateDoneCheck(block(['1. `pnpm lint` → "0 problems"', ...GOOD_LINES.slice(1, 6), "7. n/a"]), ctx());
    const f = doneCheckFollowup(r)!;
    expect(f).toMatch(/line 1: "0 problems" was not printed in this session/);
    expect(f).toMatch(/line 7: "n\/a" is not evidence/);
    expect(f).not.toMatch(/line 2/);
  });

  it("nothing to send on pass, blocked or not_required", () => {
    expect(doneCheckFollowup(evaluateDoneCheck(block(GOOD_LINES), ctx()))).toBeNull();
    expect(doneCheckFollowup(evaluateDoneCheck("hi", ctx({ turnActions: 0 })))).toBeNull();
  });

  it("an absent block asks for one", () => {
    expect(doneCheckFollowup(evaluateDoneCheck("done", ctx()))).toMatch(/did not end with a `## Done check`/);
  });
});

describe("transcript reading", () => {
  it("returns the last text-bearing assistant entry of the latest turn", () => {
    const jsonl = [
      { role: "user", message: { content: [{ type: "text", text: "do it" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "working" }, { type: "tool_use", name: "Shell" }] } },
      { role: "assistant", message: { content: [{ type: "tool_use", name: "Shell" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "Final.\n## Done check\n1. x" }] } },
      { type: "turn_ended", status: "success" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    expect(lastAssistantTextFromTranscript(jsonl)).toBe("Final.\n## Done check\n1. x");
  });

  it("a new user message resets the turn; a partial trailing line is tolerated", () => {
    const jsonl = [
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "old" }] } }),
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "again" }] } }),
      '{"role":"assist',
    ].join("\n");
    expect(lastAssistantTextFromTranscript(jsonl)).toBeNull();
  });
});

describe("rule content", () => {
  it("states the exact block format the parser accepts", () => {
    const rule = doneCheckRuleContent("enforce");
    expect(rule).toMatch(/alwaysApply: true/);
    expect(rule).toMatch(/## Done check/);
    expect(rule).toMatch(/- Who:/);
    expect(rule).toMatch(/sends you back/);
    expect(doneCheckRuleContent("advisory")).toMatch(/shown to the user/);
  });
});

// ---- I/O: a real workspace on disk ----

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function makeRoot(mode: "off" | "advisory" | "enforce", criteria: string[] = []): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-done-"));
  roots.push(root);
  const p = getGuardianPaths(root);
  await fs.mkdir(p.telemetryDir, { recursive: true });
  await fs.writeFile(p.config, JSON.stringify({ doneCheck: { mode } }));
  await fs.writeFile(p.contract, JSON.stringify({ ...defaultContract(), goal: "g", successCriteria: criteriaFromTexts(criteria) }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "x\n".repeat(40));
  return root;
}

async function tapeShell(root: string, conversationId: string, command: string, output?: string): Promise<void> {
  await appendAudit(root, { ts: nowIso(), kind: "hook.event", event: "beforeShellExecution", conversationId });
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: command, conversationId });
  if (output !== undefined) await recordShellOutput(root, { conversationId, command, output });
}

describe("runDoneCheck (on disk)", () => {
  it("off mode records nothing", async () => {
    const root = await makeRoot("off");
    expect(await runDoneCheck(root, { message: "x", conversationId: "c1" })).toBeNull();
    expect((await readAuditTail(root)).some((r) => r.kind === "done.check")).toBe(false);
  });

  it("checks against this conversation's tape only", async () => {
    const root = await makeRoot("advisory");
    await tapeShell(root, "other", "pnpm lint", "0 problems");
    await tapeShell(root, "c1", "pnpm test", "214 passed");
    const lines = ['1. `pnpm lint` → "0 problems"', ...GOOD_LINES.slice(1)];
    const out = await runDoneCheck(root, { message: block(lines), conversationId: "c1" });
    expect(out!.result.lines[0]).toMatchObject({ status: "contradicted" });
    const rec = (await readAuditTail(root)).find((r) => r.kind === "done.check")!;
    expect(rec).toMatchObject({ verdict: "fail", conversationId: "c1", followupSent: false, turnActions: 1 });
  });

  it("enforce mode returns a follow-up only from a completed stop under the cap", async () => {
    const root = await makeRoot("enforce");
    await tapeShell(root, "c1", "pnpm test", "214 passed");
    const msg = "I changed it, all good.";
    expect((await runDoneCheck(root, { message: msg, conversationId: "c1", stop: { status: "completed", loopCount: 0 } }))!.followup).toMatch(/Done check/);
    await tapeShell(root, "c1", "pnpm test", "214 passed");
    expect((await runDoneCheck(root, { message: msg, conversationId: "c1", stop: { status: "aborted", loopCount: 0 } }))!.followup).toBeNull();
    // The cap counts Guardian's own follow-ups in this chain: answers to them
    // arrive at loop_count + 1. Three sent (maxFollowups 3), the fourth is not.
    expect((await runDoneCheck(root, { message: msg, conversationId: "c1", stop: { status: "completed", loopCount: 1 } }))!.followup).toMatch(/Done check/);
    expect((await runDoneCheck(root, { message: msg, conversationId: "c1", stop: { status: "completed", loopCount: 2 } }))!.followup).toMatch(/Done check/);
    expect((await runDoneCheck(root, { message: msg, conversationId: "c1", stop: { status: "completed", loopCount: 3 } }))!.followup).toBeNull();
    // Advisory never sends.
    const adv = await makeRoot("advisory");
    await tapeShell(adv, "c1", "pnpm test", "214 passed");
    expect((await runDoneCheck(adv, { message: msg, conversationId: "c1", stop: { status: "completed", loopCount: 0 } }))!.followup).toBeNull();
  });

  it("a turn boundary is the previous done check: a Q&A turn after work owes nothing", async () => {
    const root = await makeRoot("advisory");
    await tapeShell(root, "c1", "pnpm test", "214 passed");
    await runDoneCheck(root, { message: block(GOOD_LINES), conversationId: "c1" });
    const second = await runDoneCheck(root, { message: "It returns a promise.", conversationId: "c1" });
    expect(second!.result.verdict).toBe("not_required");
    expect(turnActionCount(await readAuditTail(root), { conversationId: "c1" })).toBe(0);
  });

  it("guardian's own telemetry edits do not count as turn work", async () => {
    const root = await makeRoot("advisory");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: ".cursor/goal-guardian/state.json", conversationId: "c1" });
    expect((await runDoneCheck(root, { message: "ok", conversationId: "c1" }))!.result.verdict).toBe("not_required");
  });

  it("id-less observer records count inside the conversation window", async () => {
    const root = await makeRoot("advisory");
    const since = new Date(Date.now() - 1000).toISOString();
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: "pnpm test", source: "observer" });
    const out = await runDoneCheck(root, { message: block(GOOD_LINES), conversationId: "t-1", sinceIso: since, source: "observer" });
    expect(out!.result.lines[0]!.status).toBe("backed");
    const old = await runDoneCheck(root, { message: block(GOOD_LINES), conversationId: "t-2", sinceIso: new Date(Date.now() + 60_000).toISOString(), source: "observer" });
    // The run predates this conversation: it is not evidence here.
    expect(old!.result.required).toBe(false);
    // No in-scope output to contradict: the line fails as unverified, not as a fabrication.
    expect(old!.result.lines[0]).toMatchObject({ status: "unsupported", note: expect.stringMatching(/is not on the shell tape/) });
  });

  it("shell output keeps head and tail of long output", async () => {
    const root = await makeRoot("advisory");
    const long = `START\n${"noise\n".repeat(5000)}Tests  214 passed`;
    await recordShellOutput(root, { conversationId: "c1", command: "pnpm test", output: long });
    const raw = await fs.readFile(getGuardianPaths(root).shellOutput, "utf8");
    const line = JSON.parse(raw.trim()) as { output: string };
    expect(line.output.startsWith("START")).toBe(true);
    expect(line.output.endsWith("Tests  214 passed")).toBe(true);
    expect(line.output.length).toBeLessThan(4_200);
  });

  it("stores and reads the last response per conversation", async () => {
    const root = await makeRoot("advisory");
    await storeLastResponse(root, "c1", "g1", "hello");
    await storeLastResponse(root, "c2", "g2", "other");
    expect(await readLastResponse(root, "c1")).toMatchObject({ generationId: "g1", text: "hello" });
  });
});

// ---- Regressions from a live Cursor IDE run (fixture: real hook payloads) ----

import liveFixture from "./fixtures/donecheck/live-ide-subtract.json";

describe("live IDE run regressions", () => {
  const fx = liveFixture as { shellRuns: Array<{ command: string; output: string }>; responses: string[] };
  const liveCtx = (runs: number): DoneCheckContext => ({
    criterionIds: ["sc_1"],
    shellRuns: fx.shellRuns.slice(0, runs),
    turnActions: 2,
    lineCount: (rel) => (rel === "src/math.ts" ? 7 : null),
  });

  it("quotes inside a backticked command are command text, not claimed output (was a false contradiction)", () => {
    const r = evaluateDoneCheck(fx.responses[0]!, liveCtx(1));
    expect(r.lines.find((l) => l.key === "1")!.status).toBe("backed");
    expect(r.lines.find((l) => l.key === "5")!.status).toBe("backed");
    // Prose-only lines still fail the user's rule as written.
    expect(r.lines.find((l) => l.key === "2")!.status).toBe("unsupported");
  });

  it("the corrected second-turn block passes against the real tape", () => {
    expect(evaluateDoneCheck(fx.responses[1]!, liveCtx(fx.shellRuns.length)).verdict).toBe("pass");
  });
});

describe("output in backticks after an arrow", () => {
  it("is checked against what the command printed — both directions", () => {
    expect(evaluateLine("1", '`pnpm test` → `"214 passed"`', ctx()).status).toBe("backed");
    expect(evaluateLine("1", "`pnpm test` → `214 passed`", ctx()).status).toBe("backed");
    expect(evaluateLine("1", "`pnpm test` → `215 passed`", ctx()).status).toBe("contradicted");
  });
});

describe("declared gaps", () => {
  it('"held by: me" is a holder (corpus2 lrucache-b, bizdays-a); an empty or bare holder is not', () => {
    expect(evaluateLine("6", "gap: get() recency refresh not covered by a test · closes with: a test that reads 'a' first · held by: me", ctx()).status).toBe("gap");
    expect(evaluateLine("6", "gap: x refresh untested · closes with: a test · held by: n/a", ctx()).status).toBe("unsupported");
    expect(evaluateLine("6", "gap: x refresh untested · closes with: a test · held by: -", ctx()).status).toBe("unsupported");
  });

  it("a full gap line is accepted as declared, not forced into does-not-apply", () => {
    const r = evaluateLine("6", "gap: smoke check never imports subtract · closes with: a ts-node import test · held by: the user (not requested)", ctx());
    expect(r.status).toBe("gap");
    expect(r.note).toMatch(/held by the user/);
  });

  it("a gap missing its holder or with bare parts is unsupported", () => {
    expect(evaluateLine("6", "gap: something · closes with: n/a · held by: me", ctx()).status).toBe("unsupported");
    expect(evaluateLine("6", "gap: smoke check never imports subtract", ctx()).status).toBe("unsupported");
  });

  it("gaps do not fail the verdict", () => {
    const lines = [...GOOD_LINES.slice(0, 5), "6. gap: CSV edge cases untested · closes with: a property test · held by: next session", GOOD_LINES[6]!];
    expect(evaluateDoneCheck(block(lines), ctx()).verdict).toBe("pass");
  });
});

// ---- Hand-labelled real agent lines (blind labels; see fixture "source") ----

import labelled from "./fixtures/donecheck/labelled-agent-lines.json";

describe("labelled real agent lines", () => {
  const ACCEPT = new Set(["backed", "stated", "waived", "gap"]);
  // Residual, measured and kept visible rather than fitted away:
  // "warmup excluded from reported 15" reads as stated output (wrongly accepted);
  // "three fixed inputs, 0/0 wrong" spells the sample size in words (wrongly rejected).
  const KNOWN_RESIDUALS = new Set(["h-timing/4", "r4-csv/3"]);
  const items = (labelled as { items: Array<{ id: string; message: string; shellRuns: Array<{ command: string; output: string }>; files: Record<string, number>; labels: Record<string, string>; criterionTexts?: string[] }> }).items;

  for (const item of items) {
    it(`${item.id}: every labelled line is classified as labelled`, () => {
      const parsed = parseDoneBlock(item.message);
      const lineCtx: DoneCheckContext = {
        criterionIds: [],
        criterionTexts: item.criterionTexts ?? [],
        shellRuns: item.shellRuns,
        turnActions: 1,
        lineCount: (f) => item.files[f.replace(/^\/tmp\/gg-e2e-[A-Za-z0-9]+\//, "")] ?? null,
      };
      for (const line of parsed.lines) {
        const label = item.labels[line.key];
        if (!label || label === "X" || KNOWN_RESIDUALS.has(`${item.id}/${line.key}`)) continue;
        const r = evaluateLine(line.key, line.text, lineCtx);
        expect({ key: line.key, accepted: ACCEPT.has(r.status) }).toEqual({ key: line.key, accepted: label === "P" });
      }
    });
  }
});

describe("real-turn false contradictions (36 real Cursor agent turns, 2026-11-02)", () => {
  const runs = [
    { command: "node --test test.js", output: "1..33\n# tests 33\n# pass 33\n# fail 0\n" },
    { command: "node -e \"import('./index.js')\"", output: "issue27 PASS\nCAUGHT DEADLOCK_TIMEOUT\n" },
  ];
  const files: Record<string, string> = { "package.json": '{\n  "engines": {\n    "node": ">=22"\n  }\n}\n' };
  const c = ctx({ shellRuns: runs, lineCount: (rel) => (rel in files ? files[rel]!.split("\n").length - 1 : null), readFile: (rel) => files[rel] ?? null });

  it("output quoted next to the wrong command, but printed in the session, is real (camelcase-14, p-limit-91)", () => {
    expect(evaluateLine("5", 'Reproduced with `node -e "…"` and `node --test test.js` → "# tests 33" "# pass 33" "# fail 0"', c).status).toBe("backed");
    expect(evaluateLine("5", '`node --test test.js` → "33 pass". Hazard rerun → `CAUGHT DEADLOCK_TIMEOUT`', c).status).not.toBe("contradicted");
  });

  it("a quote from a cited file is real (camelcase-14 line 6, p-limit-42)", () => {
    expect(evaluateLine("6", '`node --test test.js` → "# pass 33"; `package.json:3` `"node": ">=22"`', c).status).toBe("backed");
  });

  it("one or two plain words in quotes are emphasis, not output (dot-prop-102 “missing”)", () => {
    expect(evaluateLine("3", '`node --test test.js` → "# pass 33"; wrongly included as “missing” = 0', c).status).toBe("backed");
  });

  it("a command the shell tape lacks is unverified, not fabricated (dot-prop-69 `rg` via a grep tool)", () => {
    const r = evaluateLine("1", "`rg '\\.includes\\('` → no matches", c);
    expect(r.status).toBe("unsupported");
    expect(r.note).toMatch(/is not on the shell tape/);
    // …and with other evidence on the line it does not sink it.
    expect(evaluateLine("1", "`node --test test.js` → \"# pass 33\"; `rg x` no matches", c).status).toBe("backed");
  });

  it("a quoted definition is not claimed output; a quote tied to a result is (p-limit-77, dequal-3, cookie-133)", () => {
    expect(evaluateLine("3", "Rule “own-key sets must match”: hand-checked 9 shapes, wrongly included 0/9, wrongly excluded 0/9", c).status).not.toBe("contradicted");
    expect(evaluateLine("3", "Heuristic “a rejection leaks a slot if `activeCount` stays > 0”: n=6, wrongly included 0/6, wrongly excluded 0/6", c).status).not.toBe("contradicted");
    expect(evaluateLine("1", "`node --test test.js` printed “# pass 34”", c).status).toBe("contradicted");
    expect(evaluateLine("1", "`node --test test.js` output (summary “# pass 34”)", c).status).toBe("contradicted");
  });

  it("several quotes in one output span are checked one by one (camelcase-14)", () => {
    expect(evaluateLine("5", '`node --test test.js` → `"# tests 33" "# pass 33" "# fail 0"`', c).status).toBe("backed");
    expect(evaluateLine("5", '`node --test test.js` → `"# tests 33" "# pass 34"`', c).status).toBe("contradicted");
  });

  it("backticked words are not commands: `node_modules`, `format()`, `while`, `Grep` (real held-out turns)", () => {
    for (const w of ["`node_modules` is present", "uses `format()` per unit", "the path walk is `while`", "searched with `Grep`"]) {
      expect(evaluateLine("4", w, c).note).not.toMatch(/cites `/);
    }
  });

  it("a span after a file reference describes the file, not output (dset-36)", () => {
    const files2 = { ...files, "test/x.js": "a\n".repeat(100) };
    const c2 = ctx({ shellRuns: runs, lineCount: (rel) => (rel in files2 ? 100 : null), readFile: (rel) => files2[rel as keyof typeof files2] ?? null });
    expect(evaluateLine("1", '`node --test test.js` → "# pass 33" including `test/x.js:94` (`should overwrite null values` / merge twin)', c2).status).toBe("backed");
  });

  it("mispaired quotes (an arrow inside, a trailing colon) are skipped, not accused (dset-2, bytesjs-55)", () => {
    expect(evaluateLine("1", '`node --test test.js` → "# pass 33"; `git log -S x` → "(empty); `git log -S y` → "(empty)"', c).status).not.toBe("contradicted");
  });

  it("fabricated output is still contradicted wherever it is claimed", () => {
    expect(evaluateLine("1", '`node --test test.js` → "# pass 34"', c)).toMatchObject({ status: "contradicted" });
    expect(evaluateLine("1", '`npm test` → "214 passed"', c)).toMatchObject({ status: "contradicted" });
  });

  it("an unbalanced fence in a pasted diff does not hide the block (dequal-33); a balanced example still does", () => {
    const msg = "Docs change:\n```diff\n+ x\n ```\n@@\n```\n\n## Done check\n1. `node --test test.js` → \"# pass 33\"";
    expect(parseDoneBlock(msg).kind).toBe("done");
    expect(parseDoneBlock("Format:\n```\n## Done check\n1. x\n```\nThat's it.").kind).toBe("none");
  });
});
