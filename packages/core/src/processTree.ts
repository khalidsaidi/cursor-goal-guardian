import { spawn, type ChildProcess } from "node:child_process";

/** Stop only the isolated child group we started, including model calls below an adapter process. */
export function stopProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill("SIGKILL"));
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { child.kill("SIGKILL"); }
}

const active = new Set<ChildProcess>();
const cleanup = (): void => { for (const child of active) stopProcessTree(child); };
const terminate = (signal: NodeJS.Signals): void => {
  cleanup();
  // Preserve other host shutdown handlers; otherwise restore the signal's normal exit behavior.
  if (process.listenerCount(signal) === 1) {
    process.removeListener(signal, signal === "SIGTERM" ? term : interrupt);
    process.kill(process.pid, signal);
  }
};
const term = (): void => terminate("SIGTERM");
const interrupt = (): void => terminate("SIGINT");

export function trackProcessTree(child: ChildProcess): void {
  if (!active.size) {
    process.on("exit", cleanup);
    process.on("SIGTERM", term);
    process.on("SIGINT", interrupt);
  }
  active.add(child);
  child.once("close", () => {
    if (process.platform !== "win32") stopProcessTree(child);
    active.delete(child);
    if (!active.size) {
      process.removeListener("exit", cleanup);
      process.removeListener("SIGTERM", term);
      process.removeListener("SIGINT", interrupt);
    }
  });
}
