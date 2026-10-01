"""Decision 1: does the latest message need the previous exchange?

Today Chief always keeps the previous exchange in context. A backend that can tell a new
topic from a follow-up lets Chief drop it, saving its characters, but a wrong drop loses
context the answer needed. So recall on follow-ups is the safety metric and characters
saved on standalone messages is the gain.
"""

from __future__ import annotations

import re
from typing import Any

import backends
from scoring import by_run, call_stats, majority
from stats import cluster_interval, mcnemar_exact, mean

NAME = "continuity"
FIXTURES = "continuity.json"

JEV_QUESTION = {
    "needs_previous": {
        "type": "noul",
        "instructions": "Does answering `latest_user_message` correctly require the previous exchange (`previous_user_message` and `previous_assistant_reply`)?",
        "criteria": {
            "true": "It refers back to the previous exchange: a pronoun or 'the other one', an answer to the assistant's question, a correction or change to what was just done, 'and…' or 'what about…' continuing the same subject, or a question about details just given.",
            "false": "It stands on its own: a new request or question that names its own subject, small talk, or a request in the same area that does not depend on what was just said.",
        },
    }
}

LLM_SYSTEM = """You decide whether a personal assistant needs the previous exchange to answer the user's latest message.
Answer true when the latest message refers back to it: a pronoun or "the other one", an answer to the assistant's question, a correction or change to what was just done, "and..." or "what about..." continuing the same subject, or a question about details just given.
Answer false when it stands on its own: a new request or question naming its own subject, small talk, or a request in the same area that does not depend on what was just said.
Reply with JSON only: {"needs_previous": true|false, "confidence": number from 0 to 1}"""

# Word cues for the rule baseline: references back, continuations and very short replies.
CUES = re.compile(
    r"\b(it|its|that|those|them|this one|the (first|other|second|last) one|which one|again|too|also|instead|then|same|"
    r"either|both|there|he|she|they|his|her|their|why|source|sources|more)\b|^(and|also|ok|okay|yes|no|actually|what about|how about|make it|make that)\b",
    re.I,
)


def state(case: dict[str, Any]) -> dict[str, Any]:
    return {
        "previous_user_message": case["previous"]["user"][:500],
        "previous_assistant_reply": case["previous"]["assistant"][:600],
        "latest_user_message": case["message"][:2000],
    }


def rule(case: dict[str, Any]) -> dict[str, Any]:
    message = case["message"].strip()
    words = len(message.split())
    needs = bool(CUES.search(message)) or words <= 3
    return {"probability": 1.0 if needs else 0.0, "latency_ms": 0, "cost": 0.0, "error": None}


def keep(case: dict[str, Any]) -> dict[str, Any]:
    return {"probability": 1.0, "latency_ms": 0, "cost": 0.0, "error": None}


def jev(case: dict[str, Any], key: str) -> dict[str, Any]:
    r = backends.jev(key, state(case), JEV_QUESTION)
    answer = (r["answers"] or {}).get("needs_previous") if not r["error"] else None
    p = answer.get("noul") if isinstance(answer, dict) else None
    return {
        "probability": p if isinstance(p, (int, float)) else None,
        "latency_ms": r["latency_ms"],
        "cost": r["cost"],
        "error": r["error"] or (None if p is not None else "no needs_previous answer"),
        "model": r["model"],
    }


def flash(case: dict[str, Any], key: str) -> dict[str, Any]:
    s = state(case)
    user = (
        f"Previous user message: {s['previous_user_message']}\n"
        f"Previous assistant reply: {s['previous_assistant_reply']}\n"
        f"Latest user message: {s['latest_user_message']}"
    )
    r = backends.chat_json(key, LLM_SYSTEM, user)
    p = None
    if not r["error"] and isinstance(r["answer"], dict):
        needs = r["answer"].get("needs_previous")
        confidence = r["answer"].get("confidence", 1)
        if isinstance(needs, bool) and isinstance(confidence, (int, float)):
            confidence = min(1.0, max(0.0, float(confidence)))
            p = confidence if needs else 1 - confidence
    return {
        "probability": p,
        "latency_ms": r["latency_ms"],
        "cost": r["cost"],
        "error": r["error"] or (None if p is not None else "unparseable answer"),
        "model": r["model"],
    }


