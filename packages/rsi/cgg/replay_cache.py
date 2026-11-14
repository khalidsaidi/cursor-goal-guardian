"""Only complete observations are reused; feedback labels are deliberately excluded from this key."""
import hashlib
import json
import os
import uuid
from pathlib import Path


def entry(task, prompt):
    directory = os.environ.get("CGG_REPLAY_CACHE")
    version = os.environ.get("CGG_REPLAY_VERSION")
    if not directory or not version:
        return None
    case = Path(os.environ["CGG_WORKSPACE"]) / ".cursor" / "goal-guardian" / "cases" / task["case"]
    digest = hashlib.sha256(version.encode())
    for file in [case / "case.json", case / "work.patch", case / "untracked.json", prompt]:
        try:
            digest.update(file.read_bytes())
        except OSError:
            return None
    return Path(directory) / (digest.hexdigest() + ".json")


def load(file):
    if file and file.exists():
        try:
            record = json.loads(file.read_text())
            if record.get("ran") and not record.get("unanswered") and isinstance(record.get("flagged"), bool):
                return record
        except (OSError, ValueError):
            pass
    return None


def save(file, record):
    if not file or not record.get("ran") or record.get("unanswered") or not isinstance(record.get("flagged"), bool):
        return
    file.parent.mkdir(parents=True, exist_ok=True)
    clean = {k:v for k,v in record.items() if k not in ("feedback_matches", "feedback", "task_id", "label", "trial")}
    temporary = file.with_suffix(".tmp-" + uuid.uuid4().hex)
    temporary.write_text(json.dumps(clean))
    temporary.replace(file)
