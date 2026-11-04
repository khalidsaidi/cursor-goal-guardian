/**
 * The adversarial review: after the deterministic check passes, a second,
 * independent agent (headless `cursor-agent` in read-only ask mode) writes the
 * strongest case against each line of the done check. The agent answers —
 * fixes the work, corrects the line, or rebuts — and the reviewer objects
 * again to what did not settle. The loop stops when a round produces no new
 * objection, or at the round cap; a final reviewer call then records what is
 * still open, without sending the agent back again.
 *
 * The deterministic check proves cited evidence is REAL; this is the part that
 * asks whether it is RELEVANT, whether a "does not apply" hides a gap, and
 * whether a line understates as well as overstates.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strippedEnv } from "@goal-guardian/core";
import type { ShellRun, TestRun } from "@goal-guardian/core";

export type { TestRun };

export interface ReviewObjection {
  /** Which done-check line it targets: "1"–"7", "sc_N", "blocked", or "general". */
  line: string;
  objection: string;
}

export interface ReviewHistoryRound {
  objections: ReviewObjection[];
  /** The agent's reply to these objections (its next final message), clipped. */
  answer?: string;
}

export interface ReviewPromptInput {
  goal: string;
  successCriteria: Array<{ id: string; text: string }>;
  constraints: string[];
  /** The agent's latest final message — the one carrying the block under review. */
  message: string;
  /** Commands taped in this conversation, with output where captured. */
  tape: ShellRun[];
  /** Workspace-relative files edited in this conversation. */
  edits: string[];
  /** Earlier rounds in this chain, oldest first. */
  history: ReviewHistoryRound[];
  /** 1-based number of this reviewer call. */
  round: number;
  maxRounds: number;
  /** The uncommitted changes to files edited in this conversation (git diff), clipped. */
  diff?: string;
  /** Lines that state something in plain words with no cited evidence — the code check left them to you. */
  plainLines?: string[];
  /** True for the closing call after the cap: report only, nobody answers it. */
  final: boolean;
  workspaceRoot: string;
  /** A throwaway copy of the workspace the reviewer may run commands in (absent: read-only review). */
  copyRoot?: string;
  /** The project's tests, re-run by Guardian itself in that copy just before the review. */
  testRun?: TestRun;
  /** What the piece-by-piece first pass found (pieces.ts). */
  pieceLines?: string[];
}


// Linux caps one argv string at 128 KiB (MAX_ARG_STRLEN); stay well inside.
const PROMPT_BUDGET = 90_000;
const MESSAGE_MAX = 24_000;
const ANSWER_MAX = 6_000;
const OUTPUT_MAX = 1_200;
const TAPE_MAX = 30_000;
const DIFF_MAX = 20_000;
const TEST_OUTPUT_MAX = 1_800;
const MAX_OBJECTIONS = 4;
const OBJECTION_MAX = 600;

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  return `${text.slice(0, head)}\n…[${text.length - max} chars cut]…\n${text.slice(-(max - head))}`;
}

function tapeLines(tape: ShellRun[]): string[] {
  // The audit tapes every command (no output) and afterShellExecution tapes it
  // again with output: keep the richest copy, latest last.
  const seen = new Map<string, ShellRun>();
  for (const run of tape) {
    const prev = seen.get(run.command);
    seen.delete(run.command);
    seen.set(run.command, prev?.output && !run.output ? prev : run);
  }
  const out: string[] = [];
  let used = 0;
  const runs = [...seen.values()].reverse(); // newest first under the budget
  for (const run of runs) {
    const block = [`$ ${run.command}`, ...(run.output !== undefined ? [clipMiddle(run.output.trimEnd(), OUTPUT_MAX) || "(no output)"] : ["(output not captured)"])].join("\n");
    if (used + block.length > TAPE_MAX) {
      out.push(`…[${runs.length - out.length} older commands not shown]`);
      break;
    }
    out.push(block);
    used += block.length;
  }
  return out.reverse();
}

