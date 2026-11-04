/**
 * The done check, as pure functions. The agent ends a turn with a
 * `## Done check` block (seven numbered rule lines, plus one `sc_N.` line per
 * contract success criterion) or a `## Blocked` block. This module judges the
 * FORM of that block deterministically — no model call — and then does the
 * part a prompt alone cannot: it cross-checks the cited evidence against the
 * session tape and the workspace files. A cited command that never ran,
 * quoted output the command never printed, or a `file:line` past the end of
 * the file is "contradicted", not merely "unverified".
 */
import type { DoneCheckRecord, DoneLineStatus } from "../schema/audit.js";

/** The note on a line that states something in words but cites no evidence. */
/** Marks a cited command the shell tape does not have. Agents also search and read
 *  through their own tools, which never reach the tape, so this is unverified, not false. */
export const NOT_ON_TAPE_MARK = " is not on the shell tape";
/** Marks a line citing commands that ran, without their output. */
export const RAN_NO_OUTPUT_MARK = " (it ran)";
export const PLAIN_STATEMENT_NOTE = "no command+output, file:line, or sample size with both error rates";

export const DONE_RULE_KEYS = ["1", "2", "3", "4", "5", "6", "7"] as const;

export interface ShellRun {
  command: string;
  /** What the command printed, when the channel captured it (Cursor's afterShellExecution). */
  output?: string;
}

export interface DoneCheckContext {
  /** Contract success-criterion ids; each needs its own `sc_N.` line. */
  criterionIds: string[];
  /** Criterion texts: an agent quoting one back (`docker image built`) is not citing a command. */
  criterionTexts?: string[];
  /** Shell commands taped in this conversation (whole conversation: evidence may predate the turn). */
  shellRuns: ShellRun[];
  /** Shell/edit actions in THIS turn. Zero means nothing changed, so no block is owed. */
  turnActions: number;
  /** Overrides turnActions > 0: a reply to Guardian's own follow-up still owes its block. */
  required?: boolean;
  /** Line count of a workspace-relative file, or null when it does not exist. */
  lineCount: (relPath: string) => number | null;
  /** Contents of a workspace-relative file (quotes may come from a cited file, not a command). */
  readFile?: (relPath: string) => string | null;
}

export interface DoneLineResult {
  key: string;
  status: DoneLineStatus;
  note: string;
}

