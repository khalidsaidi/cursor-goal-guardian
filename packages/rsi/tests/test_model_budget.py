"""The background call allowance is shared by concurrent RRSI workers; no model is contacted."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DOMAIN = Path(__file__).resolve().parent.parent / "cgg"

class BudgetTest(unittest.TestCase):
    def test_workers_share_one_allowance(self):
        with tempfile.TemporaryDirectory() as directory:
            budget = Path(directory) / "budget.json"
            budget.write_text(json.dumps({"limit": 3, "used": 0, "exhausted": False}))
            code = "from model_budget import reserve_call\ntry:\n reserve_call(); print('reserved')\nexcept RuntimeError:\n print('blocked')"
            env = {**os.environ, "CGG_MODEL_BUDGET": str(budget), "PYTHONPATH": str(DOMAIN)}
            def run(_):
                return subprocess.check_output([sys.executable, "-c", code], env=env, text=True).strip()
            with ThreadPoolExecutor(max_workers=6) as pool:
                answers = list(pool.map(run, range(12)))
            self.assertEqual(answers.count("reserved"), 3)
            self.assertEqual(json.loads(budget.read_text()), {"limit": 3, "used": 3, "exhausted": True})

    def test_daily_allowance_survives_new_attempt_and_recovers_dead_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            day = Path(directory) / "daily.json"
            day.write_text(json.dumps({"limit": 2, "used": 0}))
            env = {**os.environ, "CGG_DAILY_MODEL_BUDGET": str(day), "PYTHONPATH": str(DOMAIN)}
            code = "from model_budget import reserve_call; reserve_call()"
            first = Path(directory) / "first.json"
            first.write_text(json.dumps({"limit": 10, "used": 0}))
            env["CGG_MODEL_BUDGET"] = str(first)
            lock = Path(str(first) + ".lock")
            lock.mkdir()
            (lock / "owner").write_text("2147483647")
            subprocess.check_call([sys.executable, "-c", code], env=env)
            second = Path(directory) / "second.json"
            second.write_text(json.dumps({"limit": 10, "used": 0}))
            env["CGG_MODEL_BUDGET"] = str(second)
            subprocess.check_call([sys.executable, "-c", code], env=env)
            blocked = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True)
            self.assertNotEqual(blocked.returncode, 0)
            self.assertEqual(json.loads(day.read_text())["used"], 2)
            self.assertEqual(json.loads(second.read_text())["used"], 1)
            self.assertTrue(json.loads(second.read_text())["daily_exhausted"])

if __name__ == "__main__":
    unittest.main()
