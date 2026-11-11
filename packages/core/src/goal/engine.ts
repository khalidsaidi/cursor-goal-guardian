/**
 * Guardian's goal runs on DeepSeek Harness's own goal feature, all four of its packages, unmodified, from the
 * published packages at the version vendored in third_party/deepseek-harness:
 *
 * - @deepseek-ai/dsh-goal: GoalService and its strict fold keep the goal's state.
 * - @deepseek-ai/dsh-tool-goal: get_goal, create_goal and update_goal, run through their real tool pipeline, with
 *   their authority checks (a direct human turn, or the current goal round), their blocked threshold, their
 *   system-prompt goal policy and their wrap-up context.
 * - @deepseek-ai/dsh-goal-round-driver: their driver decides whether a round starts, reserves it and builds the
 *   round prompt.
 * - @deepseek-ai/dsh-command-goal: their /goal command, run through their command runtime.
 *
 * This file is the adapter, and it is Guardian's. Their agent isn't the one working: Cursor's is. So their runtime
 * gets a stand-in agent of the kind their own tests use, and Guardian tells their session what Cursor's hooks see:
 * - the user sent a message: a turn opens with a user-sourced message, so "direct human request" is theirs to judge;
 * - the agent stopped: the turn ends and the stand-in goes idle, which is what makes their driver act;
 * - their driver hands its round prompt to the stand-in's `followup`. That one call is the adaptation: instead of
 *   starting a turn of their own agent, the prompt goes back to Cursor's agent through Cursor's stop hook, and the
 *   round is admitted to their session as their agent would admit it.
 *
 * Every hook call is a new process. Their events are saved as `goal.engine` audit records and replayed. Their
 * "armed" state is per process, so a goal is disarmed in each new one, as after their own session resume; the stop
 * hook re-arms it with their `resume` before the driver is asked for a round.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { appendAudit } from "../audit/log.js";
import { nowIso } from "../clock.js";
import { getGuardianPaths } from "../paths.js";
import { loadEngineFold, type EngineEvent, type EngineGoal } from "./engineFold.js";

/** What Guardian asks their runtime to do. */
export type EngineOp =
  /** Make the engine's goal match the contract: create, edit or clear as their rules allow. Every op with an objective does this first. */
  | { type: "sync" }
  /** A new goal even when the objective reads the same as the completed one. */
  | { type: "create" }
  /** The user sent a message: a turn opens with it, attributed to the user. */
  | { type: "user-message" }
  /** `by: "agent"` goes through their update_goal tool and its authority; otherwise it is the user's own control (their /goal command). */
  | { type: "pause"; by?: "agent" }
  | { type: "resume" }
  /** `by: "agent"` goes through their update_goal tool; otherwise the user closed the goal. */
  | { type: "complete"; by?: "agent" }
  /** `by: "agent"` goes through their update_goal tool and its blocked threshold; otherwise Guardian's own stop (stalled, a limit). */
  | { type: "block"; code: string; message: string; by?: "agent" }
  /** The agent stopped and Guardian wants it sent back: their driver decides, and its prompt comes back. */
  | { type: "round" }
  /** One of their goal tools, through their tool pipeline. */
  | { type: "tool"; name: "get_goal" | "create_goal" | "update_goal"; args: Record<string, unknown> }
  /** Their /goal command: the text after "/goal". */
  | { type: "command"; input: string };

export interface EngineToolResult {
  isError: boolean;
  /** Their tool's own result text: the goal JSON, or their error. */
  text: string;
  /** Context their tool deferred for the model, such as the wrap-up instruction. */
  contexts: string[];
}

export interface EngineResult {
  /** The goal as it then stands, null when there is none. */
  goal: EngineGoal | null;
  /** Their driver's round prompt, when it started a round. */
  prompt?: string;
  tool?: EngineToolResult;
  command?: { kind: string; text: string };
}

/** Their runtime said no. `code` is their error code where they gave one. */
export class EngineRefused extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "EngineRefused";
    this.code = code;
  }
}

/** The phase Guardian's own records showed before the engine existed in this workspace, to seed it from. */
export type LegacyPhase = "none" | "active" | "paused" | "complete";

