import { getGuardianPaths } from "../paths.js";
import { systemClock, nowIso, type Clock } from "../clock.js";
import type { GuardianConfig } from "../schema/config.js";
import type { GuardianState } from "../schema/state.js";
import type { LexicalDriftRecord } from "../schema/audit.js";
import { emptyVerdictCache, parseVerdictCache, type VerdictCache } from "../schema/verdicts.js";
import { appendAudit, readAuditTail } from "../audit/log.js";
import { readJsonFile, writeJsonAtomic } from "../fsutil.js";
import type { DriftCandidate, DriftJudge, JudgeContext } from "./judge.js";

export interface RescoreResult {
  /** Candidates sent to the judge (0 = no call was made). */
  judged: number;
  /** Verdicts accepted and recorded. */
  recorded: number;
  /** True when a judge call was actually spent. */
  calledJudge: boolean;
}

export async function loadVerdicts(workspaceRoot: string): Promise<VerdictCache> {
  try {
    return parseVerdictCache(await readJsonFile(getGuardianPaths(workspaceRoot).verdicts));
  } catch {
    return emptyVerdictCache();
  }
}

const CANDIDATE_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * One rescore pass: gather unreviewed lexical drifts from the last 24h, send
 * one batch to the judge, record verdicts in the cache and on the audit tape.
 * Judged drifts are never re-judged (cache keyed by driftId); failed or
 * malformed judgements leave their candidates pending for the next pass.
 */
export async function runRescore(
  workspaceRoot: string,
  state: GuardianState,
  config: GuardianConfig,
  judge: DriftJudge,
  clock: Clock = systemClock,
): Promise<RescoreResult> {
  const records = await readAuditTail(workspaceRoot);
  const cache = await loadVerdicts(workspaceRoot);
  const now = clock.now().getTime();

  const pending = records.filter((r): r is LexicalDriftRecord => {
    if (r.kind !== "drift.lexical") return false;
    if (cache.entries[r.driftId]) return false;
    const ts = Date.parse(r.ts);
    return Number.isFinite(ts) && now - ts <= CANDIDATE_HORIZON_MS;
  });

  if (pending.length === 0) return { judged: 0, recorded: 0, calledJudge: false };

  const batch = pending.slice(0, config.drift.semantic.batchSize);
  const candidates: DriftCandidate[] = batch.map((r) => ({
    driftId: r.driftId,
    actionType: r.actionType,
    actionValue: r.actionValue,
    activeTaskTitle: r.activeTaskTitle,
  }));
  const context: JudgeContext = {
    goal: state.goal,
    successCriteria: state.successCriteria.map((c) => c.text),
    constraints: state.constraints,
  };

  let judgements;
  try {
    judgements = await judge.judge(candidates, context);
  } catch {
    return { judged: batch.length, recorded: 0, calledJudge: true };
  }

  const candidateIds = new Set(candidates.map((c) => c.driftId));
  let recorded = 0;
  for (const j of judgements) {
    if (!candidateIds.has(j.driftId)) continue;
    if (cache.entries[j.driftId]) continue;
    if (j.verdict !== "confirmed" && j.verdict !== "dismissed") continue;
    if (typeof j.confidence !== "number" || j.confidence < 0 || j.confidence > 1) continue;
    const ts = nowIso(clock);
    cache.entries[j.driftId] = {
      verdict: j.verdict,
      judge: judge.id,
      confidence: j.confidence,
      rationale: String(j.rationale ?? ""),
      ts,
    };
    await appendAudit(workspaceRoot, {
      ts,
      kind: "drift.verdict",
      driftId: j.driftId,
      verdict: j.verdict,
      judge: judge.id,
      confidence: j.confidence,
      rationale: String(j.rationale ?? ""),
    });
    recorded += 1;
  }

  if (recorded > 0) {
    await writeJsonAtomic(getGuardianPaths(workspaceRoot).verdicts, cache);
  }
  return { judged: batch.length, recorded, calledJudge: true };
}
