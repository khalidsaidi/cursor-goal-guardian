"use strict";
(() => {
  // src/panel/render.ts
  var SECTION_IDS = ["welcome", "repair", "goal", "tour", "focus", "criteria", "constraints", "drift", "consent"];
  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  var STATUS_WORD = {
    stable: "on course",
    recovering: "holding course",
    drifting: "off course"
  };
  function statusSentence(vm) {
    const c = vm.counts24h;
    const open = vm.driftFeed.filter((e) => e.status !== "dismissed" && !e.realigned);
    const confirmedOpen = open.filter((e) => e.status === "confirmed").length;
    const pendingOpen = open.filter((e) => e.status === "pending").length;
    const detours = c.driftConfirmed + c.driftPending;
    if (vm.health === "stable") {
      return c.driftDismissed > 0 ? `Quiet day \u2014 ${c.driftDismissed} false alarm${c.driftDismissed === 1 ? "" : "s"} cleared by review.` : "Nothing off-goal in the last 24 hours.";
    }
    if (confirmedOpen > 0) {
      return `${confirmedOpen} detour${confirmedOpen === 1 ? "" : "s"} without a way back yet.`;
    }
    if (pendingOpen > 0) {
      return `${pendingOpen} detour${pendingOpen === 1 ? "" : "s"} awaiting review \u2014 nothing confirmed off-goal.`;
    }
    return `${detours} detour${detours === 1 ? "" : "s"} \u2014 every one came back.`;
  }
  function renderWelcome(vm) {
    if (vm.setUp) return "";
    return `
    <div class="welcome">
      <div class="lamp-row"><span class="lamp idle"></span><span class="status-word">standing by</span></div>
      <p>Guardian rides along while you work with your agent: it remembers the goal,
      notices when the session wanders, and shows you the way back.</p>

      <div class="su">
        <label class="su-label" for="su-goal">What are you working toward?</label>
        <textarea id="su-goal" class="su-input su-goal" rows="2" spellcheck="false"
          placeholder="In your own words \u2014 e.g. Ship the CSV exporter with filters and tests"></textarea>

        <label class="su-label" for="su-crit">Done when&hellip;</label>
        <div id="su-crit-list" class="su-list"></div>
        <input id="su-crit" class="su-input" type="text" spellcheck="false" data-su-list="su-crit-list"
          placeholder="Add a finish line, press Enter \u2014 each becomes a task" />

        <label class="su-label" for="su-con">Boundaries</label>
        <div id="su-con-list" class="su-list"></div>
        <input id="su-con" class="su-input" type="text" spellcheck="false" data-su-list="su-con-list"
          placeholder="Optional \u2014 e.g. No new dependencies" />

        <label class="su-check"><input id="su-git" type="checkbox" checked />
          Keep Guardian&rsquo;s machine-written files out of git</label>

        <button data-setup-submit>Connect Guardian</button>
        <p class="quiet">Everything here is optional and editable later &mdash; connect empty
        and your first request to the agent becomes the goal.</p>
      </div>
    </div>`;
  }
  function renderRepair(vm) {
    if (!vm.setUp || !vm.stateBroken) return "";
    return `
    <div class="repair">
      <p>The task board file doesn&rsquo;t match its record &mdash; it may have been
      edited by hand or damaged. Your session log is intact.</p>
      <button data-cmd="rebuildState">Rebuild the board from the record</button>
    </div>`;
  }
  function renderGoal(vm) {
    if (!vm.setUp) return "";
    const goal = vm.goal.trim();
    const goalHtml = goal ? `<button class="goal-text" data-cmd="editGoal" title="Change the goal">${escapeHtml(goal)}</button>` : `<p class="goal-empty">No goal yet. Ask your agent for something \u2014 the request becomes
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
      ${vm.sessionReview ? `<p class="review-line">AI read the session: ${vm.sessionReview.verdict === "on_course" ? "on course" : "off course"} (${Math.round(vm.sessionReview.confidence * 100)}%) \u2014 ${escapeHtml(vm.sessionReview.rationale)}</p>` : ""}
      ${vm.suggestion ? `<p class="suggestion">${escapeHtml(vm.suggestion)}</p>` : ""}
    </div>`;
  }
  function renderTour(vm) {
    if (!vm.tour.visible) return "";
    const items = vm.tour.steps.map((s) => {
      const action = !s.done && s.id === "review" ? `<button class="link" data-cmd="enableRescore">turn on</button>` : !s.done && s.id === "center" ? `<button class="link" data-cmd="commandCenter">open it</button>` : "";
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
  function renderFocus(vm) {
    if (!vm.setUp) return "";
    const active = vm.board.doing[0] ?? null;
    const next = vm.board.todo;
    const doneCount = vm.board.done.length;
    const nowBlock = active ? `<div class="now-card">
         <span class="now-title">${escapeHtml(active.title)}</span>
         <button data-cmd="completeActiveTask">Mark done</button>
       </div>` : next.length > 0 ? `<div class="now-card empty"><span class="now-title quiet">Nothing in progress</span><button data-cmd="startNextTask">Start next task</button></div>` : doneCount > 0 ? `<div class="now-card empty"><span class="now-title quiet">All done \u2014 everything on the list is finished.</span></div>` : "";
    const nextBlock = next.length ? `<div class="eyebrow">Up next</div>
       <ul class="next-list">${next.map((t) => `<li><span>${escapeHtml(t.title)}</span><button class="link" data-task="${escapeHtml(t.id)}">Start</button></li>`).join("")}</ul>` : "";
    const doneBlock = doneCount ? `<div class="done-line">${doneCount} finished</div>` : "";
    if (!nowBlock && !nextBlock && !doneBlock) return "";
    return `<div class="focus"><div class="eyebrow">Now</div>${nowBlock}${nextBlock}${doneBlock}</div>`;
  }
  function renderCriteria(vm) {
    if (!vm.setUp || vm.successCriteria.length === 0) return "";
    const items = vm.successCriteria.map((c) => `<li class="${c.done ? "done" : ""}"><span class="tick">${c.done ? "\u2713" : ""}</span>${escapeHtml(c.text)}</li>`).join("");
    return `<div class="criteria"><div class="eyebrow">Done when</div><ul>${items}</ul></div>`;
  }
  function renderConstraints(vm) {
    if (!vm.setUp || vm.constraints.length === 0) return "";
    return `<div class="constraints"><div class="eyebrow">Boundaries</div><ul>${vm.constraints.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></div>`;
  }
  function shortTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function driftChip(e) {
    if (e.realigned) return `<span class="chip back">came back</span>`;
    if (e.status === "confirmed") return `<span class="chip confirmed">off-goal</span>`;
    return `<span class="chip pending">unreviewed<button class="link" data-rescore="${escapeHtml(e.driftId)}">check with AI</button></span>`;
  }
  function renderDrift(vm) {
    if (!vm.setUp) return "";
    const visible = vm.driftFeed.filter((e) => e.status !== "dismissed").slice().reverse();
    const dismissed = vm.driftFeed.length - visible.length;
    const body = visible.length ? `<ol class="track">${visible.map((e) => {
      const value = e.detail.replace(/^\[(shell|mcp|read|edit)\]\s*/, "");
      const kind = e.detail.match(/^\[(shell|mcp|read|edit)\]/)?.[1] ?? "";
      return `<li class="${e.realigned ? "back" : e.status}">
            <span class="node"></span>
            <div class="entry">
              <div class="entry-head"><span class="when">${shortTime(e.ts)}</span>${driftChip(e)}</div>
              <code title="${escapeHtml(e.detail)}">${escapeHtml(kind ? `${kind} \xB7 ` : "")}${escapeHtml(value.split(" \xB7 task:")[0]?.slice(0, 64) ?? "")}</code>
            </div>
          </li>`;
    }).join("")}</ol>` : `<p class="quiet">The session is following the track. Detours will show up here.</p>`;
    const cleared = dismissed ? `<p class="quiet">${dismissed} false alarm${dismissed === 1 ? "" : "s"} cleared by review.</p>` : "";
    return `<div class="drift"><div class="eyebrow">Off the track</div>${body}${cleared}</div>`;
  }
  function renderConsent(vm) {
    if (!vm.setUp) return "";
    if (vm.semantic.consented) {
      return vm.semantic.available ? "" : `<div class="consent muted">AI review is offline right now \u2014 detours stay marked "unreviewed" until it's back.</div>`;
    }
    if (vm.semantic.pendingCount === 0) return "";
    return `
    <div class="consent">
      <p>${vm.semantic.pendingCount === 1 ? "One detour is" : `${vm.semantic.pendingCount} detours are`} waiting for review.
      Guardian can double-check them with AI so false alarms clear themselves
      (uses your Cursor account \u2014 a few small calls).</p>
      <button data-cmd="enableRescore">Turn on AI review</button>
    </div>`;
  }
  function renderSections(vm) {
    return {
      welcome: renderWelcome(vm),
      repair: renderRepair(vm),
      goal: renderGoal(vm),
      tour: renderTour(vm),
      focus: renderFocus(vm),
      criteria: renderCriteria(vm),
      constraints: renderConstraints(vm),
      drift: renderDrift(vm),
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
    const target = event.target.closest("[data-cmd],[data-task],[data-rescore]");
    if (!target) return;
    if (target.dataset.cmd) vscode.postMessage({ type: "command", command: target.dataset.cmd });
    else if (target.dataset.task) vscode.postMessage({ type: "startTask", taskId: target.dataset.task });
    else if (target.dataset.rescore) vscode.postMessage({ type: "rescoreOne", driftId: target.dataset.rescore });
  });
  vscode.postMessage({ type: "ready" });
})();
