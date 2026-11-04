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

export const SECTION_IDS = ["welcome", "repair", "goal", "tour", "focus", "criteria", "donecheck", "constraints", "drift", "consent"] as const;
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

      <div class="su">
        <label class="su-label" for="su-goal">What are you working toward?</label>
        <textarea id="su-goal" class="su-input su-goal" rows="2" spellcheck="false"
          placeholder="In your own words — e.g. Ship the CSV exporter with filters and tests"></textarea>

        <label class="su-label" for="su-crit">Done when&hellip;</label>
        <div id="su-crit-list" class="su-list"></div>
        <input id="su-crit" class="su-input" type="text" spellcheck="false" data-su-list="su-crit-list"
          placeholder="Add a finish line, press Enter — each becomes a task" />

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

function renderRepair(vm: PanelViewModel): string {
  if (!vm.setUp || !vm.stateBroken) return "";
  return `
    <div class="repair">
      <p>The task board file doesn&rsquo;t match its record &mdash; it may have been
      edited by hand or damaged. Your session log is intact.</p>
      <button data-cmd="rebuildState">Rebuild the board from the record</button>
    </div>`;
}

const GOAL_PHASE: Record<NonNullable<PanelViewModel["goalRun"]>["phase"], { cls: string; word: string }> = {
  active: { cls: "pending", word: "In progress" },
  paused: { cls: "stated", word: "Paused" },
  blocked: { cls: "confirmed", word: "Blocked" },
  complete: { cls: "back", word: "Done — verified" },
  budget_limited: { cls: "confirmed", word: "Out of rounds" },
};

/** The goal as a run: where it stands, how many keep-going rounds it used, and what is in the way. */
function renderGoalRun(vm: PanelViewModel): string {
  const g = vm.goalRun;
  if (!g) return "";
  const p = GOAL_PHASE[g.phase];
  const claim = g.phase === "active" && g.claimedComplete ? `<span class="quiet">Agent says done — Guardian is checking.</span>` : "";
  const blocker = g.blockedReason ? `<p class="dc-tests">In the way: ${escapeHtml(g.blockedReason.message)}</p>` : "";
  const buttons =
    g.phase === "active"
      ? `<button class="link" data-cmd="pauseGoal">pause</button>`
      : g.phase === "complete"
        ? ""
        : `<button class="link" data-cmd="resumeGoal">resume</button>`;
  return `<div class="goal-run">
      <span class="chip ${p.cls}">${p.word}</span>
      <span class="quiet">rounds ${g.roundsStarted} of ${g.maxRounds}</span>
      ${claim}
      ${buttons}${g.phase !== "complete" ? ` <button class="link" data-cmd="clearGoalRun" title="Stop pursuing this goal automatically">stop</button>` : ""}
      ${blocker}
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
      ${renderGoalRun(vm)}
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

const DONE_HEADLINE: Record<NonNullable<PanelViewModel["doneCheck"]>["verdict"], string> = {
  pass: "Every line holds up against the tape.",
  fail: "The agent's done check didn't hold up.",
  blocked: "The agent reported itself blocked.",
  absent: "The agent finished work without a done check.",
  not_required: "",
};

const LINE_CHIP: Record<string, { cls: string; word: string }> = {
  backed: { cls: "back", word: "checked" },
  stated: { cls: "stated", word: "stated" },
  waived: { cls: "stated", word: "n/a, with reason" },
  gap: { cls: "pending", word: "gap declared" },
  contradicted: { cls: "confirmed", word: "contradicted" },
  unsupported: { cls: "confirmed", word: "no evidence" },
  missing: { cls: "confirmed", word: "missing" },
};

function lineLabel(key: string): string {
  if (/^\d+$/.test(key)) return `Rule ${key}`;
  if (key === "general") return "Overall";
  if (key === "blocked") return "Blocked";
  if (key === "what" || key === "unblock" || key === "who") return key === "unblock" ? "Unblock" : key[0]!.toUpperCase() + key.slice(1);
  return key;
}

/** Escape, then render `code` spans the way the chat does — notes quote commands. */
function noteHtml(note: string): string {
  // A note shortened mid-span leaves one unpaired backtick: drop it.
  return escapeHtml(note).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/`/g, "");
}

/** "Wrong flag?" — the user's label on a false alarm; once given, the flag says so instead. */
function wrongButton(vm: PanelViewModel, flag: string, ref: string, line = ""): string {
  const key = [flag, ref, line].join("|");
  if (vm.markedWrong.includes(key)) return `<span class="chip stated">marked wrong</span>`;
  return `<button class="link" data-wrong="${escapeHtml(key)}" title="Tell Guardian this flag was a false alarm">wrong flag?</button>`;
}

