import { describe, it, expect } from "vitest";
import { setReviewGuidance, buildClaimPrompt, buildScopePrompt, checkScope, parseScopeFindings, scopeObjections, buildFalsifyPrompt, buildMaterialityPrompt, buildPiecePrompt, centralClaims, falsificationFindings, falsificationObjections, falsificationPieces, falsifyClaims, filterObjections, parseFalsification, parseMaterialityVerdict, checkClaims, claimFindings, evidenceFor, extractClaims, parseClaimVerdicts, parsePieceScores, pieceFindings, scorePieces, splitIntoPieces, type ReviewerRun } from "../src/index.js";

const DIFF = [
  "diff --git a/src/a.js b/src/a.js", "--- a/src/a.js", "+++ b/src/a.js", "@@ -1 +1 @@", "-export const a = 1;", "+export const a = 2;",
  "diff --git a/test/a.test.js b/test/a.test.js", "--- a/test/a.test.js", "+++ b/test/a.test.js", "@@ -1 +1 @@", "-expect(a).toBe(1)", "+expect(a).toBe(2)",
].join("\n");

describe("piece-by-piece review", () => {
  it("cuts a turn into commands (with output, deduplicated) and one piece per changed file", () => {
    const pieces = splitIntoPieces([{ command: "npm test" }, { command: "npm test", output: "1 failed" }, { command: "ls" }], DIFF);
    expect(pieces.map((p) => [p.id, p.kind, p.title])).toEqual([
      ["R1", "run", "$ npm test"], ["R2", "run", "$ ls"], ["F1", "file", "src/a.js"], ["F2", "file", "test/a.test.js"],
    ]);
    expect(pieces[0]!.body).toContain("1 failed");
    expect(pieces[1]!.body).toContain("(output not captured)");
  });

  it("asks about each piece against the claims, and parses scores tolerantly", () => {
    const pieces = splitIntoPieces([{ command: "npm test", output: "1 failed" }], DIFF);
    const prompt = buildPiecePrompt("fix a", "All tests pass.\n## Done check", pieces);
    expect(prompt).toContain("[R1] command: $ npm test");
    expect(prompt).toContain("All tests pass.");
    const reply = JSON.stringify({ type: "result", result: 'Sure:\n```json\n{"pieces":[{"id":"R1","suspicion":"9","note":"prints 1 failed"},{"id":"F2","suspicion":12},{"id":"X9","suspicion":3}]}\n```' });
    expect(parsePieceScores(reply, ["R1", "F1", "F2"])).toEqual([{ id: "R1", suspicion: 9, note: "prints 1 failed" }, { id: "F2", suspicion: 10, note: "" }]);
    expect(parsePieceScores("no json", ["R1"])).toBeNull();
  });

  it("scores in parallel batches, read-only; failed batches leave pieces unscored", async () => {
    const tape = Array.from({ length: 8 }, (_, i) => ({ command: `cmd${i}`, output: "ok" }));
    const pieces = splitIntoPieces(tape, DIFF); // 10 pieces → 2 batches
    const seen: Array<{ copy: boolean }> = [];
    let n = 0;
    const reviewer: ReviewerRun = async (p, o) => {
      seen.push({ copy: o.copy !== undefined });
      n += 1;
      if (n === 2) return { ok: false, error: "boom" };
      const ids = [...p.matchAll(/^\[(\w+)\]/gm)].map((m) => m[1]);
      return { ok: true, stdout: JSON.stringify({ pieces: ids.map((id) => ({ id, suspicion: id === "F2" ? 8 : 0, note: id === "F2" ? "expectation changed" : "" })) }) };
    };
    const scores = await scorePieces(reviewer, { command: "x", workspaceRoot: "/w", timeoutMs: 1000, copy: { dir: "/c", scratch: "/s" } }, "g", "m", pieces);
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => !s.copy)).toBe(true);
    expect(scores.length).toBe(6);
  });

  it("hands the reviewer the suspicious pieces in full, the rest by name", () => {
    const pieces = splitIntoPieces([{ command: "npm test", output: "ok" }], DIFF);
    const lines = pieceFindings(pieces, [{ id: "R1", suspicion: 0, note: "" }, { id: "F2", suspicion: 8, note: "expectation 1 → 2, not mentioned" }]).join("\n");
    expect(lines).toContain("[F2] suspicion 8/10 — expectation 1 → 2, not mentioned");
    expect(lines).toContain("+expect(a).toBe(2)");
    expect(lines).toMatch(/Judged consistent: R1 \$ npm test; F1 src\/a\.js/);
    expect(pieceFindings(pieces, [{ id: "R1", suspicion: 1, note: "" }]).join("\n")).toContain("found no piece suspicious");
  });
});

