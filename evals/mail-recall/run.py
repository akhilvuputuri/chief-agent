#!/usr/bin/env python3
"""Offline fusion and re-ranking comparison for gmail_recall (docs/mail-recall.md).

Reads a private dataset written by `node dist/mail-recall-eval.js N --export` in the
production container. It contains email text: keep it in the private operations folder.
Nothing here calls a model or a network API; the optional re-ranker runs locally.

Conditions, each a ranked list of messages per question:
  keyword        Gmail results in the order the agent reads them (today's email agent)
  dense          gmail_recall as deployed: best chunk's cosine score
  dense-top2     mean of a message's two best chunk scores
  bm25           local BM25 over each message's indexed text
  rrf(...)       reciprocal rank fusion of the named lists
  rerank         a local cross-encoder re-ranking the top candidates of --rerank-base

The deployed agent sees both the keyword list and gmail_recall's top 8; that union is
reported as a reference set, not a ranking.

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
    for c in chunks:
        header[c["messageId"]] = f"From: {c['from']}\nSubject: {c['subject']}\nDate: {c['date']}"
        text[c["messageId"]].append(c["text"])
    documents = {m: header[m] + "\n\n" + "\n".join(parts) for m, parts in text.items()}
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
            pairs = [(q["question"], (header.get(m, "") + "\n\n" + best.get(m, (0, ""))[1])[:2000]) for m in candidates]
            scores = rerank_model.predict(pairs) if pairs else []
            order = sorted(range(len(candidates)), key=lambda i: -float(scores[i]))
            lists["rerank"] = [candidates[i] for i in order]
        rows.append(
            {
                "target": q["target"]["messageId"],
                "ranks": {name: rank_of(q["target"]["messageId"], ranking) for name, ranking in lists.items()},
                "union8": q["target"]["messageId"] in set(keyword) | set(dense[:8]),
            }
        )
    return rows


def summarise(rows, k: int):
    n = len(rows)
    names = list(rows[0]["ranks"])
    report = {"questions": n, "k": k, "conditions": {}}
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
        for baseline in ("keyword", "dense"):
            if name == baseline:
                continue
            base = [found(r["ranks"][baseline], k) for r in rows]
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
    union = sum(r["union8"] for r in rows)
    report["reference_union_keyword_plus_dense8"] = union
    return report


def table(report) -> str:
    k = report["k"]
    lines = [f"{report['questions']} questions; found@{k} with 95% Wilson interval; paired McNemar against keyword", ""]
    lines.append(f"{'condition':26} {'@1':>4} {'@5':>4} {'@'+str(k):>4}  {'95%':>11}  {'MRR':>5}  vs keyword (+/-, p)")
    for name, e in report["conditions"].items():
        lo, hi = e[f"found@{k}_wilson95"]
        vs = e.get("vs_keyword")
        versus = f"+{vs['only_this']}/-{vs['only_baseline']}, p={vs['mcnemar_p']}" if vs else ""
        lines.append(
            f"{name:26} {e['found@1']:>4} {e['found@5']:>4} {e[f'found@{k}']:>4}  {lo:.2f}-{hi:.2f}  {e['mrr@10']:>5}  {versus}"
        )
    lines.append("")
    lines.append(f"reference: keyword list plus gmail_recall top 8, as the agent sees them: {report['reference_union_keyword_plus_dense8']}")
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