export interface DoneCheckResult {
  verdict: DoneCheckRecord["verdict"];
  required: boolean;
  lines: DoneLineResult[];
  problems: string[];
}

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const DONE_TITLE = /^done check$/i;
const BLOCKED_TITLE = /^blocked$/i;
const LINE_START = /^\s*(?:[-*]\s+)?(\d+|sc_[A-Za-z0-9_-]+)\s*[.):]\s*(.*)$/;
const BARE = /^(?:n\/?a|na|none|verified|see above|as above|done|ok|okay|yes|passed|checked|confirmed|tbd|todo|-+|—|–)\.?$/i;
const WAIVED = /^does not apply\s*[:—–-]\s*(.*)$/i;
const GAP = /^gap\s*:\s*(.+?)\s*[;·|]\s*closes? with\s*:\s*(.+?)\s*[;·|]\s*held by\s*:\s*(.+)$/i;
const ARROW = /→|->|=>/;
const FILE_LINE = /([A-Za-z0-9_@.\-/\\]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;
// Single or double backtick code spans (``a `b` c`` is how markdown quotes a backtick).
const BACKTICK = /``\s?([^\n]+?)\s?``|`([^`\n]+)`/g;
const QUOTED = /"([^"\n]{4,})"|“([^”\n]{4,})”/g;
// Output stated on the line without quotes: an arrow followed by text, an
// exit code, or a reporting verb / "from \`cmd\`" with a number. Words like
// "should fail" or "yields same output" are not output (measured: those were
// every wrongly-accepted line in the first held-out sample).
const STATED_OUTPUT = [
  /(?:→|->|=>)\s*\S/,
  /\bexit(?:ed)?(?: code)?\s*[:=]?\s*\d+/i,
  /\b(?:reported|printed|prints|returned|returns|shows|showed|gave|gives|yields|outputs?)\s*:?\s*\**\d/i,
  /\d[\d.,]*\**\s*[a-z%]*\**\s+(?:from|per|via)\s+`/i,
  /\b\d+\s+(?:passed|failed|passing|failing|pass|fail|errors?|warnings?|matches)\b/i,
  /\b(?:passed|failed)\b[,:]?\s*\d+/i,
  /\boutputs?\s*:\s*[^.;]{0,40}?\d/i,
];
const SAMPLE = /\b(?:n\s*=\s*\d+|\d+\s+(?:samples?|cases|items|examples|records|runs|files|inputs|rows|values|paths|lines|observations|points|tests|measurements))\b/i;
const ERROR_TERM_REVERSED = /(?:wrongly|falsely|incorrectly)\s+(?:included|excluded)\s*:?\s*\d+|\b\d+\s*(?:FP|FN)\b|\b(?:FP|FN)\s*[:=]?\s*\d+/gi;
const BOTH_WAYS = /\bboth (?:ways|directions)\b/i;
const ERROR_TERM = /\d+(?:\.\d+)?\s*%?\s*(?:\/\s*\d+\s*)?(?:wrongly |falsely |incorrectly )?(?:included|excluded|false positives?|false negatives?)/gi;
// Rates are percentages or a/b counts — bare decimals are means, versions, t-values.
const RATE = /\d+(?:\.\d+)?\s*%|\b\d+\s*\/\s*\d+\b/g;
const KNOWN_RUNNERS = /^(?:cd|for|while|env|sudo|timeout|time|echo|sed|awk|head|tail|sort|uniq|xargs|cp|mv|rm|mkdir|touch|chmod|pnpm|npm|npx|yarn|bun|deno|node|tsx|tsc|vitest|jest|git|gh|python3?|py|pytest|pip|uv|cargo|go|make|cmake|ctest|mvn|gradle|dotnet|ruby|bundle|rake|php|composer|swift|xcodebuild|ls|cat|grep|rg|find|wc|diff|curl|docker|kubectl|bash|sh|pwsh|powershell|cmd)(?![\w-])|^(?:\{|\(|\.\/)/i;

interface ParsedLine {
  key: string;
  text: string;
}

interface Parsed {
  kind: "done" | "blocked" | "none";
  lines: ParsedLine[];
  body: string[];
  problems: string[];
}

/** Locate the block that ENDS the message and split it into keyed lines. */
export function parseDoneBlock(message: string): Parsed {
  const all = message.replace(/\r\n?/g, "\n").split("\n");
  // Fenced code is content, not structure: a heading inside ``` is not a heading.
  let inFence = false;
  const headings: Array<{ index: number; title: string }> = [];
  all.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return;
    const m = HEADING.exec(line);
    if (m?.[1]) headings.push({ index, title: m[1].replace(/[*_`]/g, "").trim() });
  });
  // An unbalanced fence (a diff that contains a ``` line) would hide the block
  // inside "code": fall back to headings regardless of fences (seen live).
  const fenceLines = all.filter((line) => /^\s*(```|~~~)/.test(line)).length;
  if (fenceLines % 2 === 1 && !headings.some((h) => DONE_TITLE.test(h.title) || BLOCKED_TITLE.test(h.title))) {
    headings.length = 0;
    all.forEach((line, index) => {
      const m = HEADING.exec(line);
      if (m?.[1]) headings.push({ index, title: m[1].replace(/[*_`]/g, "").trim() });
    });
  }
  const last = headings[headings.length - 1];
  const doneIdx = [...headings].reverse().find((h) => DONE_TITLE.test(h.title) || BLOCKED_TITLE.test(h.title));
  if (!doneIdx) return { kind: "none", lines: [], body: [], problems: [] };

  const problems: string[] = [];
  if (last && last !== doneIdx) {
    problems.push(`the ${doneIdx.title} block must end the message; "${last.title}" comes after it`);
  }
  const end = last && last !== doneIdx ? last.index : all.length;
  const body = all.slice(doneIdx.index + 1, end);
  const kind = DONE_TITLE.test(doneIdx.title) ? "done" : "blocked";

  const lines: ParsedLine[] = [];
  for (const raw of body) {
    const m = LINE_START.exec(raw);
    if (m?.[1] !== undefined) {
      lines.push({ key: m[1].toLowerCase(), text: (m[2] ?? "").trim() });
    } else if (raw.trim() && lines.length > 0) {
      // Wrapped continuation of the previous line.
      const prev = lines[lines.length - 1]!;
      prev.text = `${prev.text} ${raw.trim()}`.trim();
    }
  }
  return { kind, lines, body, problems };
}

