"""Offline tests for the mail recall eval; synthetic data only, no network."""
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run  # noqa: E402
from retrieval import (  # noqa: E402
    BM25,
    dense_ranking,
    keyword_ranking,
    mcnemar,
    paired_bootstrap,
    rank_of,
    rrf,
    wilson,
)


class RankingTests(unittest.TestCase):
    def test_bm25_prefers_the_document_with_the_rare_query_term(self):
        bm25 = BM25(
            {
                "a": "invoice for the aircon repair visit",
                "b": "weekly newsletter about repair cafes and gardening",
                "c": "your flight itinerary to tokyo",
            }
        )
        self.assertEqual(bm25.rank("aircon repair quote")[0], "a")
        self.assertNotIn("c", bm25.rank("aircon repair quote"))

    def test_dense_ranking_uses_best_or_mean_of_best_chunks(self):
        scores = {"m1:0": 0.9, "m1:1": 0.1, "m2:0": 0.6, "m2:1": 0.6, "gone:0": 0.99}
        owner = {"m1:0": "m1", "m1:1": "m1", "m2:0": "m2", "m2:1": "m2"}
        self.assertEqual(dense_ranking(scores, owner), ["m1", "m2"])
        self.assertEqual(dense_ranking(scores, owner, top=2), ["m2", "m1"])

    def test_keyword_ranking_keeps_query_order_without_duplicates(self):
        self.assertEqual(keyword_ranking([["a", "b"], [], ["b", "c"]]), ["a", "b", "c"])

    def test_rrf_rewards_items_both_lists_rank(self):
        fused = rrf([["a", "b", "c"], ["b", "c", "d"]])
        self.assertEqual(fused[0], "b")
        self.assertEqual(set(fused), {"a", "b", "c", "d"})
        self.assertEqual(rank_of("d", fused), 4)
        self.assertIsNone(rank_of("z", fused))


class StatisticsTests(unittest.TestCase):
    def test_wilson_matches_the_journal_figures(self):
        lo, hi = wilson(14, 30)
        self.assertAlmostEqual(lo, 0.302, places=3)
        self.assertAlmostEqual(hi, 0.639, places=3)

    def test_mcnemar_exact(self):
        a = [True] * 9 + [False] * 21
        b = [False] * 30
        self.assertEqual(mcnemar(a, b), (9, 0, 2 / 512))
        only_a, only_b, p = mcnemar([True] * 9 + [False] * 7, [False] * 9 + [True] * 7)
        self.assertEqual((only_a, only_b), (9, 7))
        self.assertAlmostEqual(p, 0.8036, places=4)
        self.assertEqual(mcnemar([True, False], [True, False]), (0, 0, 1.0))

    def test_paired_bootstrap_is_deterministic_and_brackets_the_mean(self):
        a = [1.0] * 20 + [0.0] * 10
        b = [1.0] * 12 + [0.0] * 18
        first = paired_bootstrap(a, b, rounds=500)
        self.assertEqual(first, paired_bootstrap(a, b, rounds=500))
        mean, low, high = first
        self.assertAlmostEqual(mean, 8 / 30)
        self.assertLessEqual(low, mean)
        self.assertGreaterEqual(high, mean)


def dataset(path: Path):
    """Three emails; one question whose target only meaning search ranks first."""
    rows = [
        {"type": "chunk", "chunkId": "m1:0", "messageId": "m1", "threadId": "t1", "at": 1, "from": "Shop", "subject": "Order update", "date": "d", "text": "We are sorry your sofa arrived late; here is a voucher."},
        {"type": "chunk", "chunkId": "m2:0", "messageId": "m2", "threadId": "t2", "at": 2, "from": "Bank", "subject": "Statement", "date": "d", "text": "Your card statement is ready."},
        {"type": "chunk", "chunkId": "m3:0", "messageId": "m3", "threadId": "t3", "at": 3, "from": "Landlord", "subject": "Lease", "date": "d", "text": "The deposit is two months of rent."},
        {
            "type": "question",
            "question": "the apology about the delayed couch",
            "target": {"messageId": "m1", "subject": "Order update", "date": "d"},
            "keywordLists": [["m2"], ["m3", "m1"]],
            "dense": {"m1:0": 0.8, "m2:0": 0.2, "m3:0": 0.1},
        },
        {"level": "info", "event": "mail_index.built"},
    ]
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\nnot json\n")


