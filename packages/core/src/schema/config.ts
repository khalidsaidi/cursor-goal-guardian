import { z } from "zod";

/**
 * Advisory-legible severity vocabulary. Goal Guardian never blocks;
 * severities only shape what gets recorded and (rarely) nudged.
 */
export const advisorySeveritySchema = z.enum(["ok", "caution", "alert"]);

export const policyRuleSchema = z
  .object({
    pattern: z.string().min(1),
    severity: advisorySeveritySchema,
    reason: z.string().optional(),
  })
  .strict();

export const notifyModeSchema = z.enum(["quiet", "balanced", "vocal"]);

export const configSchema = z
  .object({
    schemaVersion: z.literal(2).default(2),
    /** quiet = record only, zero injected messages; balanced = episode-gated nudges; vocal = nudge every advisory. */
    notify: notifyModeSchema.default("balanced"),
    nudgeCooldownMinutes: z.number().positive().default(10),
    drift: z
      .object({
        lexical: z
          .object({
            enabled: z.boolean().default(true),
            sensitivity: z.enum(["strict", "balanced", "lenient"]).default("balanced"),
          })
          .strict()
          .default({}),
        semantic: z
          .object({
            judge: z.literal("cursor-agent").default("cursor-agent"),
            batchSize: z.number().int().positive().default(10),
            debounceSeconds: z.number().positive().default(30),
            sessionCallCap: z.number().int().positive().default(20),
            /** Whole-tape review: the judge periodically reads recent raw actions
             *  against the goal, catching in-vocabulary drift lexical scoring cannot. */
            sessionReview: z
              .object({
                enabled: z.boolean().default(true),
                minNewActions: z.number().int().positive().default(10),
                maxActions: z.number().int().positive().default(30),
              })
              .strict()
              .default({}),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    /** The end-of-turn done check: the agent closes every turn that changed
     *  something with a `## Done check` (or `## Blocked`) block, checked in code
     *  against the tape. off = no protocol, no check; advisory = record and show
     *  in the panel; enforce = also send the agent back (Cursor's stop-hook
     *  follow-up) when the block is absent, malformed, or contradicted. */
    doneCheck: z
      .object({
        mode: z.enum(["off", "advisory", "enforce"]).default("off"),
        /** Follow-ups per turn before giving up (Cursor also caps at its loop_limit). */
        maxFollowups: z.number().int().min(1).max(10).default(3),
        /** Enforce: when a block is honest but leaves "done when" items open that the agent itself holds,
         *  send it back to keep going — at most this many times per user turn. 0 = never. */
        continueRounds: z.number().int().min(0).max(10).default(3),
        /** Keep-going rounds over the goal's whole life; at the cap the goal is budget_limited and the agent wraps up. */
        goalRounds: z.number().int().min(1).max(500).default(50),
        /** No model: after a turn that edited files, Guardian re-runs the project's tests in a throwaway copy
         *  (credentials stripped). A turn whose changes break tests that passed without them is flagged; in
         *  enforce mode a "done" over broken tests sends the agent back. Runs even with mode "off". */
        tests: z
          .object({
            enabled: z.boolean().default(true),
            /** When it is not `npm test` (package.json "test" script). */
            command: z.string().min(1).optional(),
            /** Per run; a failing run is repeated once without the turn's changes. */
            timeoutSeconds: z.number().int().min(5).max(120).default(60),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    advisories: z
      .object({
        remindWhenNoActiveTask: z.boolean().default(true),
        /** Escalation for drift that is lexically flagged, semantically CONFIRMED,
         *  and continues after a nudge: "ask" hands the decision to the human via
         *  the editor's confirmation UI. Never "deny" — Goal Guardian never blocks;
         *  at most it asks the person. Off by default. */
        escalateConfirmedDrift: z.enum(["off", "ask"]).default("off"),
        shellRules: z.array(policyRuleSchema).default([]),
        mcpRules: z.array(policyRuleSchema).default([]),
        readRules: z.array(policyRuleSchema).default([]),
        /** Extends the built-in neutral-command exemptions (never counted as drift). */
        neutralCommands: z.array(z.string()).default([]),
        neutralPaths: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),
  })
  .strict();

export type AdvisorySeverity = z.infer<typeof advisorySeveritySchema>;
export type PolicyRule = z.infer<typeof policyRuleSchema>;
export type NotifyMode = z.infer<typeof notifyModeSchema>;
export type GuardianConfig = z.infer<typeof configSchema>;

/** Parse a (possibly partial) config file, filling every omitted knob with its default. */
export function parseConfig(value: unknown): GuardianConfig {
  return configSchema.parse(value);
}

export function defaultConfig(): GuardianConfig {
  return configSchema.parse({});
}
