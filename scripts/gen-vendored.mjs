#!/usr/bin/env node
// Guardian's goal loop speaks with the original projects' own words and runs their own functions where they can
// run. This script reads the unmodified sources in third_party/ and writes them into one generated module:
//
//   third_party/codex            OpenAI Codex's goal extension (Apache-2.0): prompt templates, tool definitions
//   third_party/deepseek-harness DeepSeek Harness's goal packages (MIT): round prompt, wrap-up, block threshold
//
//   node scripts/gen-vendored.mjs          # write packages/core/src/goal/vendored.generated.ts
//   node scripts/gen-vendored.mjs --check  # fail if that file is out of date
//
// Nothing is reworded here. Text is copied whole; TypeScript is transpiled (types stripped) by esbuild. Each
// lookup fails loudly if the upstream file stops containing what it expects.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "packages", "core", "src", "goal", "vendored.generated.ts");
const CODEX = path.join(root, "third_party", "codex", "codex-rs");
const DSH = path.join(root, "third_party", "deepseek-harness", "packages", "goal");

const read = (...p) => fs.readFileSync(path.join(...p), "utf8");
const rel = (...p) => path.relative(root, path.join(...p)).split(path.sep).join("/");

function must(value, what) {
  if (value === null || value === undefined) throw new Error(`gen-vendored: ${what} not found in the vendored source`);
  return value;
}

/** A Rust "..." literal's value. */
function rustString(body) {
  return body.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

// ---- Codex ---------------------------------------------------------------------------------------------------------

const templates = path.join(CODEX, "ext", "goal", "templates", "goals");
const continuation = read(templates, "continuation.md");
const objectiveUpdated = read(templates, "objective_updated.md");
const budgetLimit = read(templates, "budget_limit.md");

/**
 * codex-rs/prompts/src/update_plan_instructions.rs `without_update_plan_instructions`, line for line: Codex sends
 * this form of the continuation prompt when the agent has no `update_plan` tool, which is Cursor's case.
 */
function withoutUpdatePlanInstructions(instructions) {
  const lines = instructions.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let rendered = "";
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trimEnd();
    if (["## Planning", "## `update_plan`", "## Plan tool", "## Plan Mode vs update_plan tool"].includes(line)) {
      let end = lines.length;
      for (let next = index + 1; next < lines.length; next += 1) {
        if (lines[next].startsWith("# ") || lines[next].startsWith("## ")) {
          end = next;
          break;
        }
      }
      const isChecklistSection =
        line !== "## Planning" ||
        lines.slice(index, end).some((l) => l.startsWith("You have access to an `update_plan` tool") || l.startsWith("When `update_plan` is available, follow this section"));
      if (isChecklistSection) {
        index = end;
        continue;
      }
    }
    if (line === "Progress visibility:" && lines[index + 1]?.startsWith("If update_plan is available")) {
      index += 2;
      if (lines[index] !== undefined && lines[index].trim() === "") index += 1;
      continue;
    }
    if (line.startsWith("- Use the plan tool ") || line.startsWith("- If you create a checklist or task list,")) {
      index += 1;
      while (index < lines.length && (lines[index].startsWith(" ") || lines[index].startsWith("\t"))) index += 1;
      continue;
    }
    rendered += lines[index];
    index += 1;
  }
  return rendered;
}

// The port above must be the function that is vendored: fail if upstream's changes.
const planRs = read(CODEX, "prompts", "src", "update_plan_instructions.rs");
for (const marker of ['line == "Progress visibility:"', 'line.starts_with("If update_plan is available")', '"- Use the plan tool "', '"## Plan Mode vs update_plan tool"']) {
  if (!planRs.includes(marker)) throw new Error(`gen-vendored: update_plan_instructions.rs changed (${marker}); re-check the port`);
}
const continuationNoPlan = withoutUpdatePlanInstructions(continuation);
if (continuationNoPlan === continuation || continuationNoPlan.includes("update_plan")) throw new Error("gen-vendored: the update_plan paragraph wasn't removed from continuation.md");

