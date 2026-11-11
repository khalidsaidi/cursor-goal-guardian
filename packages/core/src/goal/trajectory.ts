/**
 * The agent's run as Guardian itself saw it, in the shape the monitor reads: one assistant message per action with
 * its tool call, one tool message per result. Guardian's hooks see actions, not the agent's prose, so this is what
 * the monitoring paper calls an action-only trajectory.
 */
import { readFileEdits, readShellOutputs } from "./record.js";

export interface TrajectoryMessage {
  role: "assistant" | "tool";
  content: string;
  tool_calls: string | null;
}

/** Enough to judge a step without one long output crowding out the rest of its chunk. */
const RESULT_MAX = 2500;
/** A run longer than this is reviewed from its latest actions. */
const MAX_ACTIONS = 120;

const cut = (text: string): string => (text.length <= RESULT_MAX ? text : `${text.slice(0, 600)}\n…\n${text.slice(-(RESULT_MAX - 600))}`);

/** Commands with their output and edits with their text, oldest first, from `sinceTs` on. */
export async function readTrajectory(root: string, sinceTs: string | null): Promise<TrajectoryMessage[]> {
  const from = sinceTs ? Date.parse(sinceTs) : 0;
  const steps: Array<{ at: number; call: string; result: string }> = [];
  for (const o of await readShellOutputs(root)) {
    const at = Date.parse(o.startedAt);
    if (at < from) continue;
    steps.push({ at, call: `run_terminal_command(command=${JSON.stringify(o.command)})`, result: o.failed ? "The command failed." : cut(o.output) });
  }
  for (const e of await readFileEdits(root)) {
    const at = Date.parse(e.ts);
    if (at < from) continue;
    const changes = e.edits.length ? e.edits.map((x) => `--- replaced\n${x.old}\n+++ with\n${x.new}`).join("\n") : "(Cursor reported no text for this edit)";
    steps.push({ at, call: `edit_file(path=${JSON.stringify(e.file)})`, result: cut(changes) });
  }
  steps.sort((a, b) => a.at - b.at);
  return steps.slice(-MAX_ACTIONS).flatMap((s): TrajectoryMessage[] => [
    { role: "assistant", content: "", tool_calls: s.call },
    { role: "tool", content: s.result, tool_calls: null },
  ]);
}
