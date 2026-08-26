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

export const auditRecordSchema = z.discriminatedUnion("kind", [
  hookEventRecordSchema,
  lexicalDriftRecordSchema,
  driftVerdictRecordSchema,
  policyAdvisoryRecordSchema,
  intentDeclaredRecordSchema,
]);

export type HookEventName = z.infer<typeof hookEventNameSchema>;
export type HookEventRecord = z.infer<typeof hookEventRecordSchema>;
export type LexicalDriftRecord = z.infer<typeof lexicalDriftRecordSchema>;
export type DriftVerdictRecord = z.infer<typeof driftVerdictRecordSchema>;
export type PolicyAdvisoryRecord = z.infer<typeof policyAdvisoryRecordSchema>;
export type IntentDeclaredRecord = z.infer<typeof intentDeclaredRecordSchema>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;

export function parseAuditRecord(value: unknown): AuditRecord {
  return auditRecordSchema.parse(value);
}
