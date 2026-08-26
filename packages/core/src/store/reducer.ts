import { z } from "zod";
import {
  guardianStateSchema,
  type GuardianAction,
  type GuardianState,
} from "../schema/state.js";
import { computeHash } from "./hash.js";
import { StateError } from "./errors.js";

/**
 * The reducer is deterministic: every id and timestamp comes from the action,
 * never from randomness or the wall clock, so `replay(actions)` always
 * reproduces the exact state. (v1 generated ids inside the reducer, which
 * silently broke replay.)
 *
 * Invariants are constants, not configuration — they are the product's opinion:
 * - singleActiveTask: at most one task is `doing`, tracked by activeTaskId
 * - requireDecisionForTaskSwitch: switching the active task cites a decision
 * - disallowTodoToDone: tasks are started before they are completed
 */

const setGoalPayload = z.object({
  goal: z.string().optional(),
  successCriteria: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) }).strict()).optional(),
  constraints: z.array(z.string()).optional(),
});

const addTasksPayload = z.object({
  tasks: z.array(
    z
      .object({
        id: z.string().min(1),
        title: z.string().min(1),
        criterionId: z.string().min(1).optional(),
      })
      .strict(),
  ),
});

const startTaskPayload = z.object({ taskId: z.string().min(1), decisionId: z.string().optional() });
const completeTaskPayload = z.object({ taskId: z.string().min(1), allowSkip: z.boolean().optional() });
const openQuestionPayload = z.object({ id: z.string().min(1), text: z.string().min(1) });
const closeQuestionPayload = z.object({ id: z.string().min(1) });
const addDecisionPayload = z.object({ id: z.string().min(1), text: z.string().min(1), rationale: z.string() });
const pinPayload = z.object({ path: z.string().min(1) });

const migrateImportPayload = z.object({
  state: guardianStateSchema.omit({ meta: true }),
});

function parsePayload<T>(schema: z.ZodType<T>, action: GuardianAction): T {
  const result = schema.safeParse(action.payload);
  if (!result.success) {
    throw new StateError(
      "INVALID_PAYLOAD",
      `Invalid payload for ${action.type}: ${result.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return result.data;
}

export function reduce(state: GuardianState, action: GuardianAction): GuardianState {
  const next: GuardianState = JSON.parse(JSON.stringify(state)) as GuardianState;

  switch (action.type) {
    case "SET_GOAL": {
      const p = parsePayload(setGoalPayload, action);
      if (p.goal !== undefined) next.goal = p.goal;
      if (p.successCriteria !== undefined) next.successCriteria = p.successCriteria;
      if (p.constraints !== undefined) next.constraints = p.constraints;
      break;
    }
    case "ADD_TASKS": {
      const p = parsePayload(addTasksPayload, action);
      for (const t of p.tasks) {
        if (next.tasks.some((x) => x.id === t.id)) continue;
        next.tasks.push({ id: t.id, title: t.title, status: "todo", ...(t.criterionId ? { criterionId: t.criterionId } : {}) });
        next.queue.push(t.id);
      }
      break;
    }
    case "START_TASK": {
      const p = parsePayload(startTaskPayload, action);
      const task = next.tasks.find((t) => t.id === p.taskId);
      if (!task) throw new StateError("TASK_NOT_FOUND", `Task not found: ${p.taskId}`);
      if (next.activeTaskId && next.activeTaskId !== p.taskId) {
        const cited = p.decisionId && next.decisions.some((d) => d.id === p.decisionId);
        if (!cited) {
          throw new StateError(
            "DECISION_REQUIRED",
            "Switching the active task requires citing a recorded decision (decisionId).",
          );
        }
        const previous = next.tasks.find((t) => t.id === next.activeTaskId);
        if (previous && previous.status === "doing") previous.status = "todo";
      }
      next.activeTaskId = task.id;
      task.status = "doing";
      break;
    }
    case "COMPLETE_TASK": {
      const p = parsePayload(completeTaskPayload, action);
      const task = next.tasks.find((t) => t.id === p.taskId);
      if (!task) throw new StateError("TASK_NOT_FOUND", `Task not found: ${p.taskId}`);
      if (task.status === "todo" && !p.allowSkip) {
        throw new StateError("TODO_TO_DONE", "Cannot complete a task that has not been started.");
      }
      task.status = "done";
      if (next.activeTaskId === task.id) next.activeTaskId = null;
      next.queue = next.queue.filter((id) => id !== task.id);
      break;
    }
    case "OPEN_QUESTION": {
      const p = parsePayload(openQuestionPayload, action);
      next.openQuestions.push({ id: p.id, text: p.text, ts: action.ts, status: "open" });
      break;
    }
    case "CLOSE_QUESTION": {
      const p = parsePayload(closeQuestionPayload, action);
      const q = next.openQuestions.find((x) => x.id === p.id);
      if (!q) throw new StateError("QUESTION_NOT_FOUND", `Question not found: ${p.id}`);
      q.status = "closed";
      break;
    }
    case "ADD_DECISION": {
      const p = parsePayload(addDecisionPayload, action);
      next.decisions.push({ id: p.id, text: p.text, rationale: p.rationale, ts: action.ts });
      break;
    }
    case "PIN_CONTEXT": {
      const p = parsePayload(pinPayload, action);
      if (!next.pinnedContext.includes(p.path)) next.pinnedContext.push(p.path);
      break;
    }
    case "UNPIN_CONTEXT": {
      const p = parsePayload(pinPayload, action);
      next.pinnedContext = next.pinnedContext.filter((x) => x !== p.path);
      break;
    }
    case "MIGRATE_IMPORT": {
      const p = parsePayload(migrateImportPayload, action);
      Object.assign(next, p.state);
      break;
    }
  }

  next.meta = {
    lastActionId: action.id,
    lastUpdated: action.ts,
    actionCount: state.meta.actionCount + 1,
    hash: "",
  };
  next.meta.hash = computeHash(next);
  return guardianStateSchema.parse(next);
}
