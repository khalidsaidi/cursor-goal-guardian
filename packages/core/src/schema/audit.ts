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
    // Legacy: the Windows observer marked its records. Never written; kept so older logs still parse.
    source: z.literal("observer").optional(),
  })
  .strict();

/** Legacy: word-matching flags were removed. Never written; kept so older logs still parse. */
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

/** Legacy: policy advisories were removed. Never written; kept so older logs still parse. */
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

/** Legacy: the intent tool was removed. Never written; kept so older logs still parse. */
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

/** The raw tape: every substantive action. */
export const actionObservedRecordSchema = z
  .object({
    ...base,
    kind: z.literal("action.observed"),
    // Lets the goal loop and loop detection scope actions to one conversation.
    conversationId: z.string().optional(),
    actionType: z.enum(["shell", "mcp", "edit"]),
    actionValue: z.string(),
    // Legacy, as on hook.event.
    source: z.literal("observer").optional(),
  })
  .strict();

/** Legacy: loop detection was removed. Never written; kept so older logs still parse. */
export const loopRepeatRecordSchema = z
  .object({
    ...base,
    kind: z.literal("loop.repeat"),
    conversationId: z.string().optional(),
    command: z.string(),
    count: z.number().int().positive(),
  })
  .strict();

/** One way the agent says a "done when" item is proved. Guardian checks it against its own record. */
export const goalProofSchema = z
  .object({
    criterion: z.string(),
    command: z.string().optional(),
    /** Legacy caller quote; command evidence comes from the recorded run instead. */
    quote: z.string().optional(),
    /** Filled by Guardian, identifying the recorded command result used. */
    recordedAt: z.string().optional(),
    file: z.string().optional(),
    contains: z.string().optional(),
  })
  .strict();

/** The agent's report on the goal, in its own words: a claim until Guardian checks it. */
export const goalReportRecordSchema = z
  .object({
    ...base,
    kind: z.literal("goal.report"),
    /** The goal this report is about: a report on a goal the user has since changed doesn't count. */
    goalHash: z.string().optional(),
    status: z.enum(["complete", "blocked", "set_aside", "paused"]),
    proofs: z.array(goalProofSchema),
    changes: z.array(z.object({ file: z.string(), serves: z.string() }).strict()),
    /** Files that lost most of their lines, which the agent says the goal or the user asked for. */
    removed: z.array(z.string()).optional(),
    reason: z.string().optional(),
    userWords: z.string().optional(),
  })
  .strict();

/** The goal was paused, resumed or closed. The user does these from the panel; the agent can only pause, and only on the user's quoted request. */
export const goalControlRecordSchema = z
  .object({
    ...base,
    kind: z.literal("goal.control"),
    goalHash: z.string(),
    operation: z.enum(["pause", "resume", "done"]),
    actor: z.enum(["user", "agent"]),
  })
  .strict();

/** What this chat has already been told about the goal mid-turn, so each change is said once. */
/** Guardian recorded the user's own message as the goal. */
export const goalSetRecordSchema = z
  .object({
    ...base,
    kind: z.literal("goal.set"),
    conversationId: z.string().optional(),
    goalHash: z.string(),
  })
  .strict();

/**
 * The goal as Guardian itself last wrote it, on the user's authority: their request, their change in chat checked
 * against their words, or the panel. The contract file is compared with this; a difference nobody authorised is undone.
 */
export const goalAuthorizedRecordSchema = z
  .object({
    ...base,
    kind: z.literal("goal.authorized"),
    goal: z.string(),
    successCriteria: z.array(z.object({ id: z.string(), text: z.string() }).strict()),
    constraints: z.array(z.string()),
  })
  .strict();

/** The contract file had been changed by something other than the user, and was put back. */
export const goalRestoredRecordSchema = z
  .object({
    ...base,
    kind: z.literal("goal.restored"),
    conversationId: z.string().optional(),
    /** What the file said, briefly, so the user can see what was attempted. */
    found: z.string(),
  })
  .strict();

export const goalNoticeRecordSchema = z
  .object({
    ...base,
    kind: z.literal("goal.notice"),
    conversationId: z.string(),
    goalHash: z.string(),
    phase: z.string(),
  })
  .strict();

/** The user sent a message: what counts as "this turn" starts here. Dirty files are those already changed at that point. */
export const userMessageRecordSchema = z
  .object({
    ...base,
    kind: z.literal("user.message"),
    conversationId: z.string().optional(),
    /** Cursor's chat mode. Cmd+K sends none. */
    mode: z.string().optional(),
    dirty: z.array(z.string()).optional(),
    /** The commit the project was on when the message arrived, so work committed during the turn is still seen. */
    head: z.string().optional(),
  })
  .strict();

