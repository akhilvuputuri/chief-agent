#!/usr/bin/env python3
"""Offline fusion and re-ranking comparison for gmail_recall (docs/mail-recall.md).

Reads a private dataset written by `node dist/mail-recall-eval.js N --export` in the
production container. It contains email text: keep it in the private operations folder.
Nothing here calls a model or a network API; the optional re-ranker runs locally.

Conditions, each a ranked list of messages per question, scored at the first --k results:
  keyword        Gmail results in the order the agent reads them, first k only
  dense          gmail_recall as deployed: best chunk's cosine score
  dense-top2     mean of a message's two best chunk scores
  bm25           local BM25 over each message's indexed text
  rrf(...)       reciprocal rank fusion of the named lists
  rerank         a local cross-encoder re-ranking the top candidates of --rerank-base

Reference sets, not rankings, each with its mean size:
  keyword-all    every Gmail result the agent sees (up to 3 searches x 10): today's email agent
  union          keyword-all plus gmail_recall's top 8: the agent with both tools
Comparisons are against keyword-all (today's agent) and dense; a ranked list's first k and a
reference set of up to 38 messages are different budgets.

Usage:
  python3 evals/mail-recall/run.py DATASET.jsonl [--k 8] [--json]
  python3 evals/mail-recall/run.py DATASET.jsonl --rerank BAAI/bge-reranker-v2-m3
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# Must match CHUNK_OVERLAP in src/mail-recall.ts.
CHUNK_OVERLAP = 200

from retrieval import (  # noqa: E402
    BM25,
    dense_ranking,
    found,
    keyword_ranking,
    mcnemar,
    paired_bootstrap,
    rank_of,
    reciprocal,
    rrf,
    wilson,
)


def load(path: Path):
    questions, chunks = [], []
    for line in path.read_text().splitlines():
        if not line.startswith("{"):
            continue  # operational log lines share the output
        row = json.loads(line)
        if row.get("type") == "question":
            questions.append(row)
        elif row.get("type") == "chunk":
            chunks.append(row)
    if not questions or not chunks:
        raise SystemExit("No export rows found: run the eval with --export")
    return questions, chunks


def build(questions, chunks, rerank_model=None, rerank_base="rrf(dense,keyword)", rerank_depth=30):
    chunk_message = {c["chunkId"]: c["messageId"] for c in chunks}
    text = defaultdict(list)
    header = {}
    for c in sorted(chunks, key=lambda c: (c["messageId"], int(c["chunkId"].rsplit(":", 1)[1]))):
        header[c["messageId"]] = f"From: {c['from']}\nSubject: {c['subject']}\nDate: {c['date']}"
        # Later chunks repeat the previous chunk's last CHUNK_OVERLAP characters.
        first = not text[c["messageId"]]
        text[c["messageId"]].append(c["text"] if first else c["text"][CHUNK_OVERLAP:])
    documents = {m: header[m] + "\n\n" + "".join(parts) for m, parts in text.items()}
    bm25 = BM25(documents)
    chunk_text = {c["chunkId"]: c["text"] for c in chunks}
    rows = []
    for q in questions:
        dense = dense_ranking(q["dense"], chunk_message)
        keyword = keyword_ranking(q["keywordLists"])
        lists = {
            "keyword": keyword,
            "dense": dense,
            "dense-top2": dense_ranking(q["dense"], chunk_message, top=2),
            "bm25": bm25.rank(q["question"]),
        }
        lists["rrf(dense,keyword)"] = rrf([dense, keyword])
        lists["rrf(dense,bm25)"] = rrf([dense, lists["bm25"]])
        lists["rrf(dense,keyword,bm25)"] = rrf([dense, keyword, lists["bm25"]])
        if rerank_model is not None:
            candidates = lists[rerank_base][:rerank_depth]
            best = {}
            for chunk_id, score in q["dense"].items():
                m = chunk_message.get(chunk_id)
                if m in candidates and score > best.get(m, (-2.0, ""))[0]:
                    best[m] = (score, chunk_text[chunk_id])
            meta = q.get("keywordMeta", {})

            def passage(m):
                if m in best:
                    return header[m] + "\n\n" + best[m][1]
                if m in header:  # indexed after this question was scored
                    return header[m] + "\n\n" + text[m][0]
                # Outside the index: Gmail's headers and short snippet are all there is.
                g = meta.get(m, {})
                return f"From: {g.get('from') or ''}\nSubject: {g.get('subject') or ''}\nDate: {g.get('date') or ''}\n\n{g.get('snippet') or ''}"

            pairs = [(q["question"], passage(m)[:2000]) for m in candidates]
            scores = rerank_model.predict(pairs) if pairs else []
            order = sorted(range(len(candidates)), key=lambda i: -float(scores[i]))
            lists["rerank"] = [candidates[i] for i in order]
        union = set(keyword) | set(dense[:8])
        rows.append(
            {
                "target": q["target"]["messageId"],
                "ranks": {name: rank_of(q["target"]["messageId"], ranking) for name, ranking in lists.items()},
                "references": {
                    "keyword-all": (q["target"]["messageId"] in set(keyword), len(keyword)),
                    "union": (q["target"]["messageId"] in union, len(union)),
                },
            }
        )
    return rows


def summarise(rows, k: int):
    n = len(rows)
    names = list(rows[0]["ranks"])
    report = {"questions": n, "k": k, "references": {}, "conditions": {}}
    baselines = {
        "keyword-all": [r["references"]["keyword-all"][0] for r in rows],
        "dense": [found(r["ranks"]["dense"], k) for r in rows],
    }
    for name in ("keyword-all", "union"):
        hits = [r["references"][name][0] for r in rows]
        lo, hi = wilson(sum(hits), n)
        report["references"][name] = {
            "found": sum(hits),
            "wilson95": [round(lo, 3), round(hi, 3)],
            "mean_candidates": round(sum(r["references"][name][1] for r in rows) / n, 1),
        }
    for name in names:
        hits = [found(r["ranks"][name], k) for r in rows]
        lo, hi = wilson(sum(hits), n)
        entry = {
            "found@1": sum(found(r["ranks"][name], 1) for r in rows),
            "found@5": sum(found(r["ranks"][name], 5) for r in rows),
            f"found@{k}": sum(hits),
            f"found@{k}_wilson95": [round(lo, 3), round(hi, 3)],
            "mrr@10": round(sum(reciprocal(r["ranks"][name]) for r in rows) / n, 3),
        }
        for baseline, base in baselines.items():
            if name == baseline:
                continue
            only_this, only_base, p = mcnemar(hits, base)
            mean, low, high = paired_bootstrap([float(h) for h in hits], [float(b) for b in base])
            entry[f"vs_{baseline}"] = {
                "only_this": only_this,
                "only_baseline": only_base,
                "mcnemar_p": round(p, 4),
                "diff": round(mean, 3),
                "diff_95": [round(low, 3), round(high, 3)],
            }
        report["conditions"][name] = entry
    return report


def table(report) -> str:
    k = report["k"]
    lines = [f"{report['questions']} questions", ""]
    lines.append("reference sets (found anywhere; mean size):")
    for name, e in report["references"].items():
        lo, hi = e["wilson95"]
        lines.append(f"  {name:12} {e['found']:>4}  {lo:.2f}-{hi:.2f}  mean {e['mean_candidates']} messages")
    lines.append("")
    lines.append(f"ranked lists, first {k} (paired McNemar against keyword-all, today's agent):")
    lines.append(f"{'condition':26} {'@1':>4} {'@5':>4} {'@'+str(k):>4}  {'95%':>11}  {'MRR':>5}  vs keyword-all (+/-, p)")
    for name, e in report["conditions"].items():
        lo, hi = e[f"found@{k}_wilson95"]
        vs = e.get("vs_keyword-all")
        versus = f"+{vs['only_this']}/-{vs['only_baseline']}, p={vs['mcnemar_p']}" if vs else ""
        lines.append(
            f"{name:26} {e['found@1']:>4} {e['found@5']:>4} {e[f'found@{k}']:>4}  {lo:.2f}-{hi:.2f}  {e['mrr@10']:>5}  {versus}"
        )
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--k", type=int, default=8)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--rerank", help="sentence-transformers CrossEncoder model name (optional)")
    parser.add_argument("--rerank-base", default="rrf(dense,keyword)")
    parser.add_argument("--rerank-depth", type=int, default=30)
    args = parser.parse_args(argv)
    model = None
    if args.rerank:
        try:
            from sentence_transformers import CrossEncoder
        except ImportError:
            raise SystemExit("--rerank needs sentence-transformers: pip install sentence-transformers")
        model = CrossEncoder(args.rerank)
    questions, chunks = load(args.dataset)
    report = summarise(build(questions, chunks, model, args.rerank_base, args.rerank_depth), args.k)
    print(json.dumps(report, indent=1) if args.json else table(report))


if __name__ == "__main__":
    main()
