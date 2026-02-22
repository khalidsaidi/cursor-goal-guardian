#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/record-panel-demo-20tasks.mjs [options]",
      "",
      "Options:",
      "  --tasks <path>           Task set JSON (default: examples/ab-live-react/task_set_20.json)",
      "  --out-dir <path>         Output directory (default: artifacts/panel-demo)",
      "  --out-file <name>        Output video filename (default: goal-guardian-panel-demo-20tasks.webm)",
      "  --final-shot <name>      Final screenshot filename (default: goal-guardian-panel-demo-20tasks-final.png)",
      "  --width <px>             Viewport width (default: 1660)",
      "  --height <px>            Viewport height (default: 1040)",
      "  --step-ms <ms>           Delay per animated state step (default: 300)",
      "  --intro-ms <ms>          Intro hold before playback (default: 1800)",
      "  --outro-ms <ms>          Outro hold after playback (default: 2600)",
      "",
      "Example:",
      "  node scripts/record-panel-demo-20tasks.mjs --step-ms 340",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const out = {
    tasks: "examples/ab-live-react/task_set_20.json",
    outDir: "artifacts/panel-demo",
    outFile: "goal-guardian-panel-demo-20tasks.webm",
    finalShot: "goal-guardian-panel-demo-20tasks-final.png",
    width: 1660,
    height: 1040,
    stepMs: 300,
    introMs: 1800,
    outroMs: 2600,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      continue;
    }
    if (token === "--help" || token === "-h") {
      usage();
      process.exit(0);
    }
    if (token === "--tasks") {
      out.tasks = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (token === "--out-dir") {
      out.outDir = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (token === "--out-file") {
      out.outFile = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (token === "--final-shot") {
      out.finalShot = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (token === "--width") {
      out.width = Number.parseInt(String(argv[i + 1] ?? ""), 10);
      i += 1;
      continue;
    }
    if (token === "--height") {
      out.height = Number.parseInt(String(argv[i + 1] ?? ""), 10);
      i += 1;
      continue;
    }
    if (token === "--step-ms") {
      out.stepMs = Number.parseInt(String(argv[i + 1] ?? ""), 10);
      i += 1;
      continue;
    }
    if (token === "--intro-ms") {
      out.introMs = Number.parseInt(String(argv[i + 1] ?? ""), 10);
      i += 1;
      continue;
    }
    if (token === "--outro-ms") {
      out.outroMs = Number.parseInt(String(argv[i + 1] ?? ""), 10);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!out.tasks) throw new Error("Missing --tasks path");
  if (!out.outDir) throw new Error("Missing --out-dir path");
  if (!out.outFile) throw new Error("Missing --out-file value");
  if (!out.finalShot) throw new Error("Missing --final-shot value");
  if (!Number.isFinite(out.width) || out.width < 900) throw new Error("--width must be >= 900");
  if (!Number.isFinite(out.height) || out.height < 640) throw new Error("--height must be >= 640");
  if (!Number.isFinite(out.stepMs) || out.stepMs < 90) throw new Error("--step-ms must be >= 90");
  if (!Number.isFinite(out.introMs) || out.introMs < 0) throw new Error("--intro-ms must be >= 0");
  if (!Number.isFinite(out.outroMs) || out.outroMs < 0) throw new Error("--outro-ms must be >= 0");
  return out;
}

async function readTaskSet(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
    throw new Error("Task set JSON must contain a tasks array.");
  }
  if (parsed.tasks.length < 20) {
    throw new Error(`Expected at least 20 tasks; found ${parsed.tasks.length}`);
  }
  return parsed;
}

function short(value, max = 120) {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function makeInitialModel() {
  const now = new Date().toISOString();
  return {
    taskSetLabel: "React 20-task first-time-user run",
    activeTaskSetIndex: 0,
    totalTaskSets: 20,
    goal: "Waiting for first prompt...",
    criteria: [],
    constraints: [
      "No scope expansion without explicit criteria mapping.",
      "Track progress in Redux state first, not chat memory.",
      "Keep one active task at a time.",
    ],
    tasks: [],
    activeTaskId: "",
    openQuestions: 0,
    decisions: 0,
    pinnedContext: 0,
    actions: [
      {
        type: "BOOT",
        ts: now,
        detail: "Goal Guardian panel initialized.",
      },
    ],
    lastDiff: "State bootstrapped.",
    drift: {
      health: "Stable",
      drift24h: 0,
      realign24h: 0,
      unresolved: 0,
      feed: [],
    },
    stateUpdatedAt: now,
    nextAction: "Load the first task prompt and set goal.",
  };
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function deriveHealth(drift) {
  if (drift.drift24h === 0) return "Stable";
  if (drift.unresolved > 0) return "Drifting";
  return "Recovering";
}

function pushDriftFeed(model, item) {
  model.drift.feed.unshift(item);
  model.drift.feed = model.drift.feed.slice(0, 12);
}

function addAction(model, type, ts, detail) {
  model.actions.unshift({ type, ts, detail: short(detail, 128) });
  model.actions = model.actions.slice(0, 30);
  model.lastDiff = `${type}: ${short(detail, 150)}`;
  model.stateUpdatedAt = ts;
}

function setTaskStatus(model, taskId, status) {
  const task = model.tasks.find((x) => x.id === taskId);
  if (!task) return;
  task.status = status;
}

function computeNextAction(model) {
  if (!model.goal || model.goal === "Waiting for first prompt...") {
    return "Set goal from current user prompt.";
  }
  if (model.criteria.length === 0) {
    return "Extract success criteria and add tasks.";
  }
  if (model.drift.unresolved > 0) {
    return "Realign now: record a decision and re-anchor to active criterion.";
  }
  const todo = model.tasks.find((t) => t.status === "todo");
  if (!model.activeTaskId && todo) {
    return `Start next task ${todo.id}.`;
  }
  if (model.activeTaskId) {
    return `Continue active task ${model.activeTaskId} until criterion is met.`;
  }
  if (model.openQuestions > 0) {
    return "Close open questions before finalizing.";
  }
  return "Validate final output against all success criteria.";
}

function toViewModel(model) {
  const total = model.tasks.length;
  const done = model.tasks.filter((t) => t.status === "done").length;
  const doing = model.tasks.filter((t) => t.status === "doing").length;
  const todo = model.tasks.filter((t) => t.status === "todo").length;
  const completionPct = total > 0 ? Math.round((done / total) * 100) : 0;
  const activeTask = model.tasks.find((t) => t.id === model.activeTaskId);
  return {
    ...model,
    activeTaskTitle: activeTask ? activeTask.title : "",
    totals: { total, done, doing, todo, completionPct },
    nextAction: computeNextAction(model),
  };
}

function buildHtmlTemplate() {
  return String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Goal Guardian Panel Demo</title>
  <style>
    :root {
      --bg: #0b1220;
      --panel: #111b2d;
      --panel-soft: #0f1728;
      --border: rgba(148, 163, 184, 0.22);
      --muted: #9fb1c9;
      --text: #deebf8;
      --accent: #5cc8ff;
      --accent-soft: #8be7f6;
      --warn: #fbbf24;
      --ok: #34d399;
      --decision: #f472b6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 0% 0%, rgba(92, 200, 255, 0.14), transparent 44%),
        radial-gradient(circle at 100% 100%, rgba(52, 211, 153, 0.1), transparent 34%),
        var(--bg);
      min-height: 100vh;
      padding: 18px;
    }
    .root { max-width: 1600px; margin: 0 auto; display: grid; gap: 14px; }
    .hero {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(17, 27, 45, 0.92), rgba(15, 23, 40, 0.82));
      padding: 16px 18px;
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 12px;
    }
    .hero h1 { margin: 0 0 4px; font-size: 22px; }
    .hero .sub { color: var(--muted); font-size: 12px; }
    .badges { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .badge {
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
      color: var(--muted);
      background: rgba(15, 23, 42, 0.7);
    }
    .grid { display: grid; gap: 14px; }
    .top-grid { display: grid; gap: 14px; grid-template-columns: 1.05fr 1fr; }
    .card {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(17, 27, 45, 0.92), rgba(15, 23, 40, 0.86));
      padding: 14px;
      box-shadow: 0 12px 24px rgba(2, 6, 23, 0.36);
    }
    .card-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
      align-items: center;
    }
    .card-title { font-size: 14px; font-weight: 600; }
    .pill { font-size: 11px; color: var(--muted); }
    .guide-list { display: grid; gap: 8px; }
    .guide-item {
      border: 1px solid rgba(148, 163, 184, 0.16);
      background: rgba(15, 23, 42, 0.54);
      border-radius: 10px;
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.45;
    }
    .guide-item b { color: var(--accent-soft); }
    .pulse-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .pulse {
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.5);
      padding: 8px 10px;
    }
    .pulse .k { color: var(--muted); font-size: 10px; display: block; margin-bottom: 2px; }
    .pulse .v { font-size: 15px; font-weight: 700; }
    .progress { margin: 10px 0 12px; }
    .progress-label { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-bottom: 6px; }
    .track { height: 8px; border-radius: 999px; overflow: hidden; border: 1px solid rgba(148, 163, 184, 0.2); background: rgba(148, 163, 184, 0.2); }
    .fill { height: 100%; width: 0; background: linear-gradient(90deg, #22d3ee, #34d399); transition: width 150ms linear; }
    .next {
      border: 1px solid rgba(34, 211, 238, 0.28);
      background: rgba(34, 211, 238, 0.09);
      border-radius: 11px;
      padding: 9px 11px;
      font-size: 12px;
      line-height: 1.4;
    }
    .next .label { color: var(--muted); font-size: 10px; text-transform: uppercase; margin-bottom: 2px; letter-spacing: 0.03em; }
    .timeline-legend { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 8px; }
    .legend {
      border: 1px solid rgba(148, 163, 184, 0.16);
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 10px;
      color: var(--muted);
      background: rgba(15, 23, 42, 0.5);
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .dot.goal { background: #38bdf8; }
    .dot.task { background: #34d399; }
    .dot.question { background: #fbbf24; }
    .dot.decision { background: #f472b6; }
    .timeline-graph-wrap {
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(15, 23, 42, 0.5);
      border-radius: 12px;
      padding: 6px;
      margin-bottom: 10px;
    }
    .timeline-graph { width: 100%; height: 130px; display: block; }
    .timeline-grid { display: grid; gap: 10px; grid-template-columns: 1.25fr 0.95fr; }
    .timeline-list { display: grid; gap: 8px; max-height: 390px; overflow: hidden; }
    .timeline-item {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 8px;
      border: 1px solid rgba(148, 163, 184, 0.14);
      background: rgba(15, 23, 42, 0.5);
      border-radius: 10px;
      padding: 8px 10px;
      align-items: start;
    }
    .timeline-item .icon {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
      margin-top: 5px;
      box-shadow: 0 0 0 5px rgba(92, 200, 255, 0.14);
    }
    .timeline-item .tt { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
    .timeline-item .tm { font-size: 10px; color: var(--muted); margin-bottom: 3px; }
    .timeline-item .td { font-size: 11px; color: var(--muted); line-height: 1.35; }
    .diff {
      border: 1px solid rgba(148, 163, 184, 0.14);
      background: rgba(15, 23, 42, 0.5);
      border-radius: 11px;
      padding: 10px;
      font-size: 12px;
      line-height: 1.45;
      color: var(--muted);
    }
    .goal-box {
      border: 1px solid rgba(92, 200, 255, 0.24);
      background: rgba(92, 200, 255, 0.1);
      border-radius: 11px;
      padding: 11px 12px;
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 10px;
    }
    .chips { display: flex; gap: 7px; flex-wrap: wrap; }
    .chip {
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 999px;
      padding: 3px 9px;
      font-size: 11px;
      color: #d0deee;
      background: rgba(15, 23, 42, 0.5);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .task-board { display: grid; gap: 8px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .task-col {
      border: 1px solid rgba(148, 163, 184, 0.16);
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.5);
      padding: 8px;
      min-height: 145px;
    }
    .task-col-head {
      display: flex;
      justify-content: space-between;
      margin-bottom: 6px;
      font-size: 12px;
      font-weight: 600;
    }
    .task-item {
      border: 1px solid rgba(148, 163, 184, 0.14);
      border-radius: 9px;
      background: rgba(30, 41, 59, 0.55);
      padding: 7px 8px;
      margin-bottom: 6px;
    }
    .task-item .t { font-size: 11px; font-weight: 600; margin-bottom: 2px; }
    .task-item .id { font-size: 10px; color: var(--muted); }
    .drift-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 9px; }
    .drift-pill {
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 9px;
      background: rgba(15, 23, 42, 0.5);
      padding: 8px 9px;
    }
    .drift-pill .k { display: block; font-size: 10px; color: var(--muted); margin-bottom: 2px; }
    .drift-pill .v { font-size: 15px; font-weight: 700; }
    .drift-feed { display: grid; gap: 8px; max-height: 280px; overflow: hidden; }
    .drift-item {
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.5);
      padding: 9px 10px;
    }
    .drift-item.warning { border-color: rgba(251, 191, 36, 0.35); }
    .drift-item.recovered { border-color: rgba(52, 211, 153, 0.35); }
    .drift-item .top { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; margin-bottom: 3px; }
    .drift-item .dt { font-size: 11px; color: var(--muted); line-height: 1.35; }
    .criteria-list { display: grid; gap: 6px; }
    .criteria {
      border: 1px solid rgba(148, 163, 184, 0.14);
      border-radius: 9px;
      background: rgba(15, 23, 42, 0.5);
      padding: 6px 8px;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 7px;
      font-size: 12px;
      align-items: start;
    }
    .criteria .id { color: var(--accent); font-weight: 700; font-size: 11px; }
    .muted { color: var(--muted); }
    .empty { color: var(--muted); font-size: 12px; }
    @media (max-width: 1160px) {
      .top-grid { grid-template-columns: 1fr; }
      .timeline-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 880px) {
      .task-board { grid-template-columns: 1fr; }
      .drift-summary { grid-template-columns: 1fr; }
      .pulse-grid { grid-template-columns: 1fr; }
      .hero { grid-template-columns: 1fr; }
      .badges { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <div class="root">
    <section class="hero">
      <div>
        <h1>Goal Guardian</h1>
        <div class="sub" id="hero-sub">Anti-drift state engine</div>
      </div>
      <div class="badges">
        <span class="badge" id="badge-goal">Goal Set</span>
        <span class="badge">State-driven</span>
        <span class="badge" id="badge-taskset">Task 0/20</span>
      </div>
    </section>

    <div class="grid">
      <div class="top-grid">
        <section class="card">
          <div class="card-head">
            <div class="card-title">How To Read This Panel</div>
            <span class="pill">Quick onboarding</span>
          </div>
          <div class="guide-list">
            <div class="guide-item">Start with <b>Goal & Constraints</b> to confirm what should be built.</div>
            <div class="guide-item">Use <b>Action Timeline</b> to see what changed after each state action.</div>
            <div class="guide-item">Check <b>Drift & Realignment</b>: warnings show drift, recovered means realigned.</div>
            <div class="guide-item">Follow <b>Next Best Action</b> for what to do right now.</div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <div class="card-title">Session Pulse</div>
            <span class="pill" id="state-updated">Updated just now</span>
          </div>
          <div class="pulse-grid">
            <div class="pulse"><span class="k">Tasks Completed</span><span class="v" id="pulse-completed">0/0</span></div>
            <div class="pulse"><span class="k">Drift Health</span><span class="v" id="pulse-health">Stable</span></div>
            <div class="pulse"><span class="k">Active Task</span><span class="v" id="pulse-active">None</span></div>
            <div class="pulse"><span class="k">Open Questions</span><span class="v" id="pulse-questions">0</span></div>
          </div>
          <div class="progress">
            <div class="progress-label"><span>Definition of Done Progress</span><span id="progress-pct">0%</span></div>
            <div class="track"><div class="fill" id="progress-fill"></div></div>
          </div>
          <div class="next">
            <div class="label">Next Best Action</div>
            <div id="next-action"></div>
          </div>
        </section>
      </div>

      <section class="card">
        <div class="card-head">
          <div class="card-title">Action Timeline</div>
          <span class="pill" id="timeline-count">0 recent</span>
        </div>
        <div class="timeline-legend">
          <span class="legend"><span class="dot goal"></span>Goal / Scope</span>
          <span class="legend"><span class="dot task"></span>Task Progress</span>
          <span class="legend"><span class="dot question"></span>Questions</span>
          <span class="legend"><span class="dot decision"></span>Realignment</span>
        </div>
        <div class="timeline-graph-wrap">
          <svg class="timeline-graph" viewBox="0 0 900 130" preserveAspectRatio="none" id="timeline-svg"></svg>
        </div>
        <div class="timeline-grid">
          <div class="timeline-list" id="timeline-list"></div>
          <div class="diff">
            <div class="card-title" style="margin-bottom:7px;">Latest Diff</div>
            <div id="latest-diff" class="muted">No diff yet.</div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="card-title">Goal & Constraints</div>
          <span class="pill" id="criteria-count">0 criteria</span>
        </div>
        <div class="goal-box" id="goal-text"></div>
        <div class="card-title" style="margin-bottom:6px;">Definition of Done</div>
        <div class="chips" id="criteria-chips"></div>
        <div style="height: 10px;"></div>
        <div class="card-title" style="margin-bottom:6px;">Constraints</div>
        <div class="chips" id="constraint-chips"></div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="card-title">Tasks Board</div>
          <span class="pill" id="active-task-id">Active: None</span>
        </div>
        <div class="task-board">
          <div class="task-col">
            <div class="task-col-head"><span>To Do</span><span id="todo-count">0</span></div>
            <div id="todo-list"></div>
          </div>
          <div class="task-col">
            <div class="task-col-head"><span>Doing</span><span id="doing-count">0</span></div>
            <div id="doing-list"></div>
          </div>
          <div class="task-col">
            <div class="task-col-head"><span>Done</span><span id="done-count">0</span></div>
            <div id="done-list"></div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="card-title">Drift & Realignment</div>
          <span class="pill" id="drift-health-pill">Stable</span>
        </div>
        <div class="drift-summary">
          <div class="drift-pill"><span class="k">Drift (24h)</span><span class="v" id="drift-24h">0</span></div>
          <div class="drift-pill"><span class="k">Realigned (24h)</span><span class="v" id="realign-24h">0</span></div>
          <div class="drift-pill"><span class="k">Open Drift</span><span class="v" id="open-drift">0</span></div>
        </div>
        <div class="drift-feed" id="drift-feed"></div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="card-title">Success Criteria</div>
          <span class="pill" id="task-set-label"></span>
        </div>
        <div class="criteria-list" id="criteria-list"></div>
      </section>
    </div>
  </div>

  <script>
    function escapeHtml(text) {
      return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function formatAgo(iso) {
      const ts = Date.parse(String(iso || ""));
      if (!Number.isFinite(ts)) return "Unknown";
      const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
      if (minutes < 1) return "just now";
      if (minutes < 60) return minutes + "m ago";
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return h + "h " + m + "m ago";
    }

    function colorFor(type) {
      if (type === "SET_GOAL" || type === "ADD_TASKS") return "#38bdf8";
      if (type === "START_TASK" || type === "COMPLETE_TASK") return "#34d399";
      if (type === "OPEN_QUESTION" || type === "CLOSE_QUESTION") return "#fbbf24";
      if (type === "ADD_DECISION") return "#f472b6";
      return "#8be7f6";
    }

    function drawTimelineGraph(actions) {
      const svg = document.getElementById("timeline-svg");
      if (!svg) return;
      if (!actions.length) {
        svg.innerHTML = "";
        return;
      }
      const items = actions.slice(0, 30).slice().reverse();
      const width = 900;
      const height = 130;
      const pad = 26;
      const points = items.map((item, idx) => {
        const x = pad + (idx / Math.max(1, items.length - 1)) * (width - pad * 2);
        const lane = item.type === "SET_GOAL" || item.type === "ADD_TASKS"
          ? 0
          : item.type === "OPEN_QUESTION" || item.type === "CLOSE_QUESTION"
            ? 2
            : item.type === "ADD_DECISION"
              ? 3
              : 1;
        const y = 24 + lane * 24;
        return { x, y, item };
      });
      const path = points.map((p, i) => (i === 0 ? "M" : "L") + " " + p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" ");
      const circles = points.map((p) => {
        return '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="4.6" fill="' + colorFor(p.item.type) + '"><title>'
          + escapeHtml(p.item.type + " | " + p.item.ts) + "</title></circle>";
      }).join("");
      svg.innerHTML = ''
        + '<defs><linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#22d3ee"/></linearGradient></defs>'
        + '<path d="' + path + '" fill="none" stroke="url(#lineGrad)" stroke-width="2" opacity="0.95"/>'
        + circles
        + '<line x1="' + pad + '" y1="' + (height - 20) + '" x2="' + (width - pad) + '" y2="' + (height - 20) + '" stroke="rgba(148,163,184,0.3)"/>';
    }

    window.setPanelModel = (model) => {
      document.getElementById("hero-sub").textContent = model.goal ? "Anti-drift state engine" : "Define a goal to begin";
      document.getElementById("badge-goal").textContent = model.goal ? "Goal Set" : "No Goal";
      document.getElementById("badge-taskset").textContent = "Task " + model.activeTaskSetIndex + "/" + model.totalTaskSets;

      document.getElementById("state-updated").textContent = "State updated " + formatAgo(model.stateUpdatedAt);
      document.getElementById("pulse-completed").textContent = model.totals.done + "/" + model.totals.total;
      document.getElementById("pulse-health").textContent = model.drift.health;
      document.getElementById("pulse-active").textContent = model.activeTaskId || "None";
      document.getElementById("pulse-questions").textContent = String(model.openQuestions);
      document.getElementById("progress-pct").textContent = model.totals.completionPct + "%";
      document.getElementById("progress-fill").style.width = model.totals.completionPct + "%";
      document.getElementById("next-action").textContent = model.nextAction;

      document.getElementById("timeline-count").textContent = model.actions.length + " recent";
      document.getElementById("latest-diff").textContent = model.lastDiff;
      drawTimelineGraph(model.actions);

      const timeline = document.getElementById("timeline-list");
      timeline.innerHTML = model.actions.slice(0, 12).map((a) => (
        '<div class="timeline-item">'
          + '<div class="icon" style="background:' + colorFor(a.type) + ';box-shadow:0 0 0 5px rgba(92,200,255,0.14);"></div>'
          + '<div><div class="tt">' + escapeHtml(a.type) + '</div>'
          + '<div class="tm">' + escapeHtml(a.ts) + '</div>'
          + '<div class="td">' + escapeHtml(a.detail || "") + '</div></div>'
          + '</div>'
      )).join("");

      document.getElementById("goal-text").textContent = model.goal || "Set a goal to anchor the run.";
      document.getElementById("criteria-count").textContent = model.criteria.length + " criteria";
      document.getElementById("criteria-chips").innerHTML = model.criteria.length
        ? model.criteria.map((c) => '<span class="chip">' + escapeHtml(c) + '</span>').join("")
        : '<span class="empty">No criteria yet</span>';
      document.getElementById("constraint-chips").innerHTML = model.constraints.length
        ? model.constraints.map((c) => '<span class="chip">' + escapeHtml(c) + '</span>').join("")
        : '<span class="empty">No constraints</span>';

      document.getElementById("active-task-id").textContent = "Active: " + (model.activeTaskId || "None");
      const todo = model.tasks.filter((t) => t.status === "todo");
      const doing = model.tasks.filter((t) => t.status === "doing");
      const done = model.tasks.filter((t) => t.status === "done");
      document.getElementById("todo-count").textContent = String(todo.length);
      document.getElementById("doing-count").textContent = String(doing.length);
      document.getElementById("done-count").textContent = String(done.length);
      const renderTasks = (items) => items.length
        ? items.map((t) => '<div class="task-item"><div class="t">' + escapeHtml(t.title) + '</div><div class="id">' + escapeHtml(t.id) + '</div></div>').join("")
        : '<div class="empty">No tasks</div>';
      document.getElementById("todo-list").innerHTML = renderTasks(todo);
      document.getElementById("doing-list").innerHTML = renderTasks(doing);
      document.getElementById("done-list").innerHTML = renderTasks(done);

      document.getElementById("drift-health-pill").textContent = model.drift.health;
      document.getElementById("drift-24h").textContent = String(model.drift.drift24h);
      document.getElementById("realign-24h").textContent = String(model.drift.realign24h);
      document.getElementById("open-drift").textContent = String(model.drift.unresolved);
      const feed = document.getElementById("drift-feed");
      feed.innerHTML = model.drift.feed.length
        ? model.drift.feed.map((d) => (
            '<div class="drift-item ' + escapeHtml(d.tone || "") + '"><div class="top"><strong>'
            + escapeHtml(d.label) + '</strong><span class="muted">' + escapeHtml(d.timeAgo || "") + '</span></div>'
            + '<div class="dt">' + escapeHtml(d.detail || "") + '</div></div>'
          )).join("")
        : '<div class="empty">No drift telemetry yet</div>';

      document.getElementById("task-set-label").textContent = model.taskSetLabel;
      document.getElementById("criteria-list").innerHTML = model.criteria.length
        ? model.criteria.map((c, i) => '<div class="criteria"><span class="id">SC' + (i + 1) + '</span><span>' + escapeHtml(c) + '</span></div>').join("")
        : '<div class="empty">No success criteria yet</div>';
    };
  </script>
</body>
</html>`;
}

function formatAgoForFeed(ts) {
  const ms = Date.now() - Date.parse(ts);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m ago`;
}

function makeTaskRows(task) {
  return task.success_criteria.map((criterion, idx) => ({
    id: `${task.task_id.toLowerCase()}_sc_${idx + 1}`,
    title: short(`SC${idx + 1}: ${criterion.text}`, 86),
    status: "todo",
  }));
}

function makeTimelineDetail(type, task, idx, criterion) {
  if (type === "SET_GOAL") return `Goal set from prompt: ${short(task.user_prompt, 82)}`;
  if (type === "ADD_TASKS") return `Loaded ${task.success_criteria.length} criteria tasks for ${task.task_id}.`;
  if (type === "START_TASK") return `Started ${criterion ? criterion.id : "next criterion"} in ${task.task_id}.`;
  if (type === "COMPLETE_TASK") return `Completed ${criterion ? criterion.id : "criterion"} for ${task.task_id}.`;
  if (type === "OPEN_QUESTION") return `Clarification needed for criterion ${idx + 1}.`;
  if (type === "ADD_DECISION") return `Decision logged to realign on ${task.task_id}.`;
  if (type === "PIN_CONTEXT") return `Pinned source file context for current criterion.`;
  return `${type} executed.`;
}

async function probeDurationSeconds(videoPath) {
  try {
    const output = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ], { encoding: "utf8" }).trim();
    const value = Number.parseFloat(output);
    if (Number.isFinite(value) && value > 0) return value;
    return 0;
  } catch {
    return 0;
  }
}

async function publish(page, model) {
  const vm = toViewModel(model);
  await page.evaluate((value) => {
    window.setPanelModel(value);
  }, vm);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const tasksPath = path.resolve(repoRoot, args.tasks);
  const outDir = path.resolve(repoRoot, args.outDir);
  const videoOut = path.join(outDir, args.outFile);
  const screenshotOut = path.join(outDir, args.finalShot);

  await fs.mkdir(outDir, { recursive: true });

  const taskSet = await readTaskSet(tasksPath);
  const tasks = taskSet.tasks.slice(0, 20);
  const model = makeInitialModel();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: args.width, height: args.height },
    recordVideo: {
      dir: outDir,
      size: { width: args.width, height: args.height },
    },
  });
  const page = await context.newPage();

  await page.setContent(buildHtmlTemplate(), { waitUntil: "domcontentloaded" });
  await publish(page, model);
  await page.waitForTimeout(args.introMs);

  let virtualTs = Date.now() - 3 * 60 * 60 * 1000;
  const ts = () => {
    virtualTs += 52_000;
    return new Date(virtualTs).toISOString();
  };

  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
    const task = tasks[taskIndex];
    model.taskSetLabel = `${task.task_id} · ${task.title}`;
    model.activeTaskSetIndex = taskIndex + 1;
    model.goal = short(task.user_prompt, 240);
    model.criteria = task.success_criteria.map((c) => short(c.text, 118));
    model.tasks = makeTaskRows(task);
    model.activeTaskId = "";

    addAction(model, "SET_GOAL", ts(), makeTimelineDetail("SET_GOAL", task, 0, null));
    await publish(page, model);
    await page.waitForTimeout(args.stepMs + 70);

    addAction(model, "ADD_TASKS", ts(), makeTimelineDetail("ADD_TASKS", task, 0, null));
    await publish(page, model);
    await page.waitForTimeout(args.stepMs + 40);

    for (let criterionIdx = 0; criterionIdx < task.success_criteria.length; criterionIdx += 1) {
      const criterion = task.success_criteria[criterionIdx];
      const row = model.tasks[criterionIdx];
      if (!row) continue;

      model.activeTaskId = row.id;
      setTaskStatus(model, row.id, "doing");
      addAction(model, "START_TASK", ts(), makeTimelineDetail("START_TASK", task, criterionIdx, row));
      await publish(page, model);
      await page.waitForTimeout(args.stepMs);

      if (criterionIdx === 1 && taskIndex % 5 === 2) {
        model.openQuestions += 1;
        addAction(model, "OPEN_QUESTION", ts(), makeTimelineDetail("OPEN_QUESTION", task, criterionIdx, row));
        await publish(page, model);
        await page.waitForTimeout(args.stepMs - 40);

        if (model.openQuestions > 0) {
          model.openQuestions -= 1;
          addAction(model, "CLOSE_QUESTION", ts(), `Closed clarification for ${row.id}.`);
          await publish(page, model);
          await page.waitForTimeout(args.stepMs - 50);
        }
      }

      if (criterionIdx === 3 && taskIndex % 3 === 0) {
        model.pinnedContext += 1;
        addAction(model, "PIN_CONTEXT", ts(), makeTimelineDetail("PIN_CONTEXT", task, criterionIdx, row));
        await publish(page, model);
        await page.waitForTimeout(args.stepMs - 60);
      }

      setTaskStatus(model, row.id, "done");
      model.activeTaskId = "";
      addAction(model, "COMPLETE_TASK", ts(), makeTimelineDetail("COMPLETE_TASK", task, criterionIdx, row));
      await publish(page, model);
      await page.waitForTimeout(args.stepMs);
    }

    if (taskIndex % 4 === 1) {
      const driftTs = ts();
      model.drift.drift24h += 1;
      model.drift.unresolved += 1;
      model.drift.health = deriveHealth(model.drift);
      pushDriftFeed(model, {
        tone: "warning",
        label: `Drift detected on ${task.task_id}`,
        detail: `Unplanned switch away from ${task.task_id} criteria.`,
        timeAgo: formatAgoForFeed(driftTs),
      });
      addAction(model, "OPEN_QUESTION", driftTs, "Scope drift warning captured by telemetry.");
      await publish(page, model);
      await page.waitForTimeout(args.stepMs + 110);

      const realignTs = ts();
      model.drift.realign24h += 1;
      model.drift.unresolved = Math.max(0, model.drift.unresolved - 1);
      model.decisions += 1;
      model.drift.health = deriveHealth(model.drift);
      pushDriftFeed(model, {
        tone: "recovered",
        label: `Realigned ${task.task_id}`,
        detail: `Decision logged and focus returned to planned criteria.`,
        timeAgo: formatAgoForFeed(realignTs),
      });
      addAction(model, "ADD_DECISION", realignTs, makeTimelineDetail("ADD_DECISION", task, 0, null));
      await publish(page, model);
      await page.waitForTimeout(args.stepMs + 80);
    } else {
      model.drift.health = deriveHealth(model.drift);
    }

    await page.waitForTimeout(120);
  }

  addAction(model, "FINAL_REVIEW", ts(), "All 20 tasks replayed. Ready for human review against criteria.");
  model.drift.health = deriveHealth(model.drift);
  await publish(page, model);
  await page.waitForTimeout(args.outroMs);

  await page.screenshot({ path: screenshotOut, fullPage: true });

  const video = page.video();
  if (!video) {
    throw new Error("Playwright did not expose a video handle.");
  }

  await context.close();
  await browser.close();

  const tempVideoPath = await video.path();
  await fs.rm(videoOut, { force: true });
  await fs.rename(tempVideoPath, videoOut);

  const durationSeconds = await probeDurationSeconds(videoOut);
  const summary = {
    task_set_id: taskSet.task_set_id ?? "unknown",
    tasks_replayed: tasks.length,
    video: videoOut,
    screenshot: screenshotOut,
    width: args.width,
    height: args.height,
    approx_duration_seconds: Number(durationSeconds.toFixed(2)),
    drift_events: model.drift.drift24h,
    realign_events: model.drift.realign24h,
  };
  console.log(JSON.stringify(summary, null, 2));
}

run().catch((err) => {
  console.error(`record-panel-demo-20tasks failed: ${err.message}`);
  process.exit(1);
});
