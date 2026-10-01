"""Paired evaluation of decision backends on labelled fixtures.

Run: npm run eval:decisions -- continuity [--runs 3] [--backends keep,rule,jev,flash]
Paid backends (Jev, Flash) call OpenRouter with OPENROUTER_API_KEY.

Method, so the numbers can be defended:
- Every backend answers the same cases; comparisons are paired.
- Each paid backend runs --runs times per case; its probability is the mean, and cases whose
  decision changes between runs are reported as unstable.
- A threshold is chosen on the tuning split only (the largest gain whose recall on cases that
  need the context stays at or above --min-recall), then everything is reported on held-out.
- Proportions get 95% Wilson intervals, gains a 95% bootstrap interval, and accuracy
  differences an exact McNemar test on the cases where two backends disagree.
"""

from __future__ import annotations

import argparse
import importlib
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
import backends as backend_api  # noqa: E402
from stats import bootstrap, mcnemar_exact, mean, percentile, wilson  # noqa: E402

# Median serialized request from production context.selected logs, 30 Sep 2026 (n=15),
# used only to express a gain as a share of a typical request.
TYPICAL_REQUEST_CHARS = 54356


def collect(decision, backend: str, cases: list[dict[str, Any]], runs: int, key: str | None, concurrency: int):
    fn = decision.BACKENDS[backend]
    paid = backend in decision.PAID
    jobs = [(case, run) for run in range(runs if paid else 1) for case in cases]

    def one(job):
        case, run = job
        record = fn(case, key) if paid else fn(case)
        return {"id": case["id"], "run": run, **record}

    with ThreadPoolExecutor(max_workers=concurrency if paid else 1) as pool:
        return list(pool.map(one, jobs))


def probabilities(records: list[dict[str, Any]]) -> tuple[dict[str, float], dict[str, list[float]]]:
    per_case: dict[str, list[float]] = {}
    for r in records:
        if r["error"] is None and r["probability"] is not None:
            per_case.setdefault(r["id"], []).append(float(r["probability"]))
    return {k: mean(v) for k, v in per_case.items()}, per_case


def confusion(decision, cases, prob, threshold):
    """Positive = the case needs the context (keep it). A drop is a predicted negative."""
    out = {"tp": 0, "fn": 0, "tn": 0, "fp": 0, "missing": 0}
    for c in cases:
        if c["id"] not in prob:
            out["missing"] += 1
            continue
        keep = prob[c["id"]] >= threshold
        if decision.label(c):
            out["tp" if keep else "fn"] += 1
        else:
            out["fp" if keep else "tn"] += 1
    return out


def saved(decision, cases, prob, threshold) -> list[float]:
    """Per-case characters avoided: the gain on correct drops, zero otherwise.

    A wrong drop (a follow-up) is a recall failure, counted separately, never as a gain.
    """
    values = []
    for c in cases:
        p = prob.get(c["id"])
        dropped = p is not None and p < threshold
        values.append(decision.gain(c) if dropped and not decision.label(c) else 0.0)
    return values


def tune(decision, cases, prob, min_recall: float) -> float:
    """Largest-gain threshold on tuning cases with recall >= min_recall; ties pick the lower one."""
    candidates = sorted({0.0, 0.5, 1.0 + 1e-9} | {p + 1e-9 for p in prob.values()})
    best = (0.0, -1.0)
    for t in candidates:
        m = confusion(decision, cases, prob, t)
        positives = m["tp"] + m["fn"]
        recall = m["tp"] / positives if positives else 1.0
        if recall + 1e-12 < min_recall:
            continue
        gain = sum(saved(decision, cases, prob, t))
        if gain > best[1]:
            best = (t, gain)
    return best[0]


def summarise(decision, backend, records, cases, threshold, per_case):
    prob = {k: mean(v) for k, v in per_case.items()}
    held = [c for c in cases if c["id"] in {r["id"] for r in records}]
    m = confusion(decision, held, prob, threshold)
    positives, negatives = m["tp"] + m["fn"], m["tn"] + m["fp"]
    gains = saved(decision, held, prob, threshold)
    calls = [r for r in records if r["id"] in {c["id"] for c in held}]
    latencies = [r["latency_ms"] for r in calls if r["error"] is None]
    costs = [r["cost"] for r in calls if isinstance(r.get("cost"), (int, float))]
    unstable = sorted(
        cid for cid, values in per_case.items()
        if cid in {c["id"] for c in held} and len({v >= threshold for v in values}) > 1
    )
    possible = sum(decision.gain(c) for c in held if not decision.label(c))
    return {
        "backend": backend,
        "threshold": threshold,
        "cases": len(held),
        "confusion": m,
        "recall": m["tp"] / positives if positives else None,
        "recall_ci": wilson(m["tp"], positives),
        "drop_rate": m["tn"] / negatives if negatives else None,
        "drop_rate_ci": wilson(m["tn"], negatives),
        "accuracy": (m["tp"] + m["tn"]) / (positives + negatives) if positives + negatives else None,
        "saved_share": sum(gains) / possible if possible else None,
        "saved_per_message": mean(gains),
        "saved_per_message_ci": bootstrap(gains, mean),
        "saved_share_of_typical_request": mean(gains) / TYPICAL_REQUEST_CHARS,
        "calls": len(calls),
        "errors": sum(r["error"] is not None for r in calls),
        "latency_p50_ms": percentile(latencies, 0.5),
        "latency_p95_ms": percentile(latencies, 0.95),
        "cost_per_1000_usd": (sum(costs) / len(calls) * 1000) if calls and costs else (0.0 if not costs else None),
        "unstable_cases": unstable,
        "wrong_drops": sorted(c["id"] for c in held if decision.label(c) and prob.get(c["id"], 1) < threshold),
    }


