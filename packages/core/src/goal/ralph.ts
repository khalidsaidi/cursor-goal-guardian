/**
 * Anthropic's Ralph Loop, run beside DeepSeek's goal service and Codex's goal extension. The plugin is vendored
 * unmodified in third_party/claude-plugins-official/plugins/ralph-loop (Apache-2.0), and what runs here is its own
 * scripts: `scripts/setup-ralph-loop.sh` starts a loop, `hooks/stop-hook.sh` decides at each stop whether to feed
 * the task back or let the agent go (its completion promise was seen, or its iterations ran out), and cancelling is
 * the steps of its `commands/cancel-ralph.md`.
 *
 * This file is the adapter, and it is Guardian's. Ralph is written for Claude Code, so it needs three things given
 * to it in Cursor:
 * - a folder to keep its state file in. Its scripts write `.claude/ralph-loop.local.md` under the current
 *   directory; Guardian runs them inside `.cursor/goal-guardian/ralph/`, so the project's own `.claude` is untouched;
 * - the stop-hook input it reads (`session_id`, `transcript_path`);
 * - the agent's last message. Ralph reads it from Claude Code's transcript file. Cursor's stop hook carries neither
 *   a transcript nor the message, but its `afterAgentResponse` hook carries the response text, so Guardian records
 *   that and writes Ralph a one-line transcript in the shape its script reads. This is the one adaptation.
 *
 * Nothing here blocks or throws. Ralph needs bash, jq and perl; where one is missing, or the plugin isn't installed,
 * every call answers `ran: false` and the goal loop goes on without it.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getGuardianPaths } from "../paths.js";

/** The phrase Guardian gives Ralph as its completion promise. Ralph's own text tells the agent how to output it. */
export const RALPH_PROMISE = "GOAL COMPLETE";

const STATE_FILE = path.join(".claude", "ralph-loop.local.md");
const TIMEOUT_MS = 10_000;
const NEEDS = ["bash", "jq", "perl"];

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The plugin's folder: an explicit path (tests and the rig), else inside the installed extension beside Guardian's
 * own binaries. Null when it isn't there.
 */
export function resolveRalph(): string | null {
  const configured = process.env.GOAL_GUARDIAN_RALPH;
  const dir = configured !== undefined ? configured : path.join(path.dirname(process.execPath), "..", "ralph-loop");
  return dir && isFile(path.join(dir, "hooks", "stop-hook.sh")) && isFile(path.join(dir, "scripts", "setup-ralph-loop.sh")) ? dir : null;
}

let toolsChecked: string | null | undefined;
/** The first program Ralph's scripts need that this machine lacks, or null when all are there. */
function missingTool(): string | null {
  if (toolsChecked !== undefined) return toolsChecked;
  toolsChecked = NEEDS.find((t) => spawnSync(t, ["--version"], { stdio: "ignore", timeout: 5000, windowsHide: true }).status !== 0) ?? null;
  return toolsChecked;
}

/** Why Ralph can't run here, or null when it can. */
export function ralphUnavailable(): string | null {
  if (process.platform === "win32") return "Ralph Loop's scripts are bash: not run on Windows yet";
  if (!resolveRalph()) return "Ralph Loop isn't installed";
  const missing = missingTool();
  return missing ? `Ralph Loop needs ${missing}, which isn't installed` : null;
}

/** Where Ralph's scripts run and keep their state for this workspace. */
export function ralphHome(root: string): string {
  return path.join(getGuardianPaths(root).dir, "ralph");
}

const statePath = (root: string): string => path.join(ralphHome(root), STATE_FILE);

/** A Ralph loop is running for this workspace: its state file is there. */
export function ralphActive(root: string): boolean {
  return isFile(statePath(root));
}