/* Their packages, loaded once per process and only when a goal event needs them. Typed loosely: this file only
   passes values between their functions. */
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Theirs {
  Context: any;
  SessionStore: any;
  SessionId: (id: string) => any;
  SessionProjectionRegistry: any;
  AgentRegistry: any;
  GoalService: any;
  SystemPrompt: any;
  ToolRuntime: any;
  ToolExecutionPipeline: any;
  NativeToolExecutor: any;
  CommandRuntime: any;
  toolGoal: any;
  commandGoal: any;
  roundDriver: any;
  createUserMessage: (input: any) => any;
  ToolCallId: (id: string) => any;
}
let core: Promise<Theirs> | null = null;
let whole: Promise<Theirs> | null = null;

/** Their session, registries and goal service: all that noting a user's message needs. */
function loadCore(): Promise<Theirs> {
  core ??= (async () => {
    // Their round driver uses Promise.withResolvers, which the Node that runs Guardian's tests doesn't have yet.
    // Supplying the standard function changes none of their code.
    const P = Promise as any;
    P.withResolvers ??= function withResolvers() {
      let resolve: unknown;
      let reject: unknown;
      const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
      });
      return { promise, resolve, reject };
    };
    const [cordis, session, projection, agent, goal, llm] = await Promise.all([
      import("@deepseek-ai/cordis"),
      import("@deepseek-ai/dsh-session"),
      import("@deepseek-ai/dsh-session-projection"),
      import("@deepseek-ai/dsh-agent"),
      import("@deepseek-ai/dsh-goal"),
      import("@deepseek-ai/dsh-llm"),
    ]);
    await loadEngineFold();
    return {
      Context: (cordis as any).Context,
      SessionStore: (session as any).default,
      SessionId: (session as any).SessionId,
      SessionProjectionRegistry: (projection as any).default,
      AgentRegistry: (agent as any).default,
      GoalService: (goal as any).default,
      createUserMessage: (llm as any).createUserMessage,
      ToolCallId: (llm as any).ToolCallId,
    } as Theirs;
  })();
  return core;
}

/** The rest: their tools and tool pipeline, their system prompt, their command runtime and /goal, their round driver. */
function load(full = true): Promise<Theirs> {
  if (!full) return loadCore();
  whole ??= (async () => {
    const base = await loadCore();
    const [systemPrompt, tools, pipeline, executor, commands, toolGoal, commandGoal, roundDriver] = await Promise.all([
      import("@deepseek-ai/dsh-system-prompt"),
      import("@deepseek-ai/dsh-tools"),
      import("@deepseek-ai/dsh-tools/pipeline"),
      import("@deepseek-ai/dsh-tool-executor-native"),
      import("@deepseek-ai/dsh-commands"),
      import("@deepseek-ai/dsh-tool-goal"),
      import("@deepseek-ai/dsh-command-goal"),
      import("@deepseek-ai/dsh-goal-round-driver"),
    ]);
    return {
      ...base,
      SystemPrompt: (systemPrompt as any).default,
      ToolRuntime: (tools as any).default,
      ToolExecutionPipeline: (pipeline as any).ToolExecutionPipeline,
      NativeToolExecutor: executor,
      CommandRuntime: (commands as any).default,
      toolGoal,
      commandGoal,
      roundDriver,
    };
  })();
  return whole;
}

const SESSION = "goal-guardian-workspace";
const ENGINE_LINE = '"goal.engine"';
const LOCK_WAIT_MS = 4000;
const LOCK_STALE_MS = 15_000;
/** How long their driver gets to hand over a round prompt once the stand-in is idle and the goal armed. */
const DRIVER_WAIT_MS = 1500;
/** The user's words stay in Guardian's own prompt record; their session only needs to know a human spoke. */
const USER_TURN_TEXT = "(a message from the user)";