const REWRITTEN_SHOWN = 12;
export const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)(\/|$)|[._-](test|spec)\.[cm]?[jt]sx?$|(^|\/)test\.[cm]?[jt]sx?$/i;
const ASSERTION = /\b(assert|expect|deepEqual|deepStrictEqual|strictEqual|notEqual|equal|is|ok|throws|toBe|toEqual|toStrictEqual|toMatch|toThrow|snapshot)\b\s*[.(]|\.(is|equal|deepEqual|same|ok|true|false|throws)\s*\(/;

/** Assertion lines a diff removes from existing test files: the agent changed what a test expects. */
export function changedTestExpectations(diff: string): Array<{ file: string; line: string }> {
  const out: Array<{ file: string; line: string }> = [];
  let file: string | null = null;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).replace(/^b\//, "");
      file = p === "/dev/null" || !TEST_PATH.test(p) ? null : p;
      continue;
    }
    if (raw.startsWith("diff --git") ) { file = null; continue; }
    if (!file || !raw.startsWith("-") || raw.startsWith("---")) continue;
    const line = raw.slice(1).trim();
    if (ASSERTION.test(line)) out.push({ file, line: line.length > 160 ? line.slice(0, 157) + "…" : line });
  }
  return out;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const lines: string[] = [
    "You are an adversarial reviewer. Another AI coding agent has just ended its turn and claims, in the",
    "`## Done check` (or `## Blocked`) block at the end of its message, that its work holds up. Your job is",
    "to write the strongest case against that claim — the objection the agent would struggle to answer.",
    "",
    ...(input.copyRoot
      ? [
          "You work in a THROWAWAY COPY of the project, made just for this review:",
          `  ${input.copyRoot}`,
          "Check the message's central claims by running things there, not just by reading: run the changed code on",
          "the issue's own example and on one nearby input the change could affect; check that a test the message relies",
          "on fails without the change (`git stash`, or `git show HEAD:<file>` — HEAD is the last commit, before this",
          "work); rerun a command whose output the conclusion rests on. A few targeted commands; finish within 3 minutes.",
          "Never install packages, use the network, publish, push, log in, or touch anything outside this copy.",
        ]
      : [
          "You are read-only. You may read files under this workspace to check claims yourself:",
          `  ${input.workspaceRoot}`,
          "Do not try to edit files or run commands.",
        ]),
    "Do this review yourself: do not delegate it to a subagent, a Task tool, or another model — the user's own",
    "routing rules do not apply to this review.",
    ...(input.testRun
      ? [
          "",
          "Guardian just re-ran the project's tests itself, in a clean copy of the workspace as the agent left it:",
          `$ ${input.testRun.command}   (exit ${input.testRun.exit})`,
          clipMiddle(input.testRun.output.trimEnd(), TEST_OUTPUT_MAX) || "(no output)",
          "Treat this as ground truth. If the message describes the test result, or says why tests failed or could not",
          "run, and this contradicts it, that is material.",
        ]
      : []),
    "",
    `Goal: ${input.goal || "(none declared)"}`,
  ];
  if (input.successCriteria.length) {
    lines.push("Success criteria:");
    for (const c of input.successCriteria) lines.push(`- ${c.id}: ${c.text}`);
  }
  if (input.constraints.length) {
    lines.push("Constraints:");
    for (const c of input.constraints) lines.push(`- ${c}`);
  }
  lines.push(
    "",
    "The seven rules the block's numbered lines answer:",
    "1 every claim is backed by a named run, measurement or line of code; 2 no internal contradiction;",
    "3 any rule that decides what counts is measured on a hand-checked sample, error rate both ways;",
    "4 the work's boundaries are fixed by a stated criterion; 5 reproducible, one command where possible;",
    "6 gaps declared (what, what closes it, who holds it), not hidden; 7 numbers carry an interval and method.",
    "How the rules apply: rule 3 covers heuristics whose output the work reports or relies on (a classifier, a",
    "filter, a sampling rule) — not every judgement call. Rule 7 covers numbers the agent reports as findings",
    "(estimates, rates, timings, percentages) — not counts a test runner printed. A plain, true sentence is a",
    "valid answer to rules 2 and 4. \"does not apply\" with a true reason is valid.",
    "",
    "Find what is materially wrong. An objection is material only if, left standing, the user would be misled",
    "about whether the task is done, correct or complete — believing something false, or not knowing something",
    "they need to act on. For example:",
    "- evidence that is real but does not exercise what its line claims (a passing command that never touches the change);",
    "- a claim the tape or the files contradict (read the files to check);",
    "- a real gap labelled \"does not apply\", or work the goal asks for left unfinished with no line declaring it —",
    "  including when the message itself admits something was not done or not checked and a line still says",
    "  nothing is unfinished. That is material even if the code looks right: the user asked to be told;",
    "- a claim in the prose (a speed-up, a count, a feature) that the block's lines quietly leave out or waive;",
    "- a success criterion marked met that nothing shows met;",
    "- a number reported as a finding with no basis.",
    "Object in BOTH directions: an understatement is material too — calling something unverified, a gap, or",
    "blocked when the tape shows it done misleads the user just as much.",
    "A `## Blocked` block is a claim too. It holds only if the tape shows the agent tried the obvious ways",
    "around the blocker and the thing in the way is outside its reach (the user, a missing credential, an",
    "external service). Difficulty, slowness, or a blocker the agent could remove itself is not blocked:",
    "object to it.",
    "Not material: doubts that apply to any test of anything (\"a lookup table could also pass\"), demands for",
    "more evidence than the claim needs, which rule a true sentence is filed under, wording, formatting.",
    "Two tests every objection must pass — drop it if either fails:",
    "- Not already told: if the message already tells the user this plainly (in the prose, the argument record or",
    "  a line), they are not misled. The one exception is the gap case above: a line saying nothing is",
    "  unfinished while the message admits something is.",
    "- Load-bearing: the task's conclusion (done, correct, complete, or the decision it recommends) must rest on",
    "  what you dispute. A wrong count, line number or side remark the conclusion does not depend on is not material.",
    "",
    "Calibration — objections from real reviews, each checked independently afterwards.",
    "Material (each was confirmed by running code):",
    "- \"Fixed: null is now overwritten\" — but the sibling merge build still throws on the same null input.",
    "- \"Added a regression test\" — the test passes with the fix removed, so it cannot catch the regression.",
    "- \"Types now match for CommonJS\" — the declared default export is not callable at runtime: TypeError.",
    "- \"Documented workaround: transpile the dependency\" — the code uses BigInt literals, which no transpiler lowers.",
    "- \"Fixed the warning\" — the warning was never reproduced before the change, nor shown gone after it.",
    "- Existing test expectations flipped so the change passes, presented as a small \"tension\".",
    "Not material (true, but drop it):",
    "- \"The file has 17 entries, not 18\" — the conclusion holds either way.",
    "- \"The benchmarks were not re-run\" — the message already says so, and why.",
    "- \"Nothing shows the issue is closed\" — the task statement says it is.",
    "- \"Explain more about why the issue arose\" — the fix and its evidence stand without it.",
    "- \"The readme was not updated\" for a change the message shows in full and never claims is documented.",
    "Most turns deserve no objection. Reporting nothing is the usual correct answer.",
    "",
    "Argue each candidate objection to a stop before you report it: write the strongest answer the agent",
    "could give from the tape and the files, then decide whether the objection survives that answer. Report",
    "only objections that survive. Scale to the stakes: a small change that its own test exercises should",
    "usually draw no objection at all.",
    "",
  );

  if (input.history.length) {
    lines.push("Earlier rounds in this review, oldest first:");
    input.history.forEach((h, i) => {
      lines.push(`Round ${i + 1} — your objections:`);
      for (const o of h.objections) lines.push(`  [${o.line}] ${o.objection}`);
      if (h.answer !== undefined && i < input.history.length - 1) {
        lines.push(`Round ${i + 1} — the agent's answer (clipped):`, clipMiddle(h.answer, ANSWER_MAX));
      }
    });
    lines.push(
      "",
      "The agent's latest message below answers your last round. Drop every objection the answer settled",
      "(by fixing the work, fixing the line, or a rebuttal that holds). Keep an objection only if the answer",
      "failed to settle it, and say in the objection why the answer fails. Add a new objection only if it is",
      "genuinely new, not a rewording of a settled one.",
      "",
    );
  }

  if (input.plainLines?.length) {
    lines.push(
      `Lines ${input.plainLines.join(", ")} answer their rule in plain words, with no command, file:line or sample.`,
      "That is allowed. Judge each: object only if the statement is false, or too thin to answer its rule.",
      "",
    );
  }
  lines.push("Session tape (commands that actually ran in this conversation, with what they printed):");
  const tape = tapeLines(input.tape);
  lines.push(...(tape.length ? tape : ["(no commands taped)"]));
  lines.push("", "Files edited in this conversation:", ...(input.edits.length ? input.edits.slice(-50).map((e) => `- ${e}`) : ["(none taped)"]));
  const rewritten = input.diff ? changedTestExpectations(input.diff) : [];
  if (rewritten.length) {
    lines.push(
      "",
      `This turn removed or rewrote ${rewritten.length} existing assertion line${rewritten.length === 1 ? "" : "s"} in test files (from the diff below):`,
      ...rewritten.slice(0, REWRITTEN_SHOWN).map((r) => `- ${r.file}: ${r.line}`),
      ...(rewritten.length > REWRITTEN_SHOWN ? [`- … and ${rewritten.length - REWRITTEN_SHOWN} more`] : []),
      "Check whether the message tells the user each changed expectation and why. Changing what a test expects",
      "is changing behaviour; doing it silently to make a change pass is material.",
    );
  }
  if (input.diff) {
    lines.push(
      "",
      "What actually changed in those files (uncommitted diff). Compare it with what the message says it did:",
      "a change the message does not mention, or describes differently, is material — in particular, editing",
      "what an existing test expects so that it passes is a behaviour change the user must be told about.",
      "<<<DIFF",
      clipMiddle(input.diff, DIFF_MAX),
      "DIFF>>>",
    );
  }
  if (input.pieceLines?.length) lines.push("", ...input.pieceLines);
  lines.push("", "The agent's latest message:", "<<<MESSAGE", clipMiddle(input.message, MESSAGE_MAX), "MESSAGE>>>", "");

  lines.push(
    input.final
      ? `This is the closing review after ${input.maxRounds} rounds: nobody will answer it. Report only objections that are still open.`
      : `This is round ${input.round} of at most ${input.maxRounds}.`,
    `If no objection survives, return an empty list. Do not invent one to look thorough. At most ${MAX_OBJECTIONS} objections, most important first.`,
    "",
    "Reply with ONLY a JSON object, no other text. For each objection you keep, give the strongest answer",
    "you weighed and why the objection survives it:",
    '{"objections":[{"line":"1"-"7"|"sc_N"|"blocked"|"general","objection":"<one or two sentences, concrete: what is wrong and what would settle it>","strongest_answer":"<the agent\'s best reply>","survives_because":"<why that reply fails>"}]}',
  );

  let prompt = lines.join("\n");
  if (prompt.length > PROMPT_BUDGET) prompt = clipMiddle(prompt, PROMPT_BUDGET);
  return prompt;
}

