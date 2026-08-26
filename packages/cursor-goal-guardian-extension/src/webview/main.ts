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

document.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest("[data-cmd],[data-task],[data-rescore]") as HTMLElement | null;
  if (!target) return;
  if (target.dataset.cmd) vscode.postMessage({ type: "command", command: target.dataset.cmd });
  else if (target.dataset.task) vscode.postMessage({ type: "startTask", taskId: target.dataset.task });
  else if (target.dataset.rescore) vscode.postMessage({ type: "rescoreOne", driftId: target.dataset.rescore });
});

vscode.postMessage({ type: "ready" });
