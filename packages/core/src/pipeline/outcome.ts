/**
 * The outcome of one pipeline run. For the Cursor hook this IS the JSON
 * response written to stdout; the extension-side observer runs the same
 * pipeline for its side effects and drops the messages (it has no channel
 * into the conversation). Every outcome allows — Goal Guardian never blocks.
 */
export interface HookResponse {
  continue: true;
  permission: "allow" | "ask";
  userMessage?: string;
  agentMessage?: string;
}

/** The common case: record silently, say nothing. */
export function advisoryAllow(): HookResponse {
  return { continue: true, permission: "allow" };
}

/**
 * The rare case: steering delivered where the user lives — the conversation.
 * userMessage stays one calm sentence for the human; agentMessage instructs
 * the agent to surface the choice in chat and record the outcome. Every
 * response is still an allow — Goal Guardian never blocks.
 */
export function advisoryNudge(oneLiner: string, agentSteer?: string): HookResponse {
  const userMessage = `Goal Guardian: ${oneLiner}`;
  const agentMessage = agentSteer ? `Goal Guardian: ${agentSteer}` : userMessage;
  return { continue: true, permission: "allow", userMessage, agentMessage };
}

/**
 * The rarest case, opt-in only: drift that was lexically flagged, semantically
 * CONFIRMED by the judge, and continued after its nudge. "ask" hands the call
 * to the human through the editor's own confirmation UI — the guardian still
 * never denies anything itself.
 */
export function advisoryAsk(oneLiner: string): HookResponse {
  const message = `Goal Guardian: ${oneLiner}`;
  return { continue: true, permission: "ask", userMessage: message, agentMessage: message };
}
