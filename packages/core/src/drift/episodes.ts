import { z } from "zod";
import { getGuardianPaths } from "../paths.js";
import { systemClock, newId, nowIso, type Clock } from "../clock.js";
import type { GuardianConfig } from "../schema/config.js";
import { readJsonFile, writeJsonAtomic } from "../fsutil.js";

/**
 * The nudge governor. Consecutive related drift records (same task, overlapping
 * vocabulary) form one *episode*, and an episode earns at most one injected
 * nudge per cooldown window. This is the UX contract that keeps the hook calm:
 * warnings are recorded per action, but the conversation is interrupted per
 * episode at most.
 */

export const episodeSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string(),
    terms: z.array(z.string()),
    firstSeenTs: z.string(),
    lastSeenTs: z.string(),
    lastNudgeTs: z.string().nullable(),
  })
  .strict();

export const episodeStoreSchema = z
  .object({
    schemaVersion: z.literal(2),
    episodes: z.array(episodeSchema),
  })
  .strict();

export type Episode = z.infer<typeof episodeSchema>;
export type EpisodeStore = z.infer<typeof episodeStoreSchema>;

export function emptyEpisodeStore(): EpisodeStore {
  return { schemaVersion: 2, episodes: [] };
}

const EPISODE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EPISODE_TERMS = 24;

export interface EpisodeAssignment {
  episodeId: string;
  /** True when this drift may inject a one-line nudge into the conversation. */
  shouldNudge: boolean;
  store: EpisodeStore;
}

function overlaps(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((t) => set.has(t));
}

/**
 * Assign a drift occurrence to an episode (existing or new) and decide whether
 * it earns a nudge under the configured notify mode. Pure: returns an updated
 * store; the caller persists it.
 */
export function assignEpisode(
  store: EpisodeStore,
  drift: { taskId: string; terms: string[] },
  config: GuardianConfig,
  clock: Clock = systemClock,
): EpisodeAssignment {
  const now = clock.now().getTime();
  const ts = nowIso(clock);
  const cooldownMs = config.nudgeCooldownMinutes * 60 * 1000;

  const episodes = store.episodes.filter((e) => now - Date.parse(e.lastSeenTs) <= EPISODE_TTL_MS);

  const match = episodes.find(
    (e) =>
      e.taskId === drift.taskId &&
      now - Date.parse(e.lastSeenTs) <= cooldownMs &&
      (drift.terms.length === 0 || e.terms.length === 0 || overlaps(e.terms, drift.terms)),
  );

  const decideNudge = (lastNudgeTs: string | null): boolean => {
    if (config.notify === "quiet") return false;
    if (config.notify === "vocal") return true;
    if (lastNudgeTs === null) return true;
    return now - Date.parse(lastNudgeTs) >= cooldownMs;
  };

  if (match) {
    const shouldNudge = decideNudge(match.lastNudgeTs);
    const updated: Episode = {
      ...match,
      terms: [...new Set([...match.terms, ...drift.terms])].slice(0, MAX_EPISODE_TERMS),
      lastSeenTs: ts,
      lastNudgeTs: shouldNudge ? ts : match.lastNudgeTs,
    };
    return {
      episodeId: match.id,
      shouldNudge,
      store: { schemaVersion: 2, episodes: episodes.map((e) => (e.id === match.id ? updated : e)) },
    };
  }

  const shouldNudge = config.notify !== "quiet";
  const created: Episode = {
    id: newId("ep"),
    taskId: drift.taskId,
    terms: drift.terms.slice(0, MAX_EPISODE_TERMS),
    firstSeenTs: ts,
    lastSeenTs: ts,
    lastNudgeTs: shouldNudge ? ts : null,
  };
  return {
    episodeId: created.id,
    shouldNudge,
    store: { schemaVersion: 2, episodes: [...episodes, created] },
  };
}

export async function loadEpisodes(workspaceRoot: string): Promise<EpisodeStore> {
  const p = getGuardianPaths(workspaceRoot);
  try {
    return episodeStoreSchema.parse(await readJsonFile(p.episodes));
  } catch {
    return emptyEpisodeStore();
  }
}

export async function saveEpisodes(workspaceRoot: string, store: EpisodeStore): Promise<void> {
  const p = getGuardianPaths(workspaceRoot);
  await writeJsonAtomic(p.episodes, episodeStoreSchema.parse(store));
}
