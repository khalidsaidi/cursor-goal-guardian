import { z } from "zod";

export const configSchema = z
  .object({
    schemaVersion: z.literal(2).default(2),
    learning: z.object({ dailyCallLimit: z.number().int().min(0).max(256).optional(), callLimit: z.number().int().min(0).max(256).optional() }).strict().optional(),
  })
  .strict();

export type GuardianConfig = z.infer<typeof configSchema>;

/** Parse a config file. Workspaces set up earlier still have settings for features since removed: those are dropped. */
export function parseConfig(value: unknown): GuardianConfig {
  if (typeof value !== "object" || value === null) return configSchema.parse(value);
  const { schemaVersion, learning } = value as Record<string, unknown>;
  return configSchema.parse({ ...(schemaVersion === undefined ? {} : { schemaVersion }), ...(learning === undefined ? {} : { learning }) });
}

export function defaultConfig(): GuardianConfig {
  return configSchema.parse({});
}
