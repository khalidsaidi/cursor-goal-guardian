/**
 * One adversarial review when the agent says the goal is done and Guardian's own record agrees. A separate agent,
 * on the user's own Cursor login and default model, works in a throwaway copy of the project and tries to prove
 * each "done when" item isn't really done, and lists work no item needs. It can't block anything: when it can't
 * run, it is skipped and recorded as skipped.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Contract } from "../schema/contract.js";

export interface ReviewFailure {
  id: string;
  evidence: string;
}
export interface ReviewExtra {
  file: string;
  what: string;
}
export interface ReviewOutcome {
  ran: boolean;
  /** Why it didn't run, or why its answer couldn't be used. */
  reason?: string;
  fails: ReviewFailure[];
  extra: ReviewExtra[];
  seconds: number;
}

/** How long a review may take before Guardian gives up on it. */
export const REVIEW_BUDGET_MS = 90_000;
/** Reviews per run on a goal; after that the record alone decides and objections go to the user. */
export const MAX_REVIEWS = 2;

const MAX_ITEMS = 8;
const TEXT_MAX = 300;
const COPY_PREFIX = "gg-review-";
const MAX_FILES = 20_000;
const MAX_BYTES = 300 * 1024 * 1024;
const DEP_DIRS = ["node_modules", ".venv", "venv", "vendor"];
/** Names of environment variables that look like credentials. */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH/i;

/** The reviewer's instructions. `{goal}` and `{items}` are filled in. */
export const REVIEW_PROMPT = `You check an AI coding agent's claim that a goal is done. The user's goal:
{goal}
Done when:
{items}

This folder is a throwaway copy of the project as the agent left it. See the recent work with \`git status\`, \`git diff HEAD\` and \`git log\`.

Be an adversary. For each item, try to prove it is NOT really done: stubs, comments or text standing in for code, tests that assert nothing or don't exercise the change, output printed rather than produced, behaviour that breaks on ordinary inputs. Run the project's tests and small checks of your own. Then list every change that no item needs: extra work the user didn't ask for. Documenting the new work is not extra.

Stay in this folder. Don't install, publish, push or use the network.
Answer with JSON only, no prose: {"items":[{"id":"sc_1","verdict":"holds or fails","evidence":"one line"}],"extra":[{"file":"path","what":"one line"}]}`;

export function reviewPrompt(contract: Pick<Contract, "goal" | "successCriteria">): string {
  const override = process.env.GOAL_GUARDIAN_REVIEW_PROMPT;
  const template = override ? fs.readFileSync(override, "utf8") : REVIEW_PROMPT;
  const items = contract.successCriteria.length ? contract.successCriteria.map((c) => `- ${c.id}: ${c.text}`).join("\n") : "- goal: the goal as stated";
  return template.replace("{goal}", contract.goal).replace("{items}", items);
}

/** The first balanced JSON object in the text holding an array under `key`. Models add prose and fences around it. */
export function firstObjectWith(text: string, key: string): Record<string, unknown> | null {
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
            if (v && Array.isArray(v[key])) return v;
          } catch {
            // not JSON from here: try the next "{"
          }
          break;
        }
      }
    }
  }
  return null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, TEXT_MAX) : "");

/** The reviewer's answer, from the agent's JSON envelope or raw text. Null when there is nothing usable. */
export function parseReview(stdout: string): { fails: ReviewFailure[]; extra: ReviewExtra[] } | null {
  let text = stdout;
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const envelope = JSON.parse(line) as { result?: unknown; is_error?: unknown };
      if (envelope.is_error === true) return null;
      if (typeof envelope.result === "string") {
        text = envelope.result;
        break;
      }
    } catch {
      // not the envelope line
    }
  }
  const answer = firstObjectWith(text, "items");
  if (!answer) return null;
  const fails = (answer.items as unknown[])
    .map((e) => e as Record<string, unknown>)
    .filter((e) => /fail/i.test(str(e?.verdict)))
    .map((e) => ({ id: str(e.id) || "goal", evidence: str(e.evidence) }))
    .slice(0, MAX_ITEMS);
  const extra = (Array.isArray(answer.extra) ? answer.extra : [])
    .map((e) => e as Record<string, unknown>)
    .map((e) => ({ file: str(e?.file), what: str(e?.what) }))
    .filter((e) => e.file || e.what)
    .slice(0, MAX_ITEMS);
  return { fails, extra };
}

function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The headless Cursor agent: an explicit path, else PATH, else where its installer puts it. */
export function resolveReviewer(): string | null {
  const configured = process.env.GOAL_GUARDIAN_REVIEWER;
  if (configured) return isExecutable(configured) ? configured : null;
  const names = process.platform === "win32" ? ["cursor-agent.cmd", "cursor-agent.exe", "cursor-agent"] : ["cursor-agent"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of dir ? names : []) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  // Hooks launched by the editor often get a PATH without ~/.local/bin.
  const fallback = path.join(os.homedir(), ".local", "bin", "cursor-agent");
  return isExecutable(fallback) ? fallback : null;
}

function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout: stdout ?? "" }));
  });
}

