# packages/evaluator: Guardian's adapter for Google ADK's evaluator

The second check at "done" is Google's Agent Development Kit (github.com/google/adk-python, Apache-2.0): its
`RubricBasedMultiTurnTrajectoryEvaluator`, vendored unmodified in `third_party/adk-python`, judges Guardian's record
of the agent's run against the user's own "done when" items. It never sees the project itself, only what Guardian
gives it, so it can object to something the agent later fixed: when it objects to something Guardian's reviewer did
not, the reviewer checks that claim against the real project before it counts
(`packages/core/src/goal/review.ts`). Built and run on Linux x64 only so far. This folder is our side:

- `cgg_evaluator/cli.py`: one run in (JSON on stdin), one JSON line out. It builds one ADK `Invocation` from the user's
  request, each recorded command or edit as a tool call with its response (as `InvocationEvents`, the form ADK shows
  its judge), the evidence Guardian adds from the project (the real `git status` and diff, and each cited proof,
  with anything missing marked absent), and the agent's own completion report as the final response. The rubrics
  are the user's "done when" items, word for word, plus one of Guardian's, saying the agent changed nothing the
  request doesn't need and that tests, types, docs and comments for the requested work are not extra. Guardian
  also prepends one line telling the judge not to delegate. ADK's judge prompt and aggregation remain unchanged. Guardian sets ADK's `num_samples` option to one by default. The judge model is a `BaseLlm`
  registered with ADK's own registry that asks the user's Cursor model through `cursor-agent`, in ask mode.
- `requirements.txt`: the 17 packages ADK's evaluator loads, pinned. ADK is built on pydantic and google-genai, so the
  standard library alone isn't enough (unlike RRSI): they are installed as wheels next to the bundled Python when the
  extension is packaged, about 19 MB on linux-x64 as shipped (the whole evaluator folder is 20 MB). Nothing is installed on the user's machine.
- `tools/vendor.py`: copies the ADK files the evaluator loads from a checkout into `third_party/adk-python`.
- `tests/`: the adapter against a fake `cursor-agent`, on an interpreter with only `--site` added.

```bash
python3 -m pip install --no-deps --only-binary=:all: --target .site -r requirements.txt   # once, for development
echo '{"user_query": "...", "items": [{"id": "sc_1", "text": "..."}], "conversation": [...], "report": "..."}' \
  | python3 cgg_evaluator/cli.py
python3 -m unittest discover -s tests
```

Out: `ran`, `reason` when it didn't, `overall` (share of rubrics met), `rubrics` (`id`, `property`, `score` 0 or 1,
`rationale` in the judge's words), `calls`, `seconds`.

Not used from ADK: its `MultiTurnTrajectoryQuality` and `MultiTurnTaskSuccess` evaluators hand the judging to Vertex
AI's hosted evaluation and need a Google Cloud project, so they can't run on the user's own Cursor model.

Cost: one model call per extra check by default. Studies can set `CGG_EVALUATOR_SAMPLES` and
`CGG_EVALUATOR_PARALLEL` through ADK's own sampling and concurrency options.
