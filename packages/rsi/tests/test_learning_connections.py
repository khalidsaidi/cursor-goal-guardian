"""Specific feedback and replay reuse: local fixtures, no model requests."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

DOMAIN = Path(__file__).resolve().parent.parent / "cgg"
def load(name):
    spec = importlib.util.spec_from_file_location("test_" + name, DOMAIN / (name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

class ConnectionsTest(unittest.TestCase):
    def setUp(self):
        self.generate = unittest.mock.Mock()
        with patch.dict(sys.modules, {"cursor_llm": types.SimpleNamespace(generate=self.generate)}):
            self.feedback = load("feedback")
        self.cache = load("replay_cache")
        self.task = {"feedback": [{"key": "useful", "finding": "Missing public export", "label": "right"},
                                   {"key": "nit", "finding": "Reject formatting", "label": "wrong"}]}

    def test_unrelated_flag_does_not_preserve_a_useful_catch(self):
        self.generate.return_value = json.dumps({"matches": [{"key": "useful", "present": False}, {"key": "nit", "present": False}]})
        replay = {"fails": [{"id": "same_item", "evidence": "different complaint"}]}
        replay["feedback_matches"] = self.feedback.matches(self.task, replay)
        self.assertEqual(replay["feedback_matches"]["useful"], False)
        self.assertLess(self.feedback.satisfaction(self.task, replay), 1)
        prompt = self.generate.call_args.args[0]
        supplied = json.loads(prompt.split("INPUT_DATA_JSON:")[1])
        self.assertNotIn("label", supplied["reference_issues"][0])

    def test_rejected_complaint_can_disappear_while_real_defect_remains(self):
        self.generate.return_value = {"matches": [{"key": "useful", "present": True}, {"key": "nit", "present": False}]}
        replay = {"fails": [{"id": "export", "evidence": "public function still absent"}], "flagged": True}
        replay["feedback_matches"] = self.feedback.matches(self.task, replay)
        self.assertEqual(self.feedback.satisfaction(self.task, replay), 1)

    def test_ambiguous_missing_or_duplicate_match_cannot_qualify(self):
        for response in [{}, {"matches": [{"key": "useful", "present": None}]},
                         {"matches": [{"key": "useful", "present": True}, {"key": "useful", "present": True}]}]:
            self.generate.return_value = response
            replay = {"fails": [{"id": "x", "evidence": "uncertain"}]}
            replay["feedback_matches"] = self.feedback.matches(self.task, replay)
            self.assertIsNone(self.feedback.satisfaction(self.task, replay))

    def test_exact_match_and_silence_need_no_judgment(self):
        task = {"feedback": [{"key": "x", "finding": "Reviewer: api isn't done: no export", "label": "right"}]}
        self.assertEqual(self.feedback.matches(task, {"fails": [{"id": "api", "evidence": "no export"}]}), {"x": True})
        self.assertEqual(self.feedback.matches(task, {}), {"x": False})
        self.generate.assert_not_called()

    def test_issue_identity_cache_survives_label_changes(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"CGG_FEEDBACK_CACHE": directory, "CGG_REPLAY_VERSION": "v1"}):
            self.generate.return_value = {"matches": [{"key": "useful", "present": True}, {"key": "nit", "present": False}]}
            replay = {"fails": [{"id": "x", "evidence": "another wording"}]}
            first = self.feedback.matches(self.task, replay)
            self.task["feedback"][0]["label"] = "wrong"
            self.assertEqual(first, self.feedback.matches(self.task, replay))
            self.assertEqual(self.generate.call_count, 1)
            with patch.dict(os.environ, {"CGG_REPLAY_VERSION": "v2"}):
                self.feedback.matches(self.task, replay)
            self.assertEqual(self.generate.call_count, 2)

    def test_replay_cache_reuses_observations_but_not_labels_or_incomplete_results(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"CGG_WORKSPACE": directory, "CGG_REPLAY_CACHE": directory + "/cache", "CGG_REPLAY_VERSION": "v1"}):
            case = Path(directory) / ".cursor/goal-guardian/cases/a"
            case.mkdir(parents=True)
            for name in ["case.json", "work.patch", "untracked.json"]:
                (case / name).write_text("original")
            prompt = Path(directory) / "prompt.md"
            prompt.write_text("original prompt")
            key = self.cache.entry({"case": "a", "label": "right"}, prompt)
            self.cache.save(key, {"ran": True, "flagged": True, "fails": [], "label": "right", "feedback_matches": {"x": True}})
            self.assertNotIn("label", self.cache.load(key))
            self.assertNotIn("feedback_matches", self.cache.load(key))
            self.assertEqual(key, self.cache.entry({"case": "a", "label": "wrong"}, prompt))
            prompt.write_text("changed prompt")
            self.assertNotEqual(key, self.cache.entry({"case": "a"}, prompt))
            incomplete = Path(directory) / "incomplete.json"
            self.cache.save(incomplete, {"ran": True, "flagged": None})
            self.assertIsNone(self.cache.load(incomplete))
            self.cache.save(incomplete, {"ran": True, "flagged": False, "unanswered": ["behavior"]})
            self.assertIsNone(self.cache.load(incomplete))
