#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/evaluate-ab.js --study <study-dir> [--json]",
      "",
      "Required files inside <study-dir>:",
      "  - task_set.json",
      "  - runs.json",
      "",
      "Example:",
      "  node scripts/evaluate-ab.js --study examples/ab-study/sample",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = { study: "", json: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--study") {
      args.study = String(argv[i + 1] ?? "");
      i += 1;
    } else if (v === "--json") {
      args.json = true;
    } else if (v === "--help" || v === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${v}`);
    }
  }
  if (!args.study) {
    throw new Error("Missing required argument: --study <study-dir>");
  }
  return args;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmtPct(ratio) {
  return `${round(ratio * 100, 1)}%`;
}

function validateTaskSet(taskSet) {
  if (!taskSet || typeof taskSet !== "object") throw new Error("task_set.json must be an object");
  if (!Array.isArray(taskSet.tasks) || taskSet.tasks.length === 0) {
    throw new Error("task_set.json must include a non-empty tasks array");
  }
  const ids = new Set();
  for (const t of taskSet.tasks) {
    if (!t || typeof t !== "object") throw new Error("Each task must be an object");
    if (!t.task_id || typeof t.task_id !== "string") throw new Error("Each task must include task_id (string)");
    if (ids.has(t.task_id)) throw new Error(`Duplicate task_id in task_set: ${t.task_id}`);
    ids.add(t.task_id);
    if (!Array.isArray(t.success_criteria)) throw new Error(`Task ${t.task_id} must include success_criteria array`);
  }
}

function validateRuns(runs, taskSet) {
  if (!Array.isArray(runs) || runs.length === 0) throw new Error("runs.json must be a non-empty array");
  const validTaskIds = new Set(taskSet.tasks.map((t) => t.task_id));
  for (const run of runs) {
    if (!run.run_id || typeof run.run_id !== "string") throw new Error("Each run must include run_id (string)");
    if (!validTaskIds.has(run.task_id)) throw new Error(`Run ${run.run_id} references unknown task_id: ${run.task_id}`);
    if (run.variant !== "with_cgg" && run.variant !== "without_cgg") {
      throw new Error(`Run ${run.run_id} has invalid variant "${run.variant}" (expected with_cgg|without_cgg)`);
    }
    if (!Array.isArray(run.completed_success_criteria_ids)) {
      throw new Error(`Run ${run.run_id} must include completed_success_criteria_ids array`);
    }
    if (!Array.isArray(run.events)) throw new Error(`Run ${run.run_id} must include events array`);
  }
}

function getTaskCriteriaMap(taskSet) {
  const map = new Map();
  for (const task of taskSet.tasks) {
    const ids = task.success_criteria.map((c, idx) => String(c.id ?? `SC${idx + 1}`));
    map.set(task.task_id, ids);
  }
  return map;
}

function computeRunMetrics(run, criteriaByTask) {
  const criteria = criteriaByTask.get(run.task_id) ?? [];
  const criteriaSet = new Set(criteria);
  const completed = run.completed_success_criteria_ids.filter((id) => criteriaSet.has(id)).length;
  const completionRatio = criteria.length > 0 ? completed / criteria.length : 0;

  let scopeDriftIncidents = 0;
  let unplannedTaskSwitches = 0;
  let reworkMisunderstandingMinutes = 0;
  let reworkMisunderstandingIncidents = 0;

  const switchStarts = new Map();
  const resumeDurations = [];

  for (const e of run.events) {
    const type = String(e.type ?? "");
    if (type === "scope_drift") {
      scopeDriftIncidents += 1;
    } else if (type === "task_switch" && e.planned === false) {
      unplannedTaskSwitches += 1;
    } else if (type === "rework" && String(e.cause ?? "") === "misunderstanding") {
      reworkMisunderstandingIncidents += 1;
      const minutes = Number(e.minutes ?? 0);
      if (Number.isFinite(minutes) && minutes > 0) reworkMisunderstandingMinutes += minutes;
    } else if (type === "context_switch_start") {
      const id = String(e.switch_id ?? "");
      const ts = Date.parse(String(e.ts ?? ""));
      if (id && Number.isFinite(ts)) switchStarts.set(id, ts);
    } else if (type === "context_switch_resume") {
      const id = String(e.switch_id ?? "");
      const ts = Date.parse(String(e.ts ?? ""));
      const start = switchStarts.get(id);
      if (id && Number.isFinite(ts) && Number.isFinite(start) && ts >= start) {
        resumeDurations.push((ts - start) / 60000);
        switchStarts.delete(id);
      }
    }
  }

  return {
    run_id: run.run_id,
    task_id: run.task_id,
    variant: run.variant,
    scopeDriftIncidents,
    reworkMisunderstandingMinutes,
    reworkMisunderstandingIncidents,
    avgResumeMinutes: resumeDurations.length ? mean(resumeDurations) : 0,
    completionRatio,
    unplannedTaskSwitches,
    contextSwitchCount: resumeDurations.length,
  };
}

function aggregateVariant(runMetrics) {
  const completionRatios = runMetrics.map((r) => r.completionRatio);
  const resumeByContextSwitch = [];
  for (const r of runMetrics) {
    if (r.contextSwitchCount > 0) {
      resumeByContextSwitch.push(r.avgResumeMinutes);
    }
  }

  return {
    runCount: runMetrics.length,
    scopeDriftIncidentsPerTask: mean(runMetrics.map((r) => r.scopeDriftIncidents)),
    reworkMisunderstandingMinutesPerTask: mean(runMetrics.map((r) => r.reworkMisunderstandingMinutes)),
    reworkMisunderstandingIncidentsPerTask: mean(runMetrics.map((r) => r.reworkMisunderstandingIncidents)),
    avgResumeMinutesAfterContextSwitch: mean(resumeByContextSwitch),
    completionRatio: mean(completionRatios),
    unplannedTaskSwitchesPerTask: mean(runMetrics.map((r) => r.unplannedTaskSwitches)),
  };
}

function compare(withCgg, withoutCgg) {
  const rows = [
    {
      metric: "Scope drift incidents per task",
      better: "lower",
      with: withCgg.scopeDriftIncidentsPerTask,
      without: withoutCgg.scopeDriftIncidentsPerTask,
    },
    {
      metric: "Rework caused by misunderstanding (minutes/task)",
      better: "lower",
      with: withCgg.reworkMisunderstandingMinutesPerTask,
      without: withoutCgg.reworkMisunderstandingMinutesPerTask,
    },
    {
      metric: "Time to resume after context switch (minutes)",
      better: "lower",
      with: withCgg.avgResumeMinutesAfterContextSwitch,
      without: withoutCgg.avgResumeMinutesAfterContextSwitch,
    },
    {
      metric: "Task completion vs original success criteria",
      better: "higher",
      with: withCgg.completionRatio,
      without: withoutCgg.completionRatio,
    },
    {
      metric: "Unplanned task switches per task",
      better: "lower",
      with: withCgg.unplannedTaskSwitchesPerTask,
      without: withoutCgg.unplannedTaskSwitchesPerTask,
    },
  ];

  return rows.map((row) => {
    const delta = row.with - row.without;
    const improvement =
      row.better === "lower"
        ? row.without - row.with
        : row.with - row.without;
    const baseline = row.without === 0 ? null : improvement / row.without;
    return {
      ...row,
      delta,
      improvement,
      improvementPct: baseline === null ? null : baseline * 100,
    };
  });
}

function printTable(studyName, withAgg, withoutAgg, comparison) {
  console.log(`Study: ${studyName}`);
  console.log(`Runs: with_cgg=${withAgg.runCount}, without_cgg=${withoutAgg.runCount}`);
  console.log("");
  for (const row of comparison) {
    const left =
      row.metric === "Task completion vs original success criteria"
        ? `${fmtPct(row.with)} vs ${fmtPct(row.without)}`
        : `${round(row.with)} vs ${round(row.without)}`;

    const dir = row.improvement > 0 ? "better" : row.improvement < 0 ? "worse" : "no change";
    const pct = row.improvementPct === null ? "n/a" : `${round(row.improvementPct, 1)}%`;
    console.log(`- ${row.metric}`);
    console.log(`  with vs without: ${left}`);
    console.log(`  delta(with-without): ${round(row.delta)} | ${dir} | relative: ${pct}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const studyDir = path.resolve(args.study);

  const taskSetPath = path.join(studyDir, "task_set.json");
  const runsPath = path.join(studyDir, "runs.json");

  const [taskSet, runs] = await Promise.all([readJson(taskSetPath), readJson(runsPath)]);
  validateTaskSet(taskSet);
  validateRuns(runs, taskSet);

  const criteriaByTask = getTaskCriteriaMap(taskSet);
  const runMetrics = runs.map((r) => computeRunMetrics(r, criteriaByTask));

  const withRuns = runMetrics.filter((r) => r.variant === "with_cgg");
  const withoutRuns = runMetrics.filter((r) => r.variant === "without_cgg");
  if (withRuns.length === 0 || withoutRuns.length === 0) {
    throw new Error("Need at least one run for each variant: with_cgg and without_cgg");
  }

  const withAgg = aggregateVariant(withRuns);
  const withoutAgg = aggregateVariant(withoutRuns);
  const comparison = compare(withAgg, withoutAgg);

  const output = {
    study: taskSet.task_set_id ?? path.basename(studyDir),
    with_cgg: withAgg,
    without_cgg: withoutAgg,
    comparison,
    run_metrics: runMetrics,
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  printTable(output.study, withAgg, withoutAgg, comparison);
}

main().catch((err) => {
  console.error(`A/B evaluation failed: ${err.message}`);
  process.exit(1);
});

