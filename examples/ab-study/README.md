# A/B Evaluation For CGG Value

This folder contains a practical A/B format to measure CGG value on the same task set.

## Files

- `sample/task_set.json`: task definitions + original success criteria.
- `sample/runs.json`: paired run records for `with_cgg` and `without_cgg`.

## Metrics computed

1. Scope drift incidents per task.
2. Rework caused by misunderstanding (minutes/task).
3. Time to resume after context switch (minutes).
4. Task completion vs original success criteria.
5. Number of unplanned task switches per task.

## Run evaluator

```bash
node scripts/evaluate-ab.js --study examples/ab-study/sample
```

JSON output:

```bash
node scripts/evaluate-ab.js --study examples/ab-study/sample --json
```

## Data collection guidance

- Keep task IDs identical across both variants.
- Keep scope of each task set fixed before starting both runs.
- Log events in `runs.json` during execution:
  - `scope_drift`
  - `task_switch` (`planned: true|false`)
  - `rework` (`cause: "misunderstanding"`, `minutes`)
  - `context_switch_start` / `context_switch_resume` (same `switch_id`)
- Mark fulfilled criteria by ID in `completed_success_criteria_ids`.