interface Span {
  text: string;
  kind: "command" | "loose" | "output" | "file" | "code";
}

/**
 * Decide what each backtick span is, once. Measured on real agent blocks:
 * spans after an arrow (up to the next ";" or arrow) are output; spans
 * wholly in double quotes are output; file:line spans are references; spans
 * opening with a known runner are commands; other multi-word spans are
 * "loose" — a command only if the tape confirms it, never a contradiction.
 */
function classifySpans(text: string): Span[] {
  const out: Span[] = [];
  let outputZone = false;
  let last = 0;
  for (const m of text.matchAll(BACKTICK)) {
    const between = text.slice(last, m.index);
    if (ARROW.test(between)) outputZone = true;
    if (/[;,]|\.\s|\band\b/.test(between.replace(/→|->|=>/g, ""))) outputZone = ARROW.test(between.split(/[;,]|\.\s|\band\b/).pop() ?? "");
    last = (m.index ?? 0) + m[0].length;
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (!raw) continue;
    const quoted = /^"(.{2,})"$/.exec(raw);
    if (/^[A-Za-z0-9_@.\-/\\]+\.[A-Za-z0-9]+:\d+(?:-\d+)?$/.test(raw)) {
      out.push({ text: raw, kind: "file" });
      // What follows a file reference describes that file, not command output
      // (seen live: `test/suites/objects.js:94` (`should overwrite null values`)).
      outputZone = false;
    }
    else if (quoted?.[1]) out.push({ text: quoted[1].trim(), kind: "output" });
    else if (/\b(?:uses|using|contains|containing|calls|runs inside|defined as|via a)\s*$/i.test(between)) out.push({ text: raw, kind: "code" });
    else if (KNOWN_RUNNERS.test(raw) && /\s/.test(raw)) out.push({ text: raw, kind: "command" });
    else if (outputZone && /\s/.test(raw) && !/^[\w@.\-/\\]+\.\w+$|^[\w.\-]*\/[\w.\-/]*$/.test(raw)) out.push({ text: raw, kind: "output" });
    // A lone word (`while`, `Grep`) is a command only if the tape confirms it.
    else if (KNOWN_RUNNERS.test(raw)) out.push({ text: raw, kind: "loose" });
    else if (/\s/.test(raw)) out.push({ text: raw, kind: "loose" });
    else out.push({ text: raw, kind: "code" });
  }
  return out;
}

/** Escaping and quoting differ between channels; compare the letters only. */
function fingerprint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeText(value: string): string {
  // Strip ANSI colour codes test runners emit, then collapse whitespace.
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").toLowerCase().trim();
}

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9._-]+/).filter((t) => t.length > 0 && t !== "." && t !== "..");
}

/**
 * A cited command matches a taped run when its letters appear in order
 * (quoting/escaping differ by channel), or when every token of the citation
 * appears in the run — agents abbreviate their own loops and paths
 * (`for i in 1 2 3; do node bench.mjs` for a longer real command).
 */
function findRuns(command: string, runs: ShellRun[]): ShellRun[] {
  const want = fingerprint(command);
  if (want.length < 2) return [];
  const wantTokens = tokens(command).filter((t) => t !== "…" && t !== "...");
  // A one-word citation (`cat`) must be a whole token of the run, not a
  // substring of something else ("concatenate").
  if (!/\s/.test(command.trim())) {
    return runs.filter((r) => tokens(r.command).flatMap((t) => [t, ...t.split("/")]).includes(command.trim().toLowerCase()));
  }
  return runs.filter((r) => {
    const seen = fingerprint(r.command);
    if (seen.length === 0) return false;
    if (seen.includes(want) || want.includes(seen)) return true;
    const have = new Set(tokens(r.command).flatMap((t) => [t, ...t.split("/")]));
    return wantTokens.length >= 2 && wantTokens.every((t) => have.has(t));
  });
}

