/**
 * The original projects' goal text and functions, as they are. Everything here comes out of
 * vendored.generated.ts, which scripts/gen-vendored.mjs builds from the unmodified sources in third_party/:
 * OpenAI Codex's goal extension (Apache-2.0) and DeepSeek Harness's goal packages (MIT). This file only gives
 * them types and fills in their own placeholders the way their own code does. No wording lives here.
 */
import * as vendored from "./vendored.generated.js";

/** Codex's Template: `{{ name }}` replaced by its value (codex-rs/utils/template). */
function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, name: string) => values[name] ?? whole);
}

/** steering.rs `escape_xml_text`. */
function escapeXmlText(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Codex's continuation prompt (templates/goals/continuation.md), in the form it sends an agent that has no
 * `update_plan` tool. Guardian sets no token budget, which steering.rs renders as "none" and "unbounded".
 */
export function codexContinuation(tokensUsed: number): string {
  return render(vendored.CODEX_CONTINUATION_WITHOUT_UPDATE_PLAN as string, {
    tokens_used: String(tokensUsed),
    token_budget: "none",
    remaining_tokens: "unbounded",
  }).trimEnd();
}

/** Codex's notice that the user edited the objective (templates/goals/objective_updated.md), rendered as steering.rs does. */
export function codexObjectiveUpdated(objective: string, tokensUsed: number): string {
  return render(vendored.CODEX_OBJECTIVE_UPDATED as string, {
    objective: escapeXmlText(objective),
    tokens_used: String(tokensUsed),
    token_budget: "none",
    remaining_tokens: "unknown",
  }).trimEnd();
}

/** How Codex shows an objective to the agent: its sentence that the objective is data, then the objective in tags. */
export function codexObjectiveBlock(objective: string): string[] {
  return [vendored.CODEX_OBJECTIVE_IS_DATA as string, "", "<objective>", escapeXmlText(objective), "</objective>"];
}

/** Codex's tool definitions (ext/goal/src/spec.rs). */
export const CODEX_TOOLS = {
  get: { name: vendored.CODEX_GET_GOAL_TOOL_NAME as string, description: vendored.CODEX_GET_GOAL_DESCRIPTION as string },
  update: {
    name: vendored.CODEX_UPDATE_GOAL_TOOL_NAME as string,
    description: vendored.CODEX_UPDATE_GOAL_DESCRIPTION as string,
    statusDescription: vendored.CODEX_UPDATE_GOAL_STATUS_DESCRIPTION as string,
    statuses: vendored.CODEX_UPDATE_GOAL_STATUSES as string[],
  },
} as const;

/** DeepSeek Harness's `<goal_round>` prompt (goal-round-driver/src/prompt.ts), from its own function. */
export function deepseekGoalRound(objective: string, round: number, maxGoalRounds: number): string {
  return (vendored.renderGoalRoundPrompt({ objective, maxGoalRounds }, round) as Array<{ text: string }>)[0]!.text;
}

/** DeepSeek Harness's closing instruction (tool-goal/src/wrapup.ts), from its own function: complete, or blocked with a reason. */
export function deepseekWrapup(objective: string, blockedReason?: string): string {
  return (vendored.renderWrapupContext(objective, blockedReason) as Array<{ text: string }>)[0]!.text;
}

/** DeepSeek Harness's default: the model may report `blocked` only from this goal round on (tool-goal/src/index.ts). */
export const BLOCKED_AFTER_CONSECUTIVE_ROUNDS = vendored.DEEPSEEK_BLOCKED_AFTER_CONSECUTIVE_ROUNDS as number;

/** DeepSeek Harness's refusal of an early `blocked` (tool-goal/src/index.ts). */
export function deepseekBlockThreshold(currentRound: number): string {
  return vendored.deepseekBlockThresholdMessage({ blockedAfterConsecutiveRounds: BLOCKED_AFTER_CONSECUTIVE_ROUNDS }, { goal: { roundsStarted: currentRound } }) as string;
}

/** The blocker code DeepSeek Harness's round driver records when the round cap is reached. */
export const ROUND_LIMIT_CODE = vendored.DEEPSEEK_ROUND_LIMIT_CODE as string;
