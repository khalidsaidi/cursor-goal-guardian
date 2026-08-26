import { describe, it, expect } from "vitest";
import {
  assignEpisode,
  emptyEpisodeStore,
  parseConfig,
  defaultConfig,
  type Clock,
  type EpisodeStore,
} from "../src/index.js";

function clockAt(ms: number): Clock {
  return { now: () => new Date(ms) };
}
const T0 = Date.parse("2026-01-01T10:00:00.000Z");
const MIN = 60 * 1000;

const drift = { taskId: "t1", terms: ["darkmode", "theme"] };

describe("episode governor — the quietness contract", () => {
  it("balanced: first drift of an episode nudges, repeats within cooldown stay silent", () => {
    const config = defaultConfig();
    let store: EpisodeStore = emptyEpisodeStore();

    const first = assignEpisode(store, drift, config, clockAt(T0));
    expect(first.shouldNudge).toBe(true);
    store = first.store;

    const second = assignEpisode(store, drift, config, clockAt(T0 + 1 * MIN));
    expect(second.shouldNudge).toBe(false);
    expect(second.episodeId).toBe(first.episodeId);

    const third = assignEpisode(second.store, { taskId: "t1", terms: ["theme", "palette"] }, config, clockAt(T0 + 2 * MIN));
    expect(third.shouldNudge).toBe(false);
    expect(third.episodeId).toBe(first.episodeId);
  });

  it("balanced: after the cooldown expires the same episode may nudge again", () => {
    const config = defaultConfig(); // 10 min cooldown
    let store = emptyEpisodeStore();
    const first = assignEpisode(store, drift, config, clockAt(T0));
    store = first.store;

    // Keep the episode alive with a drift at +9min (silent), then +11min from the last nudge.
    const mid = assignEpisode(store, drift, config, clockAt(T0 + 9 * MIN));
    expect(mid.shouldNudge).toBe(false);
    const later = assignEpisode(mid.store, drift, config, clockAt(T0 + 11 * MIN));
    expect(later.episodeId).toBe(first.episodeId);
    expect(later.shouldNudge).toBe(true);
  });

  it("quiet: never nudges, ever — but episodes are still tracked", () => {
    const config = parseConfig({ notify: "quiet" });
    let store = emptyEpisodeStore();
    for (let i = 0; i < 5; i++) {
      const r = assignEpisode(store, drift, config, clockAt(T0 + i * MIN));
      expect(r.shouldNudge).toBe(false);
      store = r.store;
    }
    expect(store.episodes).toHaveLength(1);
    expect(store.episodes[0]?.lastNudgeTs).toBeNull();
  });

  it("vocal: every drift nudges", () => {
    const config = parseConfig({ notify: "vocal" });
    let store = emptyEpisodeStore();
    for (let i = 0; i < 3; i++) {
      const r = assignEpisode(store, drift, config, clockAt(T0 + i * MIN));
      expect(r.shouldNudge).toBe(true);
      store = r.store;
    }
  });

  it("a different task starts a new episode and earns its own nudge", () => {
    const config = defaultConfig();
    const first = assignEpisode(emptyEpisodeStore(), drift, config, clockAt(T0));
    const other = assignEpisode(first.store, { taskId: "t2", terms: ["darkmode", "theme"] }, config, clockAt(T0 + MIN));
    expect(other.episodeId).not.toBe(first.episodeId);
    expect(other.shouldNudge).toBe(true);
  });

  it("same task but unrelated vocabulary starts a new episode", () => {
    const config = defaultConfig();
    const first = assignEpisode(emptyEpisodeStore(), drift, config, clockAt(T0));
    const unrelated = assignEpisode(first.store, { taskId: "t1", terms: ["billing", "invoice"] }, config, clockAt(T0 + MIN));
    expect(unrelated.episodeId).not.toBe(first.episodeId);
    expect(unrelated.shouldNudge).toBe(true);
  });

  it("a gap longer than the cooldown closes the episode; the next drift is a fresh one", () => {
    const config = defaultConfig();
    const first = assignEpisode(emptyEpisodeStore(), drift, config, clockAt(T0));
    const later = assignEpisode(first.store, drift, config, clockAt(T0 + 30 * MIN));
    expect(later.episodeId).not.toBe(first.episodeId);
    expect(later.shouldNudge).toBe(true);
  });

  it("episodes older than 24h are pruned from the store", () => {
    const config = defaultConfig();
    const first = assignEpisode(emptyEpisodeStore(), drift, config, clockAt(T0));
    const dayLater = assignEpisode(first.store, { taskId: "t9", terms: ["other"] }, config, clockAt(T0 + 25 * 60 * MIN));
    expect(dayLater.store.episodes.map((e) => e.id)).toEqual([dayLater.episodeId]);
  });

  it("episode vocabulary grows by union and is capped", () => {
    const config = parseConfig({ notify: "vocal" });
    let store = emptyEpisodeStore();
    let lastId = "";
    for (let i = 0; i < 30; i++) {
      const r = assignEpisode(store, { taskId: "t1", terms: ["theme", `term${i}`] }, config, clockAt(T0 + i * 1000));
      store = r.store;
      lastId = r.episodeId;
    }
    expect(store.episodes).toHaveLength(1);
    expect(store.episodes[0]?.id).toBe(lastId);
    expect(store.episodes[0]!.terms.length).toBeLessThanOrEqual(24);
  });
});
