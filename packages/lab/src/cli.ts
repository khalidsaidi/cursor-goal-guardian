#!/usr/bin/env node
/**
 * gg-review: audit the latest agent turn in a Guardian workspace with the adversarial reviewer.
 * Usage: gg-review <workspace> <message-file> [--conversation <id>] [--model <id>] [--guidance <json-file>]
 * Costs about 10-15 agent calls on your Cursor plan per round.
 */
import fs from "node:fs";
import { conversationStart, readAuditTail, readContractSafe, readShellOutputs, shellRunsInScope, type ConversationScope } from "@goal-guardian/core";
import { runCursorAgentReviewer } from "./review.js";
import { reviewRound } from "./round.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const [root, messageFile] = args;
if (!root || !messageFile) {
  console.error("Usage: gg-review <workspace> <message-file> [--conversation <id>] [--model <id>] [--guidance <json-file>]");
  process.exit(2);
}
const conversationId = flag("conversation");
const model = flag("model");
const guidanceFile = flag("guidance");
const records = await readAuditTail(root, 5000);
const sinceIso = conversationStart(records, conversationId);
const scope: ConversationScope = { ...(conversationId ? { conversationId } : {}), ...(sinceIso ? { sinceIso } : {}) };
const result = await reviewRound(root, {
  history: [],
  message: fs.readFileSync(messageFile, "utf8"),
  contract: await readContractSafe(root),
  records,
  scope,
  shellRuns: shellRunsInScope(records, await readShellOutputs(root), scope),
  plainLines: [],
  maxRounds: 5,
  timeoutMs: 420_000,
  ...(model ? { model } : {}),
  verify: true,
  pieces: true,
  guidance: guidanceFile ? JSON.parse(fs.readFileSync(guidanceFile, "utf8")) : {},
  tests: { enabled: true, timeoutSeconds: 60 },
  reviewer: runCursorAgentReviewer,
});
console.log(JSON.stringify(result, null, 2));
