"""Atomic shared allowances across one learning attempt and its workspace's daily automatic-learning window."""
import json
import os
import time
from pathlib import Path


def _write(file, data):
    temporary = file.with_suffix(file.suffix + ".tmp-" + str(os.getpid()))
    temporary.write_text(json.dumps(data))
    temporary.replace(file)


def _lock(file):
    lock = Path(str(file) + ".lock")
    started = time.monotonic()
    while True:
        try:
            lock.mkdir()
            (lock / "owner").write_text(str(os.getpid()))
            return lock
        except FileExistsError:
            try:
                owner = lock / "owner"
                pid = int(owner.read_text()) if owner.exists() else None
                dead = False
                if pid:
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        dead = True
                    except PermissionError:
                        pass
                elif time.time() - lock.stat().st_mtime > 1:
                    dead = True
                if dead:
                    owner.unlink(missing_ok=True)
                    lock.rmdir()
                    continue
            except (OSError, ValueError):
                pass
            if time.monotonic() - started > 5:
                raise RuntimeError("background learning budget is busy")
            time.sleep(0.01)


def reserve_call():
    name = os.environ.get("CGG_MODEL_BUDGET")
    if not name:
        return
    budget = Path(name)
    daily = Path(os.environ["CGG_DAILY_MODEL_BUDGET"]) if os.environ.get("CGG_DAILY_MODEL_BUDGET") else None
    locks = []
    try:
        for file in sorted({budget, *([daily] if daily else [])}, key=str):
            locks.append(_lock(file))
        data = json.loads(budget.read_text())
        day = json.loads(daily.read_text()) if daily else None
        if data["used"] >= data["limit"] or (day and day["used"] >= day["limit"]):
            data["exhausted"] = True
            if day and day["used"] >= day["limit"]:
                data["daily_exhausted"] = True
            _write(budget, data)
            raise RuntimeError("background learning reached its model-call allowance")
        data["used"] += 1
        _write(budget, data)
        if day is not None:
            day["used"] += 1
            _write(daily, day)
    finally:
        for lock in reversed(locks):
            (lock / "owner").unlink(missing_ok=True)
            lock.rmdir()