/** One change at a time per workspace: the hook and the MCP server are separate processes. */
async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const dir = getGuardianPaths(root).telemetryDir;
  const lock = path.join(dir, "engine.lock");
  await fsp.mkdir(dir, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      await fsp.mkdir(lock);
      break;
    } catch {
      const age = await fsp.stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) await fsp.rm(lock, { recursive: true, force: true });
      else if (Date.now() - started > LOCK_WAIT_MS) throw new EngineRefused("the goal is being changed by another process", "ENGINE_BUSY");
      else await new Promise((r) => setTimeout(r, 15));
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Every engine event saved for this workspace since the last reset, straight from the audit file. */
async function savedEvents(root: string): Promise<EngineEvent[]> {
  const raw = await fsp.readFile(getGuardianPaths(root).audit, "utf8").catch(() => "");
  let events: EngineEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes(ENGINE_LINE)) continue;
    try {
      const r = JSON.parse(line) as { kind?: string; event?: EngineEvent; reset?: boolean };
      if (r.kind !== "goal.engine") continue;
      if (r.reset) events = [];
      else if (r.event) events.push(r.event);
    } catch {
      // a torn line is not an event
    }
  }
  return events;
}

interface Open {
  t: Theirs;
  ctx: any;
  goals: any;
  session: any;
  agent: any;
  pipeline: any;
  /** What their code passed to the stand-in's `followup`. */
  followups: any[];
  setStatus(status: "idle" | "running"): void;
  seeded: number;
}

/** Their whole goal runtime, mounted the way their own tests mount it, around a stand-in agent. */
async function open(seed: EngineEvent[], full = true): Promise<Open> {
  const t = await load(full);
  const ctx = new t.Context();
  await ctx.plugin(t.SessionStore);
  await ctx.plugin(t.SessionProjectionRegistry);
  if (full) await ctx.plugin(t.SystemPrompt);
  await ctx.plugin(t.AgentRegistry);
  if (full) {
    await ctx.plugin(t.ToolRuntime);
    await ctx.plugin(t.NativeToolExecutor);
    await ctx.plugin(t.CommandRuntime);
  }
  await ctx.plugin(t.GoalService);
  if (full) {
    await ctx.plugin(t.toolGoal, {});
    await ctx.plugin(t.commandGoal);
    await ctx.plugin(t.roundDriver);
  }
  const session = ctx.sessions.create(t.SessionId(SESSION), seed.length ? { seed: structuredClone(seed) } : {});
  let status: "idle" | "running" = "running";
  const followups: any[] = [];
  const queue: Record<string, any[]> = { "next-turn": [], "next-step": [] };
  const inbox = {
    get nextTurn() { return queue["next-turn"]!; },
    get nextStep() { return queue["next-step"]!; },
    append(kind: string, message: any) { queue[kind]!.push(message); },
    prepend(kind: string, message: any) { queue[kind]!.unshift(message); },
    remove(id: unknown) { for (const k of Object.keys(queue)) queue[k] = queue[k]!.filter((m) => m.id !== id); },
    splice(kind: string, start: number, count: number, items: any[]) { return queue[kind]!.splice(start, count, ...items); },
  };
  // The registry-compatible stand-in their own tests use: a session, an inbox, and nothing that runs a model.
  // `followup` is the one call Guardian adapts: what their code would start as a turn is kept for Cursor's stop hook.
  const agent = {
    id: session.id, options: {}, session, model: {}, inbox, ctx,
    get status() { return status; },
    send() {}, followup(message: any) { followups.push(message); },
    steer: () => ({ outcome: Promise.resolve({ status: "rejected" as const }) }),
    inject(message: any) { inbox.append("next-step", message); }, cancel() {},
    runMaintenance: (task: (signal: AbortSignal) => unknown) => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  };
  await ctx.agents.register(agent);
  ctx.goals.get(agent); // their strict replay of the seed: throws if it rejects the log
  return { t, ctx, goals: ctx.goals, session, agent, pipeline: full ? new t.ToolExecutionPipeline(ctx) : null, followups, setStatus: (s) => { status = s; }, seeded: seed.length };
}

const viewOf = (v: any): EngineGoal | null =>
  v ? { id: v.id, revision: v.revision, objective: v.objective, phase: v.phase, ...(v.blockedReason ? { blockedReason: { code: v.blockedReason.code, message: v.blockedReason.message } } : {}), maxGoalRounds: v.maxGoalRounds, roundsStarted: v.roundsStarted } : null;

