import { z } from "zod";

export const hookEventNameSchema = z.enum([
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "afterShellExecution",
  "afterAgentResponse",
  "stop",
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
    // Lets the done check scope "did this command run" to one conversation.
    conversationId: z.string().optional(),
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

export const doneLineStatusSchema = z.enum([
  /** Evidence cited and at least one item cross-checked against the tape or the files. */
  "backed",
  /** Evidence in the required form, but nothing a machine can cross-check (e.g. a sample size). */
  "stated",
  /** `does not apply: <reason>`. */
  "waived",
  /** `gap: <what> · closes with: <what> · held by: <who>` — unfinished, declared rather than hidden. */
  "gap",
  /** Cites something the tape or the files contradict: a command that never ran, quoted output it never printed, a missing line. */
  "contradicted",
  /** Bare "n/a" / "verified" / "see above", or prose with no evidence in any accepted form. */
  "unsupported",
  /** A required line is absent. */
  "missing",
]);

/** The deterministic end-of-turn check of the agent's `## Done check` / `## Blocked` block. */
export const doneCheckRecordSchema = z
  .object({
    ...base,
    kind: z.literal("done.check"),
    conversationId: z.string().optional(),
    generationId: z.string().optional(),
    verdict: z.enum(["pass", "fail", "blocked", "absent", "not_required"]),
    /** True when the turn changed something (shell or edit), so a block was owed. */
    required: z.boolean(),
    lines: z.array(
      z
        .object({
          key: z.string().min(1),
          status: doneLineStatusSchema,
          note: z.string(),
        })
        .strict(),
    ),
    /** Form problems outside any single line (duplicate numbers, extra lines, block not last). */
    problems: z.array(z.string()),
    /** Shell/edit actions in the turn — for a Blocked verdict, shows whether anything was attempted. */
    turnActions: z.number().int().nonnegative(),
    /** True when the enforce mode sent the agent back to fix it. */
    followupSent: z.boolean(),
    /** "Done when" items the block left open and the agent itself holds — the goal is not done yet. */
    open: z.array(z.string()).optional(),
    /** True when the follow-up was Guardian's "keep going" toward those open items. */
    continued: z.boolean().optional(),
    /** True when the follow-up was the closing wrap-up request. */
    wrapped: z.boolean().optional(),
    /** Cursor's stop-hook loop_count, when this came from the stop hook. */
    loopCount: z.number().int().nonnegative().optional(),
    source: z.literal("observer").optional(),
    /** The adversarial review of this turn, when it ran. */
  })
  .strict();

/** Guardian's own re-run of the project's tests after a turn that edited files, in a throwaway copy. No model. */
export const testsRerunRecordSchema = z
  .object({
    ...base,
    kind: z.literal("tests.rerun"),
    conversationId: z.string().optional(),
    source: z.literal("observer").optional(),
    command: z.string().min(1),
    exit: z.union([z.number().int(), z.literal("timeout")]),
    /** Same tests with the turn's changes set aside (only run when the first run failed). */
    baselineExit: z.union([z.number().int(), z.literal("timeout")]).optional(),
    /** Failed with the turn's changes, passed without them. */
    broke: z.boolean(),
    /** Tail of the failing run's output. */
    output: z.string().optional(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

/**
 * The goal as a durable, event-sourced object: every change appends a full snapshot with a higher
 * revision; clear appends a tombstone. The latest event is the state.
 */
export const goalPhaseSchema = z.enum(["active", "paused", "blocked", "complete", "budget_limited"]);
export const goalSnapshotSchema = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().positive(),
    objective: z.string(),
    phase: goalPhaseSchema,
    /** Present exactly while blocked: a stable lower-kebab-case code and a human explanation. */
    blockedReason: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().optional(),
    /** Automatic keep-going rounds allowed over the goal's whole life. */
    maxRounds: z.number().int().positive(),
    roundsStarted: z.number().int().nonnegative(),
    /** Complete only counts when Guardian verified it (the agent's own claim is not enough). */
    certified: z.boolean().optional(),
    /** The agent claimed completion (guardian_update_goal); Guardian has not verified it yet. */
    claimedComplete: z.boolean().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export const goalChangeRecordSchema = z
  .object({
    ...base,
    kind: z.literal("goal.change"),
    operation: z.enum(["create", "edit", "pause", "resume", "complete", "claim", "block", "round", "budget", "clear"]),
    actor: z.enum(["user", "agent", "guardian"]),
    goal: goalSnapshotSchema.optional(),
    /** For clear: the goal that was removed. */
    cleared: z.object({ id: z.string(), revision: z.number().int() }).strict().optional(),
  })
  .strict();

/** The agent ran the exact same command `count` times in a row (thresholds 3, 5, 8) — busy without progress. */
export const loopRepeatRecordSchema = z
  .object({
    ...base,
    kind: z.literal("loop.repeat"),
    conversationId: z.string().optional(),
    command: z.string(),
    count: z.number().int().positive(),
  })
  .strict();

/**
 * What happened after Guardian flagged something: a done-check send-back, tests a turn broke, a drift nudge,
 * a keep-going, a loop. Recorded when the outcome is known, or when the user marks the flag wrong.
 */
export const flagOutcomeRecordSchema = z
  .object({
    ...base,
    kind: z.literal("flag.outcome"),
    conversationId: z.string().optional(),
    flag: z.enum(["followup", "tests_broke", "drift", "keep_going", "loop"]),
    /** ts of the record that raised the flag (driftId for drift). */
    ref: z.string().min(1),
    line: z.string().optional(),
    /**
     * fixed = the agent changed files and the flag cleared; corrected = it cleared with no file change
     * (the agent fixed its claim, not the work); tests_green = broken tests pass again; ignored = still
     * there after the agent's answer; marked_wrong = the user says the flag was a false alarm.
     */
    outcome: z.enum(["fixed", "corrected", "tests_green", "ignored", "marked_wrong"]),
    /** Files the agent edited between the flag and the outcome. */
    editsAfter: z.number().int().nonnegative(),
    /** The flag's own words, for the case file. */
    text: z.string().optional(),
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
  doneCheckRecordSchema,
  testsRerunRecordSchema,
  flagOutcomeRecordSchema,
  loopRepeatRecordSchema,
  goalChangeRecordSchema,
]);

export type HookEventName = z.infer<typeof hookEventNameSchema>;
export type HookEventRecord = z.infer<typeof hookEventRecordSchema>;
export type LexicalDriftRecord = z.infer<typeof lexicalDriftRecordSchema>;
export type DriftVerdictRecord = z.infer<typeof driftVerdictRecordSchema>;
export type PolicyAdvisoryRecord = z.infer<typeof policyAdvisoryRecordSchema>;
export type IntentDeclaredRecord = z.infer<typeof intentDeclaredRecordSchema>;
export type ActionObservedRecord = z.infer<typeof actionObservedRecordSchema>;
export type SessionReviewRecord = z.infer<typeof sessionReviewRecordSchema>;
export type DoneLineStatus = z.infer<typeof doneLineStatusSchema>;
export type DoneCheckRecord = z.infer<typeof doneCheckRecordSchema>;
export type TestsRerunRecord = z.infer<typeof testsRerunRecordSchema>;
export type FlagOutcomeRecord = z.infer<typeof flagOutcomeRecordSchema>;
export type GoalSnapshot = z.infer<typeof goalSnapshotSchema>;
export type GoalPhase = z.infer<typeof goalPhaseSchema>;
export type GoalChangeRecord = z.infer<typeof goalChangeRecordSchema>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;

export function parseAuditRecord(value: unknown): AuditRecord {
  return auditRecordSchema.parse(value);
}
