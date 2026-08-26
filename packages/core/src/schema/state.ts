import { z } from "zod";

export const taskStatusSchema = z.enum(["todo", "doing", "done"]);

export const taskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    status: taskStatusSchema,
    criterionId: z.string().min(1).optional(),
  })
  .strict();

export const questionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    ts: z.string(),
    status: z.enum(["open", "closed"]),
  })
  .strict();

export const decisionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    rationale: z.string(),
    ts: z.string(),
  })
  .strict();

export const guardianStateSchema = z
  .object({
    schemaVersion: z.literal(2),
    goal: z.string(),
    successCriteria: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) }).strict()),
    constraints: z.array(z.string()),
    activeTaskId: z.string().nullable(),
    tasks: z.array(taskSchema),
    queue: z.array(z.string()),
    openQuestions: z.array(questionSchema),
    decisions: z.array(decisionSchema),
    pinnedContext: z.array(z.string()),
    meta: z
      .object({
        lastActionId: z.string().nullable(),
        lastUpdated: z.string(),
        actionCount: z.number().int().nonnegative(),
        hash: z.string(),
      })
      .strict(),
  })
  .strict();

export const ACTION_TYPES = [
  "SET_GOAL",
  "ADD_TASKS",
  "START_TASK",
  "COMPLETE_TASK",
  "OPEN_QUESTION",
  "CLOSE_QUESTION",
  "ADD_DECISION",
  "PIN_CONTEXT",
  "UNPIN_CONTEXT",
  "MIGRATE_IMPORT",
] as const;

export const actionTypeSchema = z.enum(ACTION_TYPES);

export const guardianActionSchema = z
  .object({
    id: z.string().min(1),
    ts: z.string(),
    actor: z.enum(["agent", "human", "system"]),
    type: actionTypeSchema,
    payload: z.record(z.unknown()),
  })
  .strict();

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type GuardianState = z.infer<typeof guardianStateSchema>;
export type ActionType = z.infer<typeof actionTypeSchema>;
export type GuardianAction = z.infer<typeof guardianActionSchema>;

export function parseState(value: unknown): GuardianState {
  return guardianStateSchema.parse(value);
}

export function parseAction(value: unknown): GuardianAction {
  return guardianActionSchema.parse(value);
}

export function defaultState(): GuardianState {
  return {
    schemaVersion: 2,
    goal: "",
    successCriteria: [],
    constraints: [],
    activeTaskId: null,
    tasks: [],
    queue: [],
    openQuestions: [],
    decisions: [],
    pinnedContext: [],
    meta: {
      lastActionId: null,
      lastUpdated: "",
      actionCount: 0,
      hash: "",
    },
  };
}
