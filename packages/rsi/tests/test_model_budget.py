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

if __name__ == "__main__":
    unittest.main()