/** Their errors carry a code; anything else is reported as it is. */
function refused(err: unknown): EngineRefused {
  const e = err as { message?: unknown; code?: unknown };
  return new EngineRefused(typeof e?.message === "string" ? e.message : String(err), typeof e?.code === "string" ? e.code : "ENGINE_ERROR");
}

type Ev = { type: string; data: any };
const events = (o: Open): Ev[] => o.session.snapshotEvents() as Ev[];

/** The turn open in their session, if one is. */
function openTurn(o: Open): number | null {
  let open: number | null = null;
  for (const e of events(o)) {
    if (e.type === "turn/start") open = e.data.turn as number;
    else if (e.type === "turn/end" && e.data.turn === open) open = null;
  }
  return open;
}
const nextTurn = (o: Open): number => events(o).reduce((max, e) => (e.type === "turn/start" ? Math.max(max, e.data.turn ?? 0) : max), 0) + 1;

function closeTurn(o: Open): void {
  const turn = openTurn(o);
  if (turn !== null) o.session.append("turn/end", { turn, reason: { kind: "completed" } });
}

/** A turn that starts with the user's message, as their agent records one. */
function openUserTurn(o: Open): void {
  closeTurn(o);
  o.setStatus("running");
  o.session.append("turn/start", { turn: nextTurn(o) });
  o.session.append("user/message", o.t.createUserMessage({ content: [{ type: "text", text: USER_TURN_TEXT }], source: { kind: "user" } }), { surfaceOp: "append" });
}

/**
 * Their tools need an open model turn. Cursor only runs its agent on a message from the user, so when no hook
 * reported that message (an older Cursor, or a call outside any hook), the turn is recorded as the user's here.
 */
function ensureTurn(o: Open): void {
  if (openTurn(o) === null) openUserTurn(o);
}

/** One call through their tool pipeline, as their agent's own tool call, with the stand-in as the caller. */
async function callTool(o: Open, name: string, args: Record<string, unknown>): Promise<EngineToolResult> {
  ensureTurn(o);
  o.setStatus("running");
  const result = await o.ctx.agents.withInitiator(o.agent, async () => {
    const input = { signal: new AbortController().signal, callId: o.t.ToolCallId(`guardian-${Date.now()}-${Math.random().toString(36).slice(2)}`), name, arguments: args, agent: o.agent };
    const prepared = await o.pipeline.prepare(input);
    const outcome = prepared.kind === "dispatch" ? await o.pipeline.dispatch(prepared.exec) : prepared;
    return o.pipeline.complete(prepared.exec, outcome);
  });
  const textOf = (blocks: any): string => (Array.isArray(blocks) ? blocks.filter((b) => b?.type === "text").map((b) => String(b.text)).join("\n") : "");
  return { isError: result.isError === true, text: textOf(result.content), contexts: ((result.additionalContexts ?? []) as any[]).map((m) => textOf(m?.content)).filter(Boolean) };
}

/** Their /goal command, through their command runtime. */
async function runCommand(o: Open, input: string): Promise<{ kind: string; text: string }> {
  o.setStatus("running");
  const execution = await o.ctx.commands.execute(o.agent, `/goal${input.trim() ? ` ${input.trim()}` : ""}`, [], new AbortController().signal);
  if (!execution) throw new EngineRefused("their /goal command isn't registered", "ENGINE_ERROR");
  return { kind: String(execution.result?.kind ?? "error"), text: String(execution.result?.text ?? "") };
}

const must = (r: EngineToolResult): void => {
  if (r.isError) throw new EngineRefused(r.text.replace(/^Error:\s*/, ""), "GOAL_TOOL_REFUSED");
};
const mustCommand = (r: { kind: string; text: string }): void => {
  if (r.kind !== "success") throw new EngineRefused(r.text, "GOAL_COMMAND_REFUSED");
};

/** Their /goal command reads these words as controls, so an objective that begins with one can't be passed to it as a new goal. */
const readsAsControl = (objective: string): boolean => /^(clear|pause|resume|edit)(\s|$)/i.test(objective.trim());

/**
 * A new goal in the user's words. Their create_goal tool takes it when the user's message opened this turn; outside
 * such a turn it is the user's own control, their /goal command. Only an objective their command would misread as
 * a control word goes to their service directly.
 */
