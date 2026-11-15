"""Judge one agent run with Google's Agent Development Kit. JSON in on stdin, one JSON line out on stdout.

The evaluator is ADK's own (third_party/adk-python, unmodified; github.com/google/adk-python, Apache-2.0):
`RubricBasedMultiTurnTrajectoryEvaluator`, with ADK's judge prompt, ADK's configured sampling (one judge call by default) and ADK's aggregation. Guardian supplies three things: the run, the rubrics and the model.

- The run: one ADK Invocation built from the user's request, each recorded command or edit as a tool call with its
  response, and the agent's own completion report as the final response.
- The rubrics: each "done when" item of the user's request, word for word, and one of Guardian's own
  (EXTRA_WORK_RUBRIC).
- The model: ADK's judge calls a registered BaseLlm. Guardian registers one that asks the user's own Cursor model
  through `cursor-agent`, as packages/rsi/cgg/cursor_llm.py does for RRSI.

In:  {"user_query": str, "items": [{"id": str, "text": str}],
      "conversation": [{"role": "assistant"|"tool", "content": str, "tool_calls": str|null}, ...], "report": str}
Out: {"ran": bool, "reason"?: str, "overall": number|null,
      "rubrics": [{"id": str, "property": str, "score": number|null, "rationale": str}], "calls": int, "seconds": number}

Usage: python cli.py --adk <dir holding google/adk> --site <dir holding ADK's dependencies>
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The one rubric that is Guardian's: the user's items say what must be done, this says nothing else should be.
EXTRA_WORK_ID = "extra"
EXTRA_WORK_RUBRIC = (
    "The final project contains no meaningful unrequested behavior, feature, API change or loss of existing work. "
    "Tests, type declarations, documentation, comments and minimal build fixes supporting the requested behavior "
    "are part of that work. Harmless formatting, wording, Markdown styling and build/test instructions are allowed, "
    "including edits to existing text. Enforce formatting, exact-text or supporting-file restrictions only when "
    "the user explicitly required them; cite the requirement and the concrete violation. A changed filename, "
    "reformatted declaration or added documentation heading alone is not a failure. Judge the current project, "
    "not superseded edits that were fixed. Copied output quotes and completion-report formatting are not requirements; "
    "use Guardian's recorded results and the actual project evidence."
)
# ADK's name for this evaluator's metric (evaluation/eval_metrics.py PrebuiltMetrics).
METRIC = "rubric_based_multi_turn_trajectory_quality_v1"
JUDGE_MODEL = "cursor-agent"
# Repeated sampling is useful for studies; normal completion needs one extra judgment.
SAMPLES = int(os.environ.get("CGG_EVALUATOR_SAMPLES", "1"))
PARALLELISM = int(os.environ.get("CGG_EVALUATOR_PARALLEL", "1"))
# Long prompts go through a file: Windows caps a command line near 32,000 characters.
ARGV_LIMIT = 20_000
TIMEOUT_S = int(os.environ.get("CGG_EVALUATOR_CALL_TIMEOUT", "300"))
# This machine's own Cursor setup can tell every agent to hand work to helpers; a judge must answer itself.
NO_DELEGATION = ("Answer this yourself, in this reply. Do not delegate to subagents or helpers and do not use tools: "
                 "everything you need is in this message. Keep each rubric explanation concise while returning every required verdict.")


def _arg(argv: list[str], flag: str, env: str, fallbacks: list[Path]) -> Path | None:
    if flag in argv:
        return Path(argv[argv.index(flag) + 1]).resolve()
    if os.environ.get(env):
        return Path(os.environ[env]).resolve()
    return next((p for p in fallbacks if p.exists()), None)


def agent_command() -> str | None:
    """The headless Cursor agent: an explicit path, else PATH, else where its installer puts it."""
    configured = os.environ.get("GOAL_GUARDIAN_REVIEWER")
    if configured:
        return configured if os.path.isfile(configured) and os.access(configured, os.X_OK) else None
    for name in ("cursor-agent", "cursor-agent.cmd", "cursor-agent.exe", "agent", "agent.cmd", "agent.exe"):
        found = shutil.which(name)
        if found:
            return found
    fallback = Path.home() / ".local" / "bin" / "cursor-agent"
    return str(fallback) if fallback.is_file() else None


CALLS = {"n": 0}
AGENT_NAME = "agent"


def tool_call(call: str) -> tuple[str, dict]:
    """Guardian records a call as `name(key="value")`: give ADK the name and the argument."""
    name, _, rest = call.partition("(")
    key, eq, value = rest.rstrip(")").partition("=")
    if eq:
        try:
            return name, {key: json.loads(value)}
        except ValueError:
            pass
    return name, {"call": call}


def ask_agent(text: str) -> str:
    """One question to the user's model. Raises when it can't be asked or gives nothing."""
    command = agent_command()
    if not command:
        raise RuntimeError("cursor-agent isn't installed")
    CALLS["n"] += 1
    text = (f"{NO_DELEGATION}\n\n{text}\n\n"
            "Evidence handling for this run: bounded excerpts and omitted files are not proof of a defect or of success. "
            "If the supplied observations cannot establish a rubric, keep its ID/Property/Rationale fields, "
            "identify the specific missing check in Rationale, and write Verdict: unclear. "
            "Do not use 'unknown' as the verdict. Judge independently of any agent's completion claim.")
    with tempfile.TemporaryDirectory(prefix="gg-eval-") as scratch:
        if os.name == "nt" or len(text) > ARGV_LIMIT:
            Path(scratch, "task.md").write_text(text, encoding="utf-8", newline="\n")
            ask = ("Read task.md in this folder and do exactly what it says. "
                   "Your whole reply is the answer it asks for, nothing else.")
        else:
            ask = text
        r = subprocess.run([command, "-p", ask, "--output-format", "json", "--trust", "--mode", "ask", "--workspace", scratch],
                           cwd=scratch, capture_output=True, text=True, encoding="utf-8", timeout=TIMEOUT_S,
                           env={**os.environ, "GOAL_GUARDIAN_REVIEWING": "1"},
                           shell=os.name == "nt" and command.lower().endswith(".cmd"))
        if r.returncode != 0:
            raise RuntimeError(f"cursor-agent exited {r.returncode}: {(r.stderr or r.stdout or '')[-300:]}")
        for line in reversed((r.stdout or "").strip().splitlines()):
            try:
                env = json.loads(line)
            except ValueError:
                continue
            if isinstance(env, dict):
                if env.get("is_error") is True:
                    raise RuntimeError("cursor-agent reported an error")
                if isinstance(env.get("result"), str) and env["result"].strip():
                    return env["result"]
        if (r.stdout or "").strip():
            return r.stdout
        raise RuntimeError("cursor-agent gave no answer")


async def evaluate(job: dict) -> dict:
    # ADK, unmodified. Imported here so a missing dependency is reported, not raised at import.
    from google.genai import types
    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse
    from google.adk.models.registry import LLMRegistry
    from google.adk.evaluation.eval_case import Invocation, InvocationEvent, InvocationEvents
    from google.adk.evaluation.eval_metrics import EvalMetric, JudgeModelOptions, RubricsBasedCriterion
    from google.adk.evaluation.eval_rubrics import Rubric, RubricContent
    from google.adk.evaluation.rubric_based_multi_turn_trajectory_evaluator import RubricBasedMultiTurnTrajectoryEvaluator

    answers = []

    class CursorLlm(BaseLlm):
        """ADK's judge model, answered by the user's own Cursor model."""

        @classmethod
        def supported_models(cls):
            return [JUDGE_MODEL]

        async def generate_content_async(self, llm_request, stream: bool = False):
            parts = [p.text for c in (llm_request.contents or []) for p in (c.parts or []) if getattr(p, "text", None)]
            system = getattr(llm_request.config, "system_instruction", None) if llm_request.config else None
            if isinstance(system, str) and system:
                parts.insert(0, system)
            answer = await asyncio.to_thread(ask_agent, "\n\n".join(parts))
            answers.append(answer)
            yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=answer)]))

    LLMRegistry.register(CursorLlm)

    user_query = str(job.get("user_query") or "").strip()
    turns = [m for m in job.get("conversation") or [] if m.get("role") in ("assistant", "tool")]
    items = [i for i in job.get("items") or [] if str(i.get("text") or "").strip()]
    if not user_query or not turns:
        return {"ran": False, "reason": "nothing to judge: no user request or no recorded actions"}
    # ADK shows its judge the tool calls and their results only when the run is given as invocation events.
    events = []
    for n, m in enumerate(turns):
        if m["role"] != "assistant" or not m.get("tool_calls"):
            continue
        name, args = tool_call(str(m["tool_calls"]))
        after = turns[n + 1] if n + 1 < len(turns) and turns[n + 1]["role"] == "tool" else None
        events.append(InvocationEvent(author=AGENT_NAME, content=types.Content(role="model", parts=[
            types.Part(function_call=types.FunctionCall(id=f"call-{n}", name=name, args=args))])))
        events.append(InvocationEvent(author=AGENT_NAME, content=types.Content(role="user", parts=[
            types.Part(function_response=types.FunctionResponse(id=f"call-{n}", name=name, response={"result": str(after["content"]) if after else ""}))])))
    invocation = Invocation(
        invocation_id="run",
        user_content=types.Content(role="user", parts=[types.Part(text=user_query)]),
        final_response=types.Content(role="model", parts=[types.Part(text=str(job.get("report") or ""))]),
        intermediate_data=InvocationEvents(invocation_events=events),
    )
    properties = {str(i["id"]): str(i["text"]) for i in items} or {"goal": user_query}
    properties[EXTRA_WORK_ID] = EXTRA_WORK_RUBRIC
    rubrics = [Rubric(rubric_id=k, rubric_content=RubricContent(text_property=v)) for k, v in properties.items()]
    metric = EvalMetric(metric_name=METRIC, threshold=1.0, criterion=RubricsBasedCriterion(
        threshold=1.0, rubrics=rubrics, judge_model_options=JudgeModelOptions(judge_model=JUDGE_MODEL, num_samples=SAMPLES, parallelism_limit=PARALLELISM)))
    result = await RubricBasedMultiTurnTrajectoryEvaluator(metric).evaluate_invocations([invocation], None, None)
    # ADK's overall scores carry a stock rationale; the judge's own words are on the per-invocation scores.
    said: dict[str, str] = {}
    for per in result.per_invocation_results or []:
        for s in per.rubric_scores or []:
            if s.rationale and (s.rubric_id not in said or (s.score is not None and s.score < 1)):
                said[s.rubric_id] = s.rationale
    scored = [{"id": s.rubric_id, "property": properties.get(s.rubric_id, ""), "score": s.score,
               "rationale": said.get(s.rubric_id) or s.rationale or ""} for s in (result.overall_rubric_scores or [])]
    if not scored:
        # Keep ADK's complete-sample scoring rule. Its own parser can still expose a useful missing check.
        from google.adk.evaluation.rubric_based_evaluator import DefaultAutoRaterResponseParser
        unclear = [s for answer in answers for s in DefaultAutoRaterResponseParser().parse(answer)
                   if s.score is None and s.rubric_id in properties]
        detail = "; ".join(f"{s.rubric_id}: {s.rationale}" for s in unclear)[:300]
        return {"ran": False, "reason": "ADK's evaluator gave no complete rubric scores" + (f"; missing check: {detail}" if detail else "")}

    return {"ran": True, "overall": result.overall_score, "rubrics": scored}


def main(argv: list[str]) -> int:
    started = time.time()
    try:
        repo = HERE.parent.parent.parent
        adk = _arg(argv, "--adk", "CGG_ADK_DIR", [HERE.parent / "adk", repo / "third_party" / "adk-python" / "src"])
        site = _arg(argv, "--site", "CGG_EVALUATOR_SITE", [HERE.parent / "site-packages", HERE.parent / ".site"])
        if not adk or not (adk / "google" / "adk" / "evaluation").is_dir():
            raise RuntimeError("ADK's files weren't found")
        # ADK's own files first, then the packages ADK depends on.
        sys.path[:0] = [str(adk), *([str(site)] if site else [])]
        job = json.loads(sys.stdin.read())
        import contextlib
        with contextlib.redirect_stdout(sys.stderr):
            result = asyncio.run(evaluate(job))
    except Exception as e:  # noqa: BLE001 - an evaluator that can't run is reported, never raised
        result = {"ran": False, "reason": f"{type(e).__name__}: {e}"[:400]}
    result = {"overall": None, "rubrics": [], **result, "calls": CALLS["n"], "seconds": round(time.time() - started, 1)}
    sys.stdout.write(json.dumps(result) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