describe("claim-by-claim review", () => {
  const MSG = [
    "Fixed the parser.",
    "",
    "The full suite was not run because there is no node_modules in this checkout.",
    "- `npm test` passes: 44 tests.",
    "Here is some plain prose about the approach taken here.",
    "```js",
    "const fails = true; // not a claim",
    "```",
    "## Done check",
  ].join("\n");

  it("pulls the factual claims out of the message by code, skipping code blocks and headings", () => {
    const claims = extractClaims(MSG);
    expect(claims.map((c) => c.text)).toEqual(["Fixed the parser.", "The full suite was not run because there is no node_modules in this checkout.", "`npm test` passes: 44 tests."]);
  });

  it("asks about each claim with the measured facts and the pieces that mention it", () => {
    const pieces = splitIntoPieces([{ command: "npm test", output: "Total: 44 Passed: 44" }, { command: "ls src", output: "index.js" }], undefined);
    const claims = extractClaims(MSG);
    expect(evidenceFor(claims[2]!, pieces).map((p) => p.id)).toEqual(["R1"]);
    const prompt = buildClaimPrompt("fix parser", ["node_modules: present (439 top-level entries)"], claims, pieces);
    expect(prompt).toContain("- node_modules: present (439 top-level entries)");
    expect(prompt).toContain("[C2] The full suite was not run because there is no node_modules");
    expect(prompt).toContain("Total: 44 Passed: 44");
  });

  it("parses verdicts, and hands the reviewer the contradicted and unbacked claims first", () => {
    const claims = extractClaims(MSG);
    const v = parseClaimVerdicts(JSON.stringify({ result: '{"claims":[{"id":"C2","verdict":"contradicted","evidence":"node_modules: present (439)"},{"id":"C3","verdict":"supported","evidence":"Passed: 44"},{"id":"C9","verdict":"contradicted"},{"id":"C3","verdict":"maybe"}]}' }), claims.map((c) => c.id))!;
    expect(v).toEqual([{ id: "C2", verdict: "contradicted", evidence: "node_modules: present (439)" }, { id: "C3", verdict: "supported", evidence: "Passed: 44" }]);
    const lines = claimFindings(["node_modules: present (439 top-level entries)"], claims, v).join("\n");
    expect(lines).toContain('- CONTRADICTED: "The full suite was not run because there is no node_modules in this checkout." — node_modules: present (439)');
    expect(lines).not.toContain("npm test` passes: 44");
  });

  it("checks claims in parallel batches, read-only", async () => {
    const claims = Array.from({ length: 9 }, (_, i) => ({ id: `C${i + 1}`, text: `claim ${i} passes` }));
    let calls = 0;
    const reviewer: ReviewerRun = async (p, o) => {
      calls += 1;
      expect(o.copy).toBeUndefined();
      const ids = [...p.matchAll(/^\[(C\d+)\]/gm)].map((m) => m[1]);
      return { ok: true, stdout: JSON.stringify({ claims: ids.map((id) => ({ id, verdict: "supported", evidence: "" })) }) };
    };
    const v = await checkClaims(reviewer, { command: "x", workspaceRoot: "/w", timeoutMs: 1, copy: { dir: "/c", scratch: "/s" } }, "g", [], claims, []);
    expect(calls).toBe(3);
    expect(v).toHaveLength(9);
  });
});