def correct(decision, cases, prob, threshold):
    return {c["id"]: (prob.get(c["id"], 1.0) >= threshold) == decision.label(c) for c in cases}


def table(results, comparisons) -> str:
    def pct(v, ci=None):
        if v is None:
            return "–"
        text = f"{v * 100:.1f}%"
        return text + (f" ({ci[0] * 100:.1f}–{ci[1] * 100:.1f})" if ci else "")

    lines = [
        "| Backend | Recall on follow-ups (95% CI) | Standalone dropped (95% CI) | Accuracy | Chars saved / message (95% CI) | Share of typical request | p50 / p95 ms | Errors | $ / 1k |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        ci = r["saved_per_message_ci"]
        lines.append(
            f"| {r['backend']} | {pct(r['recall'], r['recall_ci'])} | {pct(r['drop_rate'], r['drop_rate_ci'])} | {pct(r['accuracy'])} | "
            f"{r['saved_per_message']:,.0f} ({ci[0]:,.0f}–{ci[1]:,.0f}) | {pct(r['saved_share_of_typical_request'])} | "
            f"{r['latency_p50_ms']} / {r['latency_p95_ms']} | {r['errors']}/{r['calls']} | "
            f"{'–' if r['cost_per_1000_usd'] is None else f'{r['cost_per_1000_usd']:.4f}'} |"
        )
    lines += ["", "| Pair | Only first right | Only second right | McNemar p |", "|---|---|---|---|"]
    for c in comparisons:
        lines.append(f"| {c['a']} vs {c['b']} | {c['only_a']} | {c['only_b']} | {c['p']:.3g} |")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate decision backends.")
    parser.add_argument("decision")
    parser.add_argument("--backends", help="comma-separated; default: every backend the decision defines")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--min-recall", type=float, default=1.0)
    parser.add_argument("--min-precision", type=float, default=1.0)
    parser.add_argument("--env-file", default=str(ROOT / ".env"))
    parser.add_argument("--out")
    args = parser.parse_args()
    decision = importlib.import_module(args.decision)
    cases = json.loads((HERE / "fixtures" / decision.FIXTURES).read_text(encoding="utf-8"))
    tuning = [c for c in cases if c["split"] == "tuning"]
    held = [c for c in cases if c["split"] == "held-out"]
    names = [b for b in args.backends.split(",") if b] if args.backends else list(decision.BACKENDS)
    key = backend_api.api_key(args.env_file)
    if any(b in decision.PAID for b in names) and not key:
        sys.exit("OPENROUTER_API_KEY is required for paid backends")
    if hasattr(decision, "evaluate"):
        raw = {}
        for name in names:
            raw[name] = collect(decision, name, cases, args.runs, key, args.concurrency)
            print(f"{name}: done", file=sys.stderr)
        results, comparisons, text = decision.evaluate(cases, raw, args)
        write(decision, args, tuning, held, results, comparisons, raw, text)
        return
    results, held_prob, raw = [], {}, {}
    for name in names:
        records = collect(decision, name, cases, args.runs, key, args.concurrency)
        raw[name] = records
        _, per_case = probabilities(records)
        prob = {k: mean(v) for k, v in per_case.items()}
        # A rule has no knob: it is reported as written. Probabilistic backends get a tuned threshold.
        threshold = (
            tune(decision, tuning, prob, args.min_recall) if name in decision.PAID else 0.5
        )
        held_records = [r for r in records if r["id"] in {c["id"] for c in held}]
        held_per_case = {k: v for k, v in per_case.items() if k in {c["id"] for c in held}}
        results.append(summarise(decision, name, held_records, held, threshold, held_per_case))
        held_prob[name] = (prob, threshold)
        print(f"{name}: done", file=sys.stderr)
    comparisons = []
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            ca = correct(decision, held, *held_prob[a])
            cb = correct(decision, held, *held_prob[b])
            only_a = sum(ca[k] and not cb[k] for k in ca)
            only_b = sum(cb[k] and not ca[k] for k in ca)
            comparisons.append({"a": a, "b": b, "only_a": only_a, "only_b": only_b, "p": mcnemar_exact(only_a, only_b)})
    write(decision, args, tuning, held, results, comparisons, raw, table(results, comparisons))


def write(decision, args, tuning, held, results, comparisons, raw, text) -> None:
    report = {
        "decision": decision.NAME,
        "at": datetime.now(timezone.utc).isoformat(),
        "revision": subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip(),
        "runs": args.runs,
        "min_recall": args.min_recall,
        "min_precision": args.min_precision,
        "cases": {"tuning": len(tuning), "held_out": len(held)},
        "results": results,
        "comparisons": comparisons,
        "records": raw,
    }
    out = Path(args.out) if args.out else HERE / "results" / f"{decision.NAME}-{datetime.now().strftime('%Y%m%d-%H%M')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    print(text)
    print(f"\nFull report: {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")


if __name__ == "__main__":
    main()