async function createGoal(o: Open, objective: string): Promise<void> {
  const tool = await callTool(o, "create_goal", { objective });
  if (!tool.isError) return;
  if (readsAsControl(objective)) o.goals.create(o.agent, { objective });
  else mustCommand(await runCommand(o, objective));
}

/** The open goal with new words: their update_goal edit in the user's turn, else their /goal edit. */
async function editGoal(o: Open, goal: any, objective: string): Promise<void> {
  const tool = await callTool(o, "update_goal", { goal_id: goal.id, revision: goal.revision, action: "edit", objective });
  if (tool.isError) mustCommand(await runCommand(o, `edit ${objective}`));
}

/**
 * The agent stopped and Guardian wants it sent back. The turn ends, the stand-in goes idle, the goal is re-armed
 * with their `resume` (each hook process starts disarmed, as after their session resume), and their driver takes it
 * from there: it reserves the round and passes its prompt to `followup`. That prompt is admitted to their session
 * as their agent admits a queued round, and returned for Cursor's stop hook to deliver.
 */
async function driveRound(o: Open): Promise<string | undefined> {
  closeTurn(o);
  o.setStatus("idle");
  o.followups.length = 0;
  o.ctx.emit("agent/status", { agent: o.agent, status: "idle" });
  const goal = o.goals.get(o.agent);
  if (!goal || goal.phase !== "active") return undefined;
  if (goal.activation !== "armed") {
    try {
      o.goals.resume(o.agent, { id: goal.id, revision: goal.revision });
    } catch (err) {
      // Their resume refuses a goal that used all its rounds, before their driver can block it. Their driver's own
      // words and code for that case are recorded through their service.
      if (goal.roundsStarted >= goal.maxGoalRounds) {
        o.setStatus("running");
        o.goals.block(o.agent, { id: goal.id, revision: goal.revision }, { code: "round-limit", message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.` });
        return undefined;
      }
      throw err;
    }
  }
  const started = Date.now();
  while (!o.followups.length && Date.now() - started < DRIVER_WAIT_MS) {
    if (o.goals.get(o.agent)?.phase !== "active") break;
    await new Promise((r) => setTimeout(r, 2));
  }
  const message = o.followups.shift();
  o.setStatus("running");
  if (!message) return undefined;
  o.ctx.emit("agent/status", { agent: o.agent, status: "running" });
  o.session.append("turn/start", { turn: nextTurn(o) });
  o.session.append("user/message", message, { surfaceOp: "append" });
  return (message.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

/**
 * Ask DeepSeek's goal runtime for one thing, and save the events it wrote. Throws EngineRefused, saving nothing
 * that their strict replay would reject, when their code refuses.
 *
 * With `objective` given (the goal as the contract has it), the engine is first brought in line with it by their
 * own operations: create when there is no goal or the last one is complete, edit when the words differ, clear when
 * the contract has none. A workspace whose goal predates the engine is seeded from `legacy`. With `objective`
 * undefined nothing is synced: the op runs against the goal as their log has it.
 */
export async function engineRun(root: string, objective: string | undefined, legacy: LegacyPhase, op: EngineOp): Promise<EngineResult> {
  return withLock(root, async () => {
    let seed = await savedEvents(root);
    let o: Open;
    // Noting that the user spoke needs their session and service only; their tools, command and driver are
    // mounted for everything else. The prompt hook runs on every message, so it stays light.
    const full = !(op.type === "user-message" && objective === undefined);
    try {
      o = await open(seed, full);
    } catch {
      // Their replay rejected the saved log (a torn write, say). Start it over; Guardian's own records still stand.
      await appendAudit(root, { ts: nowIso(), kind: "goal.engine", reset: true });
      seed = [];
      o = await open(seed, full);
    }
    const { goals, agent } = o;
    const out: Omit<EngineResult, "goal"> = {};
    const hadGoalBefore = seed.some((e) => e.type === "goal/change");
    const ref = (g: any): { id: string; revision: number } => ({ id: g.id, revision: g.revision });
    try {
      if (op.type === "user-message") openUserTurn(o);
      let carried: "pause" | "complete" | null = null;
      if (objective !== undefined) {
        const want = objective.trim();
        let goal = goals.get(agent);
        if (!want) {
          if (goal) mustCommand(await runCommand(o, "clear"));
        } else if (!goal) {
          await createGoal(o, want);
          // First time in a workspace that already had a goal: carry its phase over.
          if (!hadGoalBefore && legacy === "paused") {
            mustCommand(await runCommand(o, "pause"));
            carried = "pause";
          }
          if (!hadGoalBefore && legacy === "complete" && op.type !== "create") {
            goals.complete(agent, ref(goals.get(agent)));
            carried = "complete";
          }
        } else if (goal.phase === "complete" && (goal.objective !== want || op.type === "create")) await createGoal(o, want);
        else if (goal.objective !== want) await editGoal(o, goal, want);
      }
      const goal = goals.get(agent);
      if (op.type === "tool") out.tool = await callTool(o, op.name, op.args);
      else if (op.type === "command") out.command = await runCommand(o, op.input);
      else if (op.type === carried) {
        // the phase carried over from Guardian's older records is the change asked for
      } else if (op.type === "round") out.prompt = await driveRound(o);
      else if (goal && op.type === "pause") {
        if (op.by === "agent") must(await callTool(o, "update_goal", { goal_id: goal.id, revision: goal.revision, action: "pause" }));
        else mustCommand(await runCommand(o, "pause"));
      } else if (goal && op.type === "resume") mustCommand(await runCommand(o, "resume"));
      else if (goal && op.type === "complete") {
        if (op.by === "agent") {
          out.tool = await callTool(o, "update_goal", { goal_id: goal.id, revision: goal.revision, action: "complete" });
          must(out.tool);
        } else goals.complete(agent, ref(goal));
      } else if (goal && op.type === "block") {
        if (op.by === "agent") {
          out.tool = await callTool(o, "update_goal", { goal_id: goal.id, revision: goal.revision, action: "blocked", blocked_reason: op.message });
          must(out.tool);
        } else goals.block(agent, ref(goal), { code: op.code, message: op.message });
      } else if (!goal && (op.type === "pause" || op.type === "resume" || op.type === "complete" || op.type === "block")) {
        throw new EngineRefused("no current goal", "GOAL_NOT_FOUND");
      }
      const after = viewOf(goals.get(agent)); // throws if their fold rejected what was appended
      const added = (o.session.snapshotEvents() as EngineEvent[]).slice(o.seeded);
      // A call that wrote nothing but their seed marker isn't worth a line.
      if (added.some((e) => e.type !== "session/end-seed")) {
        for (const event of added) await appendAudit(root, { ts: nowIso(), kind: "goal.engine", event: JSON.parse(JSON.stringify(event)) as EngineEvent });
      }
      return { goal: after, ...out };
    } catch (err) {
      throw err instanceof EngineRefused ? err : refused(err);
    }
  });
}

/** One change, answered with the goal as it then stands. */
export async function engineApply(root: string, objective: string, legacy: LegacyPhase, op: EngineOp): Promise<EngineGoal | null> {
  return (await engineRun(root, objective, legacy, op)).goal;
}

export interface EngineToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; required?: boolean; enum?: string[]; description?: string }>;
}

/** Their three goal tools as their runtime registers them: names, descriptions and parameters, in their words. */
export async function engineToolDefinitions(): Promise<EngineToolDefinition[]> {
  const o = await open([]);
  return ["get_goal", "create_goal", "update_goal"].map((name) => {
    const tool = o.ctx.tools.get(name);
    if (!tool) throw new Error(`their ${name} tool wasn't registered`);
    // Their runtime holds the parameters as a JSON schema object.
    const schema = JSON.parse(JSON.stringify(tool.parameters ?? {})) as { properties?: EngineToolDefinition["parameters"] };
    return { name: String(tool.name), description: String(tool.description), parameters: schema.properties ?? {} };
  });
}

/** Their system-prompt goal policy (the `tool:goal` section their tool package registers), as their runtime assembles it. */
export async function engineGoalPolicy(): Promise<string> {
  const o = await open([]);
  const assembled = await o.ctx.systemPrompt.assemble();
  const section = (assembled.sections as Array<{ name: string; text: string }>).find((s) => s.name === "tool:goal");
  if (!section) throw new Error("their goal policy section wasn't registered");
  return section.text;
}
