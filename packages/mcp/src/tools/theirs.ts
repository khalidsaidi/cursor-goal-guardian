import { z } from "zod";
import type { EngineToolDefinition } from "@goal-guardian/core";

/**
 * One of DeepSeek Harness's own tool parameters as an optional MCP field, described in their words. Optional
 * because the same MCP tool also takes a call in Codex's shape; their tool still checks what it requires.
 */
export function theirField(def: EngineToolDefinition, name: string): z.ZodTypeAny {
  const p = def.parameters[name];
  if (!p) throw new Error(`DeepSeek's ${def.name} has no parameter ${name}`);
  const base = p.enum?.length ? z.enum(p.enum as [string, ...string[]]) : p.type === "number" ? z.number() : z.string();
  return base.optional().describe(`DeepSeek Harness: ${p.description ?? name}`);
}

export const theirTool = (defs: EngineToolDefinition[], name: string): EngineToolDefinition => {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`DeepSeek's ${name} tool is missing`);
  return def;
};