/** Ralph's own count of where its loop is, from its state file. */
export function ralphIteration(root: string): number | null {
  try {
    const m = /^iteration:\s*(\d+)\s*$/m.exec(fs.readFileSync(statePath(root), "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(root: string, script: string, args: string[], input: string, env: NodeJS.ProcessEnv): Promise<Ran | null> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const done = (v: Ran | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn("bash", [script, ...args], { cwd: ralphHome(root), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", () => done(null));
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

async function prepareHome(root: string): Promise<void> {
  const home = ralphHome(root);
  await fsp.mkdir(home, { recursive: true });
  // Ralph's state holds the goal's words and the transcript the agent's last message: never let them reach a commit.
  await fsp.writeFile(path.join(home, ".gitignore"), "*\n", { flag: "wx" }).catch(() => undefined);
}

export interface RalphStart {
  ran: boolean;
  reason?: string;
  /** Everything Ralph's setup script printed: its own words to the agent about the loop and the promise. */
  said: string;
}

/**
 * Start a Ralph loop on a task with Ralph's own setup script, replacing any loop already running here.
 * `sessionId` is the chat the loop belongs to: Ralph ignores stops from any other.
 */
export async function ralphStart(root: string, task: string, opts: { maxIterations: number; sessionId?: string; promise?: string }): Promise<RalphStart> {
  const why = ralphUnavailable();
  if (why) return { ran: false, reason: why, said: "" };
  if (!task.trim()) return { ran: false, reason: "no task to loop on", said: "" };
  await prepareHome(root);
  const script = path.join(resolveRalph()!, "scripts", "setup-ralph-loop.sh");
  const args = [task, "--max-iterations", String(Math.max(0, Math.trunc(opts.maxIterations))), "--completion-promise", opts.promise ?? RALPH_PROMISE];
  const out = await run(root, script, args, "", { ...process.env, CLAUDE_CODE_SESSION_ID: opts.sessionId ?? "" });
  if (!out) return { ran: false, reason: "Ralph's setup script couldn't run", said: "" };
  if (out.code !== 0 || !ralphActive(root)) return { ran: false, reason: `Ralph's setup script refused: ${(out.stderr || out.stdout).trim().slice(0, 300)}`, said: "" };
  await fsp.writeFile(path.join(ralphHome(root), "setup-output.txt"), out.stdout).catch(() => undefined);
  return { ran: true, said: out.stdout };
}

/** What Ralph's setup script told the agent when the running loop started, or "" when none is running. */
export function ralphSaidAtStart(root: string): string {
  if (!ralphActive(root)) return "";
  try {
    return fs.readFileSync(path.join(ralphHome(root), "setup-output.txt"), "utf8");
  } catch {
    return "";
  }
}

/**
 * Ralph's own instruction about its completion promise: the block its setup script prints between its two rules,
 * word for word. "" when the script printed none.
 */
export function ralphPromiseInstruction(said: string): string {
  const at = said.indexOf("CRITICAL - Ralph Loop Completion Promise");
  if (at < 0) return "";
  const from = said.lastIndexOf("\n", said.lastIndexOf("═", at)) + 1;
  return said.slice(from).trim();
}

export type RalphDecision =
  | { ran: false; reason: string }
  /** No loop was running: Ralph has nothing to say about this stop. */
  | { ran: true; outcome: "inactive" }
  /** Ralph feeds the task back: its prompt and its one-line system message. */
  | { ran: true; outcome: "continue"; prompt: string; systemMessage: string; iteration: number | null }
  /** Ralph saw its completion promise in the agent's last message and ended its loop. */
  | { ran: true; outcome: "promise"; said: string }
  /** Ralph's iterations ran out and it ended its loop. */
  | { ran: true; outcome: "max"; said: string }
  /** Ralph ended its loop for a reason of its own (a state file it couldn't read, a stop from another chat...). */
  | { ran: true; outcome: "ended"; said: string };

/**
 * One stop through Ralph's own stop hook. `lastMessage` is the agent's last message as Cursor reported it; Guardian
 * writes it into a transcript line of the shape Ralph's script reads, and passes the path as Claude Code would.
 */
export async function ralphStop(root: string, stop: { sessionId: string; lastMessage: string }): Promise<RalphDecision> {
  const why = ralphUnavailable();
  if (why) return { ran: false, reason: why };
  if (!ralphActive(root)) return { ran: true, outcome: "inactive" };
  await prepareHome(root);
  const transcript = path.join(ralphHome(root), "transcript.jsonl");
  // One assistant message, as a Claude Code transcript line: role, then message.content[] text blocks.
  await fsp.writeFile(transcript, `${JSON.stringify({ role: "assistant", message: { role: "assistant", content: [{ type: "text", text: stop.lastMessage }] } })}\n`);
  const script = path.join(resolveRalph()!, "hooks", "stop-hook.sh");
  const out = await run(root, script, [], JSON.stringify({ session_id: stop.sessionId, transcript_path: transcript, hook_event_name: "Stop" }), { ...process.env });
  if (!out) return { ran: false, reason: "Ralph's stop hook couldn't run" };
  const said = `${out.stdout}${out.stderr}`.trim();
  if (ralphActive(root)) {
    // The loop goes on: its hook printed Claude Code's "block" decision with the task as the reason.
    try {
      const decision = JSON.parse(out.stdout.trim()) as { decision?: unknown; reason?: unknown; systemMessage?: unknown };
      if (decision.decision === "block" && typeof decision.reason === "string") {
        return { ran: true, outcome: "continue", prompt: decision.reason, systemMessage: typeof decision.systemMessage === "string" ? decision.systemMessage : "", iteration: ralphIteration(root) };
      }
    } catch {
      // not a decision
    }
    // Still running and no decision: the stop came from another chat, which Ralph leaves alone.
    return { ran: true, outcome: "inactive" };
  }
  if (/Detected <promise>/.test(out.stdout)) return { ran: true, outcome: "promise", said };
  if (/Max iterations \(\d+\) reached/.test(out.stdout)) return { ran: true, outcome: "max", said };
  return { ran: true, outcome: "ended", said };
}

/**
 * Cancel the loop, by the steps of Ralph's own cancel command: if its state file is there, read the iteration and
 * remove the file. Returns the iteration it was at, or null when no loop was running.
 */
export async function ralphCancel(root: string): Promise<number | null> {
  if (!ralphActive(root)) return null;
  const at = ralphIteration(root);
  await fsp.rm(statePath(root), { force: true }).catch(() => undefined);
  return at ?? 0;
}
