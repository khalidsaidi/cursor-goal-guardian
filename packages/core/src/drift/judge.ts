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

/**
 * A semantic drift judge reviews lexical drift candidates and either confirms
 * them (genuinely off-goal) or dismisses them (lexical false positive).
 * Implementations may call an LLM; the rescorer treats them as untrusted:
 * missing or malformed judgements simply leave candidates pending.
 */
export interface DriftJudge {
  readonly id: string;
  isAvailable(): Promise<JudgeAvailability>;
  judge(candidates: DriftCandidate[], context: JudgeContext): Promise<DriftJudgement[]>;
}
