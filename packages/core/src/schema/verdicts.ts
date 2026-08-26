import { z } from "zod";

export const verdictEntrySchema = z
  .object({
    verdict: z.enum(["confirmed", "dismissed"]),
    judge: z.string().min(1),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
    ts: z.string(),
  })
  .strict();

/** Semantic judge cache, keyed by driftId. A drift present here is never re-judged. */
export const verdictCacheSchema = z
  .object({
    schemaVersion: z.literal(2),
    entries: z.record(verdictEntrySchema),
  })
  .strict();

export type VerdictEntry = z.infer<typeof verdictEntrySchema>;
export type VerdictCache = z.infer<typeof verdictCacheSchema>;

export function parseVerdictCache(value: unknown): VerdictCache {
  return verdictCacheSchema.parse(value);
}

export function emptyVerdictCache(): VerdictCache {
  return { schemaVersion: 2, entries: {} };
}
