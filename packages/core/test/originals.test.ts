import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { BLOCKED_AFTER_CONSECUTIVE_ROUNDS, CLOSING, CODEX_TOOLS, codexContinuation, codexObjectiveUpdated, deepseekBlockThreshold, deepseekGoalRound, deepseekWrapup, goalChangedMessage, goalRoundMessage } from "../src/index.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vendored = (...p: string[]): string => fs.readFileSync(path.join(repo, "third_party", ...p), "utf8");
const codexGoal = ["codex", "codex-rs", "ext", "goal"];
const dsh = ["deepseek-harness", "packages", "goal"];

describe("the originals, as they are", () => {
  it("the generated module is what scripts/gen-vendored.mjs makes from third_party/ today", () => {
    execFileSync(process.execPath, [path.join(repo, "scripts", "gen-vendored.mjs"), "--check"], { stdio: "pipe" });
  });

  it("Codex's continuation prompt is its template, minus only the update_plan paragraph Codex itself drops", () => {
    const template = vendored(...codexGoal, "templates", "goals", "continuation.md");
    const paragraph = /Progress visibility:\n[^\n]*\n\n/.exec(template)![0];
    const expected = template.replace(paragraph, "").replace("{{ tokens_used }}", "1234").replace("{{ token_budget }}", "none").replace("{{ remaining_tokens }}", "unbounded").trimEnd();
    expect(codexContinuation(1234)).toBe(expected);
  });

  it("Codex's objective-updated notice is its template with the objective escaped as steering.rs does", () => {
    const template = vendored(...codexGoal, "templates", "goals", "objective_updated.md");
    const said = codexObjectiveUpdated("Ship <b> & go", 7);
    expect(said).toBe(template.replace("{{ objective }}", "Ship &lt;b&gt; &amp; go").replace("{{ tokens_used }}", "7").replace("{{ token_budget }}", "none").replace("{{ remaining_tokens }}", "unknown").trimEnd());
    expect(goalChangedMessage("Ship <b> & go", [{ id: "sc_1", text: "it ships" }], 7)).toContain(said);
  });

  it("the tool names, descriptions and statuses are the ones in Codex's spec.rs", () => {
    const spec = vendored(...codexGoal, "src", "spec.rs");
    expect(CODEX_TOOLS.get.name).toBe("get_goal");
    expect(CODEX_TOOLS.update.name).toBe("update_goal");
    expect(spec).toContain(`"${CODEX_TOOLS.get.description}"`);
    expect(spec).toContain(`r#"${CODEX_TOOLS.update.description}"#`);
    expect(spec).toContain(`"${CODEX_TOOLS.update.statusDescription}"`);
    expect(CODEX_TOOLS.update.statuses).toEqual(["complete", "blocked", "paused"]);
  });

  it("DeepSeek's round prompt and closing instructions are what its own source files produce", async () => {
    // Run the vendored files themselves (types stripped) and compare with what Guardian says.
    const run = async (...file: string[]): Promise<Record<string, (...args: unknown[]) => Array<{ text: string }>>> => {
      const js = esbuild.transformSync(vendored(...file), { loader: "ts", format: "esm" }).code;
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gg-orig-")), "m.mjs");
      fs.writeFileSync(tmp, js);
      return import(/* @vite-ignore */ pathToFileURL(tmp).href);
    };
    const prompt = await run(...dsh, "goal-round-driver", "src", "prompt.ts");
    const wrapup = await run(...dsh, "tool-goal", "src", "wrapup.ts");
    expect(deepseekGoalRound("Ship it", 2, 20)).toBe(prompt.renderGoalRoundPrompt!({ objective: "Ship it", maxGoalRounds: 20 }, 2)[0]!.text);
    expect(deepseekGoalRound("Ship it", 2, 20).startsWith('<goal_round>\nObjective: "Ship it"\nRound: 2/20\n\n')).toBe(true);
    expect(CLOSING.proved("Ship it")).toBe(wrapup.renderWrapupContext!("Ship it")[0]!.text);
    expect(CLOSING.blocked("Ship it", "no network")).toBe(wrapup.renderWrapupContext!("Ship it", "no network")[0]!.text);
    expect(deepseekWrapup("Ship it", "no network")).toContain('<goal_blocked>\nObjective: "Ship it"\nBlocked: "no network"\n');
  });

  it("the blocked threshold and its refusal are DeepSeek's", () => {
    expect(BLOCKED_AFTER_CONSECUTIVE_ROUNDS).toBe(3);
    expect(deepseekBlockThreshold(1)).toBe("blocked requires at least 3 consecutive goal rounds; current round is 1");
    expect(vendored(...dsh, "tool-goal", "src", "index.ts")).toContain("blocked requires at least ${resolved.blockedAfterConsecutiveRounds} consecutive goal rounds; ");
  });

  it("a round puts the user's latest words first, then both originals, then Guardian's own part", () => {
    const msg = goalRoundMessage("Ship it", [{ id: "sc_1", text: "it ships" }], { latestMessage: "carry on", round: 1, maxRounds: 20, tokensUsed: 0, unproved: ["sc_1 (it ships): no proof given"], unclaimed: [], extras: [], goalFileEdited: false, notes: [] });
    const order = ["<user>carry on</user>", "<goal_round>", "- sc_1: it ships", "Not proved: sc_1", "Continue working toward the active thread goal.", "Guardian checks update_goal against its own record"].map((s) => msg.indexOf(s));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
