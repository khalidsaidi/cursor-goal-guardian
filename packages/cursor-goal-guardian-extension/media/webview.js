"use strict";
(() => {
  // src/panel/render.ts
  var SECTION_IDS = ["welcome", "hero", "pulse", "board", "drift", "criteria", "constraints", "consent"];
  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  var HEALTH_LABEL = {
    stable: "\u{1F7E2} On track",
    recovering: "\u{1F7E1} Recovering",
    drifting: "\u{1F7E0} Drifting"
  };
  function renderWelcome(vm) {
    if (vm.setUp) return "";
    return `
    <div class="welcome">
      <h2>Goal Guardian</h2>
      <p>A drift flight-recorder for AI coding sessions. Declare a goal, and this panel
      shows what the agent did, whether it stayed on course, and how the session recovered.</p>
      <p>The trick: your goal and task list become facts in files (a Redux-style store),
      not memories in the agent's context. The agent can wander \u2014 the goal can't.
      That fixed point is what makes drift visible, and resuming after any
      interruption a read instead of a guess.</p>
      <p>Nothing is installed or written until you set it up \u2014 and it never blocks anything.</p>
      <button data-cmd="setup">Set up this workspace</button>
    </div>`;
  }
  function renderHero(vm) {
    if (!vm.setUp) return "";
    const goal = vm.goal.trim() ? escapeHtml(vm.goal) : "<em>No goal declared yet \u2014 open the contract to add one.</em>";
    const task = vm.activeTask ? `<span class="active-task">\u25B6 ${escapeHtml(vm.activeTask.title)}</span>` : `<span class="no-task">No active task</span>`;
    const review = vm.sessionReview ? `<div class="session-review ${vm.sessionReview.verdict}">AI session review: ${vm.sessionReview.verdict === "on_course" ? "on course" : "off course"} (${Math.round(vm.sessionReview.confidence * 100)}%) \u2014 ${escapeHtml(vm.sessionReview.rationale)}</div>` : "";
    const suggestion = vm.suggestion ? `<div class="suggestion">${escapeHtml(vm.suggestion)}</div>` : "";
    return `
    <div class="hero">
      <div class="health">${HEALTH_LABEL[vm.health]}</div>
      <div class="goal">${goal}</div>
      <div class="task-line">${task}</div>
      ${review}
      ${suggestion}
    </div>`;
  }
  function renderPulse(vm) {
    if (!vm.setUp) return "";
    const c = vm.counts24h;
    const tile = (label, value, tone = "") => `<div class="tile ${tone}"><div class="tile-value">${value}</div><div class="tile-label">${label}</div></div>`;
    return `
    <div class="pulse">
      ${tile("confirmed drift (24h)", c.driftConfirmed, c.driftConfirmed > 0 ? "warn" : "")}
      ${tile("unreviewed", c.driftPending)}
      ${tile("dismissed", c.driftDismissed)}
      ${tile("advisories", c.advisories)}
      ${tile("intents", c.intents)}
    </div>`;
  }
  function renderTask(t) {
    return `<li class="${t.active ? "active" : ""}" ${t.active ? "" : `data-task="${escapeHtml(t.id)}"`}>${escapeHtml(t.title)}</li>`;
  }
  function renderBoard(vm) {
    if (!vm.setUp) return "";
    const column = (title, tasks, extra = "") => `
      <div class="column">
        <h4>${title} <span class="count">${tasks.length}</span></h4>
        <ul>${tasks.map(renderTask).join("")}</ul>
        ${extra}
      </div>`;
    const doingExtra = vm.activeTask ? `<button data-cmd="completeActiveTask">Complete active task</button>` : "";
    const todoExtra = vm.board.todo.length ? `<button data-cmd="startNextTask">Start next task</button>` : "";
    return `<div class="board">${column("Doing", vm.board.doing, doingExtra)}${column("To do", vm.board.todo, todoExtra)}${column("Done", vm.board.done)}</div>`;
  }
  function renderDriftEntry(e) {
    const reviewBtn = e.status === "pending" ? `<button class="link" data-rescore="${escapeHtml(e.driftId)}">Review with AI</button>` : "";
    return `
    <li class="drift-entry ${e.status}${e.realigned ? " realigned" : ""}">
      <div class="drift-label">${escapeHtml(e.label)}${reviewBtn}</div>
      <div class="drift-detail">${escapeHtml(e.detail)}</div>
      ${e.realignmentType ? `<div class="drift-realign">\u21A9 ${escapeHtml(e.realignmentType)}</div>` : ""}
    </li>`;
  }
  function renderDrift(vm) {
    if (!vm.setUp) return "";
    const visible = vm.driftFeed.filter((e) => e.status !== "dismissed");
    const dismissed = vm.driftFeed.filter((e) => e.status === "dismissed");
    const list = visible.length ? `<ul>${visible.map(renderDriftEntry).join("")}</ul>` : `<p class="quiet">No drift recorded. The tape is clean.</p>`;
    const dismissedBlock = dismissed.length ? `<details><summary>${dismissed.length} dismissed by review</summary><ul>${dismissed.map(renderDriftEntry).join("")}</ul></details>` : "";
    return `<div class="drift"><h3>Drift &amp; realignment</h3>${list}${dismissedBlock}</div>`;
  }
  function renderCriteria(vm) {
    if (!vm.setUp || vm.successCriteria.length === 0) return "";
    const items = vm.successCriteria.map((c) => `<li class="${c.done ? "done" : ""}">${c.done ? "\u2705" : "\u2B1C"} ${escapeHtml(c.text)}</li>`).join("");
    return `<div class="criteria"><h3>Success criteria</h3><ul>${items}</ul></div>`;
  }
  function renderConstraints(vm) {
    if (!vm.setUp || vm.constraints.length === 0) return "";
    return `<div class="constraints"><h3>Constraints</h3><ul>${vm.constraints.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></div>`;
  }
  function renderConsent(vm) {
    if (!vm.setUp) return "";
    if (vm.semantic.consented) {
      return vm.semantic.available ? "" : `<div class="consent muted">AI drift review is offline (cursor-agent unavailable). Lexical signals still record.</div>`;
    }
    if (vm.semantic.pendingCount === 0) return "";
    return `
    <div class="consent">
      <p>${vm.semantic.pendingCount} drift signal${vm.semantic.pendingCount === 1 ? "" : "s"} awaiting review.
      Goal Guardian can review them with AI in the background (uses your Cursor account \u2014 a few small calls per session).</p>
      <button data-cmd="enableRescore">Enable AI review</button>
    </div>`;
  }
  function renderSections(vm) {
    return {
      welcome: renderWelcome(vm),
      hero: renderHero(vm),
      pulse: renderPulse(vm),
      board: renderBoard(vm),
      drift: renderDrift(vm),
      criteria: renderCriteria(vm),
      constraints: renderConstraints(vm),
      consent: renderConsent(vm)
    };
  }

  // src/webview/main.ts
  var vscode = acquireVsCodeApi();
  var lastHtml = /* @__PURE__ */ new Map();
  function apply(vm) {
    const sections = renderSections(vm);
    for (const id of SECTION_IDS) {
      const html = sections[id];
      if (lastHtml.get(id) === html) continue;
      lastHtml.set(id, html);
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    }
  }
  window.addEventListener("message", (event) => {
    if (event.data?.type === "vm" && event.data.vm) apply(event.data.vm);
  });
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-cmd],[data-task],[data-rescore]");
    if (!target) return;
    if (target.dataset.cmd) vscode.postMessage({ type: "command", command: target.dataset.cmd });
    else if (target.dataset.task) vscode.postMessage({ type: "startTask", taskId: target.dataset.task });
    else if (target.dataset.rescore) vscode.postMessage({ type: "rescoreOne", driftId: target.dataset.rescore });
  });
  vscode.postMessage({ type: "ready" });
})();
