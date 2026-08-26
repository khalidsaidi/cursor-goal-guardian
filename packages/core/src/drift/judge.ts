export interface DriftCandidate {
  driftId: string;
  actionType: string;
  actionValue: string;
  activeTaskTitle: string;
  criterionText?: string;
}

export interface JudgeContext {
  goal: string;
  successCriteria: string[];
  constraints: string[];
}

export interface DriftJudgement {
  driftId: string;
  verdict: "confirmed" | "dismissed";
  confidence: number;
  rationale: string;
}

export type JudgeAvailability = { ok: true } | { ok: false; reason: string };

export interface SessionReviewResult {
  verdict: "on_course" | "off_course";
  confidence: number;
  rationale: string;
  /** Indexes into the sampled action list that look genuinely off-goal. */
  flagged: number[];
}

/**
 * A semantic drift judge reviews lexical drift candidates and either confirms
 * them (genuinely off-goal) or dismisses them (lexical false positive).
 * Implementations may call an LLM; the rescorer treats them as untrusted:
 * missing or malformed judgements simply leave candidates pending.
 *
 * reviewSession is the second lens: given a sample of the RAW action tape it
 * judges the session as a whole — the path that catches in-vocabulary drift
 * no lexical signal ever fires on.
 */
export interface DriftJudge {
  readonly id: string;
  isAvailable(): Promise<JudgeAvailability>;
  judge(candidates: DriftCandidate[], context: JudgeContext): Promise<DriftJudgement[]>;
  reviewSession?(actions: string[], context: JudgeContext): Promise<SessionReviewResult | null>;
}