function shorten(value: string, max = 50): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Judge one Done-check line: its form, then each checkable item against the tape and files. */
export function evaluateLine(key: string, text: string, ctx: DoneCheckContext): DoneLineResult {
  const t = text.trim();
  if (!t || BARE.test(t)) {
    return { key, status: "unsupported", note: t ? `"${t}" is not evidence` : "empty line" };
  }
  const waived = WAIVED.exec(t);
  if (waived) {
    const reason = (waived[1] ?? "").trim();
    if (reason.length < 8 || BARE.test(reason)) {
      return { key, status: "unsupported", note: "does not apply needs a real reason" };
    }
    return { key, status: "waived", note: shorten(reason, 80) };
  }

  // Rule 6 asks for gaps declared, not hidden: an honest "not done" is a
  // valid line, so the form check never pushes a real gap into "does not apply".
  const gap = GAP.exec(t);
  if (gap) {
    const parts = [gap[1], gap[2], gap[3]].map((v) => (v ?? "").trim());
    // "held by: me" is a real holder; what and closes-with need a phrase.
    if (parts.some((v, i) => v.length < (i === 2 ? 2 : 3) || BARE.test(v))) {
      return { key, status: "unsupported", note: "a gap needs what, what closes it, and who holds it" };
    }
    return { key, status: "gap", note: shorten(`${parts[0]} — held by ${parts[2]}`, 80) };
  }

  const fileRefs = [...t.matchAll(FILE_LINE)].map((m) => ({ file: m[1]!, line: Number(m[3] ?? m[2]) }));
  const spans = classifySpans(t);
  // Strict commands (a known runner up front) must be on the tape; loose
  // spans (prose-ish code in backticks) count only when the tape confirms them.
  const criterionPrints = new Set((ctx.criterionTexts ?? []).map(fingerprint));
  const commands = spans.filter((s) => s.kind === "command" && !criterionPrints.has(fingerprint(s.text))).map((s) => s.text);
  const loose = spans.filter((s) => s.kind === "loose").map((s) => s.text);
  // Quoted output: double quotes OUTSIDE backticks (quotes inside a command
  // are part of the command — seen live: `node -e "console.log(...)"`), plus
  // backtick spans that are output (after an arrow, or wholly "quoted").
  const outside = t.replace(BACKTICK, " ");
  // A quote outside backticks is a claimed result only when its clause ties
  // it to one: an arrow, a reporting verb, or a command span before it.
  // Agents also quote their own definitions ("a rule “own-key sets must
  // match”"), which are not output (seen live, 8 of 31 honest real turns).
  const commandSpans = new Set(spans.filter((sp) => sp.kind === "command" || sp.kind === "loose").map((sp) => sp.text));
  const marked = t.replace(BACKTICK, (m, a, b) => (commandSpans.has(((a ?? b) as string).trim()) ? " \u0001 " : " ".repeat(m.length)));
  const attached = (index: number): boolean => {
    const before = marked.slice(0, index);
    const clause = before.slice(Math.max(before.lastIndexOf(";"), before.lastIndexOf(". "), before.lastIndexOf(" · "), -1) + 1);
    return /→|->|=>|\u0001|\b(?:printed|prints|printing|output|outputs|returned|returns|shows|showed|shown|reported|reports|says|said|gave|gives|logged|logs|emits|emitted|listed|lists|yields|yielded)\b/i.test(clause);
  };
  const quotes = [
    ...[...marked.matchAll(QUOTED)].filter((m) => attached(m.index ?? 0)).map((m) => (m[1] ?? m[2] ?? "").trim()).filter(Boolean),
    // An output span holding several quoted results (`"# tests 33" "# pass 33"`) is several quotes.
    ...spans.filter((sp) => sp.kind === "output").flatMap((sp) => {
      const parts = [...sp.text.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.trim());
      return parts.length >= 2 ? parts : [sp.text];
    }),
  ];
  for (const l of loose) if (findRuns(l, ctx.shellRuns).length > 0) commands.push(l);
  // "output quoted above" is the banned "see above" in other words: output
  // has to be on the line itself.
  const pointsElsewhere = /\b(?:see|quoted|shown|printed|listed|cited|output|table|results?)\s+(?:above|below|earlier)\b|\b(?:above|earlier)\s*[.)]?\s*$/i.test(outside);
  const hasOutput = quotes.length > 0 || (STATED_OUTPUT.some((re) => re.test(outside.replace(/\*\*/g, "")) || re.test(t)) && !pointsElsewhere);
  const commandForm = commands.length > 0 && hasOutput;
  const rateCount = (t.match(RATE) ?? []).length;
  // Both error directions, as rates ("2%", "1/50") or as counted errors
  // ("0/4 wrongly included, 0 wrongly excluded").
  const errorTerms = (t.match(ERROR_TERM) ?? []).length + (t.match(ERROR_TERM_REVERSED) ?? []).length;
  const sampleForm = (SAMPLE.test(t) || /\b\d+\s*\/\s*\d+\b/.test(t)) && (rateCount >= 2 || errorTerms >= 2 || (rateCount >= 1 && BOTH_WAYS.test(t)));

  if (!commandForm && fileRefs.length === 0 && !sampleForm) {
    if (commands.length > 0) {
      // A command that really ran, cited without its output ("rerun `x`" for
      // rule 5) is a statement the reviewer can judge; one that never ran is not.
      const allRan = commands.every((c) => findRuns(c, ctx.shellRuns).length > 0);
      return { key, status: "unsupported", note: `cites \`${shorten(commands[0]!, 40)}\`${allRan ? RAN_NO_OUTPUT_MARK : ""} but not its output` };
    }
    return { key, status: "unsupported", note: PLAIN_STATEMENT_NOTE };
  }

  const confirmed: string[] = [];
  // File references: the line must exist.
  for (const ref of fileRefs) {
    const rel = ref.file.replace(/\\/g, "/").replace(/^\.\//, "");
    const count = ctx.lineCount(rel);
    if (count === null) return { key, status: "contradicted", note: `${rel} does not exist` };
    if (ref.line < 1 || ref.line > count) {
      return { key, status: "contradicted", note: `${rel} has ${count} lines; line ${ref.line} cited` };
    }
    confirmed.push(`${rel}:${ref.line}`);
  }

  // Commands: confirmed when on this conversation's tape. One that is not is
  // unverified rather than false: the agent's own search/read tools never
  // reach the shell tape (seen live: `rg …` run through a grep tool).
  const notOnTape: string[] = [];
  for (const command of commandForm ? commands : []) {
    if (findRuns(command, ctx.shellRuns).length === 0) {
      notOnTape.push(command);
      continue;
    }
    confirmed.push(`\`${shorten(command, 30)}\` ran`);
  }

  // Quoted output: must appear in something the session actually printed, or
  // in a file the line cites. Fabricated output appears nowhere; output quoted
  // next to the wrong command, or a quote from package.json, is still real.
  // No captured output at all = unverifiable, not false.
  const withOutput = ctx.shellRuns.filter((r) => typeof r.output === "string");
  if (quotes.length > 0 && withOutput.length > 0) {
    // Compare letters and digits only: agents re-punctuate output
    // ({"test":0} quoted as test:0) but cannot invent its words or numbers.
    const pathLike = spans.filter((sp) => /^[\w@.\-/\\]+\.[A-Za-z0-9]+$/.test(sp.text)).map((sp) => sp.text);
    const citedFiles = [...new Set([...fileRefs.map((r) => r.file), ...spans.filter((sp) => sp.kind === "file").map((sp) => sp.text), ...pathLike])]
      .map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "").replace(/:\d+(?:-\d+)?$/, ""));
    const printed = [
      ...withOutput.map((r) => fingerprint(normalizeText(r.output ?? ""))),
      ...citedFiles.map((f) => ctx.readFile?.(f) ?? null).filter((t): t is string => t !== null).map((t) => fingerprint(normalizeText(t))),
    ];
    for (const q of quotes) {
      // One or two plain words in quotes are emphasis, not a quoted result.
      if (!/\d/.test(q) && q.trim().split(/\s+/).length <= 2 && !/[=:{}<>/]/.test(q)) continue;
      // A "quote" holding an arrow, or ending in : or ;, is two quotes mispaired, not output.
      if (/→|->|=>/.test(q) || /[:;]\s*$/.test(q)) continue;
      const fragments = q.split(/\s*(?:\.\.\.|…)\s*/).map((f) => fingerprint(normalizeText(f))).filter(Boolean);
      if (fragments.length === 0) continue;
      const inOrder = (p: string): boolean => {
        let at = 0;
        for (const f of fragments) {
          const i = p.indexOf(f, at);
          if (i < 0) return false;
          at = i + f.length;
        }
        return true;
      };
      if (!printed.some(inOrder)) {
        return { key, status: "contradicted", note: `"${shorten(q, 40)}" was not printed in this session` };
      }
      confirmed.push("quoted output matches");
    }
  }

  if (notOnTape.length > 0) {
    const note = `\`${shorten(notOnTape[0]!, 40)}\`${NOT_ON_TAPE_MARK}`;
    if (confirmed.length === 0) return { key, status: "unsupported", note };
    confirmed.push(note.trim());
  }

  if (confirmed.length === 0) {
    return { key, status: "stated", note: sampleForm ? "sample size and rates stated (not machine-checkable)" : "evidence stated" };
  }
  return { key, status: "backed", note: [...new Set(confirmed)].join("; ") };
}

