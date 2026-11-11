/**
 * Goal Guardian Cursor hook (stdio JSON in/out). Contract: this process NEVER
 * blocks and NEVER breaks the editor — every path, including crashes and
 * malformed input, ends in permission:"allow" and exit code 0.
 */
import fs from "node:fs";
import path from "node:path";
import { GUARDIAN_MESSAGE_PREFIX, advisoryAllow, agentMode, captureGoal, goalMidTurnNotice, goalTurnContext, recordFileEdit, recordShellFailure, recordShellOutput, recordUserPrompt, replayCase, runGoalStop, runPipeline, type HookResponse } from "@goal-guardian/core";

/** The stop and prompt hooks answer in their own shapes, not the permission shape. */
type HookOutput = HookResponse | { followup_message?: string } | { continue: true; additional_context?: string } | { additional_context?: string };

/** Hooks with nothing to say answer empty, never with the permission shape. */
const SILENT_EVENTS = new Set(["stop", "afterShellExecution", "postToolUse", "postToolUseFailure"]);

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

/** On Windows Cursor sends workspace roots as URI paths, such as /c:/Users/me/repo. */
function nativePath(root: string): string {
  return /^\/[a-zA-Z]:/.test(root) ? path.win32.normalize(root.slice(1)) : root;
}

/**
 * Resolve the workspace this event belongs to. Older native-Windows Cursor sent
 * no workspace_roots and a cwd outside the workspace, leaving only file_path. Ladder:
 * 1. workspace_roots
 * 2. ascend from file_path until a Guardian workspace appears
 * 3. cwd, if it is a Guardian workspace
 * Unresolvable returns "" and the caller answers a bare allow — never a
 * guessed directory, never a tape written into the wrong place.
 */
function workspaceRoot(payload: Record<string, unknown>): string {
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) return nativePath(roots[0]);

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
  if (!root) return SILENT_EVENTS.has(event) ? {} : event === "beforeSubmitPrompt" ? { continue: true } : advisoryAllow();

  switch (event) {
    case "beforeShellExecution":
      return runPipeline(root, "beforeShellExecution", "shell", String(payload.command ?? ""), ids(payload));
    case "beforeMCPExecution": {
      // Cursor sends the server as mcp_server_name; older builds used server.
      const serverName = String(payload.mcp_server_name ?? payload.server ?? "");
      const value = `${serverName}/${String(payload.tool_name ?? "")}`;
      return runPipeline(root, "beforeMCPExecution", "mcp", value, ids(payload));
    }
    // Nothing needs reads, and a Tab completion is the person typing. Connected workspaces lose these on update.
    case "beforeReadFile":
    case "beforeTabFileRead":
    case "afterTabFileEdit":
      return {};
    case "afterFileEdit": {
      const file = relativePath(root, String(payload.file_path ?? ""));
      if (!file.startsWith(".cursor/")) await captureGoal(root, ids(payload).conversationId).catch(() => undefined);
      await recordFileEdit(root, file, payload.edits).catch(() => undefined);
      return runPipeline(root, "afterFileEdit", "edit", file, ids(payload));
    }
    case "stop": {
      const { conversationId } = ids(payload);
      const followup = await runGoalStop(root, {
        ...(conversationId ? { conversationId } : {}),
        status: String(payload.status ?? ""),
        loopCount: typeof payload.loop_count === "number" ? payload.loop_count : 0,
        ...turnTokens(payload),
      }).catch(() => null);
      return followup ? { followup_message: followup } : {};
    }
    case "postToolUse":
    case "postToolUseFailure": {
      if (commandFailed(event, payload)) {
        await recordShellFailure(root, String((payload.tool_input as { command: string }).command)).catch(() => undefined);
      }
      const notice = await goalMidTurnNotice(root, ids(payload).conversationId).catch(() => null);
      return notice ? { additional_context: notice } : {};
    }
    case "beforeSubmitPrompt": {
      const mode = typeof payload.composer_mode === "string" ? payload.composer_mode : undefined;
      const prompt = String(payload.prompt ?? "");
      await recordUserPrompt(root, prompt, ids(payload).conversationId, mode).catch(() => undefined);
      const context = !prompt.startsWith(GUARDIAN_MESSAGE_PREFIX) && mode && agentMode(mode) ? await goalTurnContext(root).catch(() => null) : null;
      return context ? { continue: true, additional_context: context } : { continue: true };
    }
    case "afterShellExecution":
      await recordShellOutput(root, {
        command: String(payload.command ?? ""),
        output: String(payload.output ?? ""),
        ...(typeof payload.duration === "number" ? { durationMs: payload.duration } : {}),
      }).catch(() => undefined);
      return {};
    default:
      return advisoryAllow();
  }
}

