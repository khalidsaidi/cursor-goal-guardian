/**
 * A throwaway copy of the workspace: Guardian re-runs the agent's own test
 * command there itself. The copy is a `git clone --shared` (no objects copied, the
 * user's repository untouched) with the working tree as the agent left it laid
 * over it, so HEAD is the last commit and `git stash` / `git diff` work.
 *
 * Safety: commands in the copy run with credentials stripped from the
 * environment (registry tokens, GitHub/cloud keys, a bogus docker socket, an
 * empty npm user config, npm offline). It is a best effort, not a sandbox.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TestRun {
  command: string;
  /** Exit code, or "timeout". */
  exit: number | "timeout";
  /** Tail of combined output, colour codes stripped. */
  output: string;
}

export const COPY_PREFIX = "gg-review-copy-";
const MAX_FILES = 20_000;
const MAX_BYTES = 300 * 1024 * 1024;
const TEST_OUTPUT_KEEP = 4_000;
const DEP_DIRS = ["node_modules", ".venv", "venv", "vendor"];

function run(cmd: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => resolve({ ok: !err, stdout: stdout ?? "" }));
  });
}

/** Names of environment variables that look like credentials. */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH/i;

/**
 * The environment for commands in the copy: credentials dropped, registries
 * and docker pointed nowhere. `keep` names variables to keep even if they look
 * like secrets (cursor-agent's own login, for the reviewer process).
 */
export function strippedEnv(scratch: string, keep: RegExp | null = null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_NAME.test(k) && !(keep && keep.test(k))) continue;
    env[k] = v;
  }
  const npmrc = path.join(scratch, ".npmrc-empty");
  if (!fs.existsSync(npmrc)) fs.writeFileSync(npmrc, "");
  Object.assign(env, {
    npm_config_userconfig: npmrc,
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    GH_CONFIG_DIR: path.join(scratch, ".gh-empty"),
    DOCKER_HOST: "unix:///nonexistent-guardian-review",
  });
  return env;
}

/**
 * Copy the workspace into a fresh scratch dir. Null when it is not a git
 * repository, or too large to copy quickly.
 */
