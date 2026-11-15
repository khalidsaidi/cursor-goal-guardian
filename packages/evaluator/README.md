# CGG's Google ADK evaluator adapter

CGG's own reviewer checks the project. This adapter supplies a complementary check: Google's open-source ADK `RubricBasedMultiTurnTrajectoryEvaluator` evaluates the recorded work against the user's finish conditions and meaningful unrequested-work rubric.

ADK receives the request, recorded command/edit events and responses, completion report, and project observations CGG supplies: status/diff, relevant changed-source excerpts, cited evidence and explicit limits where content is absent or truncated. It cannot read the project itself. A focused project check can resolve a finding when the reviewer and evaluator disagree.

`cgg_evaluator/cli.py` translates JSON input into ADK's invocation/event model and rubric configuration. A registered ADK model transport calls the user's `cursor-agent` in ask mode. Upstream judge prompts, parsing and aggregation remain ADK's; CGG supplies the rubrics, evidence and transport. The default is one evaluator sample; environment options can change sampling/concurrency. Inconclusive checks are not clean passes.

The adapter returns whether it ran, per-rubric scores/rationales, call count, elapsed time and a reason when it cannot run. The CLI JSON protocol and pinned dependencies are documented by the source and `requirements.txt`. The package bundles the interpreter and wheels; normal users do not need a Google Cloud account or separate Google model key.

For local adapter development:

```sh
python3 -m pip install --no-deps --only-binary=:all: --target .site -r requirements.txt
python3 -m unittest discover -s tests
```

The retained upstream source is selected for this evaluator, not ADK's entire agent/workflow/deployment ecosystem. Hosted Vertex AI evaluation is not used. Native package checks execute the evaluator with its bundled Python and target-compatible dependencies. Real Cursor/model behavior evidence comes from Linux/WSL. See [verification](../../docs/verification.md), [design](../../docs/goal-design.md) and [NOTICE](../../NOTICE).