/** Guardian sent the agent back, with the facts it sent. */
export const goalRoundRecordSchema = z
  .object({
    ...base,
    kind: z.literal("goal.round"),
    conversationId: z.string(),
    goalHash: z.string(),
    round: z.number().int().positive(),
    /** Nothing changed since the round before: no edit, same files, same open items. */
    idle: z.boolean(),
    tree: z.string().optional(),
    tokens: z.number().int().nonnegative().optional(),
    unproved: z.array(z.string()),
    unclaimed: z.array(z.string()),
    extras: z.array(z.string()),
    /** What the independent reviewer objected to, sent back with this round. */
    reviewer: z.array(z.string()).optional(),
    goalFileEdited: z.boolean().optional(),
    /** What each part said that let this round start: Guardian's own gates, DeepSeek's round driver, Codex's scheduling. */
    decidedBy: z.object({ guardian: z.string(), deepseek: z.string(), codex: z.string() }).strict().optional(),
    /**
     * Guardian called DeepSeek's `resume` to arm the goal in this process. Their armed state lives in one process and
     * every hook call is a new one, so their driver can't start a round without it; Guardian does it only when a real
     * message from the user is on their log since the goal last stopped.
     */
    armedByGuardian: z.boolean().optional(),
  })
  .strict();

/** How a run on the goal ended. Only "proved" means Guardian's record backs every item. */
/** One adversarial review of a "complete" report: whether it ran, and what it objected to. */
export const goalRecoveryRecordSchema = z.object({
  ...base,
  kind: z.literal("goal.recovery"),
  conversationId: z.string().optional(),
  goalHash: z.string(),
  reportTs: z.string(),
  reviewId: z.string().optional(),
  skipped: z.array(z.string()),
}).strict();

