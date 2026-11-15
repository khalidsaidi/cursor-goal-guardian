"""Send RRSI's search roles to the user's own Cursor model through `cursor-agent`.

RRSI's rrsi/llm.py calls Claude on Vertex AI. Guardian has no such account: it has the user's Cursor login. This
module replaces `rrsi.llm.generate`, and the copies other RRSI modules imported by name, at import time from the
domain adapter. RRSI's own files stay unmodified.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from model_budget import reserve_call

JSON_SUFFIX = ("\n\nOutput ONLY a single valid JSON object. No prose before or "
               "after, no markdown fences.")
# Long prompts go through a file: Windows caps a command line near 32,000 characters.
ARGV_LIMIT = 20_000
TIMEOUT_S = int(os.environ.get("CGG_SEARCH_TIMEOUT", "600"))


def agent_command() -> str | None:
    """The headless Cursor agent: an explicit path, else PATH, else where its installer puts it."""
    configured = os.environ.get("GOAL_GUARDIAN_REVIEWER")
    if configured:
        return configured if os.path.isfile(configured) and os.access(configured, os.X_OK) else None
    names = ("cursor-agent", "cursor-agent.cmd", "cursor-agent.exe", "agent", "agent.cmd", "agent.exe")
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    home_bin = Path.home() / ".local" / "bin"
    return next((str(home_bin / name) for name in names if (home_bin / name).is_file()), None)


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


def generate(prompt, system=None, max_retries=3, json_only=False, model=None,
             max_tokens=20_000, cache_prefix=None):
    from rrsi.llm import extract_json  # RRSI's own JSON cleanup

    command = agent_command()
    if not command:
        raise RuntimeError("cursor-agent isn't installed")
    text = ("Answer this role yourself. Do not delegate or call tools; all required context is supplied here.\n\n"
            + "\n\n".join(p for p in (system or "", cache_prefix or "", prompt) if p)
            + (JSON_SUFFIX if json_only else ""))
    chosen = os.environ.get("CGG_SEARCH_MODEL") or None
    last = None
    for attempt in range(max_retries):
        with tempfile.TemporaryDirectory(prefix="gg-rsi-") as scratch:
            if os.name == "nt" or len(text) > ARGV_LIMIT:
                Path(scratch, "task.md").write_text(text, encoding="utf-8", newline="\n")
                ask = ("Read task.md in this folder and do exactly what it says. "
                       "Your whole reply is the answer it asks for, nothing else.")
            else:
                ask = text
            args = [command, "-p", ask, "--output-format", "json", "--trust", "--mode", "ask", "--workspace", scratch]
            if chosen:
                args += ["--model", chosen]
            env = {**os.environ, "GOAL_GUARDIAN_REVIEWING": "1"}
            reserve_call()
            try:
                r = subprocess.run(args, cwd=scratch, capture_output=True, text=True, encoding="utf-8", timeout=TIMEOUT_S, env=env,
                                   shell=os.name == "nt" and command.lower().endswith(".cmd"))
                out = answer_text(r.stdout or "") if r.returncode == 0 else None
                if out and out.strip():
                    return extract_json(out) if json_only else out.strip()
                last = RuntimeError(f"cursor-agent exited {r.returncode}: {(r.stderr or r.stdout or '')[-300:]}")
            except Exception as e:  # noqa: BLE001 - retried, then reported
                last = e
        time.sleep(min(2 ** attempt, 20))
    raise RuntimeError(f"generate failed after {max_retries} tries: {last}")


def install() -> None:
    import importlib

    import rrsi.llm as llm
    llm.generate = generate
    for name in ("rrsi.propose", "rrsi.analyst", "rrsi.digester", "rrsi.critic"):
        mod = importlib.import_module(name)
        if hasattr(mod, "generate"):
            mod.generate = generate
