import type { PanelViewModel } from "@goal-guardian/core";

/**
 * Pure HTML renderers: (view model) -> section markup strings. No vscode, no
 * DOM — the webview script applies them, tests snapshot them.
 *
 * Design: the goal is the title and status reads like an instrument. All copy
 * is on the user's side of the screen: "Done when", "Boundaries", "Mark done".
 */

export const SECTION_IDS = ["welcome", "goal", "tour", "criteria", "constraints"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderWelcome(vm: PanelViewModel): string {
  if (vm.setUp) return "";
  return `
    <div class="welcome">
      <div class="lamp-row"><span class="lamp idle"></span><span class="status-word">standing by</span></div>
      <p>Guardian rides along while you work with your agent: it remembers the goal
      and sends the agent back if it stops before the goal is done.</p>

      <div class="su">
        <label class="su-label" for="su-goal">What are you working toward?</label>
        <textarea id="su-goal" class="su-input su-goal" rows="2" spellcheck="false"
          placeholder="In your own words — e.g. Ship the CSV exporter with filters and tests"></textarea>

        <label class="su-label" for="su-crit">Done when&hellip;</label>
        <div id="su-crit-list" class="su-list"></div>
        <input id="su-crit" class="su-input" type="text" spellcheck="false" data-su-list="su-crit-list"
          placeholder="Add a finish line, press Enter" />

        <label class="su-label" for="su-con">Boundaries</label>
        <div id="su-con-list" class="su-list"></div>
        <input id="su-con" class="su-input" type="text" spellcheck="false" data-su-list="su-con-list"
          placeholder="Optional — e.g. No new dependencies" />

        <label class="su-check"><input id="su-git" type="checkbox" checked />
          Keep Guardian&rsquo;s machine-written files out of git</label>

        <button data-setup-submit>Connect Guardian</button>
        <p class="quiet">Everything here is optional and editable later &mdash; connect empty
        and your first request to the agent becomes the goal.</p>
      </div>
    </div>`;
}

const GOAL_RUN_WORD: Record<NonNullable<PanelViewModel["goalRun"]>["outcome"], string> = {
  working: "Goal: agent sent back",
  proved: "Goal proved: both goal keepers accepted it and both checks passed",
  unchecked: "Goal complete but unchecked, not proved",
  disputed: "Goal disputed, not proved: the review still objects",
  unverified: "Goal unverified, not proved: a goal keeper's code didn't run",
  blocked: "Goal blocked",
  set_aside: "Goal set aside in that chat",
  stalled: "Goal stalled: the agent stopped making progress",
  limit: "Goal not proved: the rounds ran out",
  budget_limited: "Goal stopped: its token budget is used up",
  stopped: "Goal run stopped",
};

/** How the latest run on the goal stands, with the receipts behind it. */
function renderGoalRun(vm: PanelViewModel): string {
  const g = vm.goalRun;
  if (!g) return "";
  // The user stepped in: a run that was still going no longer says what's happening.
  if (g.outcome === "working" && vm.goalPhase === "paused") return "";
  if (g.outcome === "working" && vm.goalPhase === "complete") return `<p class="review-line">Goal marked done by you.</p>`;
  const tokens = g.tokens ? (g.tokens >= 1000 ? `${Math.round(g.tokens / 1000)}K tokens` : `${g.tokens} tokens`) : "";
  const parts = [
    g.rounds ? `${g.rounds} round${g.rounds === 1 ? "" : "s"}` : "",
    g.rounds && g.seconds ? `${Math.max(1, Math.round(g.seconds / 60))} min` : "",
    tokens,
  ].filter(Boolean);
  const spent = parts.length ? ` (${parts.join(", ")})` : "";
  const disputed = g.outcome === "proved" && g.reviewer.length > 0;
  const head = `${disputed ? "Goal proved on Guardian's record, but the review still objects" : GOAL_RUN_WORD[g.outcome]}${g.round ? ` (round ${g.round})` : spent}`;
  const lines = [
    ...g.detail,
    ...g.changes.filter((c) => c.serves !== "extra").map((c) => `Changed for ${c.serves}: ${c.files.join(", ")}`),
    ...g.extras.map((f) => `Not for any done-when item, your call: ${f}`),
    ...(vm.reviews.length ? [] : g.reviewer.map((l) => `Reviewer's opinion: ${l.replace(/^Reviewer: /, "")}`)),
    ...(g.outcome === "unchecked" ? [] : g.skipped.map((s) => `Not independently checked: ${s}`)),
    ...(g.changedSinceReview ? ["The last review objected, and the agent changed the project after it. That final state wasn't reviewed again."] : []),
    ...(g.goalFileEdited ? ["The agent edited Guardian's goal files during this run."] : []),
  ];
  // The review let this through. If it shouldn't have, the user says so here, and the reviewer learns from the miss.
  const missed = g.passedReview
    ? g.saidMissed
      ? `<p class="review-line"><span class="review-said">you said: this wasn't done. The goal is reopened so Cursor can finish it.</span></p>`
      : `<p class="review-line">The review found nothing wrong with this. <button class="link" data-cmd="review.missed:${escapeHtml(g.passedReview)}">This wasn't done</button></p>`
    : "";
  return `<p class="review-line">${escapeHtml(head)}</p>${lines.map((l) => `<p class="review-line">${escapeHtml(l)}</p>`).join("")}${missed}`;
}

const SOURCE_WORD = { user: "your call", fixed: "the agent fixed it", overruled: "you marked the goal done over it", missed: "you said the work wasn't done" } as const;

/** The reviewer's objections, each with the user's verdict: those verdicts are what Guardian learns from. */
function renderReviews(vm: PanelViewModel): string {
  if (!vm.reviews.length) return "";
  const blocks = vm.reviews.map((r) => {
    const lines = r.lines.map((line, i) => {
      const said = r.feedback[i];
      const buttons = said
        ? `<span class="review-said">${said === "right" ? "you said: right call" : "you said: reviewer was wrong"}</span>`
        : `<button class="link" data-cmd="review.right:${escapeHtml(r.id)}:${r.indexes?.[i] ?? i}">Right call</button> <button class="link" data-cmd="review.wrong:${escapeHtml(r.id)}:${r.indexes?.[i] ?? i}">Reviewer was wrong</button>`;
      return `<p class="review-line">${escapeHtml(`Reviewer's opinion: ${line.replace(/^Reviewer: /, "")}`)} ${buttons}</p>`;
    });
    const label = r.label && r.label.source !== "user" ? `<p class="review-line">Counted as ${r.label.label === "right" ? "a right call" : "a wrong call"}: ${SOURCE_WORD[r.label.source]}.</p>` : "";
    const dismissed = r.dismissed.map((line) => `<p class="review-line">${escapeHtml(line)}</p>`);
    return lines.join("") + label + dismissed.join("");
  });
  return `<div class="reviews">${blocks.join("")}</div>`;
}

/**
 * Guardian improving its own reviewer. It tries by itself once enough of the user's verdicts have come in, applies a
 * result only when it did better on reviews it never learned from without losing a catch, and says what it did and
 * what it cost on the user's Cursor plan. Undo goes back to the built-in reviewer.
 */
function renderImprove(vm: PanelViewModel): string {
  const im = vm.improve;
  const out: string[] = [];
  const latest = im.latest;
  const cost = im.cost?.callLimit !== undefined ? " Background learning stops at its usage limit." : im.cost ? ` About ${im.cost.reviews} reviews and up to ${im.cost.searchCallsMax} more calls to your Cursor model.` : "";
  if (im.running) out.push(`<p class="review-line">${escapeHtml(`Guardian is improving its reviewer with RRSI from your verdicts.${im.stage ? ` ${im.stage}.` : ""}${cost}`)}</p>`);
  else if (latest?.kept) {
    out.push(
      `<p class="review-line">${escapeHtml(`Guardian improved its reviewer from your verdicts: ${latest.reason}.${latest.applied ? " It is in use now." : " It isn't in use."}${cost}`)}</p>`,
      ...latest.hypotheses.map((h) => `<p class="review-line">${escapeHtml(`Idea tested: ${h}`)}</p>`),
      `<pre class="review-diff">${escapeHtml(latest.diff)}</pre>`,
      ...(latest.applied ? [] : [`<div class="goal-controls"><button class="link" data-cmd="review.apply:${escapeHtml(latest.id)}">Use it again</button></div>`]),
    );
  } else if (latest) out.push(`<p class="review-line">${escapeHtml(`Guardian tried to improve its reviewer and kept the current one: ${latest.reason}.${cost}`)}</p>`);
  else if (im.labelled) out.push(`<p class="review-line">${escapeHtml(`${im.labelled} review${im.labelled === 1 ? " has" : "s have"} a verdict. With enough examples to learn from and check an improvement, Guardian tries in the background within its usage limit.`)}</p>`);
  if (im.usingImproved) out.push(`<p class="review-line">This workspace uses its improved reviewer. <button class="link" data-cmd="review.undo">Undo</button></p>`);
  return out.join("");
}

/** Yours alone: the agent can't resume a pause or close the goal. */
function renderGoalControls(vm: PanelViewModel): string {
  if (vm.hooksDisabled) {
    return `<p class="review-line">Cursor runs Guardian's hooks only in a trusted workspace, so the goal can't be checked here. Trust this workspace to turn it on.</p>`;
  }
  if (vm.goalPhase === "paused") {
    return `<p class="review-line">Goal paused. The agent won't be sent back until you resume. Resuming starts the agent in a new chat.</p><div class="goal-controls"><button class="link" data-cmd="goal.resume">Resume goal</button></div>`;
  }
  if (vm.goalPhase !== "active") return "";
  if (!vm.goalRun || vm.goalRun.outcome !== "working") {
    const done = vm.goalRun ? ` <button class="link" data-cmd="goal.done">Mark goal done</button>` : "";
    return `<div class="goal-controls"><button class="link" data-cmd="goal.work">Work on the goal</button>${done}</div>`;
  }
  return `<div class="goal-controls"><button class="link" data-cmd="goal.pause">Pause goal</button> <button class="link" data-cmd="goal.done">Mark goal done</button></div>`;
}

function renderVerificationWarning(vm: PanelViewModel): string {
  const run = vm.goalRun;
  if (run?.outcome !== "unchecked") return "";
  const reasons = run.skipped.map((s) => `<li>Not independently checked: ${escapeHtml(s)}</li>`).join("");
  return `<div class="verification-warning" role="status" aria-live="polite"><strong>Verification incomplete</strong><p>This work has not been fully independently checked.</p>${reasons ? `<ul>${reasons}</ul>` : ""}</div>`;
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
        <span class="lamp ${vm.status.lamp}"></span>
        <span class="status-word">${escapeHtml(vm.status.word)}</span>
      </div>
      ${renderVerificationWarning(vm)}
      ${renderGoalRun(vm)}
      ${renderReviews(vm)}
      ${renderImprove(vm)}
      ${renderGoalControls(vm)}
    </div>`;
}

function renderTour(vm: PanelViewModel): string {
  if (!vm.tour.visible) return "";
  const items = vm.tour.steps
    .map((s) => {
      const action =
        !s.done && s.id === "center"
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

export function renderSections(vm: PanelViewModel): Record<SectionId, string> {
  return {
    welcome: renderWelcome(vm),
    goal: renderGoal(vm),
    tour: renderTour(vm),
    criteria: renderCriteria(vm),
    constraints: renderConstraints(vm),
  };
}