class EndToEndTests(unittest.TestCase):
    def test_report_compares_conditions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "export.jsonl"
            dataset(path)
            out = io.StringIO()
            with redirect_stdout(out):
                run.main([str(path), "--json", "--k", "1"])
        report = json.loads(out.getvalue())
        conditions = report["conditions"]
        self.assertEqual(report["questions"], 1)
        self.assertEqual(conditions["dense"]["found@1"], 1)
        self.assertEqual(conditions["keyword"]["found@1"], 0)
        # The agent sees m1 in its keyword results, so today's agent finds it too.
        self.assertEqual(report["references"]["keyword-all"]["found"], 1)
        self.assertEqual(report["references"]["keyword-all"]["mean_candidates"], 3)
        self.assertEqual(conditions["dense"]["vs_keyword-all"]["only_this"], 0)
        self.assertIn("rrf(dense,keyword,bm25)", conditions)
        self.assertEqual(report["references"]["union"]["found"], 1)

    def test_reranker_reorders_the_candidates(self):
        class Reverse:
            def predict(self, pairs):
                return [float(i) for i in range(len(pairs))]

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "export.jsonl"
            dataset(path)
            questions, chunks = run.load(path)
        rows = run.build(questions, chunks, Reverse(), "rrf(dense,keyword)", 30)
        # dense ranks m1 first and keyword ranks it third, so fusion puts it second;
        # the stub scores later candidates higher, reversing the three candidates.
        self.assertEqual(rows[0]["ranks"]["rrf(dense,keyword)"], 2)
        self.assertEqual(rows[0]["ranks"]["rerank"], 2)
        self.assertEqual(rows[0]["ranks"]["dense"], 1)

    def test_keyword_all_counts_results_beyond_the_first_k(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "export.jsonl"
            dataset(path)
            questions, chunks = run.load(path)
        filler = [f"x{i}" for i in range(21)]
        questions[0]["keywordLists"] = [filler[:10], filler[10:], ["m1"]]
        questions[0]["dense"] = {"m1:0": 0.1, "m2:0": 0.9, "m3:0": 0.8}
        report = run.summarise(run.build(questions, chunks), 8)
        self.assertEqual(report["conditions"]["keyword"]["found@8"], 0)
        self.assertEqual(report["references"]["keyword-all"]["found"], 1)
        self.assertEqual(report["references"]["keyword-all"]["mean_candidates"], 22)

    def test_overlapping_chunk_text_is_indexed_once(self):
        first = "a" * 1300 + "OVERLAPWORD" + "b" * 189
        second = first[1300:] + " tail words"
        chunks = [
            {"chunkId": "m1:0", "messageId": "m1", "from": "f", "subject": "s", "date": "d", "text": first},
            {"chunkId": "m1:1", "messageId": "m1", "from": "f", "subject": "s", "date": "d", "text": second},
        ]
        questions = [{"question": "overlapword", "target": {"messageId": "m1"}, "keywordLists": [[]], "dense": {"m1:0": 0.5}}]
        captured = {}
        original = run.BM25

        class Spy(original):
            def __init__(self, docs, *a, **k):
                captured.update(docs)
                super().__init__(docs, *a, **k)

        run.BM25 = Spy
        try:
            run.build(questions, chunks)
        finally:
            run.BM25 = original
        self.assertEqual(captured["m1"].count("OVERLAPWORD"), 1)
        self.assertTrue(captured["m1"].endswith("tail words"))

    def test_reranker_sees_gmail_text_for_hits_outside_the_index(self):
        seen = []

        class Record:
            def predict(self, pairs):
                seen.extend(pairs)
                return [0.0] * len(pairs)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "export.jsonl"
            dataset(path)
            questions, chunks = run.load(path)
        questions[0]["keywordLists"] = [["archived", "m1"]]
        questions[0]["keywordMeta"] = {"archived": {"from": "Courier", "subject": "Delivery", "date": "d", "snippet": "your couch is delayed"}}
        run.build(questions, chunks, Record(), "rrf(dense,keyword)", 30)
        passages = {p for _, p in seen}
        self.assertIn("From: Courier\nSubject: Delivery\nDate: d\n\nyour couch is delayed", passages)
        self.assertTrue(any("sofa arrived late" in p for p in passages))

    def test_missing_export_rows_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plain.jsonl"
            path.write_text(json.dumps({"question": "q", "keyword": True}) + "\n")
            with self.assertRaises(SystemExit):
                run.load(path)


if __name__ == "__main__":
    unittest.main()
