import fs from "node:fs/promises";
import { getGuardianPaths } from "../paths.js";
import { systemClock, newId, nowIso, type Clock } from "../clock.js";
import {
  defaultState,
  guardianActionSchema,
  guardianStateSchema,
  parseState,
  type ActionType,
  type GuardianAction,
  type GuardianState,
} from "../schema/state.js";
import { contractSchema, type Contract } from "../schema/contract.js";
import { writeJsonAtomic, readJsonFile, fileExists, appendLine } from "../fsutil.js";
import { reduce } from "./reducer.js";
import { computeHash, isManuallyEdited } from "./hash.js";
import { StateError } from "./errors.js";

export const SNAPSHOT_INTERVAL = 25;

export interface Snapshot {
  lastActionIndex: number;
  state: GuardianState;
}

export interface DispatchInput {
  type: ActionType;
  payload?: Record<string, unknown>;
  actor?: GuardianAction["actor"];
}

export async function ensureStateFiles(workspaceRoot: string, clock: Clock = systemClock): Promise<void> {
  const p = getGuardianPaths(workspaceRoot);
  await fs.mkdir(p.telemetryDir, { recursive: true });
  if (!(await fileExists(p.state))) {
    const state = defaultState();
    state.meta.lastUpdated = nowIso(clock);
    state.meta.hash = computeHash(state);
    await writeJsonAtomic(p.state, state);
  }
  if (!(await fileExists(p.actions))) {
    await fs.writeFile(p.actions, "", "utf8");
  }
}

export async function loadState(workspaceRoot: string): Promise<GuardianState> {
  const p = getGuardianPaths(workspaceRoot);
  return parseState(await readJsonFile(p.state));
}

export async function loadActions(workspaceRoot: string): Promise<GuardianAction[]> {
  const p = getGuardianPaths(workspaceRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p.actions, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line, i) => {
    try {
      return guardianActionSchema.parse(JSON.parse(line));
    } catch {
      throw new StateError("CORRUPT_ACTION_LOG", `Corrupt action log entry at line ${i + 1}.`);
    }
  });
}

export async function loadSnapshot(workspaceRoot: string): Promise<Snapshot | null> {
  const p = getGuardianPaths(workspaceRoot);
  try {
    const raw = (await readJsonFile(p.snapshot)) as { lastActionIndex?: unknown; state?: unknown };
    if (typeof raw.lastActionIndex !== "number") return null;
    return { lastActionIndex: raw.lastActionIndex, state: guardianStateSchema.parse(raw.state) };
  } catch {
    return null;
  }
}

/**
 * Fill in the ids/timestamps a deterministic reducer needs, so the persisted
 * action log carries everything replay requires.
 */
function materializeAction(input: DispatchInput, clock: Clock): GuardianAction {
  const payload: Record<string, unknown> = { ...(input.payload ?? {}) };
  if (input.type === "ADD_TASKS" && Array.isArray(payload.tasks)) {
    payload.tasks = (payload.tasks as Array<Record<string, unknown>>).map((t) => ({
      ...t,
      id: typeof t.id === "string" && t.id ? t.id : newId("task"),
    }));
  }
  if (input.type === "OPEN_QUESTION" && typeof payload.id !== "string") payload.id = newId("q");
  if (input.type === "ADD_DECISION" && typeof payload.id !== "string") payload.id = newId("dec");
  return {
    id: newId("act"),
    ts: nowIso(clock),
    actor: input.actor ?? "agent",
    type: input.type,
    payload,
  };
}

function contractProjection(state: GuardianState): Contract {
  return contractSchema.parse({
    schemaVersion: 2,
    goal: state.goal,
    successCriteria: state.successCriteria,
    constraints: state.constraints,
  });
}

export async function dispatch(
  workspaceRoot: string,
  input: DispatchInput,
  clock: Clock = systemClock,
): Promise<GuardianState> {
  const p = getGuardianPaths(workspaceRoot);
  await ensureStateFiles(workspaceRoot, clock);
  const current = await loadState(workspaceRoot);

  if (isManuallyEdited(current)) {
    throw new StateError(
      "MANUAL_EDIT",
      "state.json was edited by hand. Run rebuild to restore it from the action log.",
    );
  }

  const action = materializeAction(input, clock);
  const next = reduce(current, action);

  await appendLine(p.actions, JSON.stringify(action));
  await writeJsonAtomic(p.state, next);
  await writeJsonAtomic(p.contract, contractProjection(next));

  if (next.meta.actionCount % SNAPSHOT_INTERVAL === 0) {
    const snapshot: Snapshot = { lastActionIndex: next.meta.actionCount - 1, state: next };
    await writeJsonAtomic(p.snapshot, snapshot);
  }

  return next;
}

/** Pure replay: fold the action log over the empty state. */
export function replay(actions: GuardianAction[]): GuardianState {
  let state = defaultState();
  state.meta.hash = computeHash(state);
  for (const action of actions) {
    state = reduce(state, action);
  }
  return state;
}

/** Rebuild state.json from the action log (the recovery path for manual edits). */
export async function rebuild(workspaceRoot: string): Promise<GuardianState> {
  const p = getGuardianPaths(workspaceRoot);
  const actions = await loadActions(workspaceRoot);
  const state = replay(actions);
  await writeJsonAtomic(p.state, state);
  await writeJsonAtomic(p.contract, contractProjection(state));
  return state;
}
