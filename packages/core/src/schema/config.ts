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
