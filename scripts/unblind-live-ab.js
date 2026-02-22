#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/unblind-live-ab.js --study <study-dir> [--evaluate] [--json]",
      "",
      "Reads:",
      "  - task_set.json",
      "  - runs.blinded.json",
      "  - blinding.secret.json",
      "",
      "Writes:",
      "  - runs.json (with variant = with_cgg|without_cgg)",
      "",
      "Options:",
      "  --evaluate   Run scripts/evaluate-ab.js after generating runs.json",
      "  --json       When used with --evaluate, print evaluator JSON",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = { study: "", evaluate: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--study") {
      args.study = String(argv[i + 1] ?? "");
      i += 1;
    } else if (v === "--evaluate") {
      args.evaluate = true;
    } else if (v === "--json") {
      args.json = true;
    } else if (v === "--help" || v === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${v}`);
    }
  }

  if (!args.study) throw new Error("Missing required argument: --study <study-dir>");
  return args;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function isIsoDateString(v) {
  if (typeof v !== "string" || v.length < 10) return false;
  const ts = Date.parse(v);
  return Number.isFinite(ts);
}

function validate(taskSet, blindedRuns, secret) {
  if (!taskSet || typeof taskSet !== "object") throw new Error("task_set.json must be an object");
  if (!Array.isArray(taskSet.tasks) || taskSet.tasks.length === 0) {
    throw new Error("task_set.json must include a non-empty tasks array");
  }
  if (!Array.isArray(blindedRuns) || blindedRuns.length === 0) {
    throw new Error("runs.blinded.json must be a non-empty array");
  }
  const mapping = secret?.variant_by_arm;
  if (!mapping || typeof mapping !== "object") {
    throw new Error("blinding.secret.json missing variant_by_arm");
  }
  if (!mapping.arm_alpha || !mapping.arm_beta) {
    throw new Error("variant_by_arm must include arm_alpha and arm_beta");
  }

  const taskIds = new Set(taskSet.tasks.map((t) => String(t.task_id)));
  const runKey = new Set();
  for (const r of blindedRuns) {
    if (!r || typeof r !== "object") throw new Error("Each blinded run must be an object");
    if (!taskIds.has(String(r.task_id))) throw new Error(`Unknown task_id in run: ${r.task_id}`);
    if (r.arm !== "arm_alpha" && r.arm !== "arm_beta") {
      throw new Error(`Run ${r.run_id ?? "(missing run_id)"} has invalid arm: ${r.arm}`);
    }
    const key = `${r.arm}:${r.task_id}`;
    if (runKey.has(key)) throw new Error(`Duplicate run for ${key}`);
    runKey.add(key);
    if (!Array.isArray(r.completed_success_criteria_ids)) {
      throw new Error(`Run ${r.run_id ?? key} missing completed_success_criteria_ids array`);
    }
    if (!Array.isArray(r.events)) {
      throw new Error(`Run ${r.run_id ?? key} missing events array`);
    }
    if (!isIsoDateString(r.started_at) || !isIsoDateString(r.ended_at)) {
      throw new Error(`Run ${r.run_id ?? key} must include valid started_at and ended_at ISO timestamps`);
    }
    const start = Date.parse(r.started_at);
    const end = Date.parse(r.ended_at);
    if (end < start) throw new Error(`Run ${r.run_id ?? key} has ended_at before started_at`);
  }

  for (const taskId of taskIds) {
    for (const arm of ["arm_alpha", "arm_beta"]) {
      const key = `${arm}:${taskId}`;
      if (!runKey.has(key)) throw new Error(`Missing run for ${key}`);
    }
  }
}

function convertRuns(blindedRuns, mapping) {
  return blindedRuns.map((r) => {
    const variant = mapping[r.arm];
    const normalizedRunId = `${variant}-${r.task_id}`;
    return {
      run_id: normalizedRunId,
      task_id: r.task_id,
      variant,
      started_at: r.started_at,
      ended_at: r.ended_at,
      completed_success_criteria_ids: r.completed_success_criteria_ids,
      events: r.events,
    };
  });
}

function runEvaluator(studyDir, json) {
  const args = ["scripts/evaluate-ab.js", "--study", studyDir];
  if (json) args.push("--json");
  const res = spawnSync("node", args, { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(res.stderr?.trim() || `evaluate-ab failed with exit code ${res.status}`);
  }
  process.stdout.write(res.stdout);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const studyDir = path.resolve(args.study);

  const taskSetPath = path.join(studyDir, "task_set.json");
  const blindedRunsPath = path.join(studyDir, "runs.blinded.json");
  const secretPath = path.join(studyDir, "blinding.secret.json");

  const [taskSet, blindedRuns, secret] = await Promise.all([
    readJson(taskSetPath),
    readJson(blindedRunsPath),
    readJson(secretPath),
  ]);

  validate(taskSet, blindedRuns, secret);
  const runs = convertRuns(blindedRuns, secret.variant_by_arm);
  const outPath = path.join(studyDir, "runs.json");
  await writeJson(outPath, runs);

  const summary = {
    study_dir: studyDir,
    total_runs: runs.length,
    task_count: taskSet.tasks.length,
    mapping_unblinded: true,
    output: "runs.json",
  };

  if (!args.evaluate) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (args.json) {
    runEvaluator(studyDir, true);
    return;
  }

  console.log(JSON.stringify(summary, null, 2));
  console.log("---");
  runEvaluator(studyDir, false);
}

main().catch((err) => {
  console.error(`unblind-live-ab failed: ${err.message}`);
  process.exit(1);
});
