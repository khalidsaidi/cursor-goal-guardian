# third_party/adk-python

Files from Google's Agent Development Kit, https://github.com/google/adk-python, commit c0bcdaa, Apache-2.0
(see LICENSE). Every file here except this note is upstream's own, byte for byte, at its upstream path.

Kept: LICENSE, README.md, and the 115 files under `src/google/adk` that are loaded when
`google.adk.evaluation.rubric_based_multi_turn_trajectory_evaluator.RubricBasedMultiTurnTrajectoryEvaluator` judges a
run through Guardian's adapter (`packages/evaluator`). `packages/evaluator/tools/vendor.py` finds them by running the
evaluator once and copies them from a checkout.

Left out, because that run doesn't load them: the rest of ADK (agent runtime pieces it never imports, the CLI and web
UI, other evaluators such as the ones that call Vertex AI's hosted evaluation, tests, samples and docs).

ADK's own dependencies are not copied here: they are pinned in `packages/evaluator/requirements.txt` and installed as
wheels when the extension is packaged.
