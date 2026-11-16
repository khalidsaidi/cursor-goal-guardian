"use strict";
(() => {
  // src/panel/render.ts
  var SECTION_IDS = ["welcome", "goal", "tour", "criteria", "constraints"];
  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function renderWelcome(vm) {
    if (vm.setUp) return "";
    return `
    <div class="welcome">
      <h2 class="welcome-title">Help Cursor finish your work</h2>
      <p>Keep the goal across chats, catch meaningful omissions, and learn from your feedback.</p>
      <button data-setup-submit>Connect Guardian</button>
      <p class="quiet">Connect, enable Guardian&rsquo;s tools in Cursor once, then ask for the work in chat.
      Your request becomes the goal.</p>

      <dl class="welcome-features">
        <div><dt>Goal loop <span>OpenAI Codex + DeepSeek</span></dt><dd>Remembers your goal and sends the agent back with what remains.</dd></div>
        <div><dt>Independent review <span>CGG + Google ADK</span></dt><dd>Checks finished work and returns useful findings to the agent.</dd></div>
        <div><dt>Self-improvement <span>Google RRSI</span></dt><dd>Tests reviewer updates from your feedback; adopts them only when they qualify.</dd></div>
      </dl>

      <details class="su-options">
        <summary>Add a goal or boundaries now (optional)</summary>
      <div class="su">
        <label class="su-label" for="su-goal">What are you working toward?</label>
        <textarea id="su-goal" class="su-input su-goal" rows="2" spellcheck="false"
          placeholder="In your own words \u2014 e.g. Ship the CSV exporter with filters and tests"></textarea>

        <label class="su-label" for="su-crit">Done when&hellip;</label>
        <div id="su-crit-list" class="su-list"></div>
        <input id="su-crit" class="su-input" type="text" spellcheck="false" data-su-list="su-crit-list"
          placeholder="Add a finish line, press Enter" />

        <label class="su-label" for="su-con">Boundaries</label>
        <div id="su-con-list" class="su-list"></div>
        <input id="su-con" class="su-input" type="text" spellcheck="false" data-su-list="su-con-list"
          placeholder="Optional \u2014 e.g. No new dependencies" />

        <label class="su-check"><input id="su-git" type="checkbox" checked />
          Keep Guardian&rsquo;s machine-written files out of git</label>

        <p class="quiet">You can change these later. Use Connect Guardian above when ready.</p>
      </div>
      </details>
    </div>`;
  }
  var GOAL_RUN_WORD = {
    working: "Continuing the goal: the agent has the next steps",
    proved: "Finished",
    unchecked: "The agent finished the work",
    disputed: "Work needs attention: review findings remain",
    unverified: "Goal tracking could not finish: check the setup",
    blocked: "Goal blocked",
    set_aside: "Goal kept for later in that chat",
    stalled: "Goal stalled: the agent stopped making progress",
    limit: "Goal still open: continuation limit reached",
    budget_limited: "Goal stopped: its token budget is used up",
    stopped: "Goal run stopped"
  };
  function renderGoalRun(vm) {
    const g = vm.goalRun;
    if (!g) return "";
    if (g.outcome === "working" && vm.goalPhase === "paused") return "";
    if (g.outcome === "working" && vm.goalPhase === "complete") return `<p class="review-line">Goal marked done by you.</p>`;
    const tokens = g.tokens ? g.tokens >= 1e3 ? `${Math.round(g.tokens / 1e3)}K tokens` : `${g.tokens} tokens` : "";
    const parts = [
      g.rounds ? `${g.rounds} round${g.rounds === 1 ? "" : "s"}` : "",
      g.rounds && g.seconds ? `${Math.max(1, Math.round(g.seconds / 60))} min` : "",
      tokens
    ].filter(Boolean);
    const spent = parts.length ? ` (${parts.join(", ")})` : "";
    const disputed = g.outcome === "proved" && g.reviewer.length > 0;
    const head = `${disputed ? "Work needs attention: an earlier completion still has review findings" : GOAL_RUN_WORD[g.outcome]}${g.round ? ` (round ${g.round})` : spent}`;
    const lines = [
      ...g.detail,
      ...g.changes.filter((c) => c.serves !== "extra").map((c) => `Changed for ${c.serves}: ${c.files.join(", ")}`),
      ...g.extras.map((f) => `Possible unrelated work to review: ${f}`),
      ...vm.reviews.length ? [] : g.reviewer.map((l) => `Review finding: ${l.replace(/^Reviewer: /, "")}`),
      ...g.outcome === "unchecked" ? [] : g.skipped.map((s) => `Not independently checked: ${s}`),
      ...g.changedSinceReview ? ["The last review objected, and the agent changed the project after it. That final state wasn't reviewed again."] : [],
      ...g.goalFileEdited ? ["The agent edited Guardian's goal files during this run."] : []
    ];
    const missed = g.passedReview ? g.saidMissed ? `<p class="review-line"><span class="review-said">you said: this wasn't done. The goal is reopened so Cursor can finish it.</span></p>` : `<p class="review-line">Anything still missing? <button class="link" data-cmd="review.missed:${escapeHtml(g.passedReview)}">This wasn't done</button></p>` : "";
    const lineHtml = lines.map((l) => `<p class="review-line">${escapeHtml(l)}</p>`).join("");
    const receiptHtml = lineHtml + (g.outcome === "unchecked" ? g.skipped.map((s) => `<p class="review-line">${escapeHtml(s)}</p>`).join("") : "");
    const receipts = (g.outcome === "unchecked" || g.outcome === "proved" && !disputed) && receiptHtml ? `<details class="run-details"><summary>Check details</summary>${receiptHtml}</details>` : lineHtml;
    const summary = g.outcome === "unchecked" ? "" : `<p class="review-line">${escapeHtml(head)}</p>`;
    return `${summary}${receipts}${missed}`;
  }
  var SOURCE_WORD = { user: "your call", fixed: "the agent fixed it", overruled: "you marked the goal done over it", missed: "you said the work wasn't done" };
  function renderReviews(vm) {
    if (!vm.reviews.length) return "";
    const blocks = vm.reviews.map((r) => {
      const lines = r.lines.map((line, i) => {
        const said = r.feedback[i];
        const buttons = said ? `<span class="review-said">${said === "right" ? "you marked this useful" : "you marked this unnecessary"}</span>` : `<button class="link" data-cmd="review.right:${escapeHtml(r.id)}:${r.indexes?.[i] ?? i}">Useful finding</button> <button class="link" data-cmd="review.wrong:${escapeHtml(r.id)}:${r.indexes?.[i] ?? i}">Unnecessary complaint</button>`;
        return `<p class="review-line">${escapeHtml(`Review finding: ${line.replace(/^Reviewer: /, "")}`)} ${buttons}</p>`;
      });
      const label = r.label && r.label.source !== "user" ? `<p class="review-line">Counted as ${r.label.label === "right" ? "a right call" : "a wrong call"}: ${SOURCE_WORD[r.label.source]}.</p>` : "";
      const dismissed = r.dismissed.map((line) => `<p class="review-line">${escapeHtml(line)}</p>`);
      return lines.join("") + label + dismissed.join("");
    });
    return `<div class="reviews">${blocks.join("")}</div>`;
  }
  function renderImprove(vm) {
    const im = vm.improve;
    const out = [];
    const latest = im.latest;
    const cost = im.cost?.callLimit !== void 0 ? " Background learning stops at its usage limit." : im.cost ? ` About ${im.cost.reviews} reviews and up to ${im.cost.searchCallsMax} more calls to your Cursor model.` : "";
    if (im.running) out.push(`<p class="review-line">${escapeHtml(`Guardian is testing a reviewer update with RRSI from your feedback.${im.stage ? ` ${im.stage}.` : ""}${cost}`)}</p>`);
    else if (latest?.kept) {
      out.push(
        `<p class="review-line">${escapeHtml(`A reviewer update passed the checks on your feedback: ${latest.reason}.${latest.applied ? " It is in use now." : " It isn't in use."}${cost}`)}</p>`,
        ...latest.hypotheses.map((h) => `<p class="review-line">${escapeHtml(`Idea tested: ${h}`)}</p>`),
        `<pre class="review-diff">${escapeHtml(latest.diff)}</pre>`,
        ...latest.applied ? [] : [`<div class="goal-controls"><button class="link" data-cmd="review.apply:${escapeHtml(latest.id)}">Use it again</button></div>`]
      );
    } else if (latest) out.push(`<p class="review-line">${escapeHtml(`Guardian checked a reviewer update and kept the current one: ${latest.reason}.${cost}`)}</p>`);
    else if (im.labelled) out.push(`<p class="review-line">${escapeHtml(`${im.labelled} review${im.labelled === 1 ? " has" : "s have"} specific feedback. With enough examples to learn from and check an improvement, Guardian tries in the background within its usage limit.`)}</p>`);
    if (im.usingImproved) out.push(`<p class="review-line">This workspace uses a qualified reviewer update. <button class="link" data-cmd="review.undo">Undo</button></p>`);
    return out.join("");
  }
  function renderGoalControls(vm) {
    if (vm.hooksDisabled) {
      return `<p class="review-line">Cursor runs Guardian's hooks only in a trusted workspace, so the goal can't be checked here. Trust this workspace to turn it on.</p>`;
    }
    if (vm.goalPhase === "paused") {
      return `<p class="review-line">Goal paused. Resume when you want the agent to continue; the panel opens a new chat.</p><div class="goal-controls"><button class="link" data-cmd="goal.resume">Resume goal</button></div>`;
    }
    if (vm.goalPhase !== "active") return "";
    if (!vm.goalRun || vm.goalRun.outcome !== "working") {
      const done = vm.goalRun ? ` <button class="link" data-cmd="goal.done">Mark goal done</button>` : "";
      return `<div class="goal-controls"><button class="link" data-cmd="goal.work">Work on the goal</button>${done}</div>`;
    }
    return `<div class="goal-controls"><button class="link" data-cmd="goal.pause">Pause goal</button> <button class="link" data-cmd="goal.done">Mark goal done</button></div>`;
  }
  function renderGoal(vm) {
    if (!vm.setUp) return "";
    const goal = vm.goal.trim();
    const goalHtml = goal ? `<details class="goal-request"><summary><span class="goal-preview">${escapeHtml(goal)}</span><span class="goal-toggle">Full request</span></summary><div class="goal-full"><p>${escapeHtml(goal)}</p><button class="link" data-cmd="editGoal">Edit goal</button></div></details>` : `<p class="goal-empty">No goal yet. Ask your agent for something \u2014 the request becomes
       the goal automatically. Or <button class="link" data-cmd="editGoal">write it here</button>.</p>`;
    return `
    <div class="goal">
      <div class="goal-heading"><div class="eyebrow">Goal</div><div class="lamp-row">
        <span class="lamp ${vm.status.lamp}"></span>
        <span class="status-word">${escapeHtml(vm.status.word)}</span>
      </div></div>
      ${goalHtml}
      ${renderGoalRun(vm)}
      ${renderReviews(vm)}
      ${renderImprove(vm)}
      ${renderGoalControls(vm)}
    </div>`;
  }
  function renderTour(vm) {
    if (!vm.tour.visible) return "";
    const items = vm.tour.steps.map((s) => {
      const action = !s.done && s.id === "center" ? `<button class="link" data-cmd="commandCenter">open it</button>` : "";
      return `<li class="${s.done ? "done" : ""}">
        <span class="tick">${s.done ? "\u2713" : ""}</span>
        <span class="step"><b>${escapeHtml(s.label)}</b><span class="hint">${escapeHtml(s.hint)}${action ? " \xB7 " : ""}${action}</span></span>
      </li>`;
    }).join("");
    return `<div class="tour">
    <div class="eyebrow">Get started \xB7 ${vm.tour.doneCount} of ${vm.tour.total}
      <button class="link dismiss" data-cmd="dismissTour" title="Hide this checklist">hide</button></div>
    <ul>${items}</ul>
  </div>`;
  }
  function renderCriteria(vm) {
    if (!vm.setUp || vm.successCriteria.length === 0) return "";
    const items = vm.successCriteria.map((c) => `<li class="${c.done ? "done" : ""}"><span class="tick">${c.done ? "\u2713" : ""}</span>${escapeHtml(c.text)}</li>`).join("");
    const list = `<ul>${items}</ul>`;
    if (vm.goalPhase === "complete" && vm.goalRun?.outcome === "unchecked") return `<details class="run-details"><summary>Goal details</summary>${list}</details>`;
    return `<div class="criteria"><div class="eyebrow">Done when</div>${list}</div>`;
  }
  function renderConstraints(vm) {
    if (!vm.setUp || vm.constraints.length === 0) return "";
    return `<div class="constraints"><div class="eyebrow">Boundaries</div><ul>${vm.constraints.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></div>`;
  }
  function renderSections(vm) {
    return {
      welcome: renderWelcome(vm),
      goal: renderGoal(vm),
      tour: renderTour(vm),
      criteria: renderCriteria(vm),
      constraints: renderConstraints(vm)
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
  function addListItem(listId, text) {
    const value = text.trim();
    if (!value) return;
    const list = document.getElementById(listId);
    if (!list) return;
    const item = document.createElement("div");
    item.className = "su-item";
    item.dataset.value = value;
    const label = document.createElement("span");
    label.textContent = value;
    const remove = document.createElement("button");
    remove.className = "su-remove";
    remove.textContent = "\xD7";
    remove.dataset.suRemove = "1";
    remove.title = "Remove";
    item.append(label, remove);
    list.appendChild(item);
  }
  function listValues(listId, pendingInputId) {
    const values = [];
    for (const el of Array.from(document.querySelectorAll(`#${listId} .su-item`))) {
      const v = el.dataset.value ?? "";
      if (v) values.push(v);
    }
    const pending = document.getElementById(pendingInputId)?.value.trim();
    if (pending) values.push(pending);
    return values;
  }
  document.addEventListener("input", (event) => {
    const el = event.target;
    if (el?.id === "su-goal") {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  });
  document.addEventListener("keydown", (event) => {
    const input = event.target;
    if (event.key === "Enter" && input?.dataset?.suList) {
      event.preventDefault();
      addListItem(input.dataset.suList, input.value);
      input.value = "";
    }
  });
  document.addEventListener("click", (event) => {
    const removeBtn = event.target.closest("[data-su-remove]");
    if (removeBtn) {
      removeBtn.closest(".su-item")?.remove();
      return;
    }
    const submit = event.target.closest("[data-setup-submit]");
    if (submit) {
      vscode.postMessage({
        type: "connectSubmit",
        form: {
          goal: document.getElementById("su-goal")?.value ?? "",
          criteria: listValues("su-crit-list", "su-crit"),
          constraints: listValues("su-con-list", "su-con"),
          gitignore: document.getElementById("su-git")?.checked ?? true
        }
      });
      return;
    }
    const target = event.target.closest("[data-cmd]");
    if (target?.dataset.cmd) vscode.postMessage({ type: "command", command: target.dataset.cmd });
  });
  vscode.postMessage({ type: "ready" });
})();