BACKENDS = {"keep": keep, "rule": rule, "jev": jev, "flash": flash}
PAID = {"jev", "flash"}


def label(case: dict[str, Any]) -> bool:
    return case["needs_previous"]


def gain(case: dict[str, Any]) -> float:
    """Characters avoided when the previous exchange is dropped for this case."""
    return float(case["previous"]["chars"])


# Median serialized request from production context.selected logs, 30 Sep 2026 (n=15),
# used only to express a gain as a share of a typical request.
TYPICAL_REQUEST_CHARS = 54356


def _calls(records, cases):
    """One scored item per call. A failed call keeps the context (the safe fallback)."""
    index = {c["id"]: c for c in cases}
    out = []
    for r in records:
        c = index.get(r["id"])
        if c is None:
            continue
        p = r["probability"] if r["error"] is None and r["probability"] is not None else 1.0
        out.append({"id": c["id"], "run": r["run"], "p": float(p), "label": label(c),
                    "gain": gain(c), "cluster": c["prior_index"], "failed": r["error"] is not None})
    return out


def _recall(calls, t):
    pos = [c for c in calls if c["label"]]
    return sum(c["p"] >= t for c in pos) / len(pos) if pos else None


def _drop(calls, t):
    neg = [c for c in calls if not c["label"]]
    return sum(c["p"] < t for c in neg) / len(neg) if neg else None


def _saved(calls, t):
    return [c["gain"] if c["p"] < t and not c["label"] else 0.0 for c in calls]


def _tune(calls, min_recall):
    """Largest total gain with recall >= min_recall on tuning calls; ties take the lower threshold."""
    best = (0.0, -1.0)
    for t in sorted({0.0} | {c["p"] + 1e-9 for c in calls}):
        r = _recall(calls, t)
        if r is not None and r + 1e-12 < min_recall:
            continue
        g = sum(_saved(calls, t))
        if g > best[1]:
            best = (t, g)
    return best[0]