describe("one objection at a time", () => {
  it("asks true-and-material about a single objection, with the facts and the pieces that bear on it", () => {
    const pieces = splitIntoPieces([{ command: "npm test", output: "28 passed" }], undefined);
    const p = buildMaterialityPrompt("fix", "Tests pass.", ["node_modules: present (12 top-level entries)"], { line: "1", objection: "npm test was never run" }, pieces);
    expect(p).toContain("The objection (about line 1):\nnpm test was never run");
    expect(p).toContain("28 passed");
    expect(p).toContain("- node_modules: present");
  });

  it("keeps an objection only when both answers are yes; a check that fails to run keeps it", async () => {
    expect(parseMaterialityVerdict(JSON.stringify({ result: 'ok {"true":true,"material":false,"why":"minor"}' }))).toEqual({ keep: false, why: "minor" });
    expect(parseMaterialityVerdict('{"true":true,"material":true}')).toEqual({ keep: true, why: "" });
    expect(parseMaterialityVerdict("nonsense")).toBeNull();
    const verdict: Record<string, string> = { a: '{"true":false,"material":true,"why":"tape shows it ran"}', b: '{"true":true,"material":true}' };
    const reviewer: ReviewerRun = async (p) => {
      const key = p.includes("OBJ-A") ? "a" : p.includes("OBJ-B") ? "b" : "c";
      return key === "c" ? { ok: false, error: "timeout" } : { ok: true, stdout: verdict[key]! };
    };
    const objs = [{ line: "1", objection: "OBJ-A" }, { line: "2", objection: "OBJ-B" }, { line: "3", objection: "OBJ-C" }];
    const out = await filterObjections(reviewer, { command: "x", workspaceRoot: "/w", timeoutMs: 1 }, "g", "m", [], objs, []);
    expect(out.kept.map((o) => o.objection)).toEqual(["OBJ-B", "OBJ-C"]);
    expect(out.dropped).toEqual([{ line: "1", objection: "OBJ-A", why: "tape shows it ran" }]);
  });
});

describe("trying to break the central claims", () => {
  const claims = [
    { id: "C1", text: "Tests ran fine after the fix." },
    { id: "C2", text: "Behavior is unchanged for every input." },
    { id: "C3", text: "It is 34% faster on the basic fixture." },
    { id: "C4", text: "Output matches lodash on 70 inputs." },
  ];

  it("attacks behaviour, scope and number claims first", () => {
    expect(centralClaims(claims, 2).map((c) => c.id)).toEqual(["C2", "C4"]);
    expect(centralClaims(claims, 3).map((c) => c.id)).toEqual(["C2", "C4", "C3"]);
  });

  it("gives one claim one mission, in the copy, and never edits or installs", () => {
    const p = buildFalsifyPrompt("speed up parse", claims[1]!, "/copy/ws");
    expect(p).toContain("The claim: Behavior is unchanged for every input.");
    expect(p).toContain("/copy/ws");
    expect(p).toContain("git show HEAD:<file>");
    expect(p).toMatch(/Never install packages, use the\s+network, publish, push, log in/);
  });

  it("parses what it ran and printed, tolerating prose and braces", () => {
    const out = parseFalsification(JSON.stringify({ result: 'Done:\n```json\n{"refuted":true,"command":"node -e \\"p({})\\"","printed":".5kb: null vs 512","explains":"old rejects it"}\n```' }), "c");
    expect(out).toEqual({ claim: "c", refuted: true, command: 'node -e "p({})"', printed: ".5kb: null vs 512", explains: "old rejects it" });
    expect(parseFalsification("no json here", "c")).toBeNull();
    expect(parseFalsification('{"refuted":"yes"}', "c")).toBeNull();
  });

  it("runs in the copy; a failed one is just no finding; refuting checks become evidence", async () => {
    const seen: unknown[] = [];
    const reviewer: ReviewerRun = async (p, o) => {
      seen.push(o.copy);
      if (p.includes("C-FAIL")) return { ok: false, error: "timeout" };
      return { ok: true, stdout: p.includes("C-BAD") ? '{"refuted":true,"command":"node x","printed":"null vs 512","explains":"differs"}' : '{"refuted":false,"command":"node y","printed":"same","explains":"agrees"}' };
    };
    const copy = { dir: "/c", scratch: "/s" };
    const found = await falsifyClaims(reviewer, { command: "x", workspaceRoot: "/w", timeoutMs: 1 }, "g", [{ id: "1", text: "C-OK" }, { id: "2", text: "C-BAD" }, { id: "3", text: "C-FAIL" }], copy);
    expect(seen).toEqual([copy, copy, copy]);
    expect(found.map((f) => f.refuted)).toEqual([false, true]);
    const lines = falsificationFindings(found).join("\n");
    expect(lines.indexOf("REFUTED")).toBeLessThan(lines.indexOf("held up"));
    expect(lines).toContain("printed: null vs 512");
    expect(falsificationPieces(found)).toMatchObject([{ id: "X1", kind: "run", title: "$ node x" }]);
    expect(evidenceFor({ id: "O", text: "node x printed null" }, falsificationPieces(found)).map((p) => p.id)).toEqual(["X1"]);
  });
});