/**
 * Which hook reports a failed shell command depends on which executor Cursor's server picked: one uses
 * postToolUseFailure, the other postToolUse with an exit code in tool_output, a JSON string.
 */
function commandFailed(event: string, payload: Record<string, unknown>): boolean {
  const input = payload.tool_input as { command?: unknown } | undefined;
  if (payload.tool_name !== "Shell" || typeof input?.command !== "string") return false;
  if (event === "postToolUseFailure") return true;
  try {
    const output = JSON.parse(String(payload.tool_output)) as { exitCode?: unknown };
    return typeof output.exitCode === "number" && output.exitCode !== 0;
  } catch {
    return false;
  }
}

/** Cursor reports what the turn spent. Cached reads are left out: they aren't new work. */
function turnTokens(payload: Record<string, unknown>): { tokens?: number; usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number } } {
  const count = (key: string): number => (typeof payload[key] === "number" ? (payload[key] as number) : 0);
  const tokens = count("input_tokens") + count("output_tokens");
  // The split goes to Codex's own accounting, which counts input less cached, plus output.
  const usage = { input_tokens: count("input_tokens") + count("cache_read_tokens"), cached_input_tokens: count("cache_read_tokens"), output_tokens: count("output_tokens") };
  return tokens > 0 ? { tokens, usage } : {};
}

function ids(payload: Record<string, unknown>): { conversationId?: string; generationId?: string } {
  const conversationId = typeof payload.conversation_id === "string" ? payload.conversation_id : undefined;
  const generationId = typeof payload.generation_id === "string" ? payload.generation_id : undefined;
  return { ...(conversationId ? { conversationId } : {}), ...(generationId ? { generationId } : {}) };
}

/** Plain ASCII: on Windows the output passes through a PowerShell pipeline that can re-encode anything else. */
function hookJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * `goal-guardian-hook replay-review <workspace> <caseId> <promptFile>`: re-run one saved review with another prompt
 * and print the outcome as JSON. Google's RRSI calls this, through Guardian's domain, to score candidate prompts.
 */
async function replayReview(args: string[]): Promise<void> {
  const [root, caseId, promptFile] = args;
  let out: Record<string, unknown>;
  try {
    if (!root || !caseId || !promptFile) throw new Error("usage: replay-review <workspace> <caseId> <promptFile>");
    const template = fs.readFileSync(promptFile, "utf8");
    out = { ...(await replayCase(root, caseId, template)) };
  } catch (err) {
    out = { ran: false, flagged: null, reason: err instanceof Error ? err.message : String(err), fails: [], extra: [], seconds: 0 };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

async function main(): Promise<void> {
  if (process.argv[2] === "replay-review") return replayReview(process.argv.slice(3));
  let response: HookOutput = advisoryAllow();
  try {
    const raw = await readAllStdin();
    // On Windows, Cursor pipes the payload through PowerShell, whose UTF-8 output starts with a byte-order mark.
    const payload = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>;
    if (payload && typeof payload === "object") {
      response = await handle(payload);
    }
  } catch {
    response = advisoryAllow();
  }
  process.stdout.write(hookJson(response));
}

main()
  .catch(() => {
    process.stdout.write(hookJson(advisoryAllow()));
  })
  .finally(() => {
    process.exit(0);
  });
