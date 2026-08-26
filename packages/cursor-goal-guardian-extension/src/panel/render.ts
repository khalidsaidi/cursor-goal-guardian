import type { PanelViewModel, PanelTask, PanelDriftEntry } from "@goal-guardian/core";

/**
 * Pure HTML renderers: (view model) -> section markup strings. No vscode, no
 * DOM — the webview script applies them, tests snapshot them.
 *
 * Design: the goal is the title, status reads like an instrument, and the
 * drift section is drawn as a literal track — a vertical thread the session
 * follows, with detours pushed off-axis and returns marked. All copy is on
 * the user's side of the screen: "Done when", "Boundaries", "Mark done".
 */

export const SECTION_IDS = ["welcome", "repair", "goal", "tour", "focus", "criteria", "constraints", "drift", "consent"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STATUS_WORD: Record<PanelViewModel["health"], string> = {
  stable: "on course",
  recovering: "holding course",
  drifting: "off course",
};

function statusSentence(vm: PanelViewModel): string {
  const c = vm.counts24h;
  const open = vm.driftFeed.filter((e) => e.status !== "dismissed" && !e.realigned);
  const confirmedOpen = open.filter((e) => e.status === "confirmed").length;
  const pendingOpen = open.filter((e) => e.status === "pending").length;
  const detours = c.driftConfirmed + c.driftPending;

  if (vm.health === "stable") {
    return c.driftDismissed > 0
      ? `Quiet day — ${c.driftDismissed} false alarm${c.driftDismissed === 1 ? "" : "s"} cleared by review.`
      : "Nothing off-goal in the last 24 hours.";
  }
  if (confirmedOpen > 0) {
    return `${confirmedOpen} detour${confirmedOpen === 1 ? "" : "s"} without a way back yet.`;
  }
  if (pendingOpen > 0) {
    return `${pendingOpen} detour${pendingOpen === 1 ? "" : "s"} awaiting review — nothing confirmed off-goal.`;
  }
  return `${detours} detour${detours === 1 ? "" : "s"} — every one came back.`;
}

function renderWelcome(vm: PanelViewModel): string {
  if (vm.setUp) return "";
  return `
    <div class="welcome">
      <div class="lamp-row"><span class="lamp idle"></span><span class="status-word">standing by</span></div>
      <p>Guardian rides along while you work with your agent: it remembers the goal,
      notices when the session wanders, and shows you the way back.</p>
      <p class="quiet">Nothing is written until you connect it. After that, just ask
      your agent for something — Guardian starts tracking automatically.</p>
      <button data-cmd="setup">Connect Guardian to this workspace</button>
    </div>`;
}

function renderRepair(vm: PanelViewModel): string {
  if (!vm.setUp || !vm.stateBroken) return "";
  return `
    <div class="repair">
      <p>The task board file doesn&rsquo;t match its record &mdash; it may have been
      edited by hand or damaged. Your session log is intact.</p>
      <button data-cmd="rebuildState">Rebuild the board from the record</button>
    </div>`;
}

function renderGoal(vm: PanelViewModel): string {
  if (!vm.setUp) return "";
  const goal = vm.goal.trim();
  const goalHtml = goal
    ? `<button class="goal-text" data-cmd="editGoal" title="Change the goal">${escapeHtml(goal)}</button>`
    : `<p class="goal-empty">No goal yet. Ask your agent for something — the request becomes
       the goal automatically. Or <button class="link" data-cmd="editGoal">write it here</button>.</p>`;
  return `
    <div class="goal">
      <div class="eyebrow">Goal</div>
      ${goalHtml}
      <div class="lamp-row">
        <span class="lamp ${vm.health}"></span>
        <span class="status-word">${STATUS_WORD[vm.health]}</span>
      </div>
      <p class="status-sentence">${escapeHtml(statusSentence(vm))}</p>
      ${vm.sessionReview ? `<p class="review-line">AI read the session: ${vm.sessionReview.verdict === "on_course" ? "on course" : "off course"} (${Math.round(vm.sessionReview.confidence * 100)}%) — ${escapeHtml(vm.sessionReview.rationale)}</p>` : ""}
      ${vm.suggestion ? `<p class="suggestion">${escapeHtml(vm.suggestion)}</p>` : ""}
    </div>`;
}

function renderTour(vm: PanelViewModel): string {
  if (!vm.tour.visible) return "";
  const items = vm.tour.steps
    .map((s) => {
      const action =
        !s.done && s.id === "review"
          ? `<button class="link" data-cmd="enableRescore">turn on</button>`
          : !s.done && s.id === "center"
            ? `<button class="link" data-cmd="commandCenter">open it</button>`
            : "";
      return `<li class="${s.done ? "done" : ""}">
        <span class="tick">${s.done ? "✓" : ""}</span>
        <span class="step"><b>${escapeHtml(s.label)}</b><span class="hint">${escapeHtml(s.hint)}${action ? " · " : ""}${action}</span></span>
      </li>`;
    })
    .join("");
  return `<div class="tour">
    <div class="eyebrow">Get started · ${vm.tour.doneCount} of ${vm.tour.total}
      <button class="link dismiss" data-cmd="dismissTour" title="Hide this checklist">hide</button></div>
    <ul>${items}</ul>
  </div>`;
}

function renderFocus(vm: PanelViewModel): string {
  if (!vm.setUp) return "";
  const active = vm.board.doing[0] ?? null;
  const next = vm.board.todo;
  const doneCount = vm.board.done.length;

  const nowBlock = active
    ? `<div class="now-card">
         <span class="now-title">${escapeHtml(active.title)}</span>
         <button data-cmd="completeActiveTask">Mark done</button>
       </div>`
    : next.length > 0
      ? `<div class="now-card empty"><span class="now-title quiet">Nothing in progress</span><button data-cmd="startNextTask">Start next task</button></div>`
      : doneCount > 0
        ? `<div class="now-card empty"><span class="now-title quiet">All done — everything on the list is finished.</span></div>`
        : "";

  const nextBlock = next.length
    ? `<div class="eyebrow">Up next</div>
       <ul class="next-list">${next
         .map((t: PanelTask) => `<li><span>${escapeHtml(t.title)}</span><button class="link" data-task="${escapeHtml(t.id)}">Start</button></li>`)
         .join("")}</ul>`
    : "";

  const doneBlock = doneCount ? `<div class="done-line">${doneCount} finished</div>` : "";

  if (!nowBlock && !nextBlock && !doneBlock) return "";
  return `<div class="focus"><div class="eyebrow">Now</div>${nowBlock}${nextBlock}${doneBlock}</div>`;
}

function renderCriteria(vm: PanelViewModel): string {
  if (!vm.setUp || vm.successCriteria.length === 0) return "";
  const items = vm.successCriteria
    .map((c) => `<li class="${c.done ? "done" : ""}"><span class="tick">${c.done ? "✓" : ""}</span>${escapeHtml(c.text)}</li>`)
    .join("");
  return `<div class="criteria"><div class="eyebrow">Done when</div><ul>${items}</ul></div>`;
}

function renderConstraints(vm: PanelViewModel): string {
  if (!vm.setUp || vm.constraints.length === 0) return "";
  return `<div class="constraints"><div class="eyebrow">Boundaries</div><ul>${vm.constraints.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></div>`;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function driftChip(e: PanelDriftEntry): string {
  if (e.realigned) return `<span class="chip back">came back</span>`;
  if (e.status === "confirmed") return `<span class="chip confirmed">off-goal</span>`;
  return `<span class="chip pending">unreviewed<button class="link" data-rescore="${escapeHtml(e.driftId)}">check with AI</button></span>`;
}

function renderDrift(vm: PanelViewModel): string {
  if (!vm.setUp) return "";
  // The feed arrives newest-first; a track is a path, so it flows down in time.
  const visible = vm.driftFeed.filter((e) => e.status !== "dismissed").slice().reverse();
  const dismissed = vm.driftFeed.length - visible.length;

  const body = visible.length
    ? `<ol class="track">${visible
        .map((e) => {
          const value = e.detail.replace(/^\[(shell|mcp|read|edit)\]\s*/, "");
          const kind = e.detail.match(/^\[(shell|mcp|read|edit)\]/)?.[1] ?? "";
          return `<li class="${e.realigned ? "back" : e.status}">
            <span class="node"></span>
            <div class="entry">
              <div class="entry-head"><span class="when">${shortTime(e.ts)}</span>${driftChip(e)}</div>
              <code title="${escapeHtml(e.detail)}">${escapeHtml(kind ? `${kind} · ` : "")}${escapeHtml(value.split(" · task:")[0]?.slice(0, 64) ?? "")}</code>
            </div>
          </li>`;
        })
        .join("")}</ol>`
    : `<p class="quiet">The session is following the track. Detours will show up here.</p>`;

  const cleared = dismissed ? `<p class="quiet">${dismissed} false alarm${dismissed === 1 ? "" : "s"} cleared by review.</p>` : "";
  return `<div class="drift"><div class="eyebrow">Off the track</div>${body}${cleared}</div>`;
}

function renderConsent(vm: PanelViewModel): string {
  if (!vm.setUp) return "";
  if (vm.semantic.consented) {
    return vm.semantic.available
      ? ""
      : `<div class="consent muted">AI review is offline right now — detours stay marked "unreviewed" until it's back.</div>`;
  }
  if (vm.semantic.pendingCount === 0) return "";
  return `
    <div class="consent">
      <p>${vm.semantic.pendingCount === 1 ? "One detour is" : `${vm.semantic.pendingCount} detours are`} waiting for review.
      Guardian can double-check them with AI so false alarms clear themselves
      (uses your Cursor account — a few small calls).</p>
      <button data-cmd="enableRescore">Turn on AI review</button>
    </div>`;
}

export function renderSections(vm: PanelViewModel): Record<SectionId, string> {
  return {
    welcome: renderWelcome(vm),
    repair: renderRepair(vm),
    goal: renderGoal(vm),
    tour: renderTour(vm),
    focus: renderFocus(vm),
    criteria: renderCriteria(vm),
    constraints: renderConstraints(vm),
    drift: renderDrift(vm),
    consent: renderConsent(vm),
  };
}
