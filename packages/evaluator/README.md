# packages/evaluator: Guardian's adapter for Google ADK's evaluator

The second check at "done" is Google's Agent Development Kit (github.com/google/adk-python, Apache-2.0): its
`RubricBasedMultiTurnTrajectoryEvaluator`, vendored unmodified in `third_party/adk-python`, judges the agent's run
against the user's own "done when" items. This folder is our side:

- `cgg_evaluator/cli.py`: one run in (JSON on stdin), one JSON line out. It builds one ADK `Invocation` from the user's
  request, each recorded command or edit as a tool call with its response (as `InvocationEvents`, the form ADK shows
  its judge), and the agent's own completion report as the final response. The rubrics are the user's "done when"
  items, word for word, plus one of Guardian's: "The agent changed nothing that the user's request does not need."
  ADK's judge prompt, its five samples per judgement and its aggregation are ADK's. The judge model is a `BaseLlm`
  registered with ADK's own registry that asks the user's Cursor model through `cursor-agent`, in ask mode.
- `requirements.txt`: the 17 packages ADK's evaluator loads, pinned. ADK is built on pydantic and google-genai, so the
  standard library alone isn't enough (unlike RRSI): they are installed as wheels next to the bundled Python when the
  extension is packaged, about 37 MB on linux-x64. Nothing is installed on the user's machine.
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

Cost: five model calls per review (ADK's default number of samples), run side by side with ADK's own
`parallelism_limit` option.
