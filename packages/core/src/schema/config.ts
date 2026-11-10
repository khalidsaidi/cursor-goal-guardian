import { z } from "zod";

export const configSchema = z
  .object({
    schemaVersion: z.literal(2).default(2),
  })
  .strict();

export type GuardianConfig = z.infer<typeof configSchema>;

/** Parse a config file. Workspaces set up earlier still have settings for features since removed: those are dropped. */
export function parseConfig(value: unknown): GuardianConfig {
  if (typeof value !== "object" || value === null) return configSchema.parse(value);
  const { schemaVersion } = value as Record<string, unknown>;
  return configSchema.parse(schemaVersion === undefined ? {} : { schemaVersion });
}

export function defaultConfig(): GuardianConfig {
  return configSchema.parse({});
}
