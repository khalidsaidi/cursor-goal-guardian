import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";

export type AgentTaskStatus = "todo" | "doing" | "done";

export type AgentTask = {
  id: string;
  title: string;
  status: AgentTaskStatus;
};

export type AgentDecision = {
  id: string;
  text: string;
  rationale: string;
  ts: string;
};

export type AgentQuestion = {
  id: string;
  text: string;
  ts: string;
  status: "open" | "closed";
};

export type AgentState = {
  schemaVersion: number;
  goal: string;
  definition_of_done: string[];
  constraints: string[];
  active_task: string | null;
  tasks: AgentTask[];
  queue: string[];
  open_questions: AgentQuestion[];
  decisions: AgentDecision[];
  pinned_context: string[];
  _meta: {
    lastActionId: string | null;
    lastUpdated: string;
    actionCount: number;
    hash: string;
  };
};

export type AgentAction = {
  id: string;
  ts: string;
  actor: "agent" | "human";
  type: string;
  payload: Record<string, unknown>;
};

export type RulesConfig = {
  preferredReducer: "json" | "js";
  strictMode: boolean;
  snapshotInterval: number;
  syncContractFromState: boolean;
  invariants: {
    singleActiveTask: boolean;
    requireDecisionForTaskSwitch: boolean;
    disallowTodoToDone: boolean;
  };
};

type Snapshot = {
  lastActionIndex: number;
  state: AgentState;
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

const actionSchema: Record<string, unknown> = {
  type: "object",
  required: ["id", "ts", "actor", "type", "payload"],
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    ts: { type: "string" },
    actor: { type: "string", enum: ["agent", "human"] },
    type: { type: "string" },
    payload: { type: "object", additionalProperties: true },
  },
};

const stateSchema: Record<string, unknown> = {
  type: "object",
  required: [
    "schemaVersion",
    "goal",
    "definition_of_done",
    "constraints",
    "active_task",
    "tasks",
    "queue",
    "open_questions",
    "decisions",
    "pinned_context",
    "_meta",
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "number" },
    goal: { type: "string" },
    definition_of_done: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    active_task: { type: ["string", "null"] },
    tasks: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "status"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          status: { type: "string", enum: ["todo", "doing", "done"] },
        },
      },
    },
    queue: { type: "array", items: { type: "string" } },
    open_questions: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "text", "ts", "status"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          ts: { type: "string" },
          status: { type: "string", enum: ["open", "closed"] },
        },
      },
    },
    decisions: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "text", "rationale", "ts"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          rationale: { type: "string" },
          ts: { type: "string" },
        },
      },
    },
    pinned_context: { type: "array", items: { type: "string" } },
    _meta: {
      type: "object",
      required: ["lastActionId", "lastUpdated", "actionCount", "hash"],
      additionalProperties: false,
      properties: {
        lastActionId: { type: ["string", "null"] },
        lastUpdated: { type: "string" },
        actionCount: { type: "number" },
        hash: { type: "string" },
      },
    },
  },
};

const validateAction = ajv.compile(actionSchema);
const validateState = ajv.compile(stateSchema);

