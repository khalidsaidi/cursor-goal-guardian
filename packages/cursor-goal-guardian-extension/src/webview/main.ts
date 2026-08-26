import type { PanelViewModel } from "@goal-guardian/core";
import { renderSections, SECTION_IDS, type SectionId } from "../panel/render.js";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const lastHtml = new Map<SectionId, string>();

/** Re-render only sections whose markup changed — scroll and focus survive updates. */
function apply(vm: PanelViewModel): void {
  const sections = renderSections(vm);
  for (const id of SECTION_IDS) {
    const html = sections[id];
    if (lastHtml.get(id) === html) continue;
    lastHtml.set(id, html);
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
}

window.addEventListener("message", (event: MessageEvent<{ type: string; vm?: PanelViewModel }>) => {
  if (event.data?.type === "vm" && event.data.vm) apply(event.data.vm);
});

// ---- connect form: list builders (Enter adds, x removes), then one submit ----

function addListItem(listId: string, text: string): void {
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
  remove.textContent = "×";
  remove.dataset.suRemove = "1";
  remove.title = "Remove";
  item.append(label, remove);
  list.appendChild(item);
}

function listValues(listId: string, pendingInputId: string): string[] {
  const values: string[] = [];
  for (const el of Array.from(document.querySelectorAll(`#${listId} .su-item`))) {
    const v = (el as HTMLElement).dataset.value ?? "";
    if (v) values.push(v);
  }
  // Text typed but not yet Enter'd still counts — never lose what the user wrote.
  const pending = (document.getElementById(pendingInputId) as HTMLInputElement | null)?.value.trim();
  if (pending) values.push(pending);
  return values;
}

document.addEventListener("keydown", (event) => {
  const input = event.target as HTMLInputElement;
  if (event.key === "Enter" && input?.dataset?.suList) {
    event.preventDefault();
    addListItem(input.dataset.suList, input.value);
    input.value = "";
  }
});

document.addEventListener("click", (event) => {
  const removeBtn = (event.target as HTMLElement).closest("[data-su-remove]");
  if (removeBtn) {
    removeBtn.closest(".su-item")?.remove();
    return;
  }
  const submit = (event.target as HTMLElement).closest("[data-setup-submit]");
  if (submit) {
    vscode.postMessage({
      type: "connectSubmit",
      form: {
        goal: (document.getElementById("su-goal") as HTMLInputElement | null)?.value ?? "",
        criteria: listValues("su-crit-list", "su-crit"),
        constraints: listValues("su-con-list", "su-con"),
        gitignore: (document.getElementById("su-git") as HTMLInputElement | null)?.checked ?? true,
      },
    });
    return;
  }
  const target = (event.target as HTMLElement).closest("[data-cmd],[data-task],[data-rescore]") as HTMLElement | null;
  if (!target) return;
  if (target.dataset.cmd) vscode.postMessage({ type: "command", command: target.dataset.cmd });
  else if (target.dataset.task) vscode.postMessage({ type: "startTask", taskId: target.dataset.task });
  else if (target.dataset.rescore) vscode.postMessage({ type: "rescoreOne", driftId: target.dataset.rescore });
});

vscode.postMessage({ type: "ready" });