/** The Blocked block: three labelled parts — what, what would unblock it, who holds it. */
function evaluateBlocked(body: string[]): { lines: DoneLineResult[]; problems: string[] } {
  const text = body.join("\n");
  const part = (label: RegExp, key: string, ask: string): DoneLineResult => {
    const m = label.exec(text);
    const value = (m?.[1] ?? "").trim();
    if (!value) return { key, status: "missing", note: `say ${ask}` };
    if (BARE.test(value) || value.length < 4) return { key, status: "unsupported", note: `"${value}" does not say ${ask}` };
    return { key, status: "stated", note: shorten(value, 80) };
  };
  const lines = [
    part(/^\s*(?:[-*]\s+)?\**(?:what|blocked)\**\s*[:—–-]\s*(.+)$/im, "what", "what cannot be done"),
    part(/^\s*(?:[-*]\s+)?\**unblock(?:ed by|s?)?\**\s*[:—–-]\s*(.+)$/im, "unblock", "what would unblock it"),
    part(/^\s*(?:[-*]\s+)?\**(?:who|holder|owner)\**\s*[:—–-]\s*(.+)$/im, "who", "who holds it"),
  ];
  return { lines, problems: [] };
}

/** The whole check: parse, judge every required line, decide the verdict. */
export function evaluateDoneCheck(message: string, ctx: DoneCheckContext): DoneCheckResult {
  const required = ctx.required ?? ctx.turnActions > 0;
  const parsed = parseDoneBlock(message);

  if (parsed.kind === "none") {
    return { verdict: required ? "absent" : "not_required", required, lines: [], problems: [] };
  }

  if (parsed.kind === "blocked") {
    const { lines, problems } = evaluateBlocked(parsed.body);
    const all = [...parsed.problems, ...problems];
    const ok = all.length === 0 && lines.every((l) => l.status === "stated");
    return { verdict: ok ? "blocked" : "fail", required, lines, problems: all };
  }

  const problems = [...parsed.problems];
  const expected = [...DONE_RULE_KEYS, ...ctx.criterionIds.map((id) => id.toLowerCase())];
  const seen = new Map<string, ParsedLine>();
  for (const line of parsed.lines) {
    if (seen.has(line.key)) problems.push(`line ${line.key} appears twice`);
    else seen.set(line.key, line);
  }
  for (const key of seen.keys()) {
    if (!expected.includes(key)) {
      problems.push(/^\d+$/.test(key) ? `line ${key}: the block has exactly seven numbered lines` : `${key} is not a success criterion in the contract`);
    }
  }

  const lines = expected.map((key): DoneLineResult => {
    const line = seen.get(key);
    if (!line) return { key, status: "missing", note: key.startsWith("sc_") ? "criterion not addressed" : "line absent" };
    return evaluateLine(key, line.text, ctx);
  });

  const failing = lines.some((l) => l.status === "missing" || l.status === "unsupported" || l.status === "contradicted");
  return { verdict: failing || problems.length > 0 ? "fail" : "pass", required, lines, problems };
}

