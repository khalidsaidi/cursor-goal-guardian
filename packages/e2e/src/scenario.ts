import { it } from "vitest";
import { scaffoldWorkspace, type E2EWorkspace, type ScaffoldOptions } from "./scaffold.js";
import { billableRunsEnabled, runCursorAgent } from "./agent.js";

export interface AgentScenario {
  title: string;
  workspace: ScaffoldOptions;
  prompt: string;
  timeoutMs?: number;
  /** Runs before the agent (seed audit records, etc.). */
  prime?: (ws: E2EWorkspace) => Promise<void>;
  /** Artifact assertions only — never against the agent transcript. */
  assert: (ws: E2EWorkspace) => Promise<void>;
}

/**
 * Agent scenarios get exactly one retry with a FRESH workspace (agents are
 * nondeterministic; a dirty workspace never is reused). Deterministic
 * scenarios use plain `it` — a failure there is a real bug.
 */
export function agentScenario(scenario: AgentScenario): void {
  const fn = billableRunsEnabled() ? it : it.skip;
  fn(
    scenario.title,
    async () => {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const ws = await scaffoldWorkspace(scenario.workspace);
        try {
          await scenario.prime?.(ws);
          const result = await runCursorAgent({ workspace: ws.root, prompt: scenario.prompt, timeoutMs: scenario.timeoutMs });
          if (result.timedOut) throw new Error("cursor-agent timed out");
          await scenario.assert(ws);
          await ws.cleanup();
          return;
        } catch (err) {
          lastError = err;
          await ws.cleanup(attempt === 2);
        }
      }
      throw lastError;
    },
    600_000,
  );
}
