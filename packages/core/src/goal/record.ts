/**
 * What Guardian itself saw, kept outside the audit tape because it is bulky: command output and the user's
 * latest messages. Both stay in the workspace's Guardian folder and are trimmed as they grow.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { appendAudit } from "../audit/log.js";
import { appendLine, writeJsonAtomic } from "../fsutil.js";
import { nowIso } from "../clock.js";
import { getGuardianPaths } from "../paths.js";

const HEAD = 600;
const TAIL = 3400;
const KEEP_OUTPUTS = 300;
const ROTATE_BYTES = 2_000_000;
const KEEP_PROMPTS = 3;
const MAX_PROMPT = 4000;

export interface ShellOutput {
  ts: string;
  /** When the command began, so output from before the last edit never counts as fresh. */
  startedAt: string;
  command: string;
  output: string;
  /** The project's state right after the command, where the project is a git repository. */
  tree?: string;
  /** Cursor reports commands that exit non-zero through a separate hook, sometimes with no output record at all. */
  failed?: boolean;
}

const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BYTES = 20_000_000;
const MAX_DIRTY = 2000;

function git(root: string, args: string[]): string | null {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BYTES, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  return res.status === 0 && !res.error ? res.stdout : null;
}

export interface TreeState {
  /** Changed and new files, whoever changed them: an editor, a script, `sed`. */
  paths: string[];
  /** Differs whenever any of those files' contents differ. */
  fingerprint: string;
}

/**
 * Sees what Cursor's edit hook can't: files changed by commands. Read-only, and nothing happens outside a git
 * repository or on a repository too big to read in time: the checks that need it are then skipped.
 */
export function readTree(root: string): TreeState | null {
  const scope = ["--", ".", ":(exclude).cursor"];
  const status = git(root, ["status", "--porcelain", "--no-renames", "-uall", "-z", ...scope]);
  if (status === null) return null;
  const paths: string[] = [];
  const hash = createHash("sha256");
  for (const entry of status.split("\0")) {
    if (entry.length < 4) continue;
    const file = entry.slice(3);
    paths.push(file);
    if (entry.startsWith("??")) {
      const stat = fs.statSync(path.join(root, file), { throwIfNoEntry: false });
      hash.update(`${file}:${stat?.size ?? 0}:${stat?.mtimeMs ?? 0}\n`);
    }
  }
  // A repository with no commit yet has no HEAD to compare: the file list still counts.
  hash.update(git(root, ["diff", "HEAD", "--no-ext-diff", "--binary", ...scope]) ?? status);
  return { paths, fingerprint: hash.digest("hex").slice(0, 16) };
}

export interface ShrunkFile {
  file: string;
  lost: number;
  had: number;
}

/** Fewer lines lost than this is ordinary editing. */
const MIN_LINES_LOST = 20;

/** Files that lost most of their lines against the last commit, in any language: work that may have been destroyed. */
export function readShrunkFiles(root: string): ShrunkFile[] {
  const numstat = git(root, ["diff", "HEAD", "--no-renames", "--numstat", "--", ".", ":(exclude).cursor"]);
  if (numstat === null) return [];
  const shrunk: ShrunkFile[] = [];
  for (const line of numstat.split("\n")) {
    const [added, deleted, file] = line.split("\t");
    // Binary files print "-" for both counts.
    const lost = Number(deleted) - Number(added);
    if (!file || !Number.isFinite(lost) || lost < MIN_LINES_LOST) continue;
    const now = fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), "utf8").split("\n").length - 1 : 0;
    const had = now + lost;
    if (lost * 2 >= had) shrunk.push({ file, lost, had });
  }
  return shrunk;
}

const KEPT_OUT = ["shell-output.jsonl", "prompts.json", "edits.jsonl"];

/** These hold what commands printed, what was edited and what the user typed: never let them reach a commit. */
async function keepOutOfGit(root: string): Promise<void> {
  const dir = getGuardianPaths(root).telemetryDir;
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, ".gitignore");
  const have = await fsp.readFile(file, "utf8").catch(() => "");
  const missing = KEPT_OUT.filter((name) => !have.split("\n").includes(name));
  if (missing.length) await fsp.appendFile(file, `${have && !have.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`).catch(() => undefined);
}

export interface FileEdit {
  ts: string;
  file: string;
  /** What was replaced by what, each side trimmed. */
  edits: Array<{ old: string; new: string }>;
}

const EDIT_SIDE_MAX = 1500;
const EDITS_PER_CALL = 8;
const KEEP_EDITS = 400;

