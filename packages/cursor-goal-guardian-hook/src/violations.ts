import path from "node:path";
import fs from "node:fs/promises";

/**
 * Violation Tracker for Goal Guardian
 *
 * Tracks warning counts per pattern to implement graduated guardrails.
 * Warnings reset after a configurable time period.
 */

export type ViolationTracker = {
  warningCounts: Record<string, number>; // pattern -> count
  lastReset: string;                      // ISO timestamp
};

const DEFAULT_TRACKER: ViolationTracker = {
  warningCounts: {},
  lastReset: new Date().toISOString(),
};

function getViolationsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".ai", "goal-guardian", "violations.json");
}

export async function loadViolations(workspaceRoot: string): Promise<ViolationTracker> {
  const filePath = getViolationsPath(workspaceRoot);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as ViolationTracker;
    return {
      warningCounts: parsed.warningCounts ?? {},
      lastReset: parsed.lastReset ?? new Date().toISOString(),
    };
  } catch {
    return { ...DEFAULT_TRACKER, lastReset: new Date().toISOString() };
  }
}

export async function saveViolations(workspaceRoot: string, tracker: ViolationTracker): Promise<void> {
  const filePath = getViolationsPath(workspaceRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(tracker, null, 2), "utf8");
}

/**
 * Check if warnings should be reset based on elapsed time.
 */
export function shouldResetWarnings(tracker: ViolationTracker, resetMinutes: number): boolean {
  const lastReset = Date.parse(tracker.lastReset);
  const now = Date.now();
  const elapsedMinutes = (now - lastReset) / (1000 * 60);
  return elapsedMinutes >= resetMinutes;
}

/**
 * Get the current warning count for a pattern.
 */
export function getWarningCount(tracker: ViolationTracker, pattern: string): number {
  return tracker.warningCounts[pattern] ?? 0;
}

/**
 * Increment the warning count for a pattern and return the new count.
 */
export function incrementWarning(tracker: ViolationTracker, pattern: string): number {
  const current = tracker.warningCounts[pattern] ?? 0;
  tracker.warningCounts[pattern] = current + 1;
  return current + 1;
}

/**
 * Reset all warning counts.
 */
export function resetWarnings(tracker: ViolationTracker): void {
  tracker.warningCounts = {};
  tracker.lastReset = new Date().toISOString();
}

/**
 * Get a summary of all active warnings.
 */
export function getWarningSummary(tracker: ViolationTracker): { pattern: string; count: number }[] {
  return Object.entries(tracker.warningCounts)
    .filter(([_, count]) => count > 0)
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get total warning count across all patterns.
 */
export function getTotalWarningCount(tracker: ViolationTracker): number {
  return Object.values(tracker.warningCounts).reduce((sum, count) => sum + count, 0);
}
