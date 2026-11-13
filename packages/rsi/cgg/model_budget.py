"""A shared model-call allowance for one background learning run, across RRSI roles and replays."""
import json
import os
import time
from pathlib import Path


def reserve_call():
    name = os.environ.get("CGG_MODEL_BUDGET")
    if not name:
        return
    budget = Path(name)
    lock = Path(name + ".lock")
    started = time.monotonic()
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            if time.monotonic() - started > 5:
                raise RuntimeError("background learning budget is busy")
            time.sleep(0.01)
    try:
        data = json.loads(budget.read_text())
        if data["used"] >= data["limit"]:
            data["exhausted"] = True
            budget.write_text(json.dumps(data))
            raise RuntimeError("background learning reached its model-call limit")
        data["used"] += 1
        budget.write_text(json.dumps(data))
    finally:
        lock.rmdir()
