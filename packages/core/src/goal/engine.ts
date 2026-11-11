/**
 * Guardian's goal state is kept by DeepSeek Harness's own goal service, unmodified: the published packages
 * @deepseek-ai/dsh-goal (GoalService and its strict fold), dsh-session (the session log), dsh-session-projection,
 * dsh-agent (the agent registry) and cordis, at the version vendored in third_party/deepseek-harness. Every change
 * of phase, objective, revision or round count is made by calling their service; Guardian never writes one of its
 * events itself.
 *
 * This file is the adapter, and it is Guardian's. It gives their service what it needs to run outside their agent:
 * - one of their Sessions per workspace, seeded from the events Guardian saved as `goal.engine` audit records, and
 *   saved back after each accepted change;
 * - a stand-in agent registered with their AgentRegistry, the way their own tests do (Cursor's agent is the real
 *   one, and it isn't theirs);
 * - a goal round admitted the way their round driver admits one: a turn holding a user message whose source names
 *   the goal, its revision and the next round. Their fold counts it and enforces the cap.
 *
 * Their "armed" and "disarmed" are per process, and each hook call is a new process, so Guardian doesn't use them:
 * what lets a round start is Guardian's own stop-hook logic. Their durable phases are used as they are.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { appendAudit } from "../audit/log.js";
import { nowIso } from "../clock.js";
import { getGuardianPaths } from "../paths.js";
import { loadEngineFold, type EngineEvent, type EngineGoal } from "./engineFold.js";

/** What Guardian asks their service to do. */
export type EngineOp =
  /** Make the engine's goal match the contract: create, edit or clear as their rules allow. Every op does this first. */
  | { type: "sync" }
  /** A new goal even when the objective reads the same as the completed one. */
  | { type: "create" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "complete" }
  | { type: "block"; code: string; message: string }
  /** Admit the next goal round. */
  | { type: "round" };

/** Their service said no. `code` is their error code where they gave one. */
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

/* Their packages, loaded once per process and only when a goal changes. Typed loosely: this file only passes
   values between their functions. */
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Theirs {
  Context: any;
  SessionStore: any;
  SessionId: (id: string) => any;
  SessionProjectionRegistry: any;
  AgentRegistry: any;
  GoalService: any;
  createUserMessage: (input: any) => any;
}
let theirs: Promise<Theirs> | null = null;
function load(): Promise<Theirs> {
  theirs ??= (async () => {
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
    };
  })();
  return theirs;
}

const SESSION = "goal-guardian-workspace";
const ENGINE_LINE = '"goal.engine"';
const LOCK_WAIT_MS = 4000;
const LOCK_STALE_MS = 15_000;

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
  goals: any;
  session: any;
  agent: any;
  seeded: number;
}

async function open(seed: EngineEvent[]): Promise<Open> {
  const t = await load();
  const ctx = new t.Context();
  await ctx.plugin(t.SessionStore);
  await ctx.plugin(t.SessionProjectionRegistry);
  await ctx.plugin(t.AgentRegistry);
  await ctx.plugin(t.GoalService);
  const session = ctx.sessions.create(t.SessionId(SESSION), seed.length ? { seed: structuredClone(seed) } : {});
  // The registry-compatible stand-in their own tests use: a session, and nothing that runs a model.
  const agent = {
    id: session.id, options: {}, session, model: {}, inbox: { append() {} }, ctx, status: "idle",
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: (task: (signal: AbortSignal) => unknown) => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  };
  await ctx.agents.register(agent);
  ctx.goals.get(agent); // their strict replay of the seed: throws if it rejects the log
  return { t, goals: ctx.goals, session, agent, seeded: seed.length };
}

const viewOf = (v: any): EngineGoal | null =>
  v ? { id: v.id, revision: v.revision, objective: v.objective, phase: v.phase, ...(v.blockedReason ? { blockedReason: { code: v.blockedReason.code, message: v.blockedReason.message } } : {}), maxGoalRounds: v.maxGoalRounds, roundsStarted: v.roundsStarted } : null;

/** Their errors carry a code; anything else is reported as it is. */
function refused(err: unknown): EngineRefused {
  const e = err as { message?: unknown; code?: unknown };
  return new EngineRefused(typeof e?.message === "string" ? e.message : String(err), typeof e?.code === "string" ? e.code : "ENGINE_ERROR");
}