/**
 * Tolerant parse of the reviewer's reply. The envelope is cursor-agent's JSON
 * with a `result` text; the model may wrap the object in prose or fences.
 * Returns null when unusable — the caller records an error and sends nothing.
 */
export function parseReviewOutput(stdout: string): { objections: ReviewObjection[] } | null {
  let text = stdout;
  try {
    const envelope = JSON.parse(stdout) as { result?: unknown; is_error?: unknown };
    if (envelope.is_error === true) return null;
    if (typeof envelope.result === "string") text = envelope.result;
  } catch {
    // raw text
  }
  let list = firstObjectWith(text, "objections");
  if (!list) {
    // Repair from the object itself, so quotes in surrounding prose can't shift it.
    const at = text.search(/\{\s*"objections"/);
    if (at >= 0) list = firstObjectWith(repairStrayQuotes(text.slice(at)), "objections");
  }
  if (!list) return null;
  const objections: ReviewObjection[] = [];
  for (const entry of list) {
    const e = entry as Record<string, unknown>;
    const objection = typeof e?.objection === "string" ? e.objection.trim() : "";
    if (!objection) continue;
    const line = typeof e.line === "string" || typeof e.line === "number" ? String(e.line).trim() || "general" : "general";
    objections.push({ line: line.slice(0, 40), objection: objection.slice(0, OBJECTION_MAX) });
    if (objections.length >= MAX_OBJECTIONS) break;
  }
  return { objections };
}

/**
 * The first balanced JSON object in the text that carries an array under
 * `key`. Models add prose before and after, or a stray brace — scan rather
 * than slicing from the first "{" to the last "}".
 */
export function firstObjectWith(text: string, key: string): unknown[] | null {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const v = JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
            if (v && Array.isArray(v[key])) return v[key] as unknown[];
          } catch {
            // not JSON from here; try the next "{"
          }
          break;
        }
      }
    }
  }
  return null;
}

