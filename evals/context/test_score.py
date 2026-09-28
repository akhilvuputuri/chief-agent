"""Offline tests for the context eval scorer (no network)."""
import unittest

from run import grade, summarise


def row(**over):
    base = {
        "probe": "f/1", "slice": "gap", "mode": "answer", "evidence": {"4:30 pm": "context"},
        "accept": ["4:30 ?pm|16:30"], "reject": ["11 ?am|11:00"], "reply": "It starts at 4:30 pm.",
        "toolCalls": [], "sizes": {"fixed": 40000, "serialized": 50000, "omitted": 10}, "costUsd": 0.01, "latencyMs": 2000,
    }
    base.update(over)
    return base


class GradeTest(unittest.TestCase):
    def test_correct_and_visible(self):
        g = grade(row())
        self.assertTrue(g["visible"] and g["correct"] and not g["confused"])

    def test_known_confusion_without_the_answer(self):
        g = grade(row(reply="It is at 11am."))
        self.assertTrue(g["confused"])
        self.assertFalse(g["correct"])

    def test_contrast_with_the_other_value_is_hedged(self):
        g = grade(row(reply="4:30 pm; the other one is at 11am."))
        self.assertTrue(g["hedged"])
        self.assertFalse(g["correct"] or g["confused"])

    def test_every_accept_pattern_must_match(self):
        g = grade(row(accept=["wed(nesday)?", "10:30"], reject=["2:00"], reply="Wed 7 Oct at 2:00 pm in Kestrel"))
        self.assertFalse(g["correct"])
        self.assertTrue(g["confused"])

    def test_absent_evidence_and_search(self):
        g = grade(row(evidence={"4:30 pm": "absent"}, toolCalls=["conversation_search"]))
        self.assertFalse(g["visible"])
        self.assertTrue(g["searched"])

    def test_context_mode_has_no_answer_grade(self):
        g = grade(row(mode="context", reply=None))
        self.assertNotIn("correct", g)

    def test_summary_lists_misses(self):
        rows = [row(), row(probe="f/2", slice="distant", evidence={"x": "absent"}, reply="no idea")]
        for r in rows:
            r["grade"] = grade(r)
        text = summarise(rows)
        self.assertIn("| distant | 1 |", text)
        self.assertIn("f/2 (distant)", text)


if __name__ == "__main__":
    unittest.main()