/**
 * With the adversarial review on, a line that states something in plain words
 * (no command, file:line or sample) is not bounced by code: whether a true
 * sentence is enough for its rule is a judgement, and the reviewer makes it.
 * Fake evidence, bare "n/a"/"verified", missing lines and malformed gaps still
 * fail here. Returns the adjusted result and the deferred line keys.
 */
export function deferPlainStatements(result: DoneCheckResult): { result: DoneCheckResult; deferred: string[] } {
  if (result.verdict !== "fail") return { result, deferred: [] };
  const deferred: string[] = [];
  const lines = result.lines.map((l) => {
    if (l.status === "unsupported" && (l.note === PLAIN_STATEMENT_NOTE || l.note.includes("but not its output") || l.note.endsWith(`\`${NOT_ON_TAPE_MARK}`))) {
      deferred.push(l.key);
      return { ...l, status: "stated" as const, note: "plain statement — judged by the reviewer" };
    }
    return l;
  });
  const failing = lines.some((l) => l.status === "missing" || l.status === "unsupported" || l.status === "contradicted");
  return { result: { ...result, lines, verdict: failing || result.problems.length > 0 ? "fail" : "pass" }, deferred };
}

/** Who holds a gap: the agent itself (so it can keep going), or someone else (the user, CI, a vendor). */
const AGENT_HOLDER = /^(?:me|myself|i|agent|the agent|assistant|ai|cursor|claude|this agent|us)\b/i;

