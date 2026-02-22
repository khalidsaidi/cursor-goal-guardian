# Live Blinded A/B (React, 20 Tasks)

This folder provides a **real-run** protocol for CGG evaluation.

Use this when you want evidence from actual agent executions, not synthetic logs.

## What this study measures

The same five metrics as `scripts/evaluate-ab.js`:

1. Scope drift incidents per task
2. Rework caused by misunderstanding (minutes/task)
3. Time to resume after context switch
4. Task completion vs original success criteria
5. Unplanned task switches per task

## Files

- `task_set_20.json`: 20 user-style React task prompts with explicit success criteria IDs.
- `README.md`: run protocol and scoring rubric.

## Roles

- **Operator**: runs both arms (`arm_alpha`, `arm_beta`) and records events.
- **Judge**: scores completion criteria from artifacts, without seeing mapping to CGG vs non-CGG.

Do not share `blinding.secret.json` with judges.

## Protocol (recommended)

1. Prepare two environments from the same clean baseline React app:
   - one with CGG enabled
   - one without CGG
2. Initialize blinded study scaffold:

```bash
node scripts/scaffold-live-react-env.js \
  --env /tmp/cgg-live-react-env-$(date +%Y%m%d-%H%M%S) \
  --study /tmp/cgg-live-react-20-$(date +%Y%m%d-%H%M%S) \
  --tasks examples/ab-live-react/task_set_20.json \
  --seed react-live-20-v1
```

If you already have prepared environments, use `scripts/init-live-ab.js` directly.

3. For each task:
   - run task once in `arm_alpha`, once in `arm_beta`
   - start each task from the same baseline commit/snapshot
   - fill the matching run objects in `runs.blinded.json`:
     - `started_at`, `ended_at`
     - `completed_success_criteria_ids`
     - `events`
4. Judge scores completion criteria IDs from outputs only (no access to arm mapping).
5. Unblind and evaluate:

```bash
node scripts/unblind-live-ab.js --study /tmp/cgg-live-react-20-... --evaluate
```

JSON output:

```bash
node scripts/unblind-live-ab.js --study /tmp/cgg-live-react-20-... --evaluate --json
```

## Event rubric (keep it strict)

Log events in `runs.blinded.json`:

- `scope_drift`: action unrelated to current task criteria.
- `task_switch` with `planned: false`: agent changed to unplanned work.
- `rework` with `cause: "misunderstanding"` and `minutes`: had to redo due to misunderstood requirement.
- `context_switch_start` / `context_switch_resume` with same `switch_id`.

For consistent scoring:

- Count `scope_drift` only when work is clearly outside prompt + criteria.
- Count `rework` only when earlier implementation direction was wrong, not normal refactor.
- Count unplanned switch only when no prior explicit plan/decision justified the switch.
- Use ISO timestamps (`new Date().toISOString()` format).

## Bias controls

- Keep prompts identical across both arms.
- Keep model/provider settings identical.
- Keep tools and repo state identical before each run.
- Randomize run order per arm (avoid always doing one arm first).
- Judge should evaluate only final artifacts and blinded run logs.
