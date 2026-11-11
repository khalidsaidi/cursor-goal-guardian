/**
 * Checks an agent's goal report against Guardian's own record. No model, no knowledge of any language or tool:
 * the agent names the proof, Guardian confirms it happened. A command must be on the record, have started after
 * the last edit, and have printed the quoted text. A file must exist and contain the quoted text.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Contract } from "../schema/contract.js";
import type { GoalProof, GoalReportRecord } from "../schema/audit.js";
import type { ShellOutput, ShrunkFile } from "./record.js";

/** Printing a sentence proves nothing, whatever the sentence says. */
const SAYS_NOT_DOES = /^(echo|printf|true|:|cd)(\s|$)/;
const onlyPrints = (command: string): boolean => command.split(/&&|\|\||;|\|/).every((part) => SAYS_NOT_DOES.test(part.trim()));

/** A quote this short would match nearly anything. */
const MIN_QUOTE = 4;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const normalize = (s: string): string => s.replace(ANSI, "").replace(/\s+/g, " ").trim();

/** The command's words as a shell would split them; anything that was quoted is marked, since quoted text is often code, not a path. */
function shellWords(command: string): Array<{ text: string; quoted: boolean }> {
  const out: Array<{ text: string; quoted: boolean }> = [];
  let cur = "";
  let quoted = false;
  let quote: string | null = null;
  const push = (): void => {
    if (cur) out.push({ text: cur, quoted });
    cur = "";
    quoted = false;
  };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      quoted = true;
    } else if (/\s/.test(ch) || ";|&<>()".includes(ch)) push();
    else cur += ch;
  }
  push();
  return out;
}

const PATH_LIKE = /^(?:[\w@.+-]+(?:\/[\w@.+-]+)+|[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,5})$/;
const PROJECT_FILES_MAX = 50_000;

/** Every file in the project, tracked or not, where git can list them. */
function projectFiles(root: string): string[] | null {
  const res = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 50_000_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  if (res.status !== 0 || res.error) return null;
  return res.stdout.split("\0").filter(Boolean).slice(0, PROJECT_FILES_MAX);
}

/**
 * Paths a command names that exist nowhere in the project, in any language: an unquoted word with a slash or a short
 * extension, not an option, a URL, a pattern, a variable or a redirect target. A name counts as present if a file or
 * folder by that path exists from the root, or anywhere in the project (the command may run from a subfolder).
 */