/**
 * "Done when" items the block declares unfinished and the agent itself holds: the goal is not done,
 * and nothing outside the agent is in the way.
 */
export function openWork(result: DoneCheckResult): string[] {
  if (result.verdict !== "pass") return [];
  return result.lines
    .filter((l) => l.key.startsWith("sc_") && l.status === "gap")
    .filter((l) => AGENT_HOLDER.test((l.note.split(" — held by ")[1] ?? "").trim()))
    .map((l) => `${l.key}: ${l.note.split(" — held by ")[0]}`);
}

/**
 * The closing request when Guardian stops sending the agent back with work still open (cap or stall):
 * one grounded wrap-up.
 */
export function wrapupFollowup(open: string[], stalled: boolean): string {
  return [
    `Goal Guardian: ${stalled ? "no progress in the last rounds" : "keep-going limit reached"} — stopping here with these "done when" items still open:`,
    ...open.map((o) => `- ${o}`),
    "Write your last message to the user now: what's done and how you verified it, what's still open and why,",
    "and exactly what they need to do or decide next. Stick to what this session's commands and files show; if",
    "you don't know a detail, say so rather than guess. Don't start new work. End with `## Done check` or `## Blocked`.",
  ].join("\n");
}

/**
 * The follow-up sent in enforce mode: names exactly what failed, so the
 * agent fixes the evidence rather than rewriting the block wholesale.
 */
export function doneCheckFollowup(result: DoneCheckResult): string | null {
  if (result.verdict === "pass" || result.verdict === "blocked" || result.verdict === "not_required") return null;
  if (result.verdict === "absent") {
    return "Goal Guardian done check: this turn changed files or ran commands but did not end with a `## Done check` block (or `## Blocked`). End your reply with one, in the format the goal-guardian-done-check rule gives.";
  }
  const issues = [
    ...result.problems,
    ...result.lines
      .filter((l) => l.status === "missing" || l.status === "unsupported" || l.status === "contradicted")
      .map((l) => `${/^\d+$/.test(l.key) ? `line ${l.key}` : l.key}: ${l.note}`),
  ];
  return [
    "Goal Guardian done check failed against the session tape:",
    ...issues.slice(0, 12).map((i) => `- ${i}`),
    "Fix the evidence (run what you cite, quote what it actually printed), say `does not apply: <reason>`, or declare an unfinished part as `gap: … · closes with: … · held by: …` — then end your reply with a corrected `## Done check`, or `## Blocked` if it cannot be finished in this session. Do not paper over a contradiction.",
  ].join("\n");
}