export async function makeReviewCopy(root: string, tmp: string = os.tmpdir()): Promise<{ dir: string; scratch: string } | null> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], root);
  if (!top.ok || path.resolve(top.stdout.trim()) !== path.resolve(root)) return null;
  const listed = await run("git", ["ls-files", "-co", "--exclude-standard", "-z"], root);
  if (!listed.ok) return null;
  const files = listed.stdout.split("\0").filter(Boolean);
  if (files.length > MAX_FILES) return null;
  const scratch = await fsp.mkdtemp(path.join(tmp, COPY_PREFIX));
  const dir = path.join(scratch, "ws");
  try {
    const cloned = await run("git", ["clone", "--quiet", "--shared", "--no-checkout", path.resolve(root), dir], scratch, 60_000);
    if (!cloned.ok) throw new Error("clone failed");
    // HEAD's tree, so files the agent deleted stay deleted and git sees the same changes.
    let bytes = 0;
    for (const rel of files) {
      // Not the project's Cursor wiring: its hooks and rules must not load into the reviewer.
      if (rel.split("/").includes(".git") || rel.startsWith(".cursor/")) continue;
      const src = path.join(root, rel);
      const st = await fsp.lstat(src).catch(() => null);
      if (!st || st.isDirectory()) continue;
      bytes += st.size;
      if (bytes > MAX_BYTES) throw new Error("too large");
      const dst = path.join(dir, rel);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      if (st.isSymbolicLink()) await fsp.symlink(await fsp.readlink(src), dst).catch(() => {});
      else await fsp.copyFile(src, dst);
    }
    await run("git", ["reset", "--quiet"], dir); // index = HEAD, working tree = the agent's
    // Dependencies are not copied: link them (read through; a test that writes caches writes the real ones).
    for (const dep of DEP_DIRS) {
      const src = path.join(root, dep);
      if (fs.existsSync(src) && !fs.existsSync(path.join(dir, dep))) await fsp.symlink(src, path.join(dir, dep), "dir").catch(() => {});
    }
    // The links are not the agent's change: keep them out of `git status`, `git stash -u` and `git clean`.
    await fsp.mkdir(path.join(dir, ".git", "info"), { recursive: true }).catch(() => {});
    await fsp.appendFile(path.join(dir, ".git", "info", "exclude"), DEP_DIRS.map((d) => `/${d}\n`).join("")).catch(() => {});
    return { dir, scratch };
  } catch {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

/** Commands that read or search; a "test" in their arguments is a file name, not a test run. */
const NOT_A_RUNNER = /^(?:cat|less|more|head|tail|grep|egrep|rg|ag|ack|sed|awk|ls|dir|find|fd|tree|wc|git|echo|printf|diff|cmp|code|cursor|vim?|nano|emacs|open|touch|mkdir|rm|mv|cp|chmod|stat|file|type|which|where|man|jq|yq|bat|sort|uniq|xargs|tee|realpath|basename|dirname|wget|curl|kill|sleep|export|set|source|\.)$/i;
const TEST_WORD = /test|spec|check/i;
/** What test runners print, whatever the language: "12 passed", "3 failing", "Tests run: 40", "ok 7 -", "# pass 12". */
const TEST_REPORT = /\b\d+\s+(?:tests?|passed|passing|failed|failing|pass|fail)\b|\btests? run:\s*\d+|^ok \d+\b|^# (?:pass|fail)\s+\d+/im;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Split a shell command on `&&`, `||`, `;`, `|` and newlines outside quotes. */
function shellSteps(command: string): string[] {
  const steps: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        cur += ch + (command[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      steps.push(cur, two);
      cur = "";
      i += 1;
    } else if (ch === ";" || ch === "\n") {
      steps.push(cur, ";");
      cur = "";
    } else if (ch === "|") {
      steps.push(cur, "|");
      cur = "";
    } else cur += ch;
  }
  steps.push(cur);
  return steps.map((x) => x.trim()).filter(Boolean);
}

/**
 * The tests to re-run: the configured command, else the last test run the agent itself made in
 * this conversation — whatever the language or tool (`mvn test`, `pytest -q`, `./gradlew check`,
 * `npx ava`). A step counts when its name says test/spec/check, or what it printed reads like a
 * test report. Guardian guesses no toolchain: if the agent never ran tests, nothing is re-run.
 * Only the test step is kept, with any `cd` into the workspace before it: piping it into `tail`
 * would hide its exit code, and a step that works outside the workspace (`/tmp`, other folders,
 * heredocs) tests nothing in it. Paths into the workspace are pointed at the copy.
 */
export function testCommandFromTape(runs: Array<string | { command: string; output?: string }>, root: string, copyDir: string, configured?: string): string | null {
  if (configured) return configured;
  const rootAbs = path.resolve(root);
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i]!;
    const command = typeof run === "string" ? run : run.command;
    const printed = typeof run === "string" ? "" : (run.output ?? "");
    if (command.includes("<<")) continue;
    const picked = pickTestStep(shellSteps(command), TEST_REPORT.test(printed), rootAbs);
    if (picked) return picked.split(rootAbs).join(copyDir);
  }
  return null;
}

const SEPARATORS = new Set(["&&", "||", ";", "|"]);

