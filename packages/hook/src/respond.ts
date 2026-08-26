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
 * The rare case: one calm sentence into the conversation. Every response is
 * still an allow — Goal Guardian never blocks.
 */
export function advisoryNudge(oneLiner: string): HookResponse {
  const message = `Goal Guardian: ${oneLiner} (see panel)`;
  return { continue: true, permission: "allow", userMessage: message, agentMessage: message };
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
