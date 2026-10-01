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
import run  # noqa: E402
from stats import bootstrap, mcnemar_exact, mean, percentile, wilson  # noqa: E402


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
        {"id": "a", "needs_previous": True, "previous": {"chars": 1000}},
        {"id": "b", "needs_previous": False, "previous": {"chars": 4000}},
        {"id": "c", "needs_previous": False, "previous": {"chars": 2000}},
    ]

    def test_only_correct_drops_count_as_gain(self):
        prob = {"a": 0.1, "b": 0.2, "c": 0.9}
        self.assertEqual(run.saved(continuity, self.cases, prob, 0.5), [0.0, 4000.0, 0.0])
        m = run.confusion(continuity, self.cases, prob, 0.5)
        self.assertEqual(m, {"tp": 0, "fn": 1, "tn": 1, "fp": 1, "missing": 0})

    def test_tuning_never_trades_recall_for_gain(self):
        prob = {"a": 0.3, "b": 0.2, "c": 0.4}
        # Dropping c (0.4) would also drop a (0.3), so full recall allows dropping only b.
        threshold = run.tune(continuity, self.cases, prob, 1.0)
        self.assertEqual(run.saved(continuity, self.cases, prob, threshold), [0.0, 4000.0, 0.0])

    def test_a_missing_answer_keeps_the_context(self):
        m = run.confusion(continuity, self.cases, {"b": 0.0}, 0.5)
        self.assertEqual(m["missing"], 2)
        self.assertEqual(run.saved(continuity, self.cases, {}, 0.5), [0.0, 0.0, 0.0])


class Fixtures(unittest.TestCase):
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
    def test_route_needs_agreement_and_confidence(self):
        self.assertEqual(routing.route([("email", 0.9), ("email", 0.8)], 0.8), "email")
        self.assertEqual(routing.route([("email", 0.9), ("parcels", 0.9)], 0.5), "chief")
        self.assertEqual(routing.route([("email", 0.6)], 0.8), "chief")
        self.assertEqual(routing.route([("chief", 0.99)], 0.1), "chief")
        self.assertEqual(routing.route(None, 0.0), "chief")

    def test_tuning_keeps_precision(self):
        cases = [
            {"id": "a", "gold": "email"},
            {"id": "b", "gold": "chief"},
            {"id": "c", "gold": "parcels"},
        ]
        decided = {"a": [("email", 0.9)], "b": [("email", 0.6)], "c": [("parcels", 0.7)]}
        threshold = routing._tune(cases, decided, 1.0)
        routed, correct, _ = routing._score(cases, decided, threshold)
        self.assertEqual((routed, correct), (2, 2))

    def test_options_come_from_the_core_plugin_plus_chief(self):
        self.assertIn("email", routing.OPTIONS)
        self.assertIn("research", routing.OPTIONS)
        self.assertIn("chief", routing.OPTIONS)
        gold = {c["gold"] for c in json.loads((HERE / "fixtures" / "routing.json").read_text(encoding="utf-8"))}
        self.assertTrue(gold <= set(routing.OPTIONS))


if __name__ == "__main__":
    unittest.main()
