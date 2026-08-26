export interface HookResponse {
  continue: true;
  permission: "allow";
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