export function absentPathsIn(root: string, command: string): string[] {
  const words = shellWords(command.replace(/\d*>>?\s*\S+/g, " "));
  const named = new Set<string>();
  for (const w of words) {
    const word = w.text.replace(/^\.\//, "").replace(/\/+$/, "");
    if (w.quoted || !word || word.startsWith("-") || word.includes("://") || /[*?$={}~]/.test(word) || word.startsWith("/") || word.includes("..")) continue;
    if (PATH_LIKE.test(word)) named.add(word);
  }
  if (!named.size) return [];
  let files: string[] | null | undefined;
  const absent: string[] = [];
  for (const p of [...named].slice(0, 12)) {
    if (fs.existsSync(path.join(root, p))) continue;
    files ??= projectFiles(root);
    // Outside git there is no list to look through: only what the root itself lacks can be said, so say nothing.
    if (files === null) continue;
    if (files.some((f) => f === p || f.endsWith(`/${p}`) || f.startsWith(`${p}/`) || f.includes(`/${p}/`))) continue;
    absent.push(p);
  }
  return absent;
}

export interface GoalEvaluation {
  /** Why a "done when" item isn't proved, one line each. */
  unproved: string[];
  /** Proofs that held, for the receipt. */
  proved: GoalProof[];
  /** Files changed that the report doesn't account for. */
  unclaimed: string[];
  /** Files the agent itself says the goal doesn't need. */
  extras: string[];
}

/** Paths as one form whatever the agent wrote: from the project root, forward slashes, no leading `./`. */
export function projectPath(root: string, file: string): string {
  const slashed = file.replace(/\\/g, "/");
  const relative = path.isAbsolute(slashed) ? path.relative(root, slashed).split(path.sep).join("/") : slashed;
  return path.posix.normalize(relative).replace(/^\.\//, "");
}

async function checkProof(root: string, proof: GoalProof, outputs: ShellOutput[], lastEditTs: string | null, tree: string | null): Promise<string | null> {
  if (proof.command !== undefined) {
    const command = normalize(proof.command);
    const quote = normalize(proof.quote ?? "");
    if (quote.length < MIN_QUOTE) return "a command proof needs a whole line quoted from its output";
    if (onlyPrints(command)) return `\`${command}\` only prints text, so it proves nothing`;
    const all = outputs.filter((o) => normalize(o.command) === command);
    if (all.length === 0) return `Guardian has no record of \`${command}\` running`;
    const runs = all.filter((o) => !o.failed);
    const lastFailure = [...all].reverse().find((o) => o.failed);
    const lastRun = runs[runs.length - 1];
    if (lastFailure && (!lastRun || Date.parse(lastFailure.ts) >= Date.parse(lastRun.startedAt))) return `the latest run of \`${command}\` failed`;
    const fresh = lastEditTs ? runs.filter((o) => Date.parse(o.startedAt) >= Date.parse(lastEditTs)) : runs;
    if (fresh.length === 0) return `\`${command}\` last ran before your latest edit: run it again`;
    const latest = fresh[fresh.length - 1]!;
    if (!normalize(latest.output).includes(quote)) return `the latest run of \`${command}\` did not print "${quote}"`;
    if (tree && latest.tree && latest.tree !== tree) return `files changed after \`${command}\` last ran: run it again`;
    // A command that names a file the project doesn't have proves nothing about the project, whatever it printed.
    const absent = absentPathsIn(root, command);
    if (absent.length) return `\`${command}\` names ${absent.join(", ")}, which ${absent.length === 1 ? "is" : "are"}n't in the project`;
    return null;
  }
  if (proof.file !== undefined) {
    const inside = projectPath(root, proof.file);
    if (inside.startsWith("..") || path.isAbsolute(inside)) return `${proof.file} is outside the project`;
    if (inside.startsWith(".cursor/goal-guardian")) return "Guardian's own files prove nothing";
    const full = path.join(root, inside);
    const contains = normalize(proof.contains ?? "");
    if (contains.length < MIN_QUOTE) return "a file proof needs a whole line to find in it";
    const text = await fsp.readFile(full, "utf8").catch(() => null);
    if (text === null) return `${proof.file} does not exist`;
    if (!normalize(text).includes(contains)) return `${proof.file} does not contain "${contains}"`;
    return null;
  }
  return "no command or file named, only your word";
}

export async function evaluateReport(
  root: string,
  contract: Pick<Contract, "successCriteria">,
  report: Pick<GoalReportRecord, "proofs" | "changes" | "removed">,
  seen: { outputs: ShellOutput[]; lastEditTs: string | null; editedFiles: string[]; tree?: string | null; shrunk?: ShrunkFile[] },
): Promise<GoalEvaluation> {
  const items = contract.successCriteria.length ? contract.successCriteria : [{ id: "goal", text: "the goal" }];
  const unproved: string[] = [];
  const proved: GoalProof[] = [];
  for (const item of items) {
    const proofs = report.proofs.filter((p) => p.criterion === item.id);
    if (proofs.length === 0) {
      unproved.push(`${item.id} (${item.text}): no proof given`);
      continue;
    }
    for (const proof of proofs) {
      const problem = await checkProof(root, proof, seen.outputs, seen.lastEditTs, seen.tree ?? null);
      if (problem) unproved.push(`${item.id} (${item.text}): ${problem}`);
      else proved.push(proof);
    }
  }
  // Destroyed work can't be told from wanted removal by looking, so the agent must say which it is, on the record.
  const onPurpose = new Set((report.removed ?? []).map((f) => projectPath(root, f)));
  for (const f of seen.shrunk ?? []) {
    if (!onPurpose.has(f.file)) unproved.push(`${f.file} lost ${f.lost} of its ${f.had} lines. Put them back. Only if the goal or the user asked for this removal, list the file in removed`);
  }
  // A change is only accounted for by a real item (or "extra"), not by any word the agent puts there.
  const valid = new Set([...items.map((i) => i.id), "goal", "extra"]);
  const changes = report.changes.map((c) => ({ ...c, file: projectPath(root, c.file) }));
  const claimed = new Set(changes.filter((c) => valid.has(c.serves)).map((c) => c.file));
  const edited = new Set(seen.editedFiles);
  return {
    unproved,
    proved,
    unclaimed: seen.editedFiles.filter((f) => !claimed.has(f)),
    extras: changes.filter((c) => c.serves === "extra" && edited.has(c.file)).map((c) => c.file),
  };
}

const MIN_USER_WORDS = 10;

/**
 * The user asked for this, in their latest message: the quote is found in that message, and it isn't just a piece of
 * the goal itself (quoting the goal back says nothing about what the user wants now).
 */
export function userAsked(words: string | undefined, prompts: string[], goalText: string): boolean {
  const latest = prompts[prompts.length - 1];
  if (latest === undefined || !userSaid(words, [latest])) return false;
  const plain = (text: string): string => normalize(text.replace(/[^\x00-\x7f]+/g, " ")).toLowerCase();
  // List markers don't make a piece of the goal into something else.
  const bare = (text: string): string => plain(text.replace(/^\s*(?:\d+[.)]|[-*•])\s+/gm, ""));
  return !bare(goalText).includes(bare(words ?? ""));
}

/** Changing an existing goal takes the user's own words, found in what the user actually sent. */
export function userSaid(words: string | undefined, prompts: string[]): boolean {
  // Windows PowerShell can garble accents in the recorded message, so only plain ASCII is compared.
  const plain = (text: string): string => normalize(text.replace(/[^\x00-\x7f]+/g, " ")).toLowerCase();
  const quote = plain(words ?? "");
  // Long enough to be their request, not a word any sentence holds; a message that short must match whole.
  return quote.length > 0 && prompts.some((p) => {
    const said = plain(p);
    return quote.length >= MIN_USER_WORDS ? said.includes(quote) : said === quote;
  });
}
