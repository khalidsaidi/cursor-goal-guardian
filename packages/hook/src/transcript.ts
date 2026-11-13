/** Recover a human turn from Cursor's own JSONL transcript when its prompt hook isn't delivered. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { getGuardianPaths, GUARDIAN_MESSAGE_PREFIX, recordUserPrompt, writeJsonAtomic } from "@goal-guardian/core";

const MAX_TAIL = 256 * 1024;
interface Seen {
  token?: string;
  hash?: string;
  generation?: string;
  source?: "transcript" | "prompt";
  pending?: string;
  pendingGeneration?: string;
}
type State = Record<string, Seen>;
const hash = (text: string): string => createHash("sha256").update(text.trim()).digest("hex");

async function latestUser(file: unknown): Promise<{ text: string; token: string } | null> {
  if (typeof file !== "string" || !file.endsWith(".jsonl")) return null;
  const fd = await fs.open(file, "r").catch(() => null);
  if (!fd) return null;
  try {
    const st = await fd.stat();
    if (!st.isFile()) return null;
    const start = Math.max(0, st.size - MAX_TAIL), buffer = Buffer.alloc(st.size - start);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, bytesRead);
    let offset = start > 0 ? bytes.indexOf(10) + 1 : 0;
    if (start > 0 && offset === 0) return null;
    let latest: { text: string; token: string } | null = null;
    while (offset < bytes.length) {
      const next = bytes.indexOf(10, offset), end = next < 0 ? bytes.length : next;
      try {
        const record = JSON.parse(bytes.subarray(offset, end).toString("utf8"));
        if (record.role === "user" && Array.isArray(record.message?.content)) {
          const text = record.message.content.filter((x: { type?: unknown; text?: unknown }) => x.type === "text" && typeof x.text === "string").map((x: { text: string }) => x.text).join("\n");
          const open = text.indexOf("<user_query>"), close = text.lastIndexOf("</user_query>");
          // Tool output, assistant prose and transcript metadata never become the user's request.
          if (open >= 0 && close > open) {
            const query = text.slice(open + "<user_query>".length, close).trim();
            if (query && !query.startsWith(GUARDIAN_MESSAGE_PREFIX)) latest = { text: query, token: hash(`${file}\n${start + offset}\n${query}`) };
          }
        }
      } catch { /* Partial writes and unrelated transcript records are ignored. */ }
      offset = end + 1;
    }
    return latest;
  } finally { await fd.close(); }
}

export async function captureUserFromHook(root: string, event: string, conversationId: string | undefined, payload: Record<string, unknown>): Promise<void> {
  if (process.env.GOAL_GUARDIAN_REVIEWING) return;
  const prompt = event === "beforeSubmitPrompt" && typeof payload.prompt === "string" ? payload.prompt : undefined;
  if (prompt !== undefined && (!prompt.trim() || prompt.startsWith(GUARDIAN_MESSAGE_PREFIX))) return;
  if (!conversationId) {
    if (prompt !== undefined) await recordUserPrompt(root, prompt, undefined, typeof payload.composer_mode === "string" ? payload.composer_mode : undefined);
    return;
  }
  if (prompt === undefined && typeof payload.transcript_path !== "string") return;
  const paths = getGuardianPaths(root), file = path.join(paths.telemetryDir, "transcript-turns.json"), lock = path.join(paths.telemetryDir, ".transcript-turn.lock");
  await fs.mkdir(paths.telemetryDir, { recursive: true });
  let locked = false;
  for (let i = 0; i < 60; i++) {
    try { await fs.mkdir(lock); locked = true; break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return;
      const old = await fs.stat(lock).catch(() => null);
      if (old && Date.now() - old.mtimeMs > 60_000) await fs.rmdir(lock).catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!locked) return;
  try {
    const saved: unknown = await fs.readFile(file, "utf8").then((s) => JSON.parse(s) as unknown).catch(() => null);
    const state: State = saved && typeof saved === "object" && !Array.isArray(saved) ? saved as State : {};
    const entry = state[conversationId];
    const previous: Seen = entry && typeof entry === "object" ? entry : {}, latest = await latestUser(payload.transcript_path);
    const generation = typeof payload.generation_id === "string" ? payload.generation_id : undefined;
    if (prompt !== undefined) {
      const digest = hash(prompt);
      const alreadyCaptured = generation !== undefined && previous.source === "transcript" && previous.generation === generation && previous.hash === digest && latest?.token === previous.token;
      if (!alreadyCaptured) await recordUserPrompt(root, prompt, conversationId, typeof payload.composer_mode === "string" ? payload.composer_mode : undefined);
      state[conversationId] = { ...previous, ...(alreadyCaptured ? { pending: undefined, pendingGeneration: undefined } : { pending: digest, pendingGeneration: generation }) };
    } else {
      if (!latest || latest.token === previous.token) return;
      const digest = hash(latest.text);
      const promptHookRecordedIt = previous.pending === digest && (!previous.pendingGeneration || !generation || previous.pendingGeneration === generation);
      if (!promptHookRecordedIt) await recordUserPrompt(root, latest.text, conversationId, typeof payload.composer_mode === "string" ? payload.composer_mode : "agent");
      state[conversationId] = { token: latest.token, hash: digest, generation, source: promptHookRecordedIt ? "prompt" : "transcript" };
    }
    // A workspace may have many chats; the deduplication cursor stays bounded.
    const current = state[conversationId]; delete state[conversationId]; state[conversationId] = current;
    await writeJsonAtomic(file, Object.fromEntries(Object.entries(state).slice(-64)));
  } finally { await fs.rmdir(lock).catch(() => undefined); }
}
