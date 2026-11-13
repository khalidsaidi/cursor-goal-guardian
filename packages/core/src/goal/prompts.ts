/**
 * Every word Guardian says to the agent about the goal. The goal-loop instructions are the original projects' own,
 * unmodified (see originals.ts): Codex's continuation prompt and objective notices, DeepSeek Harness's
 * `<goal_round>` prompt and closing instructions. Only what neither of them has is written here: the user's latest
 * message first, the facts from Guardian's own record, and how to report proof.
 */
import { GUARDIAN_MESSAGE_PREFIX } from "./record.js";
import { CODEX_TOOLS, ROUND_LIMIT_CODE, codexBudgetLimit, codexContinuation, codexObjectiveBlock, codexObjectiveUpdated, deepseekGoalRound, deepseekWrapup } from "./originals.js";

const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Long enough for any real goal; past it the agent reads the rest with get_goal, as Codex's prompt tells it to. */
const MAX_GOAL_CHARS = 4000;

/** Enough to read what the user asked for. */
const MAX_LATEST_CHARS = 2000;

const REPORT = CODEX_TOOLS.update.name;

type Criteria = Array<{ id: string; text: string }>;

const shown = (goal: string): string => (goal.length > MAX_GOAL_CHARS ? `${goal.slice(0, MAX_GOAL_CHARS)}…` : goal);
const doneWhen = (criteria: Criteria): string[] => (criteria.length ? ["Done when:", ...criteria.map((c) => `- ${c.id}: ${esc(c.text)}`)] : []);

/** The goal as shown outside a round: Codex's framing of an objective, then the user's own "done when" list. */
export function goalBlock(goal: string, criteria: Criteria): string[] {
  return [...codexObjectiveBlock(shown(goal)), ...doneWhen(criteria)];
}

/** Said when the user changed the goal: Codex's own notice, then the new "done when" list. */
export function goalChangedMessage(goal: string, criteria: Criteria, tokensUsed: number, tokenBudget: number | null = null, codex: { fragment?: string; notice?: string | null } = {}): string {
  // Where Codex's extension runs, the words are the ones its own code produced: its "User set the goal" fragment
  // and its objective-updated notice. Otherwise its template, rendered here the way its steering code renders it.
  return [...(codex.fragment ? [codex.fragment, ""] : []), codex.notice ?? codexObjectiveUpdated(shown(goal), tokensUsed, tokenBudget), ...(criteria.length ? ["", ...doneWhen(criteria)] : []), "", "Ask the user before removing any finished work."].join("\n");
}

/**
 * What Guardian adds to the originals' update_goal: proof it can check against its own record, an account of every
 * changed file, and set_aside. Neither original has these, so the words are Guardian's.
 */
const GUARDIAN_PART = [
  `Guardian checks ${REPORT} against its own record of this session's commands and files:`,
  "- status complete: report when the requested work is done. Proofs and file labels are optional hints. Guardian uses its recorded command results and actual project changes; do not copy output quotes or rerun a passing command merely to repair a completion report.",
  "- changes: optional hints about which goal items the changed files serve. Guardian observes the actual changes and checks for meaningful unrelated behavior; a label alone does not decide what must be removed.",
  "- Supporting tests, type declarations, documentation and minimal build fixes for the requested behavior serve that behavior's done-when item, even when the user did not name those files. Do not label them extra merely because they are supporting work. Leave harmless formatting and wording alone unless the user explicitly required otherwise.",
  "- removed: optional notes on intentional removals. Preserve existing work; line counts or report bookkeeping alone are not reasons to undo formatting or remove working code.",
  "- status blocked: the obstacle, what you tried and what you need, in reason.",
  "- status set_aside: when the user's latest message asked for only part of the goal or for something else, with their words in user_words. It covers that message only; the goal stays open. A request to continue or finish is never set_aside.",
  "- status paused: only with the user's request to pause, quoted in user_words.",
  `If ${REPORT} isn't available, say so in one line and stop.`,
];

