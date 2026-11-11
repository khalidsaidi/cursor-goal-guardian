/**
 * The finished project, put in front of the second check as evidence. The run Guardian recorded says what the agent
 * did; this says what is actually there: the project's changed files and their diff, and, for each proof the agent
 * cited, what Guardian's own record and the project hold. Guardian runs none of the project's commands: a cited
 * command is answered from the output Guardian recorded when the agent ran it, and anything cited that isn't on the
 * record or isn't in the project is marked ABSENT. Each piece is one tool call and its result, the same shape as the
 * rest of the run, so the evaluator's own structures carry it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { GoalProof } from "../schema/audit.js";
import { absentPathsIn, projectPath } from "./evaluate.js";
import type { ShellOutput } from "./record.js";
import type { TrajectoryMessage } from "./trajectory.js";

const DIFF_MAX = 6000;
const STATUS_MAX = 2000;
const OUTPUT_MAX = 1500;
const QUOTE_MAX = 300;
const GIT_TIMEOUT_MS = 5000;
const SCOPE = ["--", ".", ":(exclude).cursor"];

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`);
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

function git(root: string, args: string[]): string | null {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 20_000_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  return res.status === 0 && !res.error ? res.stdout : null;
}

const step = (call: string, result: string): TrajectoryMessage[] => [
  { role: "assistant", content: "", tool_calls: call },
  { role: "tool", content: result, tool_calls: null },
];

function commandEvidence(root: string, proof: GoalProof, outputs: ShellOutput[]): string {
  const command = squash(proof.command ?? "");
  const runs = outputs.filter((o) => squash(o.command) === command);
  const missing = absentPathsIn(root, command);
  const named = missing.length ? `\nNamed in the command and ABSENT from the project: ${missing.join(", ")}` : "";
  if (!runs.length) return `ABSENT: Guardian's record of this session has no run of this command.${named}`;
  const last = runs[runs.length - 1]!;
  if (last.failed) return `On Guardian's record: the latest run of this command FAILED.${named}`;
  const quote = squash(proof.quote ?? "");
  const printed = quote ? (squash(last.output).includes(quote) ? "The quoted line is in that output." : "ABSENT: the quoted line is not in that output.") : "";
  return `On Guardian's record: ran ${runs.length} time(s), last at ${last.ts}. Output of the last run:\n${cut(last.output, OUTPUT_MAX)}\n${printed}${named}`;
}

function fileEvidence(root: string, proof: GoalProof): string {
  const inside = projectPath(root, proof.file ?? "");
  if (inside.startsWith("..") || path.isAbsolute(inside)) return "ABSENT: this file is outside the project.";
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, inside), "utf8");
  } catch {
    return "ABSENT: this file is not in the project.";
  }
  const quote = squash(proof.contains ?? "");
  return `In the project (${text.split("\n").length} lines). ${quote ? (squash(text).includes(quote) ? "The quoted text is in it." : "ABSENT: the quoted text is not in it.") : ""}`;
}

/**
 * The evidence steps for one completion report: the project's changes as they stand, then each cited proof checked
 * against Guardian's record and the project. Outside a git repository the changes can't be listed, and that is said.
 */
export function reviewEvidence(root: string, proofs: GoalProof[], outputs: ShellOutput[]): TrajectoryMessage[] {
  const status = git(root, ["status", "--porcelain", "--no-renames", "-uall", ...SCOPE]);
  const diff = status === null ? null : git(root, ["diff", "HEAD", "--no-ext-diff", ...SCOPE]);
  const steps: TrajectoryMessage[] = [
    ...step(
      "guardian_project_state(what=\"files changed since the last commit, as they are now\")",
      status === null ? "ABSENT: the project isn't a git repository Guardian can read, so its changes can't be listed." : status.trim() ? cut(status, STATUS_MAX) : "No file differs from the last commit.",
    ),
  ];
  if (diff !== null && diff.trim()) steps.push(...step("guardian_project_state(what=\"the diff of those changes; files not yet tracked show in the list above only\")", cut(diff, DIFF_MAX)));
  for (const proof of proofs.slice(0, 12)) {
    if (proof.command !== undefined) {
      steps.push(...step(`guardian_check_proof(item=${JSON.stringify(proof.criterion)}, cited_command=${JSON.stringify(squash(proof.command).slice(0, QUOTE_MAX))}, cited_output=${JSON.stringify(squash(proof.quote ?? "").slice(0, QUOTE_MAX))})`, commandEvidence(root, proof, outputs)));
    } else if (proof.file !== undefined) {
      steps.push(...step(`guardian_check_proof(item=${JSON.stringify(proof.criterion)}, cited_file=${JSON.stringify(proof.file)}, cited_text=${JSON.stringify(squash(proof.contains ?? "").slice(0, QUOTE_MAX))})`, fileEvidence(root, proof)));
    }
  }
  return steps;
}
