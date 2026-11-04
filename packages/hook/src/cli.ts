/**
 * Goal Guardian Cursor hook (stdio JSON in/out). Contract: this process NEVER
 * blocks and NEVER breaks the editor — every path, including crashes and
 * malformed input, ends in permission:"allow" and exit code 0.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  advisoryAllow,
  lastAssistantTextFromTranscript,
  readConfigSafe,
  readLastResponse,
  recordShellOutput,
  runDoneCheck,
  runPipeline,
  storeLastResponse,
  type HookResponse,
} from "@goal-guardian/core";

/** stop/afterAgentResponse/afterShellExecution answer in their own shapes, not the permission shape. */
type HookOutput = HookResponse | { followup_message?: string };

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function eventName(payload: Record<string, unknown>): string {
  for (const key of ["hook_event_name", "hookEventName", "event", "name"]) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** True when this directory is a Guardian workspace. */
function isGuardianWorkspace(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".cursor", "goal-guardian"));
  } catch {
    return false;
  }
}

/**
 * Resolve the workspace this event belongs to. Native-Windows Cursor sends
 * hook payloads with NO workspace_roots and a cwd outside the workspace —
 * only file_path identifies where the work is happening. Ladder:
 * 1. workspace_roots (WSL/remote sends it)
 * 2. ascend from file_path until a Guardian workspace appears
 * 3. cwd, if it is a Guardian workspace
 * Unresolvable returns "" and the caller answers a bare allow — never a
 * guessed directory, never a tape written into the wrong place.
 */
