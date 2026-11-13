import { VERIFIED_CHECKS } from "./review.js";
/**
 * Stand-ins every test file starts with, so a goal can be completed without the user's Cursor plan, a Rust build or
 * a Python: a Codex goal program that keeps a small goal state and answers as the real one does, a reviewer that
 * finds nothing wrong, and an evaluator that judges every rubric met. A test that is about one of these being
 * missing, refusing or objecting sets its own.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-standins-"));
const exe = (name: string, body: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
};

const continuation = path.join(repoRoot, "third_party", "codex", "codex-rs", "ext", "goal", "templates", "goals", "continuation.md");

/** Codex's goal program: one goal per --home, its statuses, its usage, and its continuation prompt from its own template. */
export const STANDIN_CODEX = exe("codex-goals", `
const fs = require("fs"), path = require("path");
const home = process.argv[process.argv.indexOf("--home") + 1];
fs.mkdirSync(home, { recursive: true });
const state = path.join(home, "standin-goal.json");
const req = JSON.parse(fs.readFileSync(0, "utf8"));
let g = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : null;
const fresh = (objective) => ({ goal_id: "g" + Date.now(), objective, status: "active", token_budget: null, tokens_used: 0, time_used_seconds: 0, created_at_ms: Date.now(), updated_at_ms: Date.now() });
const limit = (x) => { if (x && x.status === "active" && x.token_budget !== null && x.tokens_used >= x.token_budget) x.status = "budget_limited"; return x; };
const events = { goal_updated: [], warnings: [] };
let out = { ok: true, goal: g };
if (req.op === "set") { if (req.fresh || !g || g.status === "complete") g = fresh(req.objective); else { g.objective = req.objective; if ("token_budget" in req) g.token_budget = req.token_budget; } }
else if (req.op === "status" && g) g.status = req.status;
else if (req.op === "account" && g) { g.tokens_used += req.tokens; g.time_used_seconds += req.seconds; }
else if (req.op === "clear") g = null;
else if (req.op === "turn" && g) { const u = req.usage || {}; g.tokens_used += Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)) + (u.output_tokens || 0); g.time_used_seconds += req.seconds || 0; }
else if (req.op === "user_goal") { if (req.objective !== undefined) { if (!g || g.status === "complete") g = fresh(req.objective); else g.objective = req.objective; } if (req.status && g) g.status = req.status; if (req.clear) g = null; }
limit(g);
if (req.op === "tool") {
  const a = req.arguments || {};
  let call = { accepted: true, result: { goal: g } };
  if (req.name === "create_goal") { if (g && g.status !== "complete") call = { accepted: false, refusal: "cannot create a new goal because this thread already has a goal" }; else { g = fresh(a.objective); call = { accepted: true, result: { goal: g } }; } }
  if (req.name === "update_goal") { if (!g) call = { accepted: false, refusal: "cannot update goal because this thread has no goal" }; else { g.status = a.status; call = { accepted: true, result: { goal: g } }; } }
  out = { ok: true, goal: g, events, call };
} else if (req.op === "steering") {
  if (req.kind !== "continuation") out = { ok: false, error: "the stand-in has no " + req.kind + " notice" };
  else if (!g || g.status !== "active") out = { ok: true, goal: g, steering: { kind: req.kind, answer: { continue: false, status: g ? g.status : null } } };
  else {
    // Codex's own template, as steering.rs renders it for an agent without update_plan.
    const prompt = fs.readFileSync(${JSON.stringify(continuation)}, "utf8").replace(/Progress visibility:\\n[^\\n]*\\n\\n/, "")
      .replace("{{ tokens_used }}", String(g.tokens_used)).replace("{{ token_budget }}", g.token_budget === null ? "none" : String(g.token_budget))
      .replace("{{ remaining_tokens }}", g.token_budget === null ? "unbounded" : String(Math.max(g.token_budget - g.tokens_used, 0))).trimEnd();
    out = { ok: true, goal: g, steering: { kind: req.kind, answer: { continue: true, prompt, goal_objective_context: { name: "goal_objective", output: g.objective } } } };
  }
} else if (req.op === "tool_specs") out = { ok: false, error: "the stand-in has no tool_specs" };
else if (req.op === "user_goal") out = { ok: true, goal: g, events, fragment: null };
else if (req.op === "turn") out = { ok: true, goal: g, events };
else out = { ok: true, goal: g };
if (g) fs.writeFileSync(state, JSON.stringify(g)); else if (fs.existsSync(state)) fs.rmSync(state);
process.stdout.write(JSON.stringify(out) + "\\n");
`);

/** A reviewer that checked and says every item it was asked about holds. */
export const STANDIN_REVIEWER = exe("reviewer", `
const a = process.argv.slice(2); const prompt = a[a.indexOf("-p") + 1] || "";
const ids = [...prompt.matchAll(/^- ([A-Za-z0-9_]+): /gm)].map((m) => m[1]);
process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify({ items: ids.map((id) => ({ id, verdict: "holds", evidence: "checked" })), extra: [], checks: ${JSON.stringify(VERIFIED_CHECKS)} }) }) + "\\n");`);

/** An evaluator "Python" that judges every rubric it is given met: one per item (or "goal"), and the one about extra work. */
const evaluatorPython = exe("evaluator-python", `
const job = JSON.parse(require("fs").readFileSync(0, "utf8"));
const ids = [...((job.items || []).length ? job.items.map((i) => i.id) : ["goal"]), "extra"];
process.stdout.write(JSON.stringify({ ran: true, overall: 1, rubrics: ids.map((id) => ({ id, property: id, score: 1, rationale: "met" })), calls: 0, seconds: 0 }) + "\\n");`);
export const STANDIN_EVALUATOR = JSON.stringify({ python: evaluatorPython, cli: evaluatorPython, adkDir: dir, site: dir });

process.env.GOAL_GUARDIAN_CODEX_GOALS = STANDIN_CODEX;
process.env.GOAL_GUARDIAN_REVIEWER = STANDIN_REVIEWER;
process.env.GOAL_GUARDIAN_EVALUATOR = STANDIN_EVALUATOR;
