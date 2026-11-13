/**
 * The second check at "done": Google's Agent Development Kit judges the run against the user's own "done when"
 * items. The evaluator is ADK's (third_party/adk-python, unmodified; github.com/google/adk-python, Apache-2.0):
 * its RubricBasedMultiTurnTrajectoryEvaluator, with ADK's judge prompt, one judge sample by default and ADK's
 * aggregation of them. Guardian's adapter is packages/evaluator, on the bundled Python with ADK's pinned
 * dependencies. Guardian supplies the run as it recorded it, the rubrics (the user's items word for word, plus one
 * of its own about unrequested work) and the user's own Cursor model. It can't block anything: when it can't run it
 * is skipped and recorded as skipped.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { stopProcessTree, trackProcessTree } from "../processTree.js";
import path from "node:path";
import type { TrajectoryMessage } from "./trajectory.js";

export interface EvaluatorPaths {
  python: string;
  /** Guardian's adapter: packages/evaluator/cgg_evaluator/cli.py. */
  cli: string;
  /** The folder holding ADK's own files (google/adk), unmodified. */
  adkDir: string;
  /** The folder holding the packages ADK depends on. */
  site: string;
}

export interface EvaluatorOutcome {
  ran: boolean;
  /** Why it didn't run, or why its answer couldn't be used. */
  reason?: string;
  /** ADK's overall score: the share of rubrics it judged met, 0 to 1. */
  overall: number | null;
  /** Rubrics judged, and those ADK judged not met, with the judge's own rationale. */
  rubrics: number;
  failed: Array<{ id: string; property: string; rationale: string }>;
  /** Rubric ids the evaluator was given and came back with no score for. */
  unanswered: string[];
  calls: number;
  seconds: number;
}

/**
 * How long the evaluator may take when the caller can't keep Cursor's tool call alive: Cursor ends a tool call that
 * is silent for 120 s (cursor-mcp `toolCallIdleTimeoutMs`), and progress notices reset that clock.
 */
export const EVALUATOR_BUDGET_MS = 100_000;
/** With progress notices going out, the evaluator gets this long. */
export const EVALUATOR_BUDGET_WITH_PROGRESS_MS = 300_000;
/** The id of Guardian's own rubric, the one about work nobody asked for (packages/evaluator EXTRA_WORK_ID). */
export const EXTRA_WORK_RUBRIC_ID = "extra";
const RATIONALE_MAX = 500;

const exists = (p: string): boolean => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

/**
 * Where the evaluator lives: an explicit setting (tests and the rig), else inside the installed extension next to
 * Guardian's own binaries. Null when there is none.
 */
export function resolveEvaluator(): EvaluatorPaths | null {
  const configured = process.env.GOAL_GUARDIAN_EVALUATOR;
  if (configured) {
    try {
      const m = JSON.parse(configured) as Partial<EvaluatorPaths>;
      return m.python && m.cli && m.adkDir && m.site && exists(m.cli) && exists(m.adkDir) ? { python: m.python, cli: m.cli, adkDir: m.adkDir, site: m.site } : null;
    } catch {
      return null;
    }
  }
  const win = process.platform === "win32";
  // Installed: <extension>/bin/goal-guardian-mcp beside <extension>/bin/python and <extension>/evaluator.
  const bin = path.dirname(process.execPath);
  const home = path.join(bin, "..", "evaluator");
  const installed: EvaluatorPaths = {
    python: path.join(bin, "python", win ? "python.exe" : path.join("bin", "python3")),
    cli: path.join(home, "cgg_evaluator", "cli.py"),
    adkDir: path.join(home, "adk"),
    site: path.join(home, "site-packages"),
  };
  return exists(installed.python) && exists(installed.cli) && exists(installed.adkDir) && exists(installed.site) ? installed : null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max: number): string => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** The adapter's result line. Null when there is nothing usable. */
