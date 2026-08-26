import type { PanelViewModel, PanelTask, PanelDriftEntry } from "@goal-guardian/core";

/**
 * Pure HTML renderers: (view model) -> section markup strings. No vscode, no
 * DOM — the webview script owns applying them, tests snapshot them directly.
 */

export const SECTION_IDS = ["welcome", "hero", "pulse", "board", "drift", "criteria", "constraints", "consent"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const HEALTH_LABEL: Record<PanelViewModel["health"], string> = {
  stable: "🟢 On track",
  recovering: "🟡 Recovering",
  drifting: "🟠 Drifting",
};

function renderWelcome(vm: PanelViewModel): string {
  if (vm.setUp) return "";
  return `
    <div class="welcome">
      <h2>Goal Guardian</h2>
      <p>A drift flight-recorder for AI coding sessions. Declare a goal, and this panel
      shows what the agent did, whether it stayed on course, and how the session recovered.</p>
      <p>The trick: your goal and task list become facts in files (a Redux-style store),
      not memories in the agent's context. The agent can wander — the goal can't.
      That fixed point is what makes drift visible, and resuming after any
      interruption a read instead of a guess.</p>
      <p>Nothing is installed or written until you set it up — and it never blocks anything.</p>
      <button data-cmd="setup">Set up this workspace</button>
    </div>`;
}

function renderHero(vm: PanelViewModel): string {
  if (!vm.setUp) return "";
  const goal = vm.goal.trim() ? escapeHtml(vm.goal) : "<em>No goal declared yet — open the contract to add one.</em>";
  const task = vm.activeTask
    ? `<span class="active-task">▶ ${escapeHtml(vm.activeTask.title)}</span>`
    : `<span class="no-task">No active task</span>`;
  const review = vm.sessionReview
    ? `<div class="session-review ${vm.sessionReview.verdict}">AI session review: ${
        vm.sessionReview.verdict === "on_course" ? "on course" : "off course"
      } (${Math.round(vm.sessionReview.confidence * 100)}%) — ${escapeHtml(vm.sessionReview.rationale)}</div>`
    : "";
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

function renderPulse(vm: PanelViewModel): string {
  if (!vm.setUp) return "";
  const c = vm.counts24h;
  const tile = (label: string, value: number, tone = ""): string =>
    `<div class="tile ${tone}"><div class="tile-value">${value}</div><div class="tile-label">${label}</div></div>`;
  return `
    <div class="pulse">
      ${tile("confirmed drift (24h)", c.driftConfirmed, c.driftConfirmed > 0 ? "warn" : "")}
      ${tile("unreviewed", c.driftPending)}
      ${tile("dismissed", c.driftDismissed)}
      ${tile("advisories", c.advisories)}
      ${tile("intents", c.intents)}
    </div>`;
}

function renderTask(t: PanelTask): string {
  return `<li class="${t.active ? "active" : ""}" ${t.active ? "" : `data-task="${escapeHtml(t.id)}"`}>${escapeHtml(t.title)}</li>`;
}

function renderBoard(vm: PanelViewModel): string {
  if (!vm.setUp) return "";
  const column = (title: string, tasks: PanelTask[], extra = ""): string => `
      <div class="column">
        <h4>${title} <span class="count">${tasks.length}</span></h4>
        <ul>${tasks.map(renderTask).join("")}</ul>
        ${extra}
      </div>`;
  const doingExtra = vm.activeTask ? `<button data-cmd="completeActiveTask">Complete active task</button>` : "";
  const todoExtra = vm.board.todo.length ? `<button data-cmd="startNextTask">Start next task</button>` : "";
  return `<div class="board">${column("Doing", vm.board.doing, doingExtra)}${column("To do", vm.board.todo, todoExtra)}${column("Done", vm.board.done)}</div>`;
}

function renderDriftEntry(e: PanelDriftEntry): string {
  const reviewBtn =
    e.status === "pending" ? `<button class="link" data-rescore="${escapeHtml(e.driftId)}">Review with AI</button>` : "";
  return `
    <li class="drift-entry ${e.status}${e.realigned ? " realigned" : ""}">
      <div class="drift-label">${escapeHtml(e.label)}${reviewBtn}</div>
      <div class="drift-detail">${escapeHtml(e.detail)}</div>
      ${e.realignmentType ? `<div class="drift-realign">↩ ${escapeHtml(e.realignmentType)}</div>` : ""}
    </li>`;
}

function renderDrift(vm: PanelViewModel): string {
  if (!vm.setUp) return "";
  const visible = vm.driftFeed.filter((e) => e.status !== "dismissed");
  const dismissed = vm.driftFeed.filter((e) => e.status === "dismissed");
  const list = visible.length
    ? `<ul>${visible.map(renderDriftEntry).join("")}</ul>`
    : `<p class="quiet">No drift recorded. The tape is clean.</p>`;
  const dismissedBlock = dismissed.length
    ? `<details><summary>${dismissed.length} dismissed by review</summary><ul>${dismissed.map(renderDriftEntry).join("")}</ul></details>`
    : "";
  return `<div class="drift"><h3>Drift &amp; realignment</h3>${list}${dismissedBlock}</div>`;
}

function renderCriteria(vm: PanelViewModel): string {
  if (!vm.setUp || vm.successCriteria.length === 0) return "";
  const items = vm.successCriteria
    .map((c) => `<li class="${c.done ? "done" : ""}">${c.done ? "✅" : "⬜"} ${escapeHtml(c.text)}</li>`)
    .join("");
  return `<div class="criteria"><h3>Success criteria</h3><ul>${items}</ul></div>`;
}

function renderConstraints(vm: PanelViewModel): string {
  if (!vm.setUp || vm.constraints.length === 0) return "";
  return `<div class="constraints"><h3>Constraints</h3><ul>${vm.constraints.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></div>`;
}

function renderConsent(vm: PanelViewModel): string {
  if (!vm.setUp) return "";
  if (vm.semantic.consented) {
    return vm.semantic.available
      ? ""
      : `<div class="consent muted">AI drift review is offline (cursor-agent unavailable). Lexical signals still record.</div>`;
  }
  if (vm.semantic.pendingCount === 0) return "";
  return `
    <div class="consent">
      <p>${vm.semantic.pendingCount} drift signal${vm.semantic.pendingCount === 1 ? "" : "s"} awaiting review.
      Goal Guardian can review them with AI in the background (uses your Cursor account — a few small calls per session).</p>
      <button data-cmd="enableRescore">Enable AI review</button>
    </div>`;
}

export function renderSections(vm: PanelViewModel): Record<SectionId, string> {
  return {
    welcome: renderWelcome(vm),
    hero: renderHero(vm),
    pulse: renderPulse(vm),
    board: renderBoard(vm),
    drift: renderDrift(vm),
    criteria: renderCriteria(vm),
    constraints: renderConstraints(vm),
    consent: renderConsent(vm),
  };
}