/** In one command's steps: the last one named like a test, else (when it printed a test report) the last plain runner. */
function pickTestStep(tokens: string[], printedReport: boolean, rootAbs: string): string | null {
  const candidates: Array<{ j: number; step: string; named: boolean }> = [];
  tokens.forEach((tok, j) => {
    if (SEPARATORS.has(tok) || tokens[j - 1] === "|") return; // separators, and what output is piped into
    // Drop subshell parens and redirections to files (`> /tmp/x.log`); `2>&1` stays.
    const step = tok.replace(/^\(+|\)+$/g, "").replace(/\s\d?>>?\s*(?!&)\S+/g, "").trim();
    const words = step.split(/\s+/).filter((w) => !ENV_ASSIGN.test(w));
    const first = (words[0] ?? "").replace(/^["']|["']$/g, "");
    if (!first || first === "cd" || first.includes("$") || NOT_A_RUNNER.test(path.basename(first))) return;
    if (/\/tmp\b|mktemp|\$TMPDIR/.test(step)) return; // works outside the workspace
    // Inline code (`node -e "…"`, `python -c`) is a one-off probe, not the project's tests.
    if (words.some((w) => w === "-e" || w === "-c" || w === "--eval" || w === "-p")) return;
    const unquoted = step.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, " ");
    const named = unquoted.split(/\s+/).some((w) => TEST_WORD.test(w));
    if (named || printedReport) candidates.push({ j, step, named });
  });
  const best = [...candidates].reverse().find((c) => c.named) ?? candidates[candidates.length - 1];
  if (!best) return null;
  // Every `cd` before it must stay in the workspace: relative, or under the root.
  const cds: string[] = [];
  for (const t of tokens.slice(0, best.j)) {
    const m = /^\(*cd\s+(.+?)\)*$/.exec(t);
    if (!m) continue;
    const target = m[1]!.trim().replace(/^["']|["']$/g, "");
    if (target.includes("$") || target.startsWith("~") || target === "-") return null;
    if (path.isAbsolute(target)) {
      const rel = path.relative(rootAbs, path.resolve(target));
      if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
      cds.length = 0;
      if (rel) cds.push(`cd ${JSON.stringify(rel)}`);
    } else cds.push(`cd ${m[1]!.trim()}`);
  }
  return [...cds, best.step].join(" && ");
}

/** Run the project's tests in the copy. Never throws. */
export function runProjectTests(dir: string, scratch: string, command: string, timeoutMs: number): Promise<TestRun> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const child = spawn(command, { cwd: dir, shell: true, env: { ...strippedEnv(scratch), CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const keep = (c: Buffer): void => {
      out = (out + c.toString("utf8")).slice(-TEST_OUTPUT_KEEP * 4);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const finish = (exit: number | "timeout"): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ command, exit, output: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").slice(-TEST_OUTPUT_KEEP) });
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish("timeout");
    }, timeoutMs);
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}

/**
 * The same tests with the turn's changes set aside (`git stash -u` in the copy, restored after):
 * tells "this turn broke them" from "they were already failing". Null when git cannot stash
 * (no commit yet, nothing to stash) or cannot restore — then the copy is no longer the agent's
 * working tree and must not be handed to the reviewer.
 */
export async function runTestsWithoutChanges(
  dir: string,
  scratch: string,
  command: string,
  timeoutMs: number,
): Promise<{ run: TestRun | null; restored: boolean }> {
  const stashed = await run("git", ["stash", "push", "--include-untracked", "--quiet"], dir);
  if (!stashed.ok) return { run: null, restored: true };
  const listed = await run("git", ["stash", "list"], dir);
  if (!listed.stdout.trim()) return { run: null, restored: true }; // nothing was stashed: the tree already is HEAD
  const baseline = await runProjectTests(dir, scratch, command, timeoutMs);
  // Test runs leave caches and snapshots behind; clear them so the turn's changes come back cleanly.
  await run("git", ["checkout", "--quiet", "--", "."], dir);
  await run("git", ["clean", "-fdq"], dir);
  const popped = await run("git", ["stash", "pop", "--quiet"], dir);
  return { run: baseline, restored: popped.ok };
}

/**
 * Facts about the workspace a reader would otherwise have to guess, measured by code: which
 * Node versions exist, whether dependencies are installed, what the package scripts do. Agents often
 * blame a failure on the environment ("no node_modules", "needs Node 22", "pretest did not run");
 * these let the reviewer check that against reality. Never throws.
 */
export async function environmentFacts(dir: string): Promise<string[]> {
  const facts: string[] = [];
  const v = await run("node", ["--version"], dir, 5_000);
  if (v.ok) facts.push(`node on PATH: ${v.stdout.trim()}`);
  for (const p of ["/usr/bin/node", "/usr/local/bin/node"]) {
    if (!fs.existsSync(p)) continue;
    const pv = await run(p, ["--version"], dir, 5_000);
    if (pv.ok && pv.stdout.trim() !== v.stdout.trim()) facts.push(`also installed: ${p} ${pv.stdout.trim()}`);
  }
  const nm = path.join(dir, "node_modules");
  if (fs.existsSync(nm)) {
    const n = (await fsp.readdir(nm).catch(() => [] as string[])).filter((x) => !x.startsWith(".")).length;
    facts.push(`node_modules: present (${n} top-level entries)`);
  } else if (fs.existsSync(path.join(dir, "package.json"))) facts.push("node_modules: absent");
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string>; engines?: Record<string, string>; type?: string };
    for (const [k, s] of Object.entries(pkg.scripts ?? {}).slice(0, 12)) facts.push(`package.json script ${k}: ${s.slice(0, 160)}`);
    if (pkg.engines) facts.push(`package.json engines: ${JSON.stringify(pkg.engines)}`);
    if (pkg.type) facts.push(`package.json type: ${pkg.type}`);
  } catch {
    // not a node project
  }
  const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "Cargo.lock", "go.sum", "poetry.lock"].filter((f) => fs.existsSync(path.join(dir, f)));
  if (lock.length) facts.push(`lockfiles: ${lock.join(", ")}`);
  return facts;
}