/** What the agent is told once the run is over, so it doesn't end on a bare tool call. */
export const CLOSING = {
  /** DeepSeek Harness's closing instruction for a completed goal. */
  proved: (goal: string): string => deepseekWrapup(shown(goal)),
  /** DeepSeek Harness's closing instruction for a blocked goal. */
  blocked: (goal: string, reason: string): string => deepseekWrapup(shown(goal), reason),
  setAside: "Set aside for this message. The goal stays open. Finish what the user asked, say what's left of the goal, and stop.",
  paused: "This goal is paused. Stop goal work and say so. Only the user resumes it, from the Guardian panel.",
};

export interface RoundFacts {
  /** The user's own latest message: what they want now outranks everything below it. */
  latestMessage?: string | undefined;
  round: number;
  maxRounds: number;
  /** The round prompt as DeepSeek's round driver built it for this round. */
  goalRoundPrompt?: string | undefined;
  /** The goal's own round count and cap, as DeepSeek's service holds them, for its `<goal_round>` prompt. */
  goalRound?: number;
  goalMaxRounds?: number;
  /** Tokens the goal has used so far, for Codex's budget lines. */
  tokensUsed: number;
  /** The goal's token budget in Codex's store, or none. */
  tokenBudget?: number | null;
  /** The continuation prompt Codex's own scheduling produced for this stop, and the objective as it hands it over. */
  codexPrompt?: string | null;
  codexObjectiveContext?: string | null;
  unproved: string[];
  unclaimed: string[];
  extras: string[];
  goalFileEdited: boolean;
  notes: string[];
}

export function goalRoundMessage(goal: string, criteria: Criteria, f: RoundFacts): string {
  const facts = [
    ...f.notes,
    ...f.unproved.map((u) => `- Not proved: ${esc(u)}`),
    ...f.unclaimed.map((u) => `- Observed change: ${u}`),
    ...f.extras.map((u) => `- Scope finding to verify against the request: ${u}`),
    ...(f.goalFileEdited ? ["- You edited Guardian's goal files. Only the user changes the goal: put them back."] : []),
  ];
  return [
    `${GUARDIAN_MESSAGE_PREFIX} round ${f.round} of ${f.maxRounds}. The goal isn't proved yet.`,
    "",
    ...(f.latestMessage ? ["The user's latest message:", `<user>${esc(f.latestMessage.slice(0, MAX_LATEST_CHARS))}</user>`, ""] : []),
    `Decide from their words first. If they limited the work to part of this goal, or asked for something separate from it, that is all they want this time: don't touch the rest of the goal, call ${REPORT} with status set_aside quoting them, say what's left, and stop. Keep working only if they asked for this goal, or to continue or finish.`,
    "",
    f.goalRoundPrompt ?? deepseekGoalRound(shown(goal), f.goalRound ?? f.round, f.goalMaxRounds ?? f.maxRounds),
    ...(criteria.length ? ["", ...doneWhen(criteria)] : []),
    "",
    ...(facts.length ? ["What Guardian's record shows:", ...facts, ""] : []),
    ...(f.codexPrompt ? [...(f.codexObjectiveContext ? ["<goal_objective>", esc(f.codexObjectiveContext), "</goal_objective>", ""] : []), f.codexPrompt.trimEnd()] : [codexContinuation(f.tokensUsed, f.tokenBudget ?? null)]),
    "",
    ...GUARDIAN_PART,
  ].join("\n");
}

/** The run is over without proof: the rounds ran out, or nothing moved. DeepSeek Harness's driver records this as a blocker. */
export function goalClosingMessage(goal: string, criteria: Criteria, why: string, unproved: string[], code: string = ROUND_LIMIT_CODE): string {
  return [
    `${GUARDIAN_MESSAGE_PREFIX} ${why} Don't start new work.`,
    "",
    deepseekWrapup(shown(goal), `${code}: ${why}`),
    ...(criteria.length ? ["", ...doneWhen(criteria)] : []),
    ...(unproved.length ? ["", "Still not proved:", ...unproved.map((u) => `- ${esc(u)}`)] : []),
  ].join("\n");
}

/** The goal reached its token budget in Codex's store: Codex's own budget-limit prompt closes the run. */
export function goalBudgetLimitMessage(goal: string, usage: { tokensUsed: number; tokenBudget: number | null; timeUsedSeconds: number }, codexNotice?: string | null): string {
  return [`${GUARDIAN_MESSAGE_PREFIX} the goal has used its token budget. Don't start new work.`, "", codexNotice ?? codexBudgetLimit(shown(goal), usage)].join("\n");
}