function workspaceRoot(payload: Record<string, unknown>): string {
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) return roots[0];

  const filePath = typeof payload.file_path === "string" ? payload.file_path : "";
  if (filePath && path.isAbsolute(filePath)) {
    let dir = path.dirname(filePath);
    for (let i = 0; i < 32; i += 1) {
      if (isGuardianWorkspace(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const cwd = process.cwd();
  if (isGuardianWorkspace(cwd)) return cwd;
  return "";
}

function relativePath(root: string, value: string): string {
  const asPosix = (p: string): string => p.split(path.sep).join("/");
  if (!value) return "";
  if (path.isAbsolute(value)) return asPosix(path.relative(root, value));
  return asPosix(value).replace(/^\.\//, "");
}

async function handle(payload: Record<string, unknown>): Promise<HookOutput> {
  const event = eventName(payload);
  const root = workspaceRoot(payload);
  if (!root) return event === "stop" || event === "afterAgentResponse" || event === "afterShellExecution" ? {} : advisoryAllow();

  switch (event) {
    case "beforeShellExecution":
      return runPipeline(root, "beforeShellExecution", "shell", String(payload.command ?? ""), ids(payload));
    case "beforeMCPExecution": {
      // Cursor sends the server as mcp_server_name; older builds used server.
      const serverName = String(payload.mcp_server_name ?? payload.server ?? "");
      const value = `${serverName}/${String(payload.tool_name ?? "")}`;
      return runPipeline(root, "beforeMCPExecution", "mcp", value, ids(payload));
    }
    case "beforeReadFile":
    case "beforeTabFileRead":
      return runPipeline(root, "beforeReadFile", "read", relativePath(root, String(payload.file_path ?? "")), ids(payload));
    case "afterFileEdit":
    case "afterTabFileEdit":
      return runPipeline(root, "afterFileEdit", "edit", relativePath(root, String(payload.file_path ?? "")), ids(payload));
    case "afterShellExecution":
      await handleShellResult(root, payload);
      return {};
    case "afterAgentResponse":
      await handleAgentResponse(root, payload);
      return {};
    case "stop":
      return handleStop(root, payload);
    default:
      return advisoryAllow();
  }
}

async function doneCheckOn(root: string): Promise<boolean> {
  return (await readConfigSafe(root)).doneCheck.mode !== "off";
}

/** Shell output is kept for the done check, and for picking the agent's own test command to re-run. */
async function shellOutputWanted(root: string): Promise<boolean> {
  const dc = (await readConfigSafe(root)).doneCheck;
  return dc.mode !== "off" || dc.tests.enabled;
}

/** What the command printed — the evidence quoted output is checked against. */
async function handleShellResult(root: string, payload: Record<string, unknown>): Promise<void> {
  if (!(await shellOutputWanted(root))) return;
  const { conversationId } = ids(payload);
  await recordShellOutput(root, {
    ...(conversationId ? { conversationId } : {}),
    command: String(payload.command ?? ""),
    output: String(payload.output ?? ""),
    ...(typeof payload.duration === "number" ? { durationMs: payload.duration } : {}),
  });
}

/** The final text of the turn, kept for the stop hook (which is not given it). */
async function handleAgentResponse(root: string, payload: Record<string, unknown>): Promise<void> {
  const { conversationId, generationId } = ids(payload);
  if (!conversationId || typeof payload.text !== "string") return;
  if (!(await doneCheckOn(root))) return;
  await storeLastResponse(root, conversationId, generationId, payload.text);
}

const RESPONSE_WAIT_MS = 1_500;

/** The turn's final message: this generation's stored response, else the transcript, else the latest stored. */
async function finalMessage(root: string, payload: Record<string, unknown>): Promise<string> {
  const { conversationId, generationId } = ids(payload);
  const fromTranscript = (): string | null => {
    const tp = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
    if (!tp) return null;
    try {
      return lastAssistantTextFromTranscript(fs.readFileSync(tp, "utf8"));
    } catch {
      return null;
    }
  };
  if (!conversationId) return fromTranscript() ?? "";
  const deadline = Date.now() + RESPONSE_WAIT_MS;
  for (;;) {
    const stored = await readLastResponse(root, conversationId);
    if (stored && (!generationId || stored.generationId === generationId)) return stored.text;
    const transcript = fromTranscript();
    if (transcript !== null) return transcript;
    // afterAgentResponse may still be writing; give it a moment.
    if (Date.now() >= deadline) return stored?.text ?? "";
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Set on the detached copy of this process that finishes a stop in the background. */
const BACKGROUND_ENV = "GOAL_GUARDIAN_BACKGROUND_STOP";
const backgroundFile = process.env[BACKGROUND_ENV];
// Not inherited by what this run starts (the tests, and anything they spawn).
delete process.env[BACKGROUND_ENV];

/**
 * End of turn: judge the block; in enforce mode, send the agent back with what failed. Off or
 * advisory, nothing can be sent back, so the check (and its test re-run, up to two minutes) finishes
 * in a detached process and Cursor is not kept waiting.
 */
async function handleStop(root: string, payload: Record<string, unknown>): Promise<{ followup_message?: string }> {
  const config = await readConfigSafe(root);
  // With the done check off, Guardian still re-runs the tests after an editing turn (no block, no follow-up).
  if (config.doneCheck.mode === "off" && !config.doneCheck.tests.enabled) return {};
  if (config.doneCheck.mode !== "enforce" && !backgroundFile) {
    if (inBackground(payload)) return {};
  }
  const { conversationId, generationId } = ids(payload);
  const message = config.doneCheck.mode === "off" ? "" : await finalMessage(root, payload);
  const out = await runDoneCheck(root, {
    message,
    ...(conversationId ? { conversationId } : {}),
    ...(generationId ? { generationId } : {}),
    stop: {
      status: String(payload.status ?? ""),
      loopCount: typeof payload.loop_count === "number" ? payload.loop_count : 0,
    },
  });
  return out?.followup ? { followup_message: out.followup } : {};
}

/** Re-run this process detached on the same payload. False when it could not start (then run inline). */
function inBackground(payload: Record<string, unknown>): boolean {
  try {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gg-stop-")), "payload.json");
    fs.writeFileSync(file, JSON.stringify(payload));
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, [BACKGROUND_ENV]: file },
    });
    child.unref();
    return typeof child.pid === "number";
  } catch {
    return false;
  }
}

/** The detached run: its payload comes from the file, its answer goes nowhere. */
async function backgroundStop(file: string): Promise<void> {
  try {
    const payload = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    await handle(payload);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

function ids(payload: Record<string, unknown>): { conversationId?: string; generationId?: string } {
  const conversationId = typeof payload.conversation_id === "string" ? payload.conversation_id : undefined;
  const generationId = typeof payload.generation_id === "string" ? payload.generation_id : undefined;
  return { ...(conversationId ? { conversationId } : {}), ...(generationId ? { generationId } : {}) };
}

async function main(): Promise<void> {
  if (backgroundFile) {
    await backgroundStop(backgroundFile).catch(() => {});
    return;
  }
  let response: HookOutput = advisoryAllow();
  try {
    const raw = await readAllStdin();
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (payload && typeof payload === "object") {
      response = await handle(payload);
    }
  } catch {
    response = advisoryAllow();
  }
  process.stdout.write(JSON.stringify(response));
}

main()
  .catch(() => {
    process.stdout.write(JSON.stringify(advisoryAllow()));
  })
  .finally(() => {
    process.exit(0);
  });