/**
 * Models quoting code that itself contains quotes (CSV's `""`, a shell
 * command) sometimes leave them unescaped inside a JSON string. Inside a
 * string, a quote that is not followed by `,` `}` `]` or `:` cannot be the
 * closing quote of valid JSON — escape it. Only used when strict parsing found
 * nothing (seen live: 2 of 42 replies on a CSV task, 2026-11-02).
 */
export function repairStrayQuotes(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      const next = text.slice(i + 1).match(/^\s*(.)/s)?.[1];
      if (next === undefined || ",}]:".includes(next)) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch === "\n" ? "\\n" : ch;
  }
  return out;
}

/** What the agent is sent when the reviewer objects. */
export function reviewFollowup(objections: ReviewObjection[], round: number, maxRounds: number): string {
  const label = (line: string): string => (/^\d+$/.test(line) ? `line ${line}` : line);
  return [
    `Goal Guardian review, round ${round} of ${maxRounds}: an independent reviewer read your done check against the session tape and objects:`,
    ...objections.map((o, i) => `${i + 1}. [${label(o.line)}] ${o.objection}`),
    "Answer each objection on its merits: fix the work, correct the line, or rebut it with evidence. If an objection is wrong, say why and keep your line — do not concede just to end the review. Then end your reply with the updated `## Done check` (or `## Blocked`).",
  ].join("\n");
}

