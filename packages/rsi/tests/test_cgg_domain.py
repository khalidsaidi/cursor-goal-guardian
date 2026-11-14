"""Guardian's RRSI domain against a temp checkout, fake cases and a fake cursor-agent. Run: python3 -m unittest."""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
RRSI = REPO / "third_party" / "rrsi"
DOMAIN = HERE.parent / "cgg"

FAKE_AGENT = r"""#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
p = a[a.index("-p") + 1]
ws = a[a.index("--workspace") + 1]
if p.startswith("Read task.md"):
    p = open(os.path.join(ws, "task.md")).read()
open(os.environ["FAKE_LOG"], "a").write(json.dumps({"len": len(p), "mode": a[a.index("--mode") + 1] if "--mode" in a else None}) + "\n")
print(json.dumps({"type": "result", "result": json.dumps({"echo": p[-40:]})}))
"""

FAKE_REPLAY = r"""#!/usr/bin/env python3
import json, sys
ws, case, prompt = sys.argv[1:4]
print(json.dumps({"ran": True, "flagged": "QUIET" not in open(prompt).read(), "fails": [], "extra": []}))
"""


def executable(path: Path, text: str) -> Path:
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


class CggDomainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gg-rsi-test-"))
        self.repo = self.tmp / "repo"
        shutil.copytree(RRSI, self.repo, ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(DOMAIN, self.repo / "domains" / "cgg", ignore=shutil.ignore_patterns("__pycache__"))
        d = self.repo / "domains" / "cgg"
        (d / "data").mkdir()
        (d / "data" / "tasks.json").write_text(json.dumps([
            {"id": "a", "case": "a", "label": "right", "split": "evolve"},
            {"id": "b", "case": "b", "label": "wrong", "split": "evolve"},
            {"id": "c", "case": "c", "label": "wrong", "split": "heldout"},
        ]))
        (d / "data" / "leak_terms.json").write_text(json.dumps(["exportCsv", "src/util.js", "ab"]))
        (d / "harness").mkdir()
        (d / "harness" / "reviewer.md").write_text("Goal {goal}\nItems {items}\nAnswer in JSON.")
        self.log = self.tmp / "agent.log"
        os.environ["GOAL_GUARDIAN_REVIEWER"] = str(executable(self.tmp / "agent", FAKE_AGENT))
        os.environ["FAKE_LOG"] = str(self.log)
        os.environ["CGG_WORKSPACE"] = str(self.tmp)
        os.environ["CGG_REPLAY"] = json.dumps([sys.executable, str(executable(self.tmp / "replay", FAKE_REPLAY))])
        sys.path[:0] = [str(self.repo)]
        for m in [m for m in sys.modules if m.startswith(("rrsi", "domains", "adapter", "cursor_llm", "briefs", "feedback", "replay_cache", "model_budget"))]:
            del sys.modules[m]
        from rrsi.domain import load_domain
        self.dom = load_domain("cgg")

    def tearDown(self):
        sys.path.remove(str(self.repo))
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_splits_and_smoke_ids(self):
        self.assertEqual(sorted(self.dom.evolve_ids()), ["a", "b"])
        self.assertEqual(self.dom.heldout_ids(), ["c"])
        self.assertEqual(sorted(self.dom.smoke_ids()), ["a", "b"])

    def test_run_and_score_weigh_a_wrong_flag_double(self):
        runs = self.tmp / "runs"
        self.dom.run(self.repo, runs, "j", ["a", "b"], 1)
        per, counts = self.dom.score(runs, "j", ["a", "b"], 1)
        self.assertEqual(per["a"].rewards, [1.0])   # right to object, flagged
        self.assertEqual(per["b"].rewards, [0.0])   # wrong to object, flagged
        self.assertEqual(per["b"].weights, [2.0])
        self.assertEqual(counts, {"right": 1, "right_caught": 1, "wrong": 1, "wrong_flagged": 1})
        (self.repo / "domains" / "cgg" / "harness" / "reviewer.md").write_text("Goal {goal}\nItems {items}\nQUIET")
        self.dom.run(self.repo, runs, "k", ["b"], 1)
        self.assertEqual(self.dom.score(runs, "k", ["b"], 1)[0]["b"].rewards, [1.0])

    def test_leak_screen_names_case_terms_only(self):
        reasons = [r for _, r in self.dom.critic_patterns]
        self.assertTrue(any("exportCsv" in r for r in reasons))
        self.assertFalse(any("'ab'" in r for r in reasons))

    def test_search_calls_go_to_cursor_agent_with_long_prompts_by_file(self):
        import rrsi.llm as llm
        import rrsi.propose as propose
        self.assertIs(llm.generate, propose.generate)
        self.assertEqual(json.loads(llm.generate("short", json_only=True))["echo"][-5:], "fences."[-5:])
        long = "x" * 30_000 + "THE END"
        out = llm.generate(long, system="sys")
        self.assertIn("THE END", out)
        calls = [json.loads(l) for l in self.log.read_text().splitlines()]
        self.assertEqual([c["mode"] for c in calls], ["ask", "ask"])
        self.assertGreater(calls[1]["len"], 30_000)

    def test_smoke_rejects_a_reviewer_that_lost_its_placeholders(self):
        (self.repo / "domains" / "cgg" / "harness" / "reviewer.md").write_text("no placeholders")
        ok, detail = self.dom.smoke(self.repo, self.tmp / "runs", "smoke", ["a"])
        self.assertFalse(ok)
        self.assertEqual(detail["stage"], "template")


if __name__ == "__main__":
    unittest.main()
