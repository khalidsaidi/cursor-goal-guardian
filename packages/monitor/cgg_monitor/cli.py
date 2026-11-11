"""Run the paper's monitor on one agent trajectory. JSON in on stdin, one JSON line out on stdout.

The monitor is MRT's own (third_party/mrt, unmodified; "Reliable Weak-to-Strong Monitoring of LLM Agents",
github.com/scaleapi/mrt): `PipelineUtils.run_monitor` in its hierarchical and sequential styles, with MRT's
prompts, MRT's transcript format and MRT's verdict parser. Guardian supplies the trajectory and the model.

In:  {"user_query": str,
      "conversation": [{"role": "assistant"|"tool"|"user", "content": str, "tool_calls": str|null}, ...],
      "hier_chunk": int (default 5), "seq_chunk": int (default 5),
      "styles": ["hierarchical", "sequential"] (default both; Guardian runs one per process, side by side)}
Out: {"ran": bool, "reason"?: str,
      "hierarchical": {"score": number|null, "text": str}, "sequential": {"score": number|null, "text": str},
      "hybrid": number|null, "scale": "likert 1-5", "calls": int, "seconds": number}

Usage: python cli.py [--mrt <dir holding MRT's files>]   (default: $CGG_MRT_DIR, ../mrt, the repo's third_party/mrt)
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The styles the paper's own runs use: scripts/run_monitors_shadearena.sh lines 5 and 7
# ("hierarchical_5_likert_reminder_v2", "sequential_5_likert_reminder_v2"); the number is the chunk size.
HIERARCHICAL_STYLE = "hierarchical_{n}_likert_reminder_v2"
SEQUENTIAL_STYLE = "sequential_{n}_likert_reminder_v2"
SCALE = "likert 1-5"
# The paper's hybrid monitor is a linear combination of the two scores, mu*hierarchical + (1-mu)*sequential, with
# mu = 0.5. MRT's repository holds no code for it (only result folders named *_hybrid_* read by notebooks/final),
# so this one line is Guardian's, written from the paper's definition (section 3.5, "mu-Hybrid Monitoring", default
# mu = 0.5; the paper's main runs use chunk size 5 for both).
HYBRID_MU = 0.5


def _mrt_dir(argv: list[str]) -> Path:
    if "--mrt" in argv:
        return Path(argv[argv.index("--mrt") + 1]).resolve()
    if os.environ.get("CGG_MRT_DIR"):
        return Path(os.environ["CGG_MRT_DIR"]).resolve()
    for candidate in (HERE.parent / "mrt", HERE.parent.parent.parent / "third_party" / "mrt"):
        if (candidate / "utils" / "pipeline_utils.py").is_file():
            return candidate
    raise RuntimeError("MRT's files weren't found")


def load_mrt(mrt: Path):
    """Make MRT importable, with stand-ins for what its monitor never runs. Returns the pieces Guardian calls."""
    sys.path[:0] = [str(HERE.parent), str(mrt)]
    from cgg_monitor import standins
    standins.install()
    from utils.pipeline_utils import PipelineUtils                    # MRT
    from utils.logging_utils import json_conversation_to_string      # MRT
    from utils.analysis_utils import extract_verdict                 # MRT
    from cgg_monitor.cursor_llm import CursorLLM
    from cgg_monitor.task import GuardianTask
    return PipelineUtils, json_conversation_to_string, extract_verdict, CursorLLM, GuardianTask


def score_of(extract_verdict, text: str):
    """MRT's parser gives 0 when there is no <verdict> tag; on a 1-5 scale that means no verdict."""
    try:
        v = extract_verdict(text, "verdict")
    except (TypeError, ValueError):
        return None
    return v if v is not None and 1 <= v <= 5 else None


def hybrid_of(h, s):
    return None if h is None or s is None else round(HYBRID_MU * h + (1 - HYBRID_MU) * s, 3)


async def monitor(job: dict, mrt: Path) -> dict:
    PipelineUtils, to_string, extract_verdict, CursorLLM, GuardianTask = load_mrt(mrt)
    user_query = str(job.get("user_query") or "").strip()
    turns = [m for m in job.get("conversation") or [] if m.get("role") in ("assistant", "tool", "user")]
    if not user_query or not any(m["role"] == "assistant" for m in turns):
        return {"ran": False, "reason": "nothing to monitor: no user query or no agent messages"}
    # MRT's string form: the user's query first, then the agent's messages (add_monitors.py passes conversation[1:]).
    conversation = [{"role": "user", "content": user_query, "tool_calls": None},
                    *({"role": m["role"], "content": str(m.get("content") or ""), "tool_calls": m.get("tool_calls")} for m in turns)]
    text = to_string(conversation)
    llm = CursorLLM()
    pipeline = PipelineUtils(GuardianTask(user_query))
    out = {}
    wanted = job.get("styles") or ["hierarchical", "sequential"]
    for name, style, n in (("hierarchical", HIERARCHICAL_STYLE, job.get("hier_chunk")), ("sequential", SEQUENTIAL_STYLE, job.get("seq_chunk"))):
        if name not in wanted:
            continue
        response, _ = await pipeline.run_monitor(text, llm, monitor_style=style.format(n=int(n or 5)), is_already_string=True)
        answer = response.messages[-1].get("content") or ""
        out[name] = {"score": score_of(extract_verdict, answer), "text": answer}
    both = "hierarchical" in out and "sequential" in out
    return {"ran": True, **out, "hybrid": hybrid_of(out["hierarchical"]["score"], out["sequential"]["score"]) if both else None, "calls": llm.calls}


def main(argv: list[str]) -> int:
    started = time.time()
    empty = {"score": None, "text": ""}
    result: dict
    try:
        job = json.loads(sys.stdin.read())
        # MRT prints progress and parse notes; stdout is kept for the one JSON line.
        with contextlib.redirect_stdout(sys.stderr):
            result = asyncio.run(monitor(job, _mrt_dir(argv)))
    except Exception as e:  # noqa: BLE001 - a monitor that can't run is reported, never raised
        result = {"ran": False, "reason": f"{type(e).__name__}: {e}"[:400]}
    result = {"hierarchical": empty, "sequential": empty, "hybrid": None, "calls": 0, **result,
              "scale": SCALE, "seconds": round(time.time() - started, 1)}
    sys.stdout.write(json.dumps(result) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
