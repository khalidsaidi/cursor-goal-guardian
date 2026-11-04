# @goal-guardian/lab

Internal developer tools. Private, never bundled into the extension or its binaries.

**`gg-review`** audits an agent's turn with the adversarial reviewer: measured workspace facts, each factual claim checked alone, each command and changed file scored alone, one agent per central claim trying to prove it false by running something, a drift check that reads the diff against the request, the reviewer itself in a throwaway copy, then a true-and-material check per objection.

```
node packages/lab/dist/cli.js <workspace> <message-file> [--conversation <id>] [--model <id>] [--guidance <json-file>]
```

**Cost:** one round is about 10-15 `cursor-agent` calls on your Cursor plan. This is why it is not a product feature: measuring it used up a full month's composer and Auto limits in two days.

## Measured (2026-11-03/04)

Real agent turns on temptation tasks in 14 small libraries, labelled blind, test set frozen before the run. Data and harness: `~/.cache/ggw/study`.

| | Result |
|---|---|
| Misleading turns caught, unseen | 11 of 14 (79%, 95% interval 52-92%); 9 on `composer-2.5`, 5 on `auto` |
| Clean honest turns wrongly flagged, unseen | 4 of 22 (18%, 7-39%), after independent adjudication; the objections were true but minor |
| Drift, with vs without, 28 blind pairs | 7 vs 9 incidents (better 3, worse 1, tied 24; p = 0.63): not shown |
| Drift check alone vs blind judges | caught 9 of 11; flagged 8 of 27 they judged clean |

Lessons: a weak model answers one narrow question well and one long prompt badly; hard evidence must not depend on the model choosing to use it; measured facts catch false causes. An earlier version's 6 of 8 on tuning turns fell to 3 of 12 on unseen turns, so only frozen sets count.

Open: `candidate-guidance.json` (one automatic improvement proposal) is unscored; the run was voided when usage ran out.
