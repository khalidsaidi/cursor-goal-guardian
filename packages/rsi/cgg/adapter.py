"""RRSI domain for Goal Guardian's reviewer.

Harness: harness/reviewer.md, the prompt Guardian's reviewer reads when an agent says the goal is done.
Tasks: the workspace's labelled review cases, listed by Guardian in data/tasks.json with their split
(evolve or held out, by a stable hash of the case id). Running a task replays that review with the candidate
prompt through Guardian's own binary. Rewards compare the specific findings judged by the user:
retain each useful catch and remove each rejected complaint. Other genuine defects may coexist.

Environment, set by Guardian when it starts RRSI:
  CGG_WORKSPACE   the project whose cases these are
  CGG_REPLAY      JSON list: the command that replays one review, e.g. [".../goal-guardian-hook", "replay-review"]
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent))
sys.path.insert(0, str(HERE))
from rrsi.domain import Domain          # noqa: E402
from rrsi.evaluate import TaskResult    # noqa: E402
import briefs                            # noqa: E402
import cursor_llm                        # noqa: E402
import feedback                          # noqa: E402
import replay_cache                      # noqa: E402
from model_budget import reserve_call     # noqa: E402

cursor_llm.install()

CFG = json.loads((HERE / "rrsi.json").read_text())
DATA = HERE / "data"
REPLAY_TIMEOUT_S = 300
# A flag on work that should pass is the costlier mistake: it sends a finished agent back.
WEIGHT = {"wrong": 2.0, "right": 1.0}


def _tasks() -> dict:
    p = DATA / "tasks.json"
    return {t["id"]: t for t in json.loads(p.read_text())} if p.exists() else {}


TASKS = _tasks()


def _leak_patterns() -> list:
    """Saved-case identities must not become memorized answer exceptions."""
    p = DATA / "leak_terms.json"
    terms = json.loads(p.read_text()) if p.exists() else []
    out = []
    for term in sorted(set(terms))[:200]:
        if len(term) >= 4:
            out.append((r"(?<![A-Za-z0-9_])" + re.escape(term) + r"(?![A-Za-z0-9_])", f"case-specific term {term!r}"))
    return out


def right(label: str, flagged) -> float:
    if flagged is None:
        return 0.0
    return 1.0 if bool(flagged) == (label == "right") else 0.0


class CggDomain(Domain):
    name = "cgg"
    harness_path = "harness"
    source_exts = {".md"}
    briefs = {"analyst": briefs.ANALYST, "digester": briefs.DIGESTER,
              "proposer": briefs.PROPOSER, "critic": briefs.CRITIC}
    critic_patterns = _leak_patterns()
    # RRSI's vocabulary is fixed (components.K). This domain evolves one consumed prompt file.
    component_signals = [("prompt", [r"(?m)^diff --git a/domains/cgg/harness/reviewer\.md b/domains/cgg/harness/reviewer\.md$"])]

    # ---- task sets ---------------------------------------------------------
    def evolve_ids(self):
        return [t for t, x in TASKS.items() if x["split"] == "evolve"]

    def heldout_ids(self):
        return [t for t, x in TASKS.items() if x["split"] == "heldout"]

    def smoke_ids(self, incumbent_per_task=None):
        ev = self.evolve_ids()
        picks = [next((t for t in ev if any(f["label"] == lab for f in TASKS[t].get("feedback") or [{"label": TASKS[t]["label"]}])), None) for lab in ("wrong", "right")]
        return list(dict.fromkeys(t for t in picks if t)) or ev[:1]

    # ---- Evaluate ----------------------------------------------------------
    def _one(self, root: Path, jdir: Path, tid: str, trial: int) -> None:
        out = jdir / tid / f"trial{trial}.json"
        if out.exists():
            return
        out.parent.mkdir(parents=True, exist_ok=True)
        t = TASKS[tid]
        prompt_file = self.harness_dir(root) / "reviewer.md"
        cmd = json.loads(os.environ["CGG_REPLAY"]) + [os.environ["CGG_WORKSPACE"], t["case"], str(prompt_file)]
        cache = replay_cache.entry(t, prompt_file)
        rec = replay_cache.load(cache)
        try:
            if rec is None:
                reserve_call()
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=REPLAY_TIMEOUT_S)
                rec = json.loads(r.stdout.strip().splitlines()[-1])
                if not rec.get("ran"):
                    rec["flagged"] = None
                replay_cache.save(cache, rec)
            if rec.get("ran") and isinstance(rec.get("flagged"), bool) and not rec.get("unanswered") and t.get("feedback"):
                rec["feedback_matches"] = feedback.matches(t, rec)
        except Exception as e:
            rec = {"flagged": None, "reason": str(e)[:300]}
        rec.update({"task_id": tid, "label": t["label"], "trial": trial, "feedback": t.get("feedback", [])})
        out.write_text(json.dumps(rec, indent=1))

    def run(self, root, runs_dir, job, ids, k, log_prefix=""):
        jdir = Path(runs_dir) / "jobs" / job
        jdir.mkdir(parents=True, exist_ok=True)
        work = [(t, i) for t in ids for i in range(k)]
        with ThreadPoolExecutor(max_workers=int(CFG.get("concurrency", 2))) as ex:
            list(ex.map(lambda w: self._one(Path(root), jdir, w[0], w[1]), work))

    def _rec(self, runs_dir, job, tid, trial):
        p = Path(runs_dir) / "jobs" / job / tid / f"trial{trial}.json"
        return json.loads(p.read_text()) if p.exists() else None

    def score(self, runs_dir, job, ids, k):
        per, counts = {}, {"right": 0, "right_caught": 0, "wrong": 0, "wrong_flagged": 0}
        for t in ids:
            label = TASKS[t]["label"]
            rewards, missing = [], 0
            for i in range(k):
                r = self._rec(runs_dir, job, t, i)
                if r is None or r.get("flagged") is None:
                    missing += 1
                    rewards.append(0.0)
                    continue
                judged = feedback.satisfaction(TASKS[t], r) if TASKS[t].get("feedback") else right(label, r["flagged"])
                if judged is None:
                    missing += 1
                    rewards.append(0.0)
                    continue
                rewards.append(judged)
                targets = TASKS[t].get("feedback") or []
                if targets:
                    for target in targets:
                        judged_label = target["label"]
                        counts[judged_label] += 1
                        if r["feedback_matches"].get(target["key"]) is True:
                            counts["right_caught" if judged_label == "right" else "wrong_flagged"] += 1
                else:
                    counts[label] += 1
                    if r["flagged"]:
                        counts["right_caught" if label == "right" else "wrong_flagged"] += 1
            trials = [self._rec(runs_dir, job, t, i) or {} for i in range(k)]
            targets = TASKS[t].get("feedback") or []
            weight = sum(WEIGHT[target["label"]] for target in targets) if targets else WEIGHT[label]
            per[t] = TaskResult(rewards=rewards, weights=[weight] * k, tokens=[r.get("tokens") for r in trials], missing=missing,
                                extra={"label": label, "feedback_matches": [r.get("feedback_matches") for r in trials]})
        return per, counts

    def guards(self, incumbent, candidate):
        """Use RRSI's native non-compensatory checks: average gains cannot pay for losing a useful issue."""
        violations = []
        for tid, before in incumbent.per_task.items():
            useful = [t for t in TASKS.get(tid, {}).get("feedback") or [] if t["label"] == "right"]
            if not useful:
                continue
            old = before.extra.get("feedback_matches")
            after = candidate.per_task.get(tid)
            new = after.extra.get("feedback_matches") if after else None
            if old is None:
                violations.append(f"{tid}: useful-finding attribution is missing from the reference evaluation")
                continue
            for target in useful:
                caught_before = sum(isinstance(r, dict) and r.get(target["key"]) is True for r in old) / max(1, incumbent.k)
                caught_after = sum(isinstance(r, dict) and r.get(target["key"]) is True for r in new or []) / max(1, candidate.k)
                if caught_after + 1e-12 < caught_before:
                    violations.append(f"{tid}/{target['key']}: a useful finding the current reviewer caught was lost or unclear")
        return violations

    # ---- evidence ----------------------------------------------------------
    def load_trial(self, runs_dir, job, task_id, trial):
        return self._rec(runs_dir, job, task_id, trial)

    def render_trace(self, rec, detail=False):
        if not rec:
            return "(no trial)"
        lab = rec["label"]
        want = "should be flagged: people agreed the work had a gap" if lab == "right" else \
            "should NOT be flagged: people overruled the objection"
        if rec.get("feedback"):
            want = "specific feedback targets=" + json.dumps(rec["feedback"]) + " | matched=" + json.dumps(rec.get("feedback_matches"))
        lines = [f"case {rec['task_id']} | {want}",
                 f"reviewer flagged={rec.get('flagged')} | satisfaction={feedback.satisfaction({'feedback': rec['feedback']}, rec) if rec.get('feedback') else right(lab, rec.get('flagged'))}"]
        for f in rec.get("fails") or []:
            lines.append(f"  item {f.get('id')} judged FAILS: {f.get('evidence')}")
        for x in rec.get("extra") or []:
            lines.append(f"  extra named: {x.get('file')}: {x.get('what')}")
        if rec.get("reason"):
            lines.append(f"  not run: {rec['reason']}")
        return "\n".join(lines)

    def task_row(self, task_id, rec, tr):
        return (f"{task_id} | verdict={TASKS[task_id]['label']} | rewards={tr.rewards if tr else '?'} | "
                f"flagged={rec.get('flagged') if rec else '?'}")

    def smoke(self, root, runs_dir, job, ids):
        root, runs_dir = Path(root), Path(runs_dir)
        rv = self.harness_dir(root) / "reviewer.md"
        txt = rv.read_text() if rv.exists() else ""
        miss = [p for p in ("{goal}", "{items}") if p not in txt]
        if miss:
            return False, {"stage": "template", "detail": f"reviewer.md lacks {miss}"}
        self.run(root, runs_dir, job, ids, 1)
        bad = {t: (self._rec(runs_dir, job, t, 0) or {}).get("reason") for t in ids
               if (self._rec(runs_dir, job, t, 0) or {}).get("flagged") is None}
        return (not bad), {"stage": "smoke_run", **({"unrun": bad} if bad else {"n": len(ids)})}


DOMAIN = CggDomain()