export function getStatePaths(workspaceRoot: string) {
  const dir = path.join(workspaceRoot, ".cursor", "goal-guardian");
  return {
    dir,
    state: path.join(dir, "state.json"),
    actions: path.join(dir, "actions.jsonl"),
    reducer: path.join(dir, "reducer.js"),
    rules: path.join(dir, "rules.json"),
    snapshot: path.join(dir, "snapshot.json"),
    contract: path.join(dir, "contract.json"),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  if (crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `"${k}":${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function computeHash(state: AgentState): string {
  const copy: AgentState = {
    ...state,
    _meta: { ...state._meta, hash: "" },
  };
  const payload = stableStringify(copy);
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function defaultState(): AgentState {
  const base: AgentState = {
    schemaVersion: 1,
    goal: "",
    definition_of_done: [],
    constraints: [],
    active_task: null,
    tasks: [],
    queue: [],
    open_questions: [],
    decisions: [],
    pinned_context: [],
    _meta: {
      lastActionId: null,
      lastUpdated: nowIso(),
      actionCount: 0,
      hash: "",
    },
  };
  base._meta.hash = computeHash(base);
  return base;
}

export function defaultRules(): RulesConfig {
  return {
    preferredReducer: "json",
    strictMode: true,
    snapshotInterval: 25,
    syncContractFromState: true,
    invariants: {
      singleActiveTask: true,
      requireDecisionForTaskSwitch: true,
      disallowTodoToDone: true,
    },
  };
}

export async function ensureStateStoreFiles(workspaceRoot: string): Promise<void> {
  const p = getStatePaths(workspaceRoot);
  await fs.mkdir(p.dir, { recursive: true });

  const stateExists = await exists(p.state);
  if (!stateExists) {
    const seeded = await seedStateFromContract(p.contract);
    await writeJsonAtomic(p.state, seeded ?? defaultState());
  }
  if (!(await exists(p.actions))) {
    await fs.writeFile(p.actions, "", "utf8");
  }
  if (!(await exists(p.rules))) {
    await writeJsonAtomic(p.rules, defaultRules());
  }
  if (!(await exists(p.reducer))) {
    const template = [
      "// Reducer must be pure: (state, action) -> nextState",
      "export default function reducer(state, action) {",
      "  // Example: return state unchanged",
      "  return state;",
      "}",
      "",
    ].join("\n");
    await fs.writeFile(p.reducer, template, "utf8");
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string, fallbackValue: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallbackValue;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${crypto.randomBytes(4).toString("hex")}`);
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

async function seedStateFromContract(contractPath: string): Promise<AgentState | null> {
  try {
    const raw = await fs.readFile(contractPath, "utf8");
    const contract = JSON.parse(raw) as { goal?: string; success_criteria?: string[]; constraints?: string[] };
    const base = defaultState();
    base.goal = contract.goal ?? "";
    base.definition_of_done = contract.success_criteria ?? [];
    base.constraints = contract.constraints ?? [];
    base._meta.lastUpdated = nowIso();
    base._meta.hash = computeHash(base);
    return base;
  } catch {
    return null;
  }
}

export async function loadRules(workspaceRoot: string): Promise<RulesConfig> {
  const p = getStatePaths(workspaceRoot);
  const rules = await readJson<RulesConfig>(p.rules, defaultRules());
  return { ...defaultRules(), ...rules };
}

export async function loadState(workspaceRoot: string): Promise<AgentState> {
  const p = getStatePaths(workspaceRoot);
  const state = await readJson<AgentState>(p.state, defaultState());
  return state;
}

export async function loadActions(workspaceRoot: string): Promise<AgentAction[]> {
  const p = getStatePaths(workspaceRoot);
  try {
    const raw = await fs.readFile(p.actions, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    return lines.map((line) => JSON.parse(line) as AgentAction);
  } catch {
    return [];
  }
}

async function loadSnapshot(workspaceRoot: string): Promise<Snapshot | null> {
  const p = getStatePaths(workspaceRoot);
  if (!(await exists(p.snapshot))) return null;
  return readJson<Snapshot | null>(p.snapshot, null);
}

function validateOrThrow(action: AgentAction) {
  const ok = validateAction(action);
  if (!ok) {
    const msg = ajv.errorsText(validateAction.errors);
    throw new Error(`Invalid action: ${msg}`);
  }
}

function validateStateOrThrow(state: AgentState) {
  const ok = validateState(state);
  if (!ok) {
    const msg = ajv.errorsText(validateState.errors);
    throw new Error(`Invalid state: ${msg}`);
  }
}

async function loadJsReducer(reducerPath: string): Promise<((state: AgentState, action: AgentAction) => AgentState) | null> {
  if (!(await exists(reducerPath))) return null;
  try {
    const url = pathToFileURL(reducerPath).href + `?t=${Date.now()}`;
    const mod: any = await import(url);
    if (typeof mod.default === "function") return mod.default;
    if (typeof mod.reducer === "function") return mod.reducer;
    return null;
  } catch {
    return null;
  }
}

function applyActionJson(state: AgentState, action: AgentAction, rules: RulesConfig): AgentState {
  const next: AgentState = JSON.parse(JSON.stringify(state)) as AgentState;
  const payload = action.payload ?? {};

  switch (action.type) {
    case "SET_GOAL": {
      next.goal = String(payload.goal ?? "");
      next.definition_of_done = Array.isArray(payload.definition_of_done) ? payload.definition_of_done.map(String) : next.definition_of_done;
      next.constraints = Array.isArray(payload.constraints) ? payload.constraints.map(String) : next.constraints;
      break;
    }
    case "ADD_TASKS": {
      const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      for (const t of tasks) {
        const id = String(t.id ?? newId("task"));
        if (next.tasks.some((x) => x.id === id)) continue;
        next.tasks.push({ id, title: String(t.title ?? "Untitled task"), status: "todo" });
        next.queue.push(id);
      }
      break;
    }
    case "START_TASK": {
      const taskId = String(payload.taskId ?? "");
      const task = next.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (rules.invariants.singleActiveTask && next.active_task && next.active_task !== taskId) {
        if (rules.invariants.requireDecisionForTaskSwitch) {
          const decisionId = String(payload.decision_id ?? "");
          const hasDecision = next.decisions.some((d) => d.id === decisionId);
          if (!hasDecision) {
            throw new Error("Decision required to switch active task.");
          }
        }
      }
      next.active_task = taskId;
      task.status = "doing";
      break;
    }
    case "COMPLETE_TASK": {
      const taskId = String(payload.taskId ?? "");
      const task = next.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (rules.invariants.disallowTodoToDone && task.status === "todo" && !payload.allowSkip) {
        throw new Error("Cannot complete a task that has not been started.");
      }
      task.status = "done";
      if (next.active_task === taskId) next.active_task = null;
      next.queue = next.queue.filter((id) => id !== taskId);
      break;
    }
    case "OPEN_QUESTION": {
      const text = String(payload.text ?? "");
      if (!text) throw new Error("OPEN_QUESTION requires text.");
      next.open_questions.push({ id: newId("q"), text, ts: nowIso(), status: "open" });
      break;
    }
    case "CLOSE_QUESTION": {
      const id = String(payload.id ?? "");
      const q = next.open_questions.find((x) => x.id === id);
      if (!q) throw new Error(`Question not found: ${id}`);
      q.status = "closed";
      break;
    }
    case "ADD_DECISION": {
      const text = String(payload.text ?? "");
      const rationale = String(payload.rationale ?? "");
      if (!text || !rationale) throw new Error("ADD_DECISION requires text and rationale.");
      next.decisions.push({ id: newId("dec"), text, rationale, ts: nowIso() });
      break;
    }
    case "PIN_CONTEXT": {
      const p = String(payload.path ?? "");
      if (p && !next.pinned_context.includes(p)) next.pinned_context.push(p);
      break;
    }
    case "UNPIN_CONTEXT": {
      const p = String(payload.path ?? "");
      next.pinned_context = next.pinned_context.filter((x) => x !== p);
      break;
    }
    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }

  next._meta.lastActionId = action.id;
  next._meta.lastUpdated = nowIso();
  next._meta.actionCount = state._meta.actionCount + 1;
  next._meta.hash = computeHash(next);
  validateStateOrThrow(next);
  return next;
}

export async function reduceAction(
  workspaceRoot: string,
  state: AgentState,
  action: AgentAction
): Promise<AgentState> {
  validateOrThrow(action);
  const rules = await loadRules(workspaceRoot);
  const p = getStatePaths(workspaceRoot);

  if (rules.preferredReducer === "js") {
    const reducer = await loadJsReducer(p.reducer);
    if (reducer) {
      const next = reducer(state, action);
      validateStateOrThrow(next);
      return next;
    }
  }

  return applyActionJson(state, action, rules);
}

export async function dispatchAction(
  workspaceRoot: string,
  partial: Omit<AgentAction, "id" | "ts"> & { id?: string; ts?: string }
): Promise<AgentState> {
  const p = getStatePaths(workspaceRoot);
  const rules = await loadRules(workspaceRoot);
  await ensureStateStoreFiles(workspaceRoot);
  const current = await loadState(workspaceRoot);

  if (rules.strictMode) {
    const currentHash = computeHash(current);
    if (current._meta.hash && current._meta.hash !== currentHash) {
      throw new Error("State file was edited manually. Rebuild state before dispatching new actions.");
    }
  }

  const action: AgentAction = {
    id: partial.id ?? newId("act"),
    ts: partial.ts ?? nowIso(),
    actor: partial.actor ?? "agent",
    type: partial.type,
    payload: partial.payload ?? {},
  };

  const next = await reduceAction(workspaceRoot, current, action);
  await appendAction(p.actions, action);
  await writeJsonAtomic(p.state, next);

  if (rules.syncContractFromState) {
    await syncContractFromState(p.contract, next);
  }

  if (rules.snapshotInterval > 0) {
    const actions = await loadActions(workspaceRoot);
    if (actions.length % rules.snapshotInterval === 0) {
      const snapshot: Snapshot = { lastActionIndex: actions.length - 1, state: next };
      await writeJsonAtomic(p.snapshot, snapshot);
    }
  }

  return next;
}

export async function rebuildState(workspaceRoot: string): Promise<AgentState> {
  const p = getStatePaths(workspaceRoot);
  await ensureStateStoreFiles(workspaceRoot);
  const rules = await loadRules(workspaceRoot);
  const snapshot = await loadSnapshot(workspaceRoot);
  const actions = await loadActions(workspaceRoot);

  let state = snapshot ? snapshot.state : await seedStateFromContract(p.contract) ?? defaultState();
  let startIndex = snapshot ? snapshot.lastActionIndex + 1 : 0;

  for (let i = startIndex; i < actions.length; i++) {
    state = await reduceAction(workspaceRoot, state, actions[i]!);
  }

  state._meta.actionCount = actions.length;
  state._meta.lastUpdated = nowIso();
  state._meta.hash = computeHash(state);
  validateStateOrThrow(state);
  await writeJsonAtomic(p.state, state);

  if (rules.syncContractFromState) {
    await syncContractFromState(p.contract, state);
  }

  if (rules.snapshotInterval > 0) {
    const snapshotOut: Snapshot = { lastActionIndex: actions.length - 1, state };
    await writeJsonAtomic(p.snapshot, snapshotOut);
  }

  return state;
}

async function appendAction(filePath: string, action: AgentAction): Promise<void> {
  await fs.appendFile(filePath, JSON.stringify(action) + "\n", "utf8");
}

async function syncContractFromState(contractPath: string, state: AgentState): Promise<void> {
  const payload = {
    goal: state.goal,
    success_criteria: state.definition_of_done,
    constraints: state.constraints,
  };
  await writeJsonAtomic(contractPath, payload);
}
