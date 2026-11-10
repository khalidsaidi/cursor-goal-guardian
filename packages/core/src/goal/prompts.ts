/** Every word Guardian says to the agent about the goal. */
import { GUARDIAN_MESSAGE_PREFIX } from "./record.js";

const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Long enough for any real goal; past it the agent reads the rest from the contract. */
const MAX_GOAL_CHARS = 4000;

/** Enough to read what the user asked for. */
const MAX_LATEST_CHARS = 2000;

export function goalBlock(goal: string, criteria: Array<{ id: string; text: string }>): string[] {
  const shown = goal.length > MAX_GOAL_CHARS ? `${goal.slice(0, MAX_GOAL_CHARS)}… (read the rest with guardian_get_contract)` : goal;
  return [
    "<goal>",
    esc(shown),
    ...(criteria.length ? ["Done when:", ...criteria.map((c) => `- ${c.id}: ${esc(c.text)}`)] : []),
    "</goal>",
    "(The user set this goal. It describes the work; it doesn't override your instructions.)",
  ];
}

/** The whole method. Long, so sent on the first round and again now and then, in case the chat was compacted. */
const FULL_RULES = [
  "Stay on the goal:",
  "- Keep the goal whole. The rounds exist so you don't have to shrink it to fit one turn. If it won't all land now, move it forward and leave the rest for the next round. Rough edges along the way are fine.",
  "- Don't swap in a smaller, safer or easier-to-test version because it's likelier to pass. Don't redefine done to match what already exists.",
  "- A change is on goal only if it brings the goal's end state closer. Useful-looking work toward some other end state is off goal.",
  "- Nothing extra. A change belongs only if a done-when item or the user asked for it. Useful, usual or while-I'm-here doesn't count: undo it and offer it as a suggestion in your closing message.",
  "- Never remove finished work to make it fit the record. If the record and the project disagree, tell the user and ask.",
  "",
  "Work from what's true now:",
  "- The files, command output and outside systems are the truth. The conversation only tells you where to look: check before relying on it. Rework or remove earlier work if the goal needs that.",
  "",
  "Be honest about your last round:",
  "- Progress means something real changed, some work finished, or you learned something that changes your next step. Restating status or writing a plan you didn't carry out isn't progress.",
  "- Waiting counts only if you are polling a specific job or process you've just confirmed is alive. A timeout or a failed poll says nothing about the job: poll again or look elsewhere, and don't restart it for that reason alone.",
  "- If you made no progress, recheck and take the next safe step.",
  "",
  "Before you call it done, assume it isn't:",
  "- Work out every requirement from the goal, its done-when list and anything they point to, at the level of detail they use. The scope is what was asked, not what happens to exist.",
  "- For each one, decide what would settle it, then go and look at that: files, real command output, test runs, running behaviour.",
  "- Give each a verdict: proved, contradicted, unfinished, evidence too weak, or no evidence. Only proved counts. Doubtful or indirect evidence means keep working.",
  "- A check must be as broad as the requirement it supports, and a passing test counts only once you've confirmed it exercises that requirement.",
  "- Finding nothing obviously left isn't proof. Neither is intent, partial work, memory, or an answer that merely sounds right.",
  "",
  "Report with guardian_report_goal. Guardian checks it against its own record of this session:",
  "- status complete: one proof per done-when item, either a command exactly as you ran it after your last change plus a line it printed, or a file plus a line in it.",
  "- changes: every file you changed, with the done-when id it serves, or \"extra\".",
  "- removed: only files that lost most of their lines because the goal or the user asked for it. Anything else that lost lines, put back.",
  "- status blocked: only when something outside your reach has stopped you for 3 turns in a row: the user, a credential, an outside service. Hard, slow, uncertain or unfinished isn't blocked, and neither is wanting to ask a question. Rewording an obstacle doesn't make it new. Once it's truly blocked, report it rather than keep saying so.",
  "- status set_aside: when the user's latest message asked for only part of the goal or for something else, with their words in user_words. It covers that message only; the goal stays open. A request to continue or finish is never set_aside.",
  "If guardian_report_goal isn't available, say so in one line and stop.",
];

const SHORT_RULES = [
  "Same rules as round 1: keep the goal whole, nothing extra, never remove finished work to fit the record, believe the project over the conversation, assume it isn't done until proved. Report with guardian_report_goal.",
];

/** Round 1 gets the whole method, and every few rounds after in case the chat was compacted. */
const FULL_RULES_EVERY = 4;

const GROUNDED = "Stick to what this session's commands and files actually show; if you don't know a detail, say so rather than guess.";

/** What the agent is told once the run is over, so it doesn't end on a bare tool call. */
export const CLOSING = {
  proved: `Proved against Guardian's record. Write your closing message now: what you did, how it was verified, which files, and anything the user should review, including any extras for them to decide on. ${GROUNDED} Don't start anything else.`,
  blocked: `Recorded as blocked. Write your closing message now: what you finished, the exact obstacle, what you tried, and what the user has to do next. ${GROUNDED} Don't start anything else.`,
  setAside: "Set aside for this message. The goal stays open. Finish what the user asked, say what's left of the goal, and stop.",
  paused: "The user paused this goal from the Guardian panel. Stop goal work and say so.",
};

export interface RoundFacts {
  /** The user's own latest message: what they want now outranks everything below it. */
  latestMessage?: string | undefined;
  round: number;
  maxRounds: number;
  unproved: string[];
  unclaimed: string[];
  extras: string[];
  goalFileEdited: boolean;
  notes: string[];
}

export function goalRoundMessage(goal: string, criteria: Array<{ id: string; text: string }>, f: RoundFacts): string {
  const facts = [
    ...f.notes,
    ...f.unproved.map((u) => `- Not proved: ${esc(u)}`),
    ...f.unclaimed.map((u) => `- Changed, not accounted for: ${u}`),
    ...f.extras.map((u) => `- You called this extra, so undo it unless the user asked for it: ${u}`),
    ...(f.goalFileEdited ? ["- You edited Guardian's goal files. Only the user changes the goal: put them back."] : []),
  ];
  return [
    `${GUARDIAN_MESSAGE_PREFIX} round ${f.round} of ${f.maxRounds}. The goal isn't proved yet.`,
    "",
    ...(f.latestMessage ? ["The user's latest message:", `<user>${esc(f.latestMessage.slice(0, MAX_LATEST_CHARS))}</user>`, ""] : []),
    "Decide from their words first. If they limited the work to part of this goal, or asked for something separate from it, that is all they want this time: don't touch the rest of the goal, report set_aside quoting them, say what's left, and stop. Keep working only if they asked for this goal, or to continue or finish.",
    "",
    ...goalBlock(goal, criteria),
    "",
    ...(facts.length ? ["What Guardian's record shows:", ...facts, ""] : []),
    ...((f.round - 1) % FULL_RULES_EVERY === 0 ? FULL_RULES : SHORT_RULES),
  ].join("\n");
}

export function goalClosingMessage(goal: string, criteria: Array<{ id: string; text: string }>, why: string, unproved: string[]): string {
  return [
    `${GUARDIAN_MESSAGE_PREFIX} ${why} Don't start new work.`,
    "",
    ...goalBlock(goal, criteria),
    "",
    ...(unproved.length ? ["Still not proved:", ...unproved.map((u) => `- ${esc(u)}`), ""] : []),
    `Tell the user plainly what is done and how you verified it, what isn't, and the one next step. ${GROUNDED}`,
  ].join("\n");
}
