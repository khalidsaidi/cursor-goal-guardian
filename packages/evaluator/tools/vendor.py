"""Copy the part of Google's ADK that Guardian's evaluator loads into third_party/adk-python, unmodified.

Run with a Python that has google-adk installed from the same checkout:
  python tools/vendor.py <adk-python checkout> <repo>/third_party/adk-python
It runs the evaluator once against a stand-in agent, takes every google.adk module that was loaded, and copies those
files byte for byte from the checkout, with LICENSE and README.md. It also prints the other packages that were loaded,
which is what requirements.txt has to cover.
"""
import json, os, shutil, stat, subprocess, sys, tempfile
from pathlib import Path

checkout, dest = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
here = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="gg-vendor-"))
agent = tmp / "agent"
agent.write_text('#!/usr/bin/env python3\nimport json\nprint(json.dumps({"type":"result","result":"ID: sc_1\\nProperty: p\\nRationale: fine.\\nVerdict: yes\\n\\nID: extra\\nProperty: p\\nRationale: fine.\\nVerdict: yes"}))\n')
agent.chmod(agent.stat().st_mode | stat.S_IEXEC)
probe = tmp / "probe.py"
probe.write_text(f'''
import sys, json, io, os
sys.argv = ["cli.py", "--adk", {str(checkout / "src")!r}]
sys.stdin = io.StringIO(json.dumps({{"user_query": "Add x", "items": [{{"id": "sc_1", "text": "x exists"}}],
  "conversation": [{{"role": "assistant", "content": "", "tool_calls": "edit_file(path=\\"a\\")"}}, {{"role": "tool", "content": "ok", "tool_calls": None}}], "report": "done"}}))
sys.path.insert(0, {str(here)!r})
from cgg_evaluator import cli
real = sys.stdout; sys.stdout = io.StringIO(); cli.main(sys.argv[1:]); out = sys.stdout.getvalue(); sys.stdout = real
mods = sorted(set(getattr(m, "__file__", None) or "" for m in list(sys.modules.values())))
print(json.dumps({{"out": json.loads(out), "files": [f for f in mods if f]}}))
''')
r = subprocess.run([sys.executable, str(probe)], capture_output=True, text=True, env={**os.environ, "GOAL_GUARDIAN_REVIEWER": str(agent)})
data = json.loads(r.stdout.strip().splitlines()[-1])
assert data["out"]["ran"], data["out"]
src = checkout / "src"
adk_files = sorted(f for f in data["files"] if f.startswith(str(src) + os.sep))
shutil.rmtree(dest, ignore_errors=True)
for f in adk_files:
    rel = Path(f).relative_to(checkout)
    (dest / rel).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(f, dest / rel)
for name in ("LICENSE", "README.md"):
    shutil.copyfile(checkout / name, dest / name)
commit = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
(dest / "VENDORED.md").write_text(f"""# third_party/adk-python

Files from Google's Agent Development Kit, https://github.com/google/adk-python, commit {commit[:7]}, Apache-2.0
(see LICENSE). Every file here except this note is upstream's own, byte for byte, at its upstream path.

Kept: LICENSE, README.md, and the {len(adk_files)} files under `src/google/adk` that are loaded when
`google.adk.evaluation.rubric_based_multi_turn_trajectory_evaluator.RubricBasedMultiTurnTrajectoryEvaluator` judges a
run through Guardian's adapter (`packages/evaluator`). `packages/evaluator/tools/vendor.py` finds them by running the
evaluator once and copies them from a checkout.

Left out, because that run doesn't load them: the rest of ADK (agent runtime pieces it never imports, the CLI and web
UI, other evaluators such as the ones that call Vertex AI's hosted evaluation, tests, samples and docs).

ADK's own dependencies are not copied here: they are pinned in `packages/evaluator/requirements.txt` and installed as
wheels when the extension is packaged.
""")
others = sorted({Path(f).parts[Path(f).parts.index("site-packages") + 1] for f in data["files"] if "site-packages" in Path(f).parts})
print(json.dumps({"commit": commit, "adk_files": len(adk_files), "other_packages": others}))
