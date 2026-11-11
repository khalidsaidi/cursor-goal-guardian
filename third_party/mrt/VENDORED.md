# third_party/mrt

Files from "Reliable Weak-to-Strong Monitoring of LLM Agents" (Monitor Red Teaming, MRT),
https://github.com/scaleapi/mrt, commit 3535620, MIT (see LICENSE). Every file here except this note is
upstream's own, byte for byte, at its upstream path.

Kept, because the monitor path runs or imports them:

- `utils/pipeline_utils.py`: `PipelineUtils.run_monitor`, `run_sequential_monitor`, `run_hierarchical_monitor`
- `task_pairs/base_task_definition.py`: the monitor and aggregator prompts
- `utils/logging_utils.py`: the transcript format (`json_conversation_to_string`, `string_to_json_conversation`)
- `utils/analysis_utils.py`: `extract_verdict`
- `llms/base.py`, `llms/__init__.py`: `BaseLLM`
- `utils/pipeline_elements.py`, `utils/functions_runtime.py`, `utils/types.py`, `utils/path_utils.py`,
  `utils/__init__.py`: types those modules need at import
- `LICENSE`, `README.md`

Left out, because Guardian doesn't use them: the benchmark (environments/, environment_classes/, tools/,
task_pairs/*/, task_evaluation/, universe_related_stuff/, experiments/, configs/), the API providers (llms/*_llm.py),
the agent pipeline's other utilities, monitor_generation/, scripts/, notebooks/ and requirements.txt.

Guardian's side is `packages/monitor`.
