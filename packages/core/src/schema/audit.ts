import { z } from "zod";

export const hookEventNameSchema = z.enum([
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
]);

export const driftActionTypeSchema = z.enum(["shell", "mcp", "read", "edit"]);
export const policyActionTypeSchema = z.enum(["shell", "mcp", "read"]);

const base = {
  ts: z.string(),
};

export const hookEventRecordSchema = z
  .object({
    ...base,
    kind: z.literal("hook.event"),
    event: hookEventNameSchema,
    conversationId: z.string().optional(),
    generationId: z.string().optional(),
    // Absent = Cursor's hook runtime; "observer" = the extension's in-process
    // recorder. The observer uses this to tell live hooks from its own echo.
    source: z.literal("observer").optional(),
  })
  .strict();

export const lexicalDriftRecordSchema = z
  .object({
    ...base,
    kind: z.literal("drift.lexical"),
    driftId: z.string().min(1),
    episodeId: z.string().min(1),
    actionType: driftActionTypeSchema,
    actionValue: z.string(),
    activeTaskId: z.string(),
    activeTaskTitle: z.string(),
    taskTerms: z.array(z.string()),
    actionTerms: z.array(z.string()),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();

export const driftVerdictRecordSchema = z
  .object({
    ...base,
    kind: z.literal("drift.verdict"),
    driftId: z.string().min(1),
    verdict: z.enum(["confirmed", "dismissed"]),
    judge: z.string().min(1),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  })
  .strict();

export const policyAdvisoryRecordSchema = z
  .object({
    ...base,
    kind: z.literal("policy.advisory"),
    severity: z.enum(["caution", "alert"]),
    actionType: policyActionTypeSchema,
    actionValue: z.string(),
    rule: z.string(),
    reason: z.string(),
  })
  .strict();

export const intentDeclaredRecordSchema = z
  .object({
    ...base,
    kind: z.literal("intent.declared"),
    intentId: z.string().min(1),
    taskId: z.string().optional(),
    summary: z.string().min(1),
    plannedActions: z.array(z.string()).optional(),
  })
  .strict();

/** The raw tape: every substantive action, so semantic review can read the session itself. */
export const actionObservedRecordSchema = z
  .object({
    ...base,
    kind: z.literal("action.observed"),
    actionType: z.enum(["shell", "mcp", "edit"]),
    actionValue: z.string(),
    source: z.literal("observer").optional(),
  })
  .strict();

/** A whole-session verdict from the judge over the raw tape — catches in-vocabulary drift no lexical signal can. */
export const sessionReviewRecordSchema = z
  .object({
    ...base,
    kind: z.literal("session.review"),
    verdict: z.enum(["on_course", "off_course"]),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
    judge: z.string().min(1),
    sampledActions: z.number().int().nonnegative(),
    flaggedActions: z.array(z.string()),
  })
  .strict();

export const auditRecordSchema = z.discriminatedUnion("kind", [
  hookEventRecordSchema,
  lexicalDriftRecordSchema,
  driftVerdictRecordSchema,
  policyAdvisoryRecordSchema,
  intentDeclaredRecordSchema,
  actionObservedRecordSchema,
  sessionReviewRecordSchema,
]);

export type HookEventName = z.infer<typeof hookEventNameSchema>;
export type HookEventRecord = z.infer<typeof hookEventRecordSchema>;
export type LexicalDriftRecord = z.infer<typeof lexicalDriftRecordSchema>;
export type DriftVerdictRecord = z.infer<typeof driftVerdictRecordSchema>;
export type PolicyAdvisoryRecord = z.infer<typeof policyAdvisoryRecordSchema>;
export type IntentDeclaredRecord = z.infer<typeof intentDeclaredRecordSchema>;
export type ActionObservedRecord = z.infer<typeof actionObservedRecordSchema>;
export type SessionReviewRecord = z.infer<typeof sessionReviewRecordSchema>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;

export function parseAuditRecord(value: unknown): AuditRecord {
  return auditRecordSchema.parse(value);
}
