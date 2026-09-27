"""Offline checks of the picker contract. No network."""

from __future__ import annotations

import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from picker import (  # noqa: E402
    DOMAINS,
    build_questions,
    build_state,
    clip,
    load_config,
    pick,
    scenario_request,
)

CONFIG_PATH = HERE.parent.parent / "config" / "tool-picker.json"
CONFIG = load_config(CONFIG_PATH)
GOLDEN = HERE / "request-golden.json"


def load(name: str):
    return json.loads((HERE / name).read_text(encoding="utf-8"))


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False)


class PickTest(unittest.TestCase):
    def test_golden_cases(self) -> None:
        for case in load("pick-cases.json"):
            with self.subTest(case["name"]):
                self.assertEqual(
                    pick(case["probabilities"], CONFIG, DOMAINS), case["expected"]
                )

    def test_ignores_non_finite_bool_and_unrequested(self) -> None:
        probabilities = {
            "gmail": True,
            "calendar": math.nan,
            "daily": math.inf,
            "jobs": None,
            "work": 0.8,
            "library": 0.9,
        }
        self.assertEqual(pick(probabilities, CONFIG, DOMAINS), ["library", "work"])
        self.assertEqual(pick(probabilities, CONFIG, ["work", "gmail"]), ["work"])
        self.assertEqual(pick({}, CONFIG, DOMAINS), [])


class RequestTest(unittest.TestCase):
    scenario = {
        "id": "shape",
        "message": "and the other one? " + "😀" * 3000,
        "gold": ["gmail"],
        "split": "tuning",
        "prior": [
            {"user": "oldest", "assistant": "dropped", "tools": ["gmail_search"]},
            {"user": "𝒜" * 600, "assistant": "é" * 400, "tools": ["gmail_search"]},
            {"user": "latest", "assistant": "ok", "tools": []},
        ],
        "signals": {
            "pending_approvals": ["calendar event draft: Dentist"],
            "active_background_task": "Comparing laptops",
            "tools_used_last_hour": ["gmail_search", "calendar_list", "gmail_search"],
        },
    }

    def test_state_shape_and_clipping(self) -> None:
        state, _ = scenario_request(CONFIG, self.scenario, DOMAINS)
        limits = CONFIG["state"]
        self.assertEqual(
            list(state),
            [
                "latest_user_message",
                "previous_turns",
                "pending_approvals",
                "active_background_task",
                "tools_used_last_hour",
                "always_available",
            ],
        )
        self.assertEqual(len(state["latest_user_message"]), limits["messageChars"])
        turns = state["previous_turns"]
        self.assertEqual(len(turns), limits["previousTurns"])
        self.assertEqual([list(t) for t in turns], [["user", "assistant", "tools_used"]] * 2)
        # Astral characters count once each, as code points.
        self.assertEqual(turns[0]["user"], "𝒜" * limits["previousUserChars"])
        self.assertEqual(turns[0]["assistant"], "é" * limits["assistantChars"])
        self.assertEqual(turns[1], {"user": "latest", "assistant": "ok", "tools_used": []})
        self.assertEqual(state["pending_approvals"], ["calendar event draft: Dentist"])
        self.assertEqual(state["active_background_task"], "Comparing laptops")
        self.assertEqual(state["tools_used_last_hour"], ["gmail_search", "calendar_list"])
        self.assertEqual(state["always_available"], CONFIG["alwaysAvailable"])
        self.assertEqual(clip("a😀b", 2), "a😀")

    def test_missing_signals(self) -> None:
        state = build_state(CONFIG, "hi", [], [], None, [])
        self.assertEqual(state["previous_turns"], [])
        self.assertIsNone(state["active_background_task"])
        self.assertEqual(state["tools_used_last_hour"], [])

    def test_questions(self) -> None:
        questions = build_questions(CONFIG, ["watchlist", "gmail", "calendar"])
        self.assertEqual(list(questions), ["gmail", "calendar", "watchlist"])
        gmail = questions["gmail"]
        self.assertEqual(list(gmail), ["type", "instructions", "criteria"])
        self.assertEqual(list(gmail["criteria"]), ["true", "false"])
        self.assertEqual(gmail["type"], "noul")
        self.assertIn("the gmail tools", gmail["instructions"])
        info = CONFIG["domains"]["gmail"]
        self.assertEqual(
            gmail["criteria"]["true"],
            f"{info['description']} Examples: {info['examples']}.",
        )
        self.assertEqual(gmail["criteria"]["false"], CONFIG["question"]["false"])
        self.assertEqual(list(build_questions(CONFIG, DOMAINS)), list(DOMAINS))
        for question in build_questions(CONFIG, DOMAINS).values():
            for placeholder in ("{domain}", "{description}", "{examples}"):
                self.assertNotIn(placeholder, dumps(question))

    def test_request_golden(self) -> None:
        # Generated from the TypeScript side; both must build identical requests.
        self.assertTrue(GOLDEN.exists(), "request-golden.json is missing")
        scenarios = {s["id"]: s for s in load("scenarios.json")}
        entries = load(GOLDEN.name)
        self.assertTrue(entries, "request-golden.json has no entries")
        for entry in entries:
            with self.subTest(entry["id"]):
                state, questions = scenario_request(
                    CONFIG, scenarios[entry["id"]], entry["domains"]
                )
                self.assertEqual(dumps(state), dumps(entry["state"]))
                self.assertEqual(dumps(questions), dumps(entry["questions"]))


class DataTest(unittest.TestCase):
    def test_scenarios_are_well_formed(self) -> None:
        scenarios = load("scenarios.json")
        ids = [s["id"] for s in scenarios]
        self.assertEqual(len(ids), len(set(ids)))
        for scenario in scenarios:
            with self.subTest(scenario["id"]):
                self.assertIn(scenario["split"], ("tuning", "held-out"))
                self.assertLessEqual(set(scenario["gold"]), set(DOMAINS))
                scenario_request(CONFIG, scenario, DOMAINS)

    def test_config_rejects_malformed(self) -> None:
        good = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        broken = [
            {**good, "threshold": True},
            {**good, "cap": 0},
            {**good, "state": {**good["state"], "previousTurns": -1}},
            {**good, "domains": dict(reversed(list(good["domains"].items())))},
            {k: v for k, v in good.items() if k != "alwaysAvailable"},
        ]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.json"
            for config in broken:
                path.write_text(json.dumps(config), encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_config(path)
            path.write_text("{", encoding="utf-8")
            with self.assertRaises(ValueError):
                load_config(path)


if __name__ == "__main__":
    unittest.main()
