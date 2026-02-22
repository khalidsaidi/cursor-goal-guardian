#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/scaffold-live-react-env.js \\",
      "    --env <env-root-dir> \\",
      "    --study <study-dir> \\",
      "    --tasks <task-set.json> \\",
      "    [--seed <seed>]",
      "",
      "Creates:",
      "  <env-root>/baseline   (fresh Vite React TS app)",
      "  <env-root>/arm_alpha  (copy of baseline)",
      "  <env-root>/arm_beta   (copy of baseline)",
      "  <study>/...           (blinded A/B scaffold via init-live-ab.js)",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = { env: "", study: "", tasks: "", seed: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--env") {
      args.env = String(argv[i + 1] ?? "");
      i += 1;
    } else if (v === "--study") {
      args.study = String(argv[i + 1] ?? "");
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

  if (!args.env) throw new Error("Missing required argument: --env <env-root-dir>");
  if (!args.study) throw new Error("Missing required argument: --study <study-dir>");
  if (!args.tasks) throw new Error("Missing required argument: --tasks <task-set.json>");
  return args;
}

function runOrThrow(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${res.status}`);
  }
}

async function ensureMissing(dirPath, label) {
  try {
    await fs.access(dirPath);
    throw new Error(`${label} already exists: ${dirPath}`);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return;
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const envRoot = path.resolve(args.env);
  const studyDir = path.resolve(args.study);
  const taskSetPath = path.resolve(args.tasks);

  await ensureMissing(envRoot, "Environment root");
  await ensureMissing(studyDir, "Study directory");

  await fs.mkdir(envRoot, { recursive: true });
  runOrThrow("npm", ["create", "vite@latest", "baseline", "--", "--template", "react-ts"], envRoot);
  runOrThrow("npm", ["install"], path.join(envRoot, "baseline"));

  runOrThrow("cp", ["-a", "baseline", "arm_alpha"], envRoot);
  runOrThrow("cp", ["-a", "baseline", "arm_beta"], envRoot);
  runOrThrow("rm", ["-rf", "arm_alpha/node_modules", "arm_beta/node_modules"], envRoot);
  runOrThrow("ln", ["-s", "../baseline/node_modules", "arm_alpha/node_modules"], envRoot);
  runOrThrow("ln", ["-s", "../baseline/node_modules", "arm_beta/node_modules"], envRoot);

  const initArgs = ["scripts/init-live-ab.js", "--out", studyDir, "--tasks", taskSetPath];
  if (args.seed) initArgs.push("--seed", args.seed);
  runOrThrow("node", initArgs, repoRoot);

  const operatorPaths = {
    env_root: envRoot,
    arm_paths: {
      arm_alpha: path.join(envRoot, "arm_alpha"),
      arm_beta: path.join(envRoot, "arm_beta"),
    },
    note: "Keep this file private from judges because they should not infer variant mapping.",
  };
  await fs.writeFile(path.join(studyDir, "operator.paths.json"), JSON.stringify(operatorPaths, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        env_root: envRoot,
        study_dir: studyDir,
        baseline: path.join(envRoot, "baseline"),
        arm_alpha: operatorPaths.arm_paths.arm_alpha,
        arm_beta: operatorPaths.arm_paths.arm_beta,
        next: `node scripts/unblind-live-ab.js --study ${studyDir} --evaluate`,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(`scaffold-live-react-env failed: ${err.message}`);
  process.exit(1);
});