export const goalReviewRecordSchema = z
  .object({
    ...base,
    kind: z.literal("goal.review"),
    conversationId: z.string().optional(),
    goalHash: z.string(),
    /** The report it reviewed. */
    reportTs: z.string(),
    /** Names the review for labels and its saved case. */
    id: z.string().optional(),
    /** A replayable copy of what it reviewed was saved, or why not. */
    caseSaved: z.boolean().optional(),
    caseSkipped: z.string().optional(),
    ran: z.boolean(),
    reason: z.string().optional(),
    seconds: z.number().int().nonnegative(),
    fails: z.array(z.object({ id: z.string(), evidence: z.string() }).strict()),
    extra: z.array(z.object({ file: z.string(), what: z.string() }).strict()),
    /** Done-when ids the reviewer gave no clear verdict on. */
    unanswered: z.array(z.string()).optional(),
    /** Version of the fixed completion checks; old cached verdicts cannot satisfy a newer policy. */
    policy: z.string().optional(),
    /** Effective reviewer template, so feedback-driven improvements are not bypassed by old cached checks. */
    reviewerKey: z.string().optional(),
    verdicts: z.array(z.object({ id: z.string(), verdict: z.enum(["holds", "fails", "unclear"]), evidence: z.string() }).strict()).optional(),
    checks: z.array(z.object({ id: z.enum(["build", "public_api", "behavior"]), verdict: z.enum(["holds", "fails", "unclear", "not_applicable"]), evidence: z.string() }).strict()).optional(),
    /** The project state and report this review judged: the same state is never reviewed twice. */
    stateKey: z.string().optional(),
    /** The project's state when it was reviewed, so a later change can be told from an objection ignored. */
    tree: z.string().optional(),
    /** Google ADK's evaluator on the same run: the rubrics it judged and those it judged not met. */
    evaluator: z
      .object({
        ran: z.boolean(),
        reason: z.string().optional(),
        overall: z.number().nullable(),
        rubrics: z.number().int().nonnegative(),
        failed: z.array(z.object({ id: z.string(), property: z.string(), rationale: z.string() }).strict()),
        unanswered: z.array(z.string()).optional(),
        calls: z.number().int().nonnegative(),
        seconds: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /** The reviewer's check, against the project, of what the evaluator alone objected to. */
    adjudication: z
      .object({
        ran: z.boolean(),
        reason: z.string().optional(),
        seconds: z.number().int().nonnegative(),
        confirmed: z.array(z.object({ id: z.string(), evidence: z.string() }).strict()),
        dismissed: z.array(z.object({ id: z.string(), property: z.string(), rationale: z.string(), evidence: z.string() }).strict()),
        unclear: z.array(z.string()),
      })
      .strict()
      .optional(),
    /** Written by an earlier second check that the evaluator replaced. Still read so old records parse; never used. */
    monitor: z
      .object({
        ran: z.boolean(),
        reason: z.string().optional(),
        hierarchical: z.number().nullable(),
        sequential: z.number().nullable(),
        hybrid: z.number().nullable(),
        summary: z.string(),
        calls: z.number().int().nonnegative(),
        seconds: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** The user's verdict on one of the reviewer's objections. */
export const reviewFeedbackRecordSchema = z
  .object({
    ...base,
    kind: z.literal("review.feedback"),
    reviewId: z.string(),
    index: z.number().int().nonnegative(),
    /** right and wrong judge an objection; missed says a review that passed should have objected. */
    label: z.enum(["right", "wrong", "missed"]),
  })
  .strict();

const improveScoreSchema = z.object({ correct: z.number().int().nonnegative(), catches: z.number().int().nonnegative() }).strict();

/** The user asked Guardian to try improving its reviewer. */
export const improveStartRecordSchema = z
  .object({
    ...base,
    kind: z.literal("improve.start"),
    id: z.string(),
    /** Started by Guardian itself once enough verdicts had come in. */
    auto: z.boolean().optional(),
    /** What the run is expected to spend on the user's Cursor plan: reviews replayed, and model calls for the search at most. */
    reviews: z.number().int().nonnegative().optional(),
    searchCallsMax: z.number().int().nonnegative().optional(),
    callLimit: z.number().int().nonnegative().optional(),
  })
  .strict();

/** How far an improvement run has got, for the panel. */
export const improveProgressRecordSchema = z.object({ ...base, kind: z.literal("improve.progress"), id: z.string(), stage: z.string() }).strict();

/** One try at improving the reviewer: what was proposed, how both versions did on held-out cases, and the call. */
export const improveRunRecordSchema = z
  .object({
    ...base,
    kind: z.literal("improve.run"),
    id: z.string(),
    /** The labelled cases this run learned from, as one fingerprint: a new batch of labels gives a new one. */
    labels: z.string().optional(),
    /** Started by Guardian itself, not by a click. */
    auto: z.boolean().optional(),
    kept: z.boolean(),
    reason: z.string(),
    train: z.number().int().nonnegative(),
    heldOut: z.number().int().nonnegative(),
    old: improveScoreSchema.optional(),
    new: improveScoreSchema.optional(),
    lostCatches: z.number().int().nonnegative().optional(),
    seconds: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    hypotheses: z.array(z.string()),
    diff: z.string(),
  })
  .strict();

/** The user switched the workspace to an improved reviewer, or back to the built-in one. */
export const improveApplyRecordSchema = z.object({ ...base, kind: z.literal("improve.apply"), runId: z.string(), auto: z.boolean().optional() }).strict();
export const improveUndoRecordSchema = z.object({ ...base, kind: z.literal("improve.undo") }).strict();

export const goalEndRecordSchema = z
  .object({
    ...base,
    kind: z.literal("goal.end"),
    conversationId: z.string(),
    goalHash: z.string(),
    /**
     * proved: both goal keepers accepted the completion and both checks ran clean. unchecked: both accepted, but a
     * check didn't run or the last state wasn't reviewed. disputed: the review still objects to the very state
     * reported, after its reviews ran out. unverified: a goal keeper's own code didn't run, so nothing could be accepted.
     */
    outcome: z.enum(["proved", "unchecked", "disputed", "unverified", "blocked", "set_aside", "stalled", "limit", "stopped", "budget_limited"]),
    /** Whose rule ended the run, where it wasn't the agent's own report: Guardian's stall rule, Cursor's follow-up limit, or a goal keeper. */
    by: z.enum(["guardian", "cursor", "deepseek", "codex"]).optional(),
    /** Checks that didn't run on this state, each with why. */
    skipped: z.array(z.string()).optional(),
    /** For a disputed end: the project state and report it was about. The same state reported again stays disputed. */
    stateKey: z.string().optional(),
    /** Actual project contents when this run closed, for checking later repairs after an unchecked end. */
    tree: z.string().optional(),
    /** A block accepted on the first turn, in a turn the user's message opened: by DeepSeek's rule, at the agent's word alone. */
    atAgentsWord: z.boolean().optional(),
    rounds: z.number().int().nonnegative().optional(),
    seconds: z.number().int().nonnegative().optional(),
    tokens: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
    proved: z.array(goalProofSchema).optional(),
    /** Requested items established by the finished-work checks; separate from captured command references. */
    verifiedItems: z.array(z.string()).optional(),
    unproved: z.array(z.string()).optional(),
    extras: z.array(z.string()).optional(),
    /** Every changed file and the done-when item the agent says it serves, for the user to look over. */
    changes: z.array(z.object({ file: z.string(), serves: z.string() }).strict()).optional(),
    removed: z.array(z.string()).optional(),
    /** The review's last objections, if it still objected when its reviews ran out and nothing changed after: the user's call. */
    reviewer: z.array(z.string()).optional(),
    /** The last review objected and the project changed afterwards: that final state was not reviewed again. */
    changedSinceReview: z.boolean().optional(),
    goalFileEdited: z.boolean().optional(),
    /** The agent never reported in this run, so asking again in this chat would only repeat it. */
    noReport: z.boolean().optional(),
  })
  .strict();

/**
 * One event of DeepSeek Harness's own session log for this workspace's goal, exactly as its services produced it
 * (goal/change, the turn and user-message events of an admitted goal round, its seed markers). Guardian stores
 * them; DeepSeek's fold reads them. `reset` starts the log over after one their replay rejected.
 */
export const goalEngineRecordSchema = z
  .object({
    ...base,
    kind: z.literal("goal.engine"),
    event: z.record(z.unknown()).optional(),
    reset: z.boolean().optional(),
  })
  .strict();

/**
 * A change to the goal that didn't happen because one of the two goal keepers running side by side (DeepSeek
 * Harness's service, Codex's extension) or Guardian's own check refused it. `by` names who.
 */
export const goalRefusedRecordSchema = z
  .object({
    ...base,
    kind: z.literal("goal.refused"),
    conversationId: z.string().optional(),
    goalHash: z.string(),
    change: z.string(),
    by: z.enum(["deepseek", "codex", "guardian"]),
    message: z.string(),
  })
  .strict();

/** What Codex's extension said at one stop: ran or skipped (and why), and its decision. */
export const goalPartnersRecordSchema = z
  .object({
    ...base,
    kind: z.literal("goal.partners"),
    conversationId: z.string(),
    goalHash: z.string(),
    codex: z.object({ ran: z.boolean(), reason: z.string().optional(), continues: z.boolean().optional(), status: z.string().optional() }).strict(),
  })
  .strict();

export const auditRecordSchema = z.discriminatedUnion("kind", [
  goalRefusedRecordSchema,
  goalPartnersRecordSchema,
  goalEngineRecordSchema,
  hookEventRecordSchema,
  lexicalDriftRecordSchema,
  policyAdvisoryRecordSchema,
  intentDeclaredRecordSchema,
  actionObservedRecordSchema,
  loopRepeatRecordSchema,
  goalReportRecordSchema,
  userMessageRecordSchema,
  goalControlRecordSchema,
  goalNoticeRecordSchema,
  goalSetRecordSchema,
  goalAuthorizedRecordSchema,
  goalRestoredRecordSchema,
  goalRoundRecordSchema,
  goalEndRecordSchema,
  goalReviewRecordSchema,
  goalRecoveryRecordSchema,
  reviewFeedbackRecordSchema,
  improveStartRecordSchema,
  improveRunRecordSchema,
  improveProgressRecordSchema,
  improveApplyRecordSchema,
  improveUndoRecordSchema,
]);

export type GoalRefusedRecord = z.infer<typeof goalRefusedRecordSchema>;
export type GoalPartnersRecord = z.infer<typeof goalPartnersRecordSchema>;
export type HookEventName = z.infer<typeof hookEventNameSchema>;
export type HookEventRecord = z.infer<typeof hookEventRecordSchema>;
export type LexicalDriftRecord = z.infer<typeof lexicalDriftRecordSchema>;
export type PolicyAdvisoryRecord = z.infer<typeof policyAdvisoryRecordSchema>;
export type IntentDeclaredRecord = z.infer<typeof intentDeclaredRecordSchema>;
export type ActionObservedRecord = z.infer<typeof actionObservedRecordSchema>;
export type GoalProof = z.infer<typeof goalProofSchema>;
export type GoalReportRecord = z.infer<typeof goalReportRecordSchema>;
export type GoalRoundRecord = z.infer<typeof goalRoundRecordSchema>;
export type UserMessageRecord = z.infer<typeof userMessageRecordSchema>;
export type GoalControlRecord = z.infer<typeof goalControlRecordSchema>;
export type GoalEndRecord = z.infer<typeof goalEndRecordSchema>;
export type GoalReviewRecord = z.infer<typeof goalReviewRecordSchema>;
export type ReviewFeedbackRecord = z.infer<typeof reviewFeedbackRecordSchema>;
export type ImproveRunRecord = z.infer<typeof improveRunRecordSchema>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;

export function parseAuditRecord(value: unknown): AuditRecord {
  return auditRecordSchema.parse(value);
}
