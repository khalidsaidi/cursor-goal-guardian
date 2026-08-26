import { spawn } from "node:child_process";
import type {
  DriftCandidate,
  DriftJudge,
  DriftJudgement,
  JudgeAvailability,
  JudgeContext,
  SessionReviewResult,
} from "./judge.js";

/**
 * The first DriftJudge implementation: shells out to the Cursor CLI agent in
 * headless mode (`cursor-agent -p <prompt> --output-format json`), which bills
 * the user's Cursor account. Hosts must gate calls behind explicit consent.
 * The prompt builder and output parser are exported separately so they can be
 * unit-tested against recorded captures without spending tokens.
 */

export function buildJudgePrompt(candidates: DriftCandidate[], context: JudgeContext): string {
  const lines: string[] = [
    "You are reviewing whether an AI coding agent drifted from its declared goal.",
    "",
    `Goal: ${context.goal || "(none declared)"}`,
  ];
  if (context.successCriteria.length) {
    lines.push("Success criteria:");
    for (const c of context.successCriteria) lines.push(`- ${c}`);
  }
  if (context.constraints.length) {
    lines.push("Constraints:");
    for (const c of context.constraints) lines.push(`- ${c}`);
  }
  lines.push(
    "",
    "Each numbered candidate below was lexically flagged as possibly off-goal.",
    "Judge each one: confirmed = genuinely unrelated to the goal/active task;",
    "dismissed = plausibly in service of it (refactors, housekeeping, and",
    "prerequisites count as in service).",
    "",
  );
  candidates.forEach((c, i) => {
    lines.push(`${i}. [${c.actionType}] ${c.actionValue}`);
    lines.push(`   active task: ${c.activeTaskTitle}${c.criterionText ? ` (criterion: ${c.criterionText})` : ""}`);
  });
  lines.push(
    "",
    'Reply with ONLY a JSON array, one entry per candidate, no other text:',
    '[{"index":0,"verdict":"confirmed"|"dismissed","confidence":0.0-1.0,"rationale":"<20 words"}]',
  );
  return lines.join("\n");
}

/**
 * Parse headless cursor-agent stdout into judgements. Tolerant by design:
 * the envelope is JSON with a `result` text field, and models sometimes wrap
 * the array in prose or code fences — we extract the first JSON array found.
 * Anything unparseable yields no judgement (the candidate stays pending).
 */
export function parseJudgeOutput(stdout: string, candidates: DriftCandidate[]): DriftJudgement[] {
  let text = stdout;
  try {
    const envelope = JSON.parse(stdout) as { result?: unknown; is_error?: unknown };
    if (envelope.is_error === true) return [];
    if (typeof envelope.result === "string") text = envelope.result;
  } catch {
    // Not an envelope; treat stdout as the raw result text.
  }

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: DriftJudgement[] = [];
  for (const entry of parsed) {
    const e = entry as Record<string, unknown>;
    const index = typeof e.index === "number" ? e.index : Number.parseInt(String(e.index ?? ""), 10);
    const candidate = Number.isInteger(index) ? candidates[index] : undefined;
    const verdict = e.verdict === "confirmed" || e.verdict === "dismissed" ? e.verdict : null;
    const confidence = typeof e.confidence === "number" && e.confidence >= 0 && e.confidence <= 1 ? e.confidence : null;
    if (!candidate || !verdict || confidence === null) continue;
    if (out.some((j) => j.driftId === candidate.driftId)) continue;
    out.push({
      driftId: candidate.driftId,
      verdict,
      confidence,
      rationale: String(e.rationale ?? ""),
    });
  }
  return out;
}

export function buildSessionReviewPrompt(actions: string[], context: JudgeContext): string {
  const lines: string[] = [
    "You are auditing whether an AI coding session stayed on its declared goal.",
    "",
    `Goal: ${context.goal || "(none declared)"}`,
  ];
  if (context.successCriteria.length) {
    lines.push("Success criteria:");
    for (const c of context.successCriteria) lines.push(`- ${c}`);
  }
  if (context.constraints.length) {
    lines.push("Constraints:");
    for (const c of context.constraints) lines.push(`- ${c}`);
  }
  lines.push("", "Recent session actions, oldest first:", "");
  actions.forEach((a, i) => lines.push(`${i}. ${a}`));
  lines.push(
    "",
    "Judge the session as a whole. Refactors, tests, housekeeping, and",
    "prerequisites count as in service of the goal. off_course means real work",
    "is being spent on something the goal does not need.",
    "",
    'Reply with ONLY a JSON object, no other text:',
    '{"verdict":"on_course"|"off_course","confidence":0.0-1.0,"rationale":"<30 words","flagged":[indexes of off-goal actions]}',
  );
  return lines.join("\n");
}

/** Tolerant parse of the session-review reply; null when unusable (skip, retry later). */
export function parseSessionReviewOutput(stdout: string): SessionReviewResult | null {
  let text = stdout;
  try {
    const envelope = JSON.parse(stdout) as { result?: unknown; is_error?: unknown };
    if (envelope.is_error === true) return null;
    if (typeof envelope.result === "string") text = envelope.result;
  } catch {
    // raw text
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const verdict = parsed.verdict === "on_course" || parsed.verdict === "off_course" ? parsed.verdict : null;
  const confidence = typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1 ? parsed.confidence : null;
  if (!verdict || confidence === null) return null;
  const flagged = Array.isArray(parsed.flagged)
    ? parsed.flagged.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0)
    : [];
  return { verdict, confidence, rationale: String(parsed.rationale ?? ""), flagged };
}

export interface CursorAgentJudgeOptions {
  command?: string;
  model?: string;
  timeoutMs?: number;
  cwd?: string;
}

function run(command: string, args: string[], timeoutMs: number, cwd?: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

export function createCursorAgentJudge(options: CursorAgentJudgeOptions = {}): DriftJudge {
  const command = options.command ?? "cursor-agent";
  const timeoutMs = options.timeoutMs ?? 90_000;

  return {
    id: "cursor-agent",
    async isAvailable(): Promise<JudgeAvailability> {
      try {
        const res = await run(command, ["status"], 10_000, options.cwd);
        if (res.code !== 0) return { ok: false, reason: `cursor-agent status exited ${res.code}` };
        if (/not logged in|unauthenticated/i.test(res.stdout)) return { ok: false, reason: "not logged in" };
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    async judge(candidates: DriftCandidate[], context: JudgeContext): Promise<DriftJudgement[]> {
      const prompt = buildJudgePrompt(candidates, context);
      // --trust: the judge only reads the prompt and emits text, but headless
      // runs in an untrusted cwd otherwise stall on the trust prompt.
      const args = ["-p", prompt, "--output-format", "json", "--trust"];
      if (options.model) args.push("--model", options.model);
      const res = await run(command, args, timeoutMs, options.cwd);
      if (res.code !== 0) throw new Error(`cursor-agent exited ${res.code}`);
      return parseJudgeOutput(res.stdout, candidates);
    },
    async reviewSession(actions: string[], context: JudgeContext): Promise<SessionReviewResult | null> {
      const prompt = buildSessionReviewPrompt(actions, context);
      const args = ["-p", prompt, "--output-format", "json", "--trust"];
      if (options.model) args.push("--model", options.model);
      const res = await run(command, args, timeoutMs, options.cwd);
      if (res.code !== 0) return null;
      return parseSessionReviewOutput(res.stdout);
    },
  };
}
