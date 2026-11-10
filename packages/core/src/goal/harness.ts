/**
 * The harness: the text Guardian steers agents with, kept as files a workspace can carry its own improved version
 * of. Only the reviewer prompt is wired today; the rule and the send-back text are meant to join this list.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getGuardianPaths } from "../paths.js";

export interface HarnessFile {
  /** File name under .cursor/goal-guardian/harness/. */
  file: string;
  /** Placeholders a version must keep, or it can't be filled in. */
  required: string[];
}

export const HARNESS_FILES = {
  reviewer: { file: "reviewer.md", required: ["{goal}", "{items}"] },
} satisfies Record<string, HarnessFile>;

export type HarnessName = keyof typeof HARNESS_FILES;

export function harnessDir(root: string): string {
  return path.join(getGuardianPaths(root).dir, "harness");
}

export function harnessPath(root: string, name: HarnessName): string {
  return path.join(harnessDir(root), HARNESS_FILES[name].file);
}

/** A version that drops a placeholder can't be used. */
export function harnessUsable(name: HarnessName, text: string): boolean {
  return text.trim().length > 0 && HARNESS_FILES[name].required.every((p) => text.includes(p));
}

/** The workspace's own version if it has a usable one, otherwise the built-in text. */
export function readHarness(root: string | undefined, name: HarnessName, builtIn: string): string {
  if (!root) return builtIn;
  try {
    const text = fs.readFileSync(harnessPath(root, name), "utf8");
    return harnessUsable(name, text) ? text : builtIn;
  } catch {
    return builtIn;
  }
}

export async function writeHarness(root: string, name: HarnessName, text: string): Promise<void> {
  if (!harnessUsable(name, text)) throw new Error(`that ${name} version drops a required placeholder`);
  await fsp.mkdir(harnessDir(root), { recursive: true });
  await fsp.writeFile(harnessPath(root, name), text, "utf8");
}

export async function removeHarness(root: string, name: HarnessName): Promise<void> {
  await fsp.rm(harnessPath(root, name), { force: true });
}