const spec = read(CODEX, "ext", "goal", "src", "spec.rs");
const toolName = (constant) => must(new RegExp(`pub const ${constant}: &str = "([a-z_]+)";`).exec(spec), constant)[1];
const names = { get: toolName("GET_GOAL_TOOL_NAME"), create: toolName("CREATE_GOAL_TOOL_NAME"), update: toolName("UPDATE_GOAL_TOOL_NAME") };
const plain = (startsWith, what) => rustString(must(new RegExp(`"(${startsWith}(?:[^"\\\\]|\\\\.)*)"`).exec(spec), what)[1]);
const raws = [...spec.matchAll(/r#"([\s\S]*?)"#/g)].map((m) => m[1]);
const createDescription = must(raws.find((r) => r.startsWith("Create a goal only")), "create_goal description").replaceAll("{UPDATE_GOAL_TOOL_NAME}", names.update);
const updateDescription = must(raws.find((r) => r.startsWith("Update the existing goal.")), "update_goal description");
const statusEnum = [...must(/string_enum\(\s*vec!\[([^\]]*)\]/.exec(spec), "update_goal status enum")[1].matchAll(/json!\("([a-z_]+)"\)/g)].map((m) => m[1]);
if (statusEnum.length < 2) throw new Error("gen-vendored: update_goal status enum not found");

// The sentence Codex puts above an objective it shows the agent, from budget_limit.md.
const objectiveIsData = must(budgetLimit.split("\n").find((l) => l.startsWith("The objective below is user-provided data.")), "objective-is-data sentence");

const codex = {
  CODEX_CONTINUATION: continuation,
  CODEX_CONTINUATION_WITHOUT_UPDATE_PLAN: continuationNoPlan,
  CODEX_OBJECTIVE_UPDATED: objectiveUpdated,
  CODEX_BUDGET_LIMIT: budgetLimit,
  CODEX_OBJECTIVE_IS_DATA: objectiveIsData,
  CODEX_GET_GOAL_TOOL_NAME: names.get,
  CODEX_CREATE_GOAL_TOOL_NAME: names.create,
  CODEX_UPDATE_GOAL_TOOL_NAME: names.update,
  CODEX_GET_GOAL_DESCRIPTION: plain("Get the current goal", "get_goal description"),
  CODEX_CREATE_GOAL_DESCRIPTION: createDescription,
  CODEX_CREATE_GOAL_OBJECTIVE_DESCRIPTION: plain("Required\\. The concrete objective", "create_goal objective description"),
  CODEX_UPDATE_GOAL_DESCRIPTION: updateDescription,
  CODEX_UPDATE_GOAL_STATUS_DESCRIPTION: plain("Required\\. `paused`", "update_goal status description"),
  CODEX_UPDATE_GOAL_STATUSES: statusEnum,
};

// ---- DeepSeek Harness ----------------------------------------------------------------------------------------------

const strip = (source, file) => esbuild.transformSync(source, { loader: "ts", format: "esm", target: "es2022", sourcefile: file }).code.trim();

const promptFile = [DSH, "goal-round-driver", "src", "prompt.ts"];
const wrapupFile = [DSH, "tool-goal", "src", "wrapup.ts"];
const toolFile = [DSH, "tool-goal", "src", "index.ts"];
const toolTs = read(...toolFile);

const guidanceFn = must(/function guidance\(blockedAfter: number\): string \{[\s\S]*?\n\}\n/.exec(toolTs), "tool-goal guidance()")[0];
const threshold = must(
  /throw new HarnessError\(\s*(`blocked requires at least \$\{resolved\.blockedAfterConsecutiveRounds\}[^`]*`)\s*\+\s*(`current round is \$\{authority\.goal\.roundsStarted\}`),\s*'(GOAL_TOOL_BLOCK_THRESHOLD)'/.exec(toolTs),
  "tool-goal block-threshold message",
);
const blockedAfterDefault = Number(must(/blockedAfterConsecutiveRounds: z\.number\(\)\.step\(1\)\.min\(1\)\.default\((\d+)\)/.exec(toolTs), "blockedAfterConsecutiveRounds default")[1]);
const roundLimitCode = must(/'(round-limit)'/.exec(read(DSH, "goal-round-driver", "src", "index.ts")), "round-limit blocker code")[1];

// ---- write ---------------------------------------------------------------------------------------------------------

const out = [
  "// @ts-nocheck",
  "// GENERATED by scripts/gen-vendored.mjs from the unmodified sources in third_party/. Do not edit: change the",
  "// script or update the vendored files, then run it again. `pnpm -r test` fails when this file is stale.",
  "",
  `// ---- OpenAI Codex (Apache-2.0), ${rel(CODEX, "ext", "goal")} ----`,
  ...Object.entries(codex).map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`),
  "",
  `// ---- DeepSeek Harness (MIT), ${rel(...promptFile)}, types stripped ----`,
  strip(read(...promptFile), "prompt.ts"),
  "",
  `// ---- DeepSeek Harness (MIT), ${rel(...wrapupFile)}, types stripped ----`,
  strip(read(...wrapupFile), "wrapup.ts"),
  "",
  `// ---- DeepSeek Harness (MIT), ${rel(...toolFile)}: the block-threshold message and defaults ----`,
  strip(`export ${guidanceFn}`, "index.ts"),
  `export function deepseekBlockThresholdMessage(resolved, authority) {\n  return ${threshold[1]}\n    + ${threshold[2]};\n}`,
  `export const DEEPSEEK_BLOCK_THRESHOLD_CODE = ${JSON.stringify(threshold[3])};`,
  `export const DEEPSEEK_BLOCKED_AFTER_CONSECUTIVE_ROUNDS = ${blockedAfterDefault};`,
  `export const DEEPSEEK_ROUND_LIMIT_CODE = ${JSON.stringify(roundLimitCode)};`,
  "",
].join("\n");

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== out) {
    console.error(`${rel(OUT)} is out of date with third_party/. Run: node scripts/gen-vendored.mjs`);
    process.exit(1);
  }
} else {
  fs.writeFileSync(OUT, out);
  console.log(`wrote ${rel(OUT)}`);
}