/** How Guardian's flags turned out this week — the reason to trust it, or not. */
function renderTrackRecord(vm: PanelViewModel): string {
  const t = vm.trackRecord;
  if (!t) return "";
  const parts = [
    t.fixed ? `${t.fixed} fixed by the agent` : "",
    t.testsGreen ? `${t.testsGreen} broken test run${t.testsGreen === 1 ? "" : "s"} green again` : "",
    t.corrected ? `${t.corrected} claim${t.corrected === 1 ? "" : "s"} corrected` : "",
    t.ignored ? `${t.ignored} not addressed` : "",
    t.markedWrong ? `${t.markedWrong} marked wrong by you` : "",
  ].filter(Boolean);
  return `<p class="dc-tests">Guardian's flags this week: ${parts.join(" · ")}.</p>`;
}

/** The end-of-turn check: what the agent claimed, and what the tape says about it. */
function renderDoneCheck(vm: PanelViewModel): string {
  const d = vm.doneCheck;
  if (!vm.setUp) return "";
  const tests = renderTests(vm.tests, vm) + renderTrackRecord(vm);
  if (!d) return tests;
  const lines = d.lines
    .map((l) => {
      const chip = LINE_CHIP[l.status] ?? { cls: "pending", word: l.status };
      return `<li class="${chip.cls}"><span class="dc-key">${escapeHtml(lineLabel(l.key))}</span><span class="chip ${chip.cls}">${chip.word}</span><span class="dc-note">${noteHtml(l.note)}</span></li>`;
    })
    .join("");
  const problems = d.problems.map((p) => `<li class="confirmed"><span class="dc-note">${noteHtml(p)}</span></li>`).join("");
  const followup = d.continued
    ? `<p class="quiet">The goal isn't done yet (${d.open.length} "done when" item${d.open.length === 1 ? "" : "s"} still open): sent the agent back to keep going. ${wrongButton(vm, "keep_going", d.ts)}</p>`
    : d.followupSent
      ? `<p class="quiet">Sent the agent back to fix it. ${wrongButton(vm, "followup", d.ts)}</p>`
      : "";
  return `<div class="donecheck ${d.verdict}">
    <div class="eyebrow">Last done check · ${shortTime(d.ts)}</div>
    <p class="dc-headline">${escapeHtml(DONE_HEADLINE[d.verdict])}</p>
    ${lines || problems ? `<ul class="dc-lines">${problems}${lines}</ul>` : ""}
    ${followup}
  </div>${tests}`;
}

/** Guardian's own test re-run after the last editing turn: no model, just the exit codes. */
function renderTests(t: PanelViewModel["tests"], vm: PanelViewModel): string {
  if (!t) return "";
  const cmd = `<code>${escapeHtml(t.command)}</code>`;
  const failed = (e: number | "timeout"): string => (e === "timeout" ? "timed out" : `failed (exit ${e})`);
  const headline =
    t.exit === 0
      ? `Guardian re-ran ${cmd} itself after the last change: it passes.`
      : t.broke
        ? `Guardian re-ran ${cmd} itself: it ${failed(t.exit)} with the last turn's changes and passes without them. That turn broke it.`
        : t.exit === "timeout"
          ? `Guardian re-ran ${cmd} itself: it timed out, so it says nothing either way.`
          : t.baselineExit !== undefined
            ? `Guardian re-ran ${cmd} itself: it ${failed(t.exit)}, but it also ${t.baselineExit === "timeout" ? "timed out" : "failed"} before the last turn's changes.`
            : `Guardian re-ran ${cmd} itself: it ${failed(t.exit)}.`;
  const cls = t.exit === 0 ? "pass" : t.broke ? "fail" : "blocked";
  const output = t.output && t.exit !== 0 ? `<details class="dc-output"><summary>Last output</summary><pre>${escapeHtml(t.output.trim().split("\n").slice(-20).join("\n"))}</pre></details>` : "";
  return `<div class="donecheck dc-rerun ${cls}">
    <div class="eyebrow">Tests, re-run by Guardian · ${shortTime(t.ts)}</div>
    <p class="dc-headline">${headline}${t.broke ? ` ${wrongButton(vm, "tests_broke", t.ts)}` : ""}</p>
    ${output}
  </div>`;
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
              <div class="entry-head"><span class="when">${shortTime(e.ts)}</span>${driftChip(e)}${e.status !== "dismissed" ? wrongButton(vm, "drift", e.driftId) : ""}</div>
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
    donecheck: renderDoneCheck(vm),
    constraints: renderConstraints(vm),
    drift: renderDrift(vm),
    consent: renderConsent(vm),
  };
}
