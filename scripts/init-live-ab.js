#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/init-live-ab.js --out <study-dir> --tasks <task-set.json> [--seed <string>]",
      "",
      "Creates a blinded A/B study scaffold with:",
      "  - task_set.json",
      "  - runs.blinded.json (editable during study)",
      "  - blinding.public.json (safe to share with judges)",
      "  - blinding.secret.json (operator-only mapping)",
      "",
      "Example:",
      "  node scripts/init-live-ab.js \\",
      "    --out /tmp/cgg-live-react-20260222 \\",
      "    --tasks examples/ab-live-react/task_set_20.json \\",
      "    --seed react-live-v1",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = { out: "", tasks: "", seed: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--out") {
      args.out = String(argv[i + 1] ?? "");
      i += 1;
    } else if (v === "--tasks") {
      args.tasks = String(argv[i + 1] ?? "");
      i += 1;
    } else if (v === "--seed") {
      args.seed = String(argv[i + 1] ?? "");
      i += 1;
    } else if (v === "--help" || v === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${v}`);
    }
  }

  if (!args.out) throw new Error("Missing required argument: --out <study-dir>");
  if (!args.tasks) throw new Error("Missing required argument: --tasks <task-set.json>");
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

function validateTaskSet(taskSet) {
  if (!taskSet || typeof taskSet !== "object") throw new Error("task_set must be a JSON object");
  if (!Array.isArray(taskSet.tasks) || taskSet.tasks.length === 0) {
    throw new Error("task_set.tasks must be a non-empty array");
  }
  const ids = new Set();
  for (const t of taskSet.tasks) {
    if (!t || typeof t !== "object") throw new Error("Each task must be an object");
    if (!t.task_id || typeof t.task_id !== "string") throw new Error("Each task must include task_id");
    if (ids.has(t.task_id)) throw new Error(`Duplicate task_id: ${t.task_id}`);
    ids.add(t.task_id);
    if (!Array.isArray(t.success_criteria) || t.success_criteria.length === 0) {
      throw new Error(`Task ${t.task_id} must include non-empty success_criteria`);
    }
  }
}

function hashSeed(seedValue) {
  const seed = seedValue || crypto.randomUUID();
  return crypto.createHash("sha256").update(seed).digest("hex");
}

function variantByArm(seedHash) {
  const firstNibble = Number.parseInt(seedHash[0] ?? "0", 16);
  const withOnAlpha = Number.isFinite(firstNibble) ? firstNibble % 2 === 0 : true;
  return withOnAlpha
    ? { arm_alpha: "with_cgg", arm_beta: "without_cgg" }
    : { arm_alpha: "without_cgg", arm_beta: "with_cgg" };
}

function makeRunSkeleton(taskId, arm) {
  return {
    run_id: `${arm}-${taskId}`,
    task_id: taskId,
    arm,
    started_at: "",
    ended_at: "",
    completed_success_criteria_ids: [],
    events: [],
    notes: "",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  const taskSetPath = path.resolve(args.tasks);

  const taskSet = await readJson(taskSetPath);
  validateTaskSet(taskSet);

  await fs.mkdir(outDir, { recursive: true });

  const seedHash = hashSeed(args.seed);
  const mapping = variantByArm(seedHash);
  const taskIds = taskSet.tasks.map((t) => t.task_id);

  const runs = [];
  for (const taskId of taskIds) {
    runs.push(makeRunSkeleton(taskId, "arm_alpha"));
    runs.push(makeRunSkeleton(taskId, "arm_beta"));
  }

  const publicMeta = {
    study_id: taskSet.task_set_id ?? path.basename(outDir),
    created_at: new Date().toISOString(),
    arms: ["arm_alpha", "arm_beta"],
    task_count: taskIds.length,
    blinding_method: "seeded arm mapping; mapping hidden in blinding.secret.json",
    files: {
      task_set: "task_set.json",
      blinded_runs: "runs.blinded.json",
      blinded_meta: "blinding.public.json",
    },
  };

  const secretMeta = {
    ...publicMeta,
    seed_hash: seedHash,
    variant_by_arm: mapping,
    keep_private: true,
  };

  await writeJson(path.join(outDir, "task_set.json"), taskSet);
  await writeJson(path.join(outDir, "runs.blinded.json"), runs);
  await writeJson(path.join(outDir, "blinding.public.json"), publicMeta);
  await writeJson(path.join(outDir, "blinding.secret.json"), secretMeta);

  console.log(
    JSON.stringify(
      {
        study_dir: outDir,
        study_id: publicMeta.study_id,
        task_count: taskIds.length,
        arms: publicMeta.arms,
        next_steps: [
          "Run each task twice: once in arm_alpha environment, once in arm_beta environment.",
          "Fill runs.blinded.json during execution (criteria IDs + events + timestamps).",
          "Share only task_set.json, runs.blinded.json, blinding.public.json with judges.",
          "After scoring, unblind with: node scripts/unblind-live-ab.js --study <study-dir>",
        ],
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(`init-live-ab failed: ${err.message}`);
  process.exit(1);
});
