/** The hook's JSON answer on stdout. Goal Guardian never blocks and says nothing here. */
export interface HookResponse {
  continue: true;
  permission: "allow";
}

export function advisoryAllow(): HookResponse {
  return { continue: true, permission: "allow" };
}