/** The way their round driver admits a round: one balanced turn whose user message is attributed to the goal. */
function admitRound(o: Open, goal: any): void {
  const turn = (o.session.snapshotEvents() as Array<{ type: string; data: { turn?: number } }>).reduce((max, e) => (e.type === "turn/start" ? Math.max(max, e.data.turn ?? 0) : max), 0) + 1;
  const round = goal.roundsStarted + 1;
  o.session.append("turn/start", { turn });
  o.session.append("user/message", o.t.createUserMessage({ content: [{ type: "text", text: `Goal Guardian round ${round}` }], source: { kind: "goal", goalId: goal.id, revision: goal.revision, round } }), { surfaceOp: "append" });
  o.session.append("turn/end", { turn, reason: { kind: "completed" } });
}

/**
 * Ask DeepSeek's goal service for one change, and save the events it wrote. Returns the goal as it then stands
 * (null when there is none). Throws EngineRefused, saving nothing, when their service refuses.
 *
 * `objective` is the goal as the contract has it. Before the change asked for, the engine is brought in line with
 * it by their own operations: create when there is no goal or the last one is complete, edit when the words
 * differ, clear when the contract has none. A workspace whose goal predates the engine is seeded from `legacy`.
 */
export async function engineApply(root: string, objective: string, legacy: LegacyPhase, op: EngineOp): Promise<EngineGoal | null> {
  return withLock(root, async () => {
    let seed = await savedEvents(root);
    let o: Open;
    try {
      o = await open(seed);
    } catch {
      // Their replay rejected the saved log (a torn write, say). Start it over; Guardian's own records still stand.
      await appendAudit(root, { ts: nowIso(), kind: "goal.engine", reset: true });
      seed = [];
      o = await open(seed);
    }
    const { goals, agent } = o;
    const want = objective.trim();
    try {
      let goal = goals.get(agent);
      let carried: "pause" | "complete" | null = null;
      if (!want) {
        if (goal) goals.clear(agent, goal);
      } else {
        if (!goal) {
          goal = goals.create(agent, { objective: want });
          // First time in a workspace that already had a goal: carry its phase over.
          if (!seed.length && legacy === "paused") {
            goal = goals.pause(agent, goal);
            carried = "pause";
          }
          if (!seed.length && legacy === "complete" && op.type !== "create") {
            goal = goals.complete(agent, goal);
            carried = "complete";
          }
        } else if (goal.objective !== want || op.type === "create") {
          if (goal.phase === "complete") goal = goals.create(agent, { objective: want });
          else if (goal.objective !== want) goal = goals.edit(agent, goal, { objective: want });
        }
        if (op.type === carried) {
          // the phase carried over from Guardian's older records is the change asked for
        } else if (op.type === "pause") goals.pause(agent, goal);
        else if (op.type === "resume") goals.resume(agent, goal);
        else if (op.type === "complete") goals.complete(agent, goal);
        else if (op.type === "block") goals.block(agent, goal, { code: op.code, message: op.message });
        else if (op.type === "round") {
          // Their driver reserves a round only for an active goal with rounds left; an event their fold rejects
          // would poison the log, so the same condition is checked before appending.
          if (goal.phase !== "active") throw new EngineRefused(`cannot start a goal round from phase "${goal.phase}"`, "GOAL_INVALID_TRANSITION");
          if (goal.roundsStarted >= goal.maxGoalRounds) throw new EngineRefused(`goal "${goal.id}" exhausted ${goal.maxGoalRounds} goal rounds`, "round-limit");
          admitRound(o, goal);
        }
      }
      const after = viewOf(goals.get(agent)); // throws if their fold rejected what was appended
      const added = (o.session.snapshotEvents() as EngineEvent[]).slice(o.seeded);
      // A change that wrote nothing but their seed marker isn't worth a line.
      if (added.some((e) => e.type !== "session/end-seed")) {
        for (const event of added) await appendAudit(root, { ts: nowIso(), kind: "goal.engine", event: JSON.parse(JSON.stringify(event)) as EngineEvent });
      }
      return after;
    } catch (err) {
      throw err instanceof EngineRefused ? err : refused(err);
    }
  });
}
