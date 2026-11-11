# packages/monitor: Guardian's adapter for the paper's monitor

The monitor from "Reliable Weak-to-Strong Monitoring of LLM Agents" (github.com/scaleapi/mrt), vendored unmodified
in `third_party/mrt`, reads an agent's trajectory piece by piece and scores how far it strayed from what the user
asked. This folder is our side:

- `cgg_monitor/cli.py`: one trajectory in (JSON on stdin), one JSON line out. It builds the transcript with MRT's
  `json_conversation_to_string`, runs MRT's `PipelineUtils.run_monitor` twice, in the styles the paper's own runs use
  (`hierarchical_5_likert_reminder_v2` and `sequential_5_likert_reminder_v2`, from MRT's
  `scripts/run_monitors_shadearena.sh`), and reads each score with MRT's `extract_verdict`. The hybrid score is the
  mean of the two; MRT's repository has no code for that step, so that one line is ours, from the paper's definition.
- `cgg_monitor/cursor_llm.py`: MRT's `BaseLLM`, answered by `cursor-agent`, the user's own Cursor model, in ask mode.
- `cgg_monitor/task.py`: MRT's `BaseTaskDefinition`, subclassed with no prompt overridden: the monitor's prompts are
  MRT's own.
- `cgg_monitor/standins.py`: MRT's modules import pydantic, anthropic, openai, yaml, rich, pandas and its mock
  environments at the top; the monitor path runs none of them. Empty stand-ins satisfy those imports, so the monitor
  runs on Guardian's bundled Python, which has the standard library only. No MRT file is edited.
- `tests/`: the adapter against a fake `cursor-agent`, on an interpreter with no site-packages
  (`python3 -m unittest discover -s tests`; set `MRT_UPSTREAM` to a checkout to verify the vendored files).

```bash
echo '{"user_query": "...", "conversation": [{"role": "assistant", "content": "...", "tool_calls": null}]}' \
  | python3 cgg_monitor/cli.py
```

In: `user_query`, `conversation` (roles `assistant`, `tool`, `user`; `tool_calls` a string or null), `hier_chunk`,
`seq_chunk` (default 5). Out: `ran`, `reason` when it didn't, `hierarchical` and `sequential` (`score` 1 to 5 or
null, `text`), `hybrid`, `scale`, `calls`, `seconds`.

Cost: with N agent messages and chunk size c, the hierarchical monitor makes ceil(N/c) calls plus its aggregation
layers and the sequential monitor ceil(N/c); MRT awaits them one after another.