/** The headless agent: configured path, else PATH, else the installer's default location. */
export function resolveAgentCommand(configured?: string): string | null {
  if (configured) return configured;
  const names = process.platform === "win32" ? ["cursor-agent.cmd", "cursor-agent.exe", "cursor-agent"] : ["cursor-agent"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  // Hooks launched by the editor often get a PATH without ~/.local/bin.
  const fallback = path.join(os.homedir(), ".local", "bin", "cursor-agent");
  return isExecutable(fallback) ? fallback : null;
}

function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ReviewerRunOptions {
  command: string;
  workspaceRoot: string;
  /** Run in this throwaway copy, allowed to run commands, with credentials stripped (else: read-only ask mode). */
  copy?: { dir: string; scratch: string };
  model?: string;
  timeoutMs: number;
}

export type ReviewerRun = (prompt: string, options: ReviewerRunOptions) => Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;

const SCRATCH_PREFIX = "gg-review-";
const SCRATCH_STALE_MS = 60 * 60 * 1000;

/**
 * A hook killed mid-review (Cursor's timeout, the editor closing) never
 * reaches its cleanup: remove scratch workspaces older than an hour.
 */
export async function sweepStaleScratch(dir: string = os.tmpdir(), now: number = Date.now()): Promise<void> {
  try {
    for (const name of await fsp.readdir(dir)) {
      if (!name.startsWith(SCRATCH_PREFIX)) continue;
      const p = path.join(dir, name);
      const st = await fsp.stat(p).catch(() => null);
      if (st?.isDirectory() && now - st.mtimeMs > SCRATCH_STALE_MS) await fsp.rm(p, { recursive: true, force: true });
    }
  } catch {
    // housekeeping only
  }
}

/** Marks the reviewer's own hook events so Guardian does not tape them. */
export const REVIEWER_ENV = "GOAL_GUARDIAN_REVIEWER";

/**
 * Run the reviewer: read-only ask mode, in an empty scratch workspace (so the
 * project's hooks and rules do not load), with the real workspace added for
 * reading. Never throws.
 */
export const runCursorAgentReviewer: ReviewerRun = async (prompt, options) => {
  let scratch: string | null = null;
  try {
    await sweepStaleScratch();
    scratch = await fsp.mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX));
    const args = options.copy
      ? ["-p", prompt, "--output-format", "json", "--force", "--trust", "--workspace", options.copy.dir]
      : ["-p", prompt, "--mode", "ask", "--output-format", "json", "--trust", "--workspace", scratch, "--add-dir", options.workspaceRoot];
    if (options.model) args.push("--model", options.model);
    return await new Promise((resolve) => {
      const child = spawn(options.command, args, {
        cwd: options.copy ? options.copy.dir : scratch!,
        stdio: ["ignore", "pipe", "pipe"],
        // In the copy it may run commands: credentials out, except cursor-agent's own login.
        env: { ...(options.copy ? strippedEnv(options.copy.scratch, /^CURSOR/i) : process.env), [REVIEWER_ENV]: "1" },
        shell: process.platform === "win32" && /\.cmd$/i.test(options.command),
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (v: { ok: true; stdout: string } | { ok: false; error: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ ok: false, error: `reviewer timed out after ${Math.round(options.timeoutMs / 1000)}s` });
      }, options.timeoutMs);
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      child.on("error", (err) => finish({ ok: false, error: `reviewer failed to start: ${err.message}` }));
      child.on("close", (code) => {
        if (code === 0) finish({ ok: true, stdout });
        else {
          const why = (stderr.trim().split("\n").pop() ?? "").slice(0, 200);
          finish({ ok: false, error: `reviewer exited ${code}${why ? `: ${why}` : ""}` });
        }
      });
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (scratch) await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
};