/**
 * A copy of the project as the agent left it: a shared clone (nothing copied from the repository's history) with
 * the working tree laid over it, so `git diff` shows the same changes. Guardian's own files and the project's Cursor
 * wiring stay behind, so no hooks or rules load into the reviewer. Null outside git or when the project is too big.
 */
export async function makeReviewCopy(root: string): Promise<{ dir: string; scratch: string } | null> {
  const top = await git(["rev-parse", "--show-toplevel"], root);
  if (!top.ok || path.resolve(top.stdout.trim()) !== path.resolve(root)) return null;
  const listed = await git(["ls-files", "-co", "--exclude-standard", "-z"], root);
  const files = listed.stdout.split("\0").filter(Boolean);
  if (!listed.ok || files.length > MAX_FILES) return null;
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), COPY_PREFIX));
  const dir = path.join(scratch, "ws");
  try {
    if (!(await git(["clone", "--quiet", "--shared", "--no-checkout", path.resolve(root), dir], scratch)).ok) throw new Error("clone failed");
    let bytes = 0;
    for (const rel of files) {
      if (rel.startsWith(".cursor/")) continue;
      const src = path.join(root, rel);
      const st = await fsp.lstat(src).catch(() => null);
      if (!st || st.isDirectory()) continue;
      bytes += st.size;
      if (bytes > MAX_BYTES) throw new Error("too large");
      const dst = path.join(dir, rel);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      if (st.isSymbolicLink()) await fsp.symlink(await fsp.readlink(src), dst).catch(() => undefined);
      else await fsp.copyFile(src, dst);
    }
    await git(["reset", "--quiet"], dir);
    // Installed dependencies are linked, not copied, and kept out of the reviewer's `git status`.
    for (const dep of DEP_DIRS) {
      const src = path.join(root, dep);
      if (fs.existsSync(src) && !fs.existsSync(path.join(dir, dep))) await fsp.symlink(fs.realpathSync(src), path.join(dir, dep), "dir").catch(() => undefined);
    }
    await fsp.appendFile(path.join(dir, ".git", "info", "exclude"), DEP_DIRS.map((d) => `/${d}\n`).join("")).catch(() => undefined);
    return { dir, scratch };
  } catch {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
}

/** The reviewer's environment: credentials out except Cursor's own login, registries and docker pointed nowhere. */
function reviewerEnv(scratch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_NAME.test(k) && !/^CURSOR/i.test(k)) continue;
    env[k] = v;
  }
  const npmrc = path.join(scratch, ".npmrc-empty");
  fs.writeFileSync(npmrc, "");
  return { ...env, npm_config_userconfig: npmrc, npm_config_offline: "true", GH_CONFIG_DIR: path.join(scratch, ".gh-empty"), DOCKER_HOST: "unix:///nonexistent-guardian-review", GOAL_GUARDIAN_REVIEWING: "1" };
}

function runAgent(command: string, prompt: string, dir: string, scratch: string, budgetMs: number): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const done = (v: { ok: true; stdout: string } | { ok: false; reason: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn(command, ["-p", prompt, "--output-format", "json", "--force", "--trust", "--workspace", dir], {
      cwd: dir,
      env: reviewerEnv(scratch),
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32" && /\.cmd$/i.test(command),
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, reason: `the reviewer took longer than ${Math.round(budgetMs / 1000)}s` });
    }, budgetMs);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.on("error", (err) => done({ ok: false, reason: `the reviewer couldn't start: ${err.message}` }));
    child.on("close", (code) => done(code === 0 ? { ok: true, stdout } : { ok: false, reason: `the reviewer exited with ${code}` }));
  });
}

/** Run one review of the project against the goal. Never throws. */
export async function runReview(root: string, contract: Pick<Contract, "goal" | "successCriteria">, budgetMs = REVIEW_BUDGET_MS): Promise<ReviewOutcome> {
  const started = Date.now();
  const seconds = (): number => Math.round((Date.now() - started) / 1000);
  const skipped = (reason: string): ReviewOutcome => ({ ran: false, reason, fails: [], extra: [], seconds: seconds() });
  // A review's own agent must never review itself.
  if (process.env.GOAL_GUARDIAN_REVIEWING) return skipped("already inside a review");
  const command = resolveReviewer();
  if (!command) return skipped("cursor-agent isn't installed");
  let prompt: string;
  try {
    prompt = reviewPrompt(contract);
  } catch {
    return skipped("the review prompt couldn't be read");
  }
  const copy = await makeReviewCopy(root);
  if (!copy) return skipped("the project isn't a git repository Guardian can copy");
  try {
    const run = await runAgent(command, prompt, copy.dir, copy.scratch, budgetMs);
    if (!run.ok) return skipped(run.reason);
    const parsed = parseReview(run.stdout);
    if (!parsed) return skipped("the reviewer's answer couldn't be read");
    return { ran: true, ...parsed, seconds: seconds() };
  } finally {
    await fsp.rm(copy.scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** One line per objection, as the agent and the panel see them. */
export function reviewLines(outcome: Pick<ReviewOutcome, "fails" | "extra">): string[] {
  return [
    ...outcome.fails.map((f) => `Reviewer: ${f.id} isn't done: ${f.evidence}`),
    ...outcome.extra.map((e) => `Reviewer: ${e.file || "a change"} isn't needed by any item: ${e.what}`),
  ];
}