export function parseEvaluator(stdout: string, expect: string[] = []): EvaluatorOutcome | null {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const v = JSON.parse(line) as { ran?: unknown; reason?: unknown; overall?: unknown; rubrics?: unknown; calls?: unknown; seconds?: unknown };
      if (typeof v.ran !== "boolean") continue;
      const rubrics = (Array.isArray(v.rubrics) ? v.rubrics : []) as Array<{ id?: unknown; property?: unknown; score?: unknown; rationale?: unknown }>;
      const judged = rubrics.filter((r) => num(r.score) !== null);
      const ran = v.ran && judged.length > 0;
      return {
        ran,
        ...(typeof v.reason === "string" ? { reason: v.reason } : v.ran && !ran ? { reason: "the evaluator judged no rubric" } : {}),
        overall: num(v.overall),
        rubrics: judged.length,
        failed: judged.filter((r) => num(r.score)! < 1).map((r) => ({ id: text(r.id, 80), property: text(r.property, 300), rationale: text(r.rationale, RATIONALE_MAX) })),
        // A rubric that came back without a score was not judged: that is never the same as met.
        unanswered: expect.filter((id) => !judged.some((r) => text(r.id, 80) === id)),
        calls: num(v.calls) ?? 0,
        seconds: Math.round(num(v.seconds) ?? 0),
      };
    } catch {
      // not the result line
    }
  }
  return null;
}

export interface EvaluatorJob {
  /** The user's request, as Guardian recorded it. */
  userQuery: string;
  /** The user's "done when" items: each becomes one of ADK's rubrics, word for word. */
  items: Array<{ id: string; text: string }>;
  conversation: TrajectoryMessage[];
  /** The agent's own completion report. */
  report: string;
}

/** Judge one run. Never throws. */
export function runEvaluator(job: EvaluatorJob, budgetMs: number, paths: EvaluatorPaths | null = resolveEvaluator()): Promise<EvaluatorOutcome> {
  const started = Date.now();
  const seconds = (): number => Math.round((Date.now() - started) / 1000);
  const skipped = (reason: string): EvaluatorOutcome => ({ ran: false, reason, overall: null, rubrics: 0, failed: [], unanswered: [], calls: 0, seconds: seconds() });
  // The rubrics the adapter builds: one per done-when item (or "goal" when there are none), and Guardian's own.
  const expect = [...(job.items.length ? job.items.map((i) => i.id) : ["goal"]), EXTRA_WORK_RUBRIC_ID];
  if (process.env.GOAL_GUARDIAN_REVIEWING) return Promise.resolve(skipped("already inside a review"));
  if (!paths) return Promise.resolve(skipped("the evaluator isn't installed"));
  if (!job.conversation.length) return Promise.resolve(skipped("Guardian recorded no actions for this run"));
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const done = (v: EvaluatorOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn(paths.python, ["-I", paths.cli, "--adk", paths.adkDir, "--site", paths.site], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" } });
    trackProcessTree(child);
    const timer = setTimeout(() => {
      stopProcessTree(child);
      done(skipped(`the evaluator took longer than ${Math.round(budgetMs / 1000)}s`));
    }, budgetMs);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.on("error", (err) => done(skipped(`the evaluator couldn't start: ${err.message}`)));
    child.on("close", () => {
      const parsed = parseEvaluator(stdout, expect);
      done(parsed ? { ...parsed, seconds: seconds() } : skipped("the evaluator's answer couldn't be read"));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify({ user_query: job.userQuery, items: job.items, conversation: job.conversation, report: job.report }));
  });
}

/** One line per rubric ADK judged not met, as the agent and the panel see them. */
export function evaluatorLines(outcome: Pick<EvaluatorOutcome, "ran" | "failed">): string[] {
  if (!outcome.ran) return [];
  return outcome.failed.map((f) =>
    f.id === EXTRA_WORK_RUBRIC_ID ? `Evaluator: the run changed things the request doesn't need: ${f.rationale}` : `Evaluator: ${f.id} isn't met (${f.property}): ${f.rationale}`,
  );
}