def evaluate(cases, records_by_backend, args):
    tuning = [c for c in cases if c["split"] == "tuning"]
    held = [c for c in cases if c["split"] == "held-out"]
    held_ids = {c["id"] for c in held}
    results, right_by = [], {}
    for name, records in records_by_backend.items():
        paid = name in PAID
        tcalls, hcalls = _calls(records, tuning), _calls(records, held)
        t = _tune(tcalls, args.min_recall) if paid else 0.5
        follow_t = sorted(c["p"] for c in tcalls if c["label"])
        follow_h = sorted(c["p"] for c in hcalls if c["label"])
        # Sensitivity: retune without the tuning follow-up that sets the threshold.
        tight = min((c for c in tcalls if c["label"]), key=lambda c: c["p"], default=None)
        loo_t = _tune([c for c in tcalls if not tight or c["id"] != tight["id"]], args.min_recall) if paid else t
        per_case: dict[str, list[bool]] = {}
        for c in hcalls:
            per_case.setdefault(c["id"], []).append((c["p"] >= t) == c["label"])
        right_by[name] = majority(per_case)
        gains = _saved(hcalls, t)
        results.append({
            "backend": name,
            "threshold": t,
            "calls_scored": len(hcalls),
            "unique_messages": len({c["message"] for c in held}),
            "recall": _recall(hcalls, t),
            "recall_ci": cluster_interval(hcalls, lambda c: c["cluster"], lambda s: _recall(s, t)),
            "recall_by_run": by_run(hcalls, lambda s: _recall(s, t)),
            "drop_rate": _drop(hcalls, t),
            "drop_rate_ci": cluster_interval(hcalls, lambda c: c["cluster"], lambda s: _drop(s, t)),
            "drop_rate_by_run": by_run(hcalls, lambda s: _drop(s, t)),
            "saved_per_message": mean(gains),
            "saved_per_message_ci": cluster_interval(
                [dict(c, saved=g) for c, g in zip(hcalls, gains)], lambda c: c["cluster"],
                lambda s: mean([x["saved"] for x in s])),
            "saved_share_of_typical_request": mean(gains) / TYPICAL_REQUEST_CHARS,
            "lowest_follow_up_p_tuning": follow_t[0] if follow_t else None,
            "lowest_follow_up_p_held_out": follow_h[0] if follow_h else None,
            "threshold_without_tightest_tuning_label": loo_t,
            "recall_at_that_threshold": _recall(hcalls, loo_t),
            "tightest_tuning_label": tight["id"] if tight else None,
            "wrong_drops": sorted({c["id"] for c in hcalls if c["label"] and c["p"] < t}),
            "unstable_cases": sorted(k for k, v in per_case.items() if len(set(v)) > 1),
            **call_stats(records, held_ids, paid),
        })
    names = list(records_by_backend)
    comparisons = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            ra, rb = right_by[a], right_by[b]
            only_a = sum(ra[k] and not rb[k] for k in ra)
            only_b = sum(rb[k] and not ra[k] for k in ra)
            comparisons.append({"a": a, "b": b, "only_a": only_a, "only_b": only_b, "p": mcnemar_exact(only_a, only_b)})
    return results, comparisons, _table(results, comparisons, len(held))


def _pct(v, ci=None):
    if v is None:
        return "–"
    return f"{v * 100:.1f}%" + (f" ({ci[0] * 100:.1f}–{ci[1] * 100:.1f})" if ci else "")


def _table(results, comparisons, n):
    lines = [
        f"Held-out: {n} cases; each call scored on its own; intervals resample whole conversations.",
        "",
        "| Backend | Recall on follow-ups (95% CI) | Standalone dropped (95% CI) | Chars saved / message (95% CI) | Share of typical request | Threshold (lowest follow-up p: tuning / held-out) | Without tightest tuning label: threshold → held-out recall | Mean / p50 / p95 ms | Errors | $ / 1k |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        ci = r["saved_per_message_ci"] or (0, 0)
        cost = r["cost_per_decision_usd"]
        lines.append(
            f"| {r['backend']} | {_pct(r['recall'], r['recall_ci'])} | {_pct(r['drop_rate'], r['drop_rate_ci'])} | "
            f"{r['saved_per_message']:,.0f} ({ci[0]:,.0f}–{ci[1]:,.0f}) | {_pct(r['saved_share_of_typical_request'])} | "
            f"{r['threshold']:.3f} ({r['lowest_follow_up_p_tuning'] if r['lowest_follow_up_p_tuning'] is None else round(r['lowest_follow_up_p_tuning'], 3)} / "
            f"{r['lowest_follow_up_p_held_out'] if r['lowest_follow_up_p_held_out'] is None else round(r['lowest_follow_up_p_held_out'], 3)}) | "
            f"{r['threshold_without_tightest_tuning_label']:.3f} → {_pct(r['recall_at_that_threshold'])} | "
            f"{r['latency_mean_ms']} / {r['latency_p50_ms']} / {r['latency_p95_ms']} | {r['errors']}/{r['calls']} | "
            f"{'unknown' if cost is None else f'{cost * 1000:.4f}'} |"
        )
    lines += ["", "| Pair (per-case majority of runs) | Only first right | Only second right | McNemar p |", "|---|---|---|---|"]
    for c in comparisons:
        lines.append(f"| {c['a']} vs {c['b']} | {c['only_a']} | {c['only_b']} | {c['p']:.3g} |")
    return "\n".join(lines)