/** What an edit changed, as Cursor's hook reports it, so the turn can be reviewed piece by piece later. */
export async function recordFileEdit(root: string, file: string, edits: unknown): Promise<void> {
  if (!file || file.startsWith(".cursor/")) return;
  await keepOutOfGit(root);
  const cut = (v: unknown): string => {
    const text = typeof v === "string" ? v : "";
    return text.length <= EDIT_SIDE_MAX ? text : `${text.slice(0, EDIT_SIDE_MAX)}\n… (${text.length - EDIT_SIDE_MAX} more characters)`;
  };
  const list = (Array.isArray(edits) ? edits : []).slice(0, EDITS_PER_CALL).map((e) => ({ old: cut((e as { old_string?: unknown })?.old_string), new: cut((e as { new_string?: unknown })?.new_string) }));
  const p = getGuardianPaths(root).edits;
  await appendLine(p, JSON.stringify({ ts: nowIso(), file, edits: list } satisfies FileEdit));
  const size = await fsp.stat(p).then((s) => s.size, () => 0);
  if (size > ROTATE_BYTES) {
    const kept = (await fsp.readFile(p, "utf8")).split("\n").filter(Boolean).slice(-KEEP_EDITS);
    await fsp.writeFile(p, `${kept.join("\n")}\n`);
  }
}

export async function readFileEdits(root: string): Promise<FileEdit[]> {
  const raw = await fsp.readFile(getGuardianPaths(root).edits, "utf8").catch(() => "");
  const out: FileEdit[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as FileEdit);
    } catch {
      // A torn last line is not evidence.
    }
  }
  return out;
}

export async function recordShellOutput(root: string, entry: { command: string; output: string; durationMs?: number }): Promise<void> {
  await keepOutOfGit(root);
  const p = getGuardianPaths(root).shellOutput;
  const output = entry.output.length <= HEAD + TAIL ? entry.output : `${entry.output.slice(0, HEAD)}\n…\n${entry.output.slice(-TAIL)}`;
  const ts = nowIso();
  const startedAt = new Date(Date.parse(ts) - Math.max(0, entry.durationMs ?? 0)).toISOString();
  const tree = readTree(root)?.fingerprint;
  await appendLine(p, JSON.stringify({ ts, startedAt, command: entry.command, output, ...(tree ? { tree } : {}) } satisfies ShellOutput));
  const size = await fsp.stat(p).then((s) => s.size, () => 0);
  if (size > ROTATE_BYTES) {
    const kept = (await fsp.readFile(p, "utf8")).split("\n").filter(Boolean).slice(-KEEP_OUTPUTS);
    await fsp.writeFile(p, `${kept.join("\n")}\n`);
  }
}

export async function recordShellFailure(root: string, command: string): Promise<void> {
  await keepOutOfGit(root);
  const ts = nowIso();
  await appendLine(getGuardianPaths(root).shellOutput, JSON.stringify({ ts, startedAt: ts, command, output: "", failed: true } satisfies ShellOutput));
}

export async function readShellOutputs(root: string): Promise<ShellOutput[]> {
  const raw = await fsp.readFile(getGuardianPaths(root).shellOutput, "utf8").catch(() => "");
  const out: ShellOutput[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as ShellOutput);
    } catch {
      // A torn last line is not evidence.
    }
  }
  return out;
}

/** Messages Guardian itself sends back are not the user speaking. */
export const GUARDIAN_MESSAGE_PREFIX = "Goal Guardian:";

export async function recordUserPrompt(root: string, prompt: string, conversationId?: string, mode?: string): Promise<void> {
  if (!prompt.trim() || prompt.startsWith(GUARDIAN_MESSAGE_PREFIX)) return;
  const dirty = readTree(root)?.paths.slice(0, MAX_DIRTY);
  await appendAudit(root, { ts: nowIso(), kind: "user.message", ...(conversationId ? { conversationId } : {}), ...(mode ? { mode } : {}), ...(dirty ? { dirty } : {}) });
  await keepOutOfGit(root);
  const prompts = await readUserPrompts(root);
  await writeJsonAtomic(getGuardianPaths(root).prompts, [...(prompts ?? []), prompt.slice(0, MAX_PROMPT)].slice(-KEEP_PROMPTS));
}

/** The user's latest messages, or null where Cursor's hooks never reported any (nothing to check against). */
export async function readUserPrompts(root: string): Promise<string[] | null> {
  try {
    const value: unknown = JSON.parse(await fsp.readFile(getGuardianPaths(root).prompts, "utf8"));
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}
