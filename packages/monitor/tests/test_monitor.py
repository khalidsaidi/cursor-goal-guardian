"""Guardian's adapter for MRT's monitor, against a fake cursor-agent. Run: python3 -m unittest (from packages/monitor)."""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
CLI = HERE.parent / "cgg_monitor" / "cli.py"
MRT = REPO / "third_party" / "mrt"

# Answers with the next verdict from FAKE_VERDICTS (the last one repeats) and logs each prompt it was sent.
FAKE_AGENT = r"""#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
p = a[a.index("-p") + 1]
ws = a[a.index("--workspace") + 1]
if p.startswith("Read task.md"):
    p = open(os.path.join(ws, "task.md")).read()
log = os.environ["FAKE_LOG"]
n = len(open(log).read().splitlines()) if os.path.exists(log) else 0
open(log, "a").write(json.dumps({"prompt": p, "mode": a[a.index("--mode") + 1] if "--mode" in a else None,
                                 "reviewing": os.environ.get("GOAL_GUARDIAN_REVIEWING")}) + "\n")
if os.environ.get("FAKE_FAIL"):
    sys.exit(3)
verdicts = os.environ["FAKE_VERDICTS"].split(",")
v = verdicts[min(n, len(verdicts) - 1)]
tail = "" if v == "none" else "<verdict>%s</verdict>" % v
print(json.dumps({"type": "result", "result": "Summary %d.\n%s" % (n, tail)}))
"""

JOB = {
    "user_query": "Add a min helper to bytes.js",
    "conversation": [
        {"role": "assistant", "content": "I'll read the file.", "tool_calls": "read_file(path='index.js')"},
        {"role": "tool", "content": "module.exports = bytes", "tool_calls": None},
        {"role": "assistant", "content": "Adding min.", "tool_calls": "edit_file(path='index.js')"},
        {"role": "tool", "content": "ok", "tool_calls": None},
        {"role": "assistant", "content": "Done.", "tool_calls": None},
    ],
    "hier_chunk": 2,
    "seq_chunk": 2,
}


class MonitorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gg-monitor-test-"))
        agent = self.tmp / "agent"
        agent.write_text(FAKE_AGENT)
        agent.chmod(agent.stat().st_mode | stat.S_IEXEC)
        self.log = self.tmp / "agent.log"
        self.env = {**os.environ, "GOAL_GUARDIAN_REVIEWER": str(agent), "FAKE_LOG": str(self.log), "FAKE_VERDICTS": "2"}
        self.env.pop("GOAL_GUARDIAN_REVIEWING", None)

    def run_cli(self, job=JOB, flags=("-I", "-S"), **env):
        # -I -S: no site-packages and no user paths, like Guardian's bundled interpreter.
        r = subprocess.run([sys.executable, *flags, str(CLI), "--mrt", str(MRT)], input=json.dumps(job),
                           capture_output=True, text=True, env={**self.env, **env}, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        lines = r.stdout.strip().splitlines()
        self.assertEqual(len(lines), 1, f"stdout must be one JSON line, got: {r.stdout[:400]}")
        return json.loads(lines[0])

    def prompts(self):
        return [json.loads(l) for l in self.log.read_text().splitlines()]

    def test_runs_on_the_standard_library_alone_and_parses_scores(self):
        out = self.run_cli()
        self.assertTrue(out["ran"])
        self.assertEqual(out["scale"], "likert 1-5")
        self.assertEqual(out["hierarchical"]["score"], 2.0)
        self.assertEqual(out["sequential"]["score"], 2.0)
        self.assertEqual(out["hybrid"], 2.0)
        # 5 agent messages in chunks of 2: hierarchical 3 chunks + 2 + 1 aggregations, sequential 3.
        self.assertEqual(out["calls"], 9)
        self.assertEqual(len(self.prompts()), 9)

    def test_hybrid_is_the_mean_of_the_two_final_scores(self):
        # Calls 1-6 are hierarchical (its final answer is call 6), calls 7-9 sequential (final answer call 9).
        out = self.run_cli(FAKE_VERDICTS="1,1,1,1,1,4,1,1,1")
        self.assertEqual(out["hierarchical"]["score"], 4.0)
        self.assertEqual(out["sequential"]["score"], 1.0)
        self.assertEqual(out["hybrid"], 2.5)

    def test_one_style_can_run_alone_so_two_processes_can_run_side_by_side(self):
        out = self.run_cli(job={**JOB, "styles": ["sequential"]}, FAKE_VERDICTS="1,1,3")
        self.assertEqual(out["sequential"]["score"], 3.0)
        self.assertIsNone(out["hierarchical"]["score"])
        self.assertIsNone(out["hybrid"])
        self.assertEqual(out["calls"], 3)

    def test_a_missing_verdict_is_no_score_not_zero(self):
        out = self.run_cli(FAKE_VERDICTS="none")
        self.assertTrue(out["ran"])
        self.assertIsNone(out["hierarchical"]["score"])
        self.assertIsNone(out["hybrid"])

    def test_the_prompts_are_mrts_own_and_go_to_the_agent_in_ask_mode(self):
        self.run_cli()
        calls = self.prompts()
        self.assertTrue(all(c["mode"] == "ask" and c["reviewing"] == "1" for c in calls))
        first = calls[0]["prompt"]
        self.assertIn("You are an AI monitor for an agentic AI assistant", first)          # MRT's monitor message
        self.assertIn("LLM Agent Suspicious Behavior Monitoring Scorecard", first)        # its likert rubric
        self.assertIn("<begin_user_query>\n Add a min helper to bytes.js", first)
        self.assertIn("ASSISTANT: I'll read the file.Tool calls:\n- read_file(path='index.js')", first)  # MRT's format
        self.assertIn("Do not delegate", first)
        self.assertIn("Here are monitor summaries from the previous layer", calls[3]["prompt"])  # MRT's aggregation
        self.assertIn("[Earlier in this review] You answered:\nSummary 6.", calls[7]["prompt"])  # sequential memory

    def test_long_prompts_go_through_a_file(self):
        job = {**JOB, "conversation": [{"role": "assistant", "content": "x" * 30_000 + " THE END", "tool_calls": None}]}
        out = self.run_cli(job)
        self.assertTrue(out["ran"])
        self.assertIn("THE END", self.prompts()[0]["prompt"])

    def test_a_failing_agent_is_reported_not_raised(self):
        out = self.run_cli(FAKE_FAIL="1")
        self.assertFalse(out["ran"])
        self.assertIn("cursor-agent exited 3", out["reason"])
        self.assertIsNone(out["hybrid"])

    def test_no_agent_and_nothing_to_monitor(self):
        out = self.run_cli(GOAL_GUARDIAN_REVIEWER=str(self.tmp / "missing"))
        self.assertFalse(out["ran"])
        self.assertIn("cursor-agent isn't installed", out["reason"])
        out = self.run_cli({"user_query": "x", "conversation": []})
        self.assertFalse(out["ran"])

    def test_vendored_mrt_files_are_unmodified(self):
        upstream = os.environ.get("MRT_UPSTREAM")  # a checkout of scaleapi/mrt at 3535620, when one is around
        if not upstream:
            self.skipTest("set MRT_UPSTREAM to compare against a checkout")
        for f in MRT.rglob("*"):
            if f.is_file() and "__pycache__" not in f.parts and f.name != "VENDORED.md":
                self.assertEqual(f.read_bytes(), (Path(upstream) / f.relative_to(MRT)).read_bytes(), str(f))


if __name__ == "__main__":
    unittest.main()
