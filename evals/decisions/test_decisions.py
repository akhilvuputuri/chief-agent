"""Offline tests for the decision harness: statistics, scoring and fixtures. No network."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import continuity  # noqa: E402
import routing  # noqa: E402
from stats import bootstrap, cluster_bootstrap, mcnemar_exact, mean, percentile, wilson  # noqa: E402


class Stats(unittest.TestCase):
    def test_mcnemar_exact(self):
        self.assertEqual(mcnemar_exact(0, 0), 1.0)
        # 10 discordant pairs all one way: 2 * 0.5^10.
        self.assertAlmostEqual(mcnemar_exact(10, 0), 2 / 1024)
        self.assertAlmostEqual(mcnemar_exact(3, 3), 1.0)
        self.assertAlmostEqual(mcnemar_exact(1, 5), mcnemar_exact(5, 1))

    def test_wilson_is_bounded_and_contains_the_estimate(self):
        low, high = wilson(48, 48)
        self.assertAlmostEqual(high, 1.0)
        self.assertGreater(low, 0.9)
        low, high = wilson(0, 20)
        self.assertEqual(low, 0.0)
        low, high = wilson(30, 60)
        self.assertLess(low, 0.5)
        self.assertGreater(high, 0.5)
        self.assertIsNone(wilson(0, 0))

    def test_bootstrap_is_reproducible_and_brackets_the_mean(self):
        values = [0, 0, 100, 200, 0, 50, 0, 300]
        self.assertEqual(bootstrap(values, mean), bootstrap(values, mean))
        low, high = bootstrap(values, mean)
        self.assertLessEqual(low, mean(values))
        self.assertGreaterEqual(high, mean(values))

    def test_percentile_nearest_rank(self):
        self.assertEqual(percentile([5, 1, 3, 2, 4], 0.5), 3)
        self.assertEqual(percentile([5, 1, 3, 2, 4], 0.95), 5)
        self.assertIsNone(percentile([], 0.5))


class Scoring(unittest.TestCase):
    cases = [
        {"id": "a", "needs_previous": True, "previous": {"chars": 1000}, "prior_index": 0},
        {"id": "b", "needs_previous": False, "previous": {"chars": 4000}, "prior_index": 0},
        {"id": "c", "needs_previous": False, "previous": {"chars": 2000}, "prior_index": 1},
    ]

    def calls(self, probs):
        records = [
            {"id": k, "run": 0, "probability": v, "error": None if v is not None else "x"}
            for k, v in probs.items()
        ]
        return continuity._calls(records, self.cases)

    def test_only_correct_drops_count_as_gain(self):
        calls = self.calls({"a": 0.1, "b": 0.2, "c": 0.9})
        self.assertEqual(continuity._saved(calls, 0.5), [0.0, 4000.0, 0.0])
        self.assertEqual(continuity._recall(calls, 0.5), 0.0)

    def test_tuning_never_trades_recall_for_gain(self):
        calls = self.calls({"a": 0.3, "b": 0.2, "c": 0.4})
        # Dropping c (0.4) would also drop a (0.3), so full recall allows dropping only b.
        t = continuity._tune(calls, 1.0)
        self.assertEqual(continuity._saved(calls, t), [0.0, 4000.0, 0.0])

    def test_a_failed_call_keeps_the_context(self):
        calls = self.calls({"a": None, "b": None, "c": 0.0})
        self.assertEqual([c["p"] for c in calls], [1.0, 1.0, 0.0])
        self.assertEqual(continuity._recall(calls, 0.5), 1.0)

    def test_cluster_bootstrap_resamples_whole_groups(self):
        items = [{"g": 0, "v": 1.0}, {"g": 0, "v": 1.0}, {"g": 1, "v": 0.0}]
        low, high = cluster_bootstrap(items, lambda x: x["g"], lambda s: mean([x["v"] for x in s]))
        # Only three group mixes are possible: all of group 0, all of group 1, or both.
        self.assertEqual((low, high), (0.0, 1.0))
        self.assertIsNone(cluster_bootstrap([], lambda x: x, mean))


class Fixtures(unittest.TestCase):
    def test_no_message_appears_in_both_continuity_splits(self):
        cases = json.loads((HERE / "fixtures" / "continuity.json").read_text(encoding="utf-8"))
        tuning = {c["message"] for c in cases if c["split"] == "tuning"}
        held = {c["message"] for c in cases if c["split"] == "held-out"}
        self.assertEqual(tuning & held, set())

    def test_continuity_fixture_is_balanced_and_split_by_conversation(self):
        cases = json.loads((HERE / "fixtures" / "continuity.json").read_text(encoding="utf-8"))
        self.assertEqual(len({c["id"] for c in cases}), len(cases))
        splits: dict[int, set[str]] = {}
        for c in cases:
            splits.setdefault(c["prior_index"], set()).add(c["split"])
        self.assertTrue(all(len(s) == 1 for s in splits.values()))
        for split in ("tuning", "held-out"):
            labels = [c["needs_previous"] for c in cases if c["split"] == split]
            self.assertEqual(labels.count(True), labels.count(False))

    def test_rule_baseline_flags_obvious_follow_ups(self):
        follow = {"message": "and the other one?", "previous": {"user": "", "assistant": "", "chars": 1}}
        fresh = {"message": "what's the weather in Singapore tomorrow?", "previous": {"user": "", "assistant": "", "chars": 1}}
        self.assertEqual(continuity.rule(follow)["probability"], 1.0)
        self.assertEqual(continuity.rule(fresh)["probability"], 0.0)


class Routing(unittest.TestCase):
    def call(self, agent, confidence, gold="email", case="a", run=0):
        return {"id": case, "run": run, "gold": gold, "agent": agent, "confidence": confidence}

    def test_one_call_routes_only_above_the_threshold(self):
        self.assertEqual(routing.route(self.call("email", 0.9), 0.8), "email")
        self.assertEqual(routing.route(self.call("email", 0.6), 0.8), "chief")
        self.assertEqual(routing.route(self.call("chief", 0.99), 0.1), "chief")

    def test_a_failed_call_goes_to_chief(self):
        calls = routing._calls(
            [{"id": "a", "run": 0, "agent": None, "confidence": None, "error": "HTTP 500"}],
            [{"id": "a", "gold": "email"}],
        )
        self.assertEqual(routing.route(calls[0], 0.0), "chief")

    def test_tuning_keeps_precision_and_prefers_the_higher_tie(self):
        calls = [
            self.call("email", 0.9, "email", "a"),
            self.call("email", 0.6, "chief", "b"),
            self.call("parcels", 0.7, "parcels", "c"),
        ]
        t = routing._tune(calls, 1.0)
        self.assertEqual(t, 0.7)
        self.assertEqual(routing._precision(calls, t), 1.0)

    def test_options_come_from_the_core_plugin_plus_chief(self):
        self.assertIn("email", routing.OPTIONS)
        self.assertIn("research", routing.OPTIONS)
        self.assertIn("chief", routing.OPTIONS)
        gold = {c["gold"] for c in json.loads((HERE / "fixtures" / "routing.json").read_text(encoding="utf-8"))}
        self.assertTrue(gold <= set(routing.OPTIONS))


if __name__ == "__main__":
    unittest.main()
