/**
 * Replayable cases: what one review looked at, saved so the same review can be run again later with a different
 * prompt. A case is the goal, the commit the work sits on, the work as a binary patch plus new files, the prompt used
 * and the verdict. Nothing here knows any language: it is git and files.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getGuardianPaths } from "../paths.js";
import type { Contract } from "../schema/contract.js";
import { DEP_DIRS, type ReviewExtra, type ReviewFailure } from "./review.js";

/** A case bigger than this isn't saved: replays are for ordinary goals, not whole-repo rewrites. */
export const MAX_CASE_BYTES = 2 * 1024 * 1024;
/** Only the newest cases are kept. */
export const MAX_CASES = 200;

export interface ReviewCase {
  id: string;
  ts: string;
  goal: string;
  items: Array<{ id: string; text: string }>;
  /** The commit the work sits on. */
  base: string;
  prompt: string;
  flagged: boolean;
  fails: ReviewFailure[];
  extra: ReviewExtra[];
}

interface UntrackedFile {
  path: string;
  b64: string;
}

export function casesDir(root: string): string {
  return path.join(getGuardianPaths(root).dir, "cases");
}

function run(args: string[], cwd: string, input?: string): Promise<{ ok: boolean; stdout: Buffer }> {
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, encoding: "buffer", windowsHide: true }, (err, stdout) =>
      resolve({ ok: !err, stdout: (stdout as Buffer) ?? Buffer.alloc(0) }),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

const OUTSIDE_GUARDIAN = ["--", ".", ":(exclude).cursor"];

/**
 * Save what a review saw. Returns why it wasn't saved, or null when it was. Cases live next to the telemetry and
 * never reach a commit.
 */
export async function saveCase(
  root: string,
  id: string,
  contract: Pick<Contract, "goal" | "successCriteria">,
  review: { prompt: string; fails: ReviewFailure[]; extra: ReviewExtra[] },
  ts: string,
  maxBytes = MAX_CASE_BYTES,
): Promise<string | null> {
  const head = await run(["rev-parse", "--verify", "HEAD"], root);
  if (!head.ok) return "the project has no commit to replay the work on";
  const patch = await run(["diff", "HEAD", "--binary", ...OUTSIDE_GUARDIAN], root);
  if (!patch.ok) return "git couldn't describe the work";
  const listed = await run(["ls-files", "-o", "--exclude-standard", "-z", ...OUTSIDE_GUARDIAN], root);
  const untracked: UntrackedFile[] = [];
  let bytes = patch.stdout.length;
  for (const rel of listed.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const st = await fsp.lstat(path.join(root, rel)).catch(() => null);
    if (!st?.isFile()) continue;
    bytes += st.size;
    if (bytes > maxBytes) break;
    untracked.push({ path: rel, b64: (await fsp.readFile(path.join(root, rel))).toString("base64") });
  }
  if (bytes > maxBytes) return `the work is over ${Math.round(maxBytes / 1024 / 1024)} MB`;
  const dir = path.join(casesDir(root), id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(casesDir(root), ".gitignore"), "*\n").catch(() => undefined);
  const record: ReviewCase = {
    id,
    ts,
    goal: contract.goal,
    items: contract.successCriteria.map((c) => ({ id: c.id, text: c.text })),
    base: head.stdout.toString("utf8").trim(),
    prompt: review.prompt,
    flagged: review.fails.length + review.extra.length > 0,
    fails: review.fails,
    extra: review.extra,
  };
  await fsp.writeFile(path.join(dir, "work.patch"), patch.stdout);
  await fsp.writeFile(path.join(dir, "untracked.json"), JSON.stringify(untracked));
  await fsp.writeFile(path.join(dir, "case.json"), JSON.stringify(record, null, 1));
  await pruneCases(root);
  return null;
}

async function pruneCases(root: string, keep = MAX_CASES): Promise<void> {
  const all = await loadCases(root);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) await fsp.rm(path.join(casesDir(root), old.id), { recursive: true, force: true });
}

/** Saved cases, oldest first. */
export async function loadCases(root: string): Promise<ReviewCase[]> {
  const names = await fsp.readdir(casesDir(root)).catch(() => [] as string[]);
  const out: ReviewCase[] = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(casesDir(root), name, "case.json"), "utf8")) as ReviewCase);
    } catch {
      // not a case
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** The work as a diff, trimmed, for a reader that needs the gist rather than every byte. */
export async function casePatchText(root: string, id: string, max = 2000): Promise<string> {
  const text = await fsp.readFile(path.join(casesDir(root), id, "work.patch"), "utf8").catch(() => "");
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/**
 * The project as the review saw it, rebuilt in a throwaway folder: a shared clone at the base commit with the work
 * applied. Null when the base commit is gone or the work no longer applies.
 */
export async function materializeCase(root: string, c: ReviewCase): Promise<{ dir: string; scratch: string } | null> {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "gg-replay-"));
  const dir = path.join(scratch, "ws");
  const fail = async (): Promise<null> => {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    return null;
  };
  if (!(await run(["clone", "--quiet", "--shared", "--no-checkout", path.resolve(root), dir], scratch)).ok) return fail();
  if (!(await run(["checkout", "--quiet", "--detach", c.base], dir)).ok) return fail();
  const patchFile = path.join(casesDir(root), c.id, "work.patch");
  if ((await fsp.stat(patchFile).catch(() => null))?.size) {
    if (!(await run(["apply", "--binary", "--whitespace=nowarn", patchFile], dir)).ok) return fail();
  }
  try {
    const untracked = JSON.parse(await fsp.readFile(path.join(casesDir(root), c.id, "untracked.json"), "utf8")) as UntrackedFile[];
    for (const f of untracked) {
      const dst = path.join(dir, f.path);
      if (!path.resolve(dst).startsWith(path.resolve(dir) + path.sep)) continue;
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.writeFile(dst, Buffer.from(f.b64, "base64"));
    }
  } catch {
    return fail();
  }
  // Installed dependencies are linked from the project, as for a live review.
  for (const dep of DEP_DIRS) {
    const src = path.join(root, dep);
    if (fs.existsSync(src) && !fs.existsSync(path.join(dir, dep))) await fsp.symlink(fs.realpathSync(src), path.join(dir, dep), "dir").catch(() => undefined);
  }
  await fsp.appendFile(path.join(dir, ".git", "info", "exclude"), DEP_DIRS.map((d) => `/${d}\n`).join("")).catch(() => undefined);
  return { dir, scratch };
}
