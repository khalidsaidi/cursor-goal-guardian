"""MRT's monitor model, answered by the user's own Cursor model through `cursor-agent`.

MRT ships one BaseLLM subclass per API provider (llms/anthropic_llm.py and so on). Guardian has no API account: it
has the user's Cursor login. This is Guardian's provider, the same way packages/rsi/cgg/cursor_llm.py serves RRSI.
MRT must be importable (see standins.install and cli._mrt_dir) before this module is.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from llms.base import BaseLLM                      # MRT, unmodified
from utils.pipeline_elements import QueryResult    # MRT, unmodified

# Long prompts go through a file: Windows caps a command line near 32,000 characters.
ARGV_LIMIT = 20_000
TIMEOUT_S = int(os.environ.get("CGG_MONITOR_CALL_TIMEOUT", "300"))
# This machine's own Cursor setup can tell every agent to hand work to helpers; a monitor must answer itself.
NO_DELEGATION = ("Answer this yourself, in this reply. Do not delegate to subagents or helpers and do not use tools: "
                 "everything you need is in this message.")


def agent_command() -> str | None:
    """The headless Cursor agent: an explicit path, else PATH, else where its installer puts it."""
    configured = os.environ.get("GOAL_GUARDIAN_REVIEWER")
    if configured:
        return configured if os.path.isfile(configured) and os.access(configured, os.X_OK) else None
    for name in ("cursor-agent", "cursor-agent.cmd", "cursor-agent.exe"):
        found = shutil.which(name)
        if found:
            return found
    fallback = Path.home() / ".local" / "bin" / "cursor-agent"
    return str(fallback) if fallback.is_file() else None


def answer_text(stdout: str) -> str | None:
    """The answer from cursor-agent's JSON envelope, or the raw output. None when it reported an error."""
    for line in reversed(stdout.strip().splitlines()):
        try:
            env = json.loads(line)
        except ValueError:
            continue
        if isinstance(env, dict):
            if env.get("is_error") is True:
                return None
            if isinstance(env.get("result"), str):
                return env["result"]
    return stdout


def flatten(messages) -> str:
    """One prompt from MRT's chat messages. cursor-agent takes a single prompt, not a list of roles.

    MRT's hierarchical calls and its first sequential call are a system message and one user message; later
    sequential calls carry the earlier excerpts and the monitor's own earlier answers too, kept here in order.
    """
    system = [m["content"] for m in messages if m["role"] == "system"]
    rest = [m for m in messages if m["role"] != "system"]
    parts = [NO_DELEGATION, *system]
    if len(rest) == 1:
        parts.append(rest[0]["content"] or "")
    else:
        for m in rest[:-1]:
            who = "You were given" if m["role"] == "user" else "You answered"
            parts.append(f"[Earlier in this review] {who}:\n{m['content'] or ''}")
        parts.append(f"[Now]\n{rest[-1]['content'] or ''}")
    return "\n\n".join(p for p in parts if p)


def ask(prompt: str) -> str:
    """One call to cursor-agent. Raises with the reason when there is no usable answer."""
    command = agent_command()
    if not command:
        raise RuntimeError("cursor-agent isn't installed")
    with tempfile.TemporaryDirectory(prefix="gg-monitor-") as scratch:
        if len(prompt) > ARGV_LIMIT:
            Path(scratch, "task.md").write_text(prompt, encoding="utf-8")
            text = ("Read task.md in this folder and do exactly what it says. "
                    "Your whole reply is the answer it asks for, nothing else.")
        else:
            text = prompt
        args = [command, "-p", text, "--output-format", "json", "--trust", "--mode", "ask", "--workspace", scratch]
        model = os.environ.get("CGG_MONITOR_MODEL")
        if model:
            args += ["--model", model]
        env = {**os.environ, "GOAL_GUARDIAN_REVIEWING": "1"}
        r = subprocess.run(args, cwd=scratch, capture_output=True, text=True, timeout=TIMEOUT_S, env=env,
                           shell=os.name == "nt" and command.lower().endswith(".cmd"))
    out = answer_text(r.stdout or "") if r.returncode == 0 else None
    if not out or not out.strip():
        raise RuntimeError(f"cursor-agent exited {r.returncode}: {(r.stderr or r.stdout or '')[-300:]}")
    return out.strip()


class CursorLLM(BaseLLM):
    """A BaseLLM whose every query is one cursor-agent call. Counts its calls."""

    def __init__(self) -> None:
        super().__init__(model="cursor-agent", temperature=None)
        self.calls = 0

    @property
    def provider(self) -> str:
        return "cursor"

    async def query(self, query, runtime, env=None, messages=(), extra_args={}):  # noqa: B006 - MRT's signature
        self.calls += 1
        text = await asyncio.to_thread(ask, flatten(list(messages)))
        reply = {"role": "assistant", "content": text, "tool_calls": None}
        return QueryResult(query=query, runtime=runtime, env=env, messages=[*messages, reply], extra_args=extra_args)