describe("a refuted claim is an objection", () => {
  it("carries the claim, what was run and what it printed; claims that held up are not objections", () => {
    const out = falsificationObjections([
      { claim: "Behavior is unchanged.", refuted: true, command: "node x.js", printed: ".5kb: null vs 512", explains: "old rejects it, new accepts it." },
      { claim: "Tests pass.", refuted: false, command: "npm test", printed: "ok", explains: "agrees" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.objection).toMatch(/Behavior is unchanged[\s\S]*old rejects it[\s\S]*node x\.js[\s\S]*\.5kb: null vs 512/);
  });
});

describe("the drift check reads the diff against the request", () => {
  const DIFF2 = ["diff --git a/index.js b/index.js", "+const keep = true", "diff --git a/readme.md b/readme.md", "+## New option"].join("\n");
  it("shows only changed files, with the request and the done-when list", () => {
    const pieces = splitIntoPieces([{ command: "npm test", output: "ok" }], DIFF2);
    const p = buildScopePrompt("add a keep option", ["a test passes"], ["no new deps"], pieces.filter((x) => x.kind === "file"));
    expect(p).toContain("What the user asked for: add a keep option");
    expect(p).toContain("- a test passes");
    expect(p).toContain("[readme.md]");
    expect(p).not.toContain("npm test");
  });
  it("parses findings, and turns them into objections on the scope line", () => {
    const f = parseScopeFindings(JSON.stringify({ result: '{"unneeded":[{"file":"readme.md","what":"a new docs section","why":"not requested"},{"file":"x"}]}' }))!;
    expect(f).toEqual([{ file: "readme.md", what: "a new docs section", why: "not requested" }]);
    expect(scopeObjections(f)).toEqual([{ line: "4", objection: "Outside what was asked: readme.md: a new docs section. not requested Take it out, or say why the request needs it." }]);
    expect(parseScopeFindings("nope")).toBeNull();
    expect(scopeObjections([{ file: "test/a.js", what: "an extra assertion", why: "" }, { file: "src/a.test.ts", what: "x", why: "" }])).toEqual([]);
  });
  it("makes one read-only call; no changed files means no call", async () => {
    let calls = 0;
    const reviewer: ReviewerRun = async (_p, o) => { calls += 1; expect(o.copy).toBeUndefined(); return { ok: true, stdout: '{"unneeded":[]}' }; };
    const opts = { command: "x", workspaceRoot: "/w", timeoutMs: 1, copy: { dir: "/c", scratch: "/s" } };
    expect(await checkScope(reviewer, opts, "g", [], [], splitIntoPieces([{ command: "ls" }], undefined))).toEqual([]);
    expect(calls).toBe(0);
    await checkScope(reviewer, opts, "g", [], [], splitIntoPieces([], DIFF2));
    expect(calls).toBe(1);
  });
});

describe("adjustable guidance", () => {
  it("is added to the narrow prompts, and clears", () => {
    setReviewGuidance({ materiality: "MAT-RULE", falsify: "FAL-RULE", scope: "SCO-RULE" });
    const p = splitIntoPieces([], "diff --git a/a.js b/a.js\n+x");
    expect(buildMaterialityPrompt("g", "m", [], { line: "1", objection: "o" }, p)).toContain("MAT-RULE");
    expect(buildFalsifyPrompt("g", { id: "C1", text: "c" }, "/c")).toContain("FAL-RULE");
    expect(buildScopePrompt("g", [], [], p)).toContain("SCO-RULE");
    setReviewGuidance(undefined);
    expect(buildScopePrompt("g", [], [], p)).not.toContain("SCO-RULE");
  });
});
