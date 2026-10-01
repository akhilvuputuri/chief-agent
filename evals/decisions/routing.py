"""Decision 2: can one agent handle this message on its own (a fast path past Chief's routing)?

Today every domain request costs a coordinator model call whose only job is to call
agent_run. If a cheap decision names the agent with high confidence, the host could start
that agent directly and give Chief the report, saving that call. A wrong route wastes an
agent run and Chief still has to delegate, so precision of routed messages is the safety
metric and the share of routable messages routed correctly is the gain. Deferring to Chief
is never wrong; it just saves nothing.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import backends
from scoring import by_run, call_stats, majority
from stats import cluster_interval, mcnemar_exact, mean

NAME = "routing"
FIXTURES = "routing.json"
ROOT = Path(__file__).resolve().parents[2]

# Proxy for a saved coordinator call: mean latency and reported cost of all main-model calls,
# 25–30 Sep 2026 (CloudWatch model.completed, n=203, before #129). A coordinator call whose only
# job is agent_run is probably shorter, so savings expressed with these are an upper estimate.
MAIN_CALL_MS = 4200
MAIN_CALL_USD = 0.0208

# Cue domains → agent types, as in fixtures/gen_routing.py.
CUE_AGENT = {
    "gmail": "email",
    "calendar": "calendar",
    "daily": "daily",
    "routines": "daily",
    "jobs": "jobs",
    "research": "research",
    "media": "media",
    "parcels": "parcels",
    "library": "library",
    "watchlist": "stocks",
    "news": "news",
}


def _options() -> dict[str, str]:
    core = json.loads((ROOT / "plugins" / "core" / "plugin.json").read_text(encoding="utf-8"))
    research = json.loads((ROOT / "plugins" / "public-research" / "plugin.json").read_text(encoding="utf-8"))
    options = {a["id"]: a["description"] for a in core["agents"]}
    options["research"] = research["agents"][0]["description"]
    options["chief"] = (
        "None of these alone: small talk, general knowledge the assistant can answer itself, "
        "remembering a preference, earlier conversations, several of these areas at once, "
        "canvases, background tasks, skills, or job fit and interview preparation."
    )
    return options


OPTIONS = _options()
AGENTS = [o for o in OPTIONS if o != "chief"]

LLM_SYSTEM = (
    "You route a personal assistant's message to the one agent that can handle all of it, or to "
    "'chief' when none can on its own. Agents:\n"
    + "\n".join(f"- {k}: {v}" for k, v in OPTIONS.items())
    + '\nReply with JSON only: {"agent": one of the names above, "confidence": number from 0 to 1}'
)


def state(case: dict[str, Any]) -> dict[str, Any]:
    prior = case.get("prior") or []
    return {
        "latest_user_message": case["message"][:2000],
        "previous_turns": [
            {"user": t.get("user", "")[:500], "assistant": t.get("assistant", "")[:300]}
            for t in prior[-2:]
        ],
    }


def chief(case: dict[str, Any]) -> dict[str, Any]:
    return {"agent": "chief", "confidence": 1.0, "latency_ms": 0, "cost": 0.0, "error": None}


_cues: dict[str, list[str]] = {}


def rule(case: dict[str, Any]) -> dict[str, Any]:
    """The production word cues: route when they point at exactly one agent."""
    if case["message"] not in _cues:
        cases = json.loads((Path(__file__).parent / "fixtures" / FIXTURES).read_text(encoding="utf-8"))
        messages = [c["message"] for c in cases]
        out = subprocess.run(
            ["npx", "tsx", "evals/decisions/cues.ts"],
            cwd=ROOT, input=json.dumps(messages), capture_output=True, text=True, check=True,
        ).stdout
        _cues.update(zip(messages, json.loads(out.strip().splitlines()[-1])))
    agents = {CUE_AGENT[d] for d in _cues[case["message"]] if d in CUE_AGENT}
    other = [d for d in _cues[case["message"]] if d not in CUE_AGENT]
    agent = agents.pop() if len(agents) == 1 and not other else "chief"
    return {"agent": agent, "confidence": 1.0, "latency_ms": 0, "cost": 0.0, "error": None}


def jev(case: dict[str, Any], key: str) -> dict[str, Any]:
    r = backends.jev(
        key,
        state(case),
        {
            "agent": {
                "type": "choice",
                "instructions": "Which single agent can handle all of `latest_user_message` (read with `previous_turns`)? Choose chief when none can on its own.",
                "criteria": OPTIONS,
            }
        },
    )
    answer = (r["answers"] or {}).get("agent") if not r["error"] else None
    agent = answer.get("choice") if isinstance(answer, dict) else None
    probabilities = answer.get("probabilities") if isinstance(answer, dict) else None
    confidence = probabilities.get(agent) if isinstance(probabilities, dict) and agent else None
    return {
        "agent": agent if agent in OPTIONS else None,
        "confidence": confidence,
        "latency_ms": r["latency_ms"],
        "cost": r["cost"],
        "error": r["error"] or (None if agent in OPTIONS and confidence is not None else "no valid choice"),
        "model": r["model"],
    }


def flash(case: dict[str, Any], key: str) -> dict[str, Any]:
    s = state(case)
    prior = "\n".join(f"Earlier user: {t['user']}\nEarlier assistant: {t['assistant']}" for t in s["previous_turns"])
    r = backends.chat_json(key, LLM_SYSTEM, (prior + "\n" if prior else "") + f"Latest message: {s['latest_user_message']}")
    agent = confidence = None
    if not r["error"] and isinstance(r["answer"], dict):
        agent = r["answer"].get("agent")
        c = r["answer"].get("confidence")
        confidence = min(1.0, max(0.0, float(c))) if isinstance(c, (int, float)) else None
    ok = agent in OPTIONS and confidence is not None
    return {
        "agent": agent if ok else None,
        "confidence": confidence if ok else None,
        "latency_ms": r["latency_ms"],
        "cost": r["cost"],
        "error": r["error"] or (None if ok else "unparseable answer"),
        "model": r["model"],
    }


BACKENDS = {"chief": chief, "rule": rule, "jev": jev, "flash": flash}
PAID = {"jev", "flash"}


def _calls(records, cases):
    """One scored item per call. A failed call routes to chief (the safe fallback)."""
    index = {c["id"]: c for c in cases}
    out = []
    for r in records:
        c = index.get(r["id"])
        if c is None:
            continue
        ok = r["error"] is None and r["agent"] is not None
        out.append({"id": c["id"], "run": r["run"], "gold": c["gold"],
                    "agent": r["agent"] if ok else "chief",
                    "confidence": float(r["confidence"]) if ok else 0.0})
    return out


def route(call: dict[str, Any], threshold: float) -> str:
    """Fast-path target for one call, or chief."""
    if call["agent"] == "chief" or call["confidence"] < threshold:
        return "chief"
    return call["agent"]


def _routed(calls, t):
    return [c for c in calls if route(c, t) != "chief"]


def _precision(calls, t):
    routed = _routed(calls, t)
    return sum(route(c, t) == c["gold"] for c in routed) / len(routed) if routed else None


def _hit(c, t):
    return route(c, t) != "chief" and route(c, t) == c["gold"]


def _tune(calls, min_precision):
    """Most correct routes with precision >= min_precision on tuning calls; ties take the
    higher (more conservative) threshold. Candidates come from tuning confidences only."""
    best_t, best_correct = 1.01, -1
    for t in sorted({c["confidence"] for c in calls}):
        p = _precision(calls, t)
        if p is not None and p + 1e-12 < min_precision:
            continue
        correct = sum(_hit(c, t) for c in calls)
        if correct >= best_correct:
            best_t, best_correct = t, correct
    return best_t


def evaluate(cases, records_by_backend, args):
    tuning = [c for c in cases if c["split"] == "tuning"]
    held = [c for c in cases if c["split"] == "held-out"]
    held_ids = {c["id"] for c in held}
    results, hits_by = [], {}
    for name, records in records_by_backend.items():
        paid = name in PAID
        tcalls, hcalls = _calls(records, tuning), _calls(records, held)
        t = _tune(tcalls, args.min_precision) if paid else 0.0
        routed = _routed(hcalls, t)
        correct = [c for c in routed if c["gold"] == c["agent"]]
        routable = [c for c in hcalls if c["gold"] != "chief"]
        per_case: dict[str, list[bool]] = {}
        for c in hcalls:
            per_case.setdefault(c["id"], []).append(_hit(c, t))
        hits_by[name] = majority(per_case)
        stats = call_stats(records, held_ids, paid)
        saved_rate = len(correct) / len(hcalls) if hcalls else 0.0
        decision_usd = stats["cost_per_decision_usd"]
        cluster = lambda c: c["id"]  # noqa: E731  (a case's runs are one cluster)
        results.append({
            "backend": name,
            "threshold": t,
            "calls_scored": len(hcalls),
            "routed": len(routed),
            "correct": len(correct),
            "wrong": len(routed) - len(correct),
            "precision": _precision(hcalls, t),
            # Over routed calls only: each routed case is one cluster.
            "precision_ci": cluster_interval(
                routed, cluster, lambda s: sum(c["gold"] == c["agent"] for c in s) / len(s) if s else None),
            "routed_cases": len({c["id"] for c in routed}),
            "precision_by_run": by_run(hcalls, lambda s: _precision(s, t)),
            "coverage": len(correct) / len(routable) if routable else None,
            "coverage_ci": cluster_interval(
                routable, cluster, lambda s: sum(_hit(c, t) for c in s) / len(s) if s else None),
            "calls_saved_per_100": saved_rate * 100,
            "calls_saved_per_100_ci": [v * 100 for v in (cluster_interval(
                hcalls, cluster, lambda s: sum(_hit(c, t) for c in s) / len(s) if s else None) or (0.0, 0.0))],
            # Per message: saved coordinator calls minus this decision's own mean latency and cost.
            "net_ms_per_message": saved_rate * MAIN_CALL_MS - stats["latency_mean_ms"],
            # Unknown when a paid backend reported no cost; never silently free.
            "net_usd_per_1000": None if decision_usd is None else (saved_rate * MAIN_CALL_USD - decision_usd) * 1000,
            "wrong_routes": sorted({f"{c['id']} (run {c['run']} → {c['agent']})" for c in routed if c["gold"] != c["agent"]}),
            "unstable_cases": sorted(k for k, v in per_case.items() if len(set(v)) > 1),
            **stats,
        })
    names = list(records_by_backend)
    comparisons = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            ra, rb = hits_by[a], hits_by[b]
            only_a = sum(ra[k] and not rb[k] for k in ra)
            only_b = sum(rb[k] and not ra[k] for k in ra)
            comparisons.append({"a": a, "b": b, "only_a": only_a, "only_b": only_b, "p": mcnemar_exact(only_a, only_b)})
    return results, comparisons, _table(results, comparisons, len(held), sum(c["gold"] != "chief" for c in held))


def _table(results, comparisons, n, routable) -> str:
    def pct(v, ci=None):
        if v is None:
            return "–"
        return f"{v * 100:.1f}%" + (f" ({ci[0] * 100:.1f}–{ci[1] * 100:.1f})" if ci else "")

    lines = [
        f"Held-out: {n} messages, {routable} routable to one agent. One call per message, as in production; each run is scored on its own and intervals resample whole cases.",
        "",
        "| Backend | Threshold | Routed calls (wrong) | Precision (95% CI) | Precision by run | Coverage of routable (95% CI) | Coordinator calls saved / 100 msgs (95% CI) | Net ms / message | Net $ / 1k msgs | Mean / p50 / p95 ms | Errors | Decision $ / 1k |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        ci = r["calls_saved_per_100_ci"]
        cost = r["cost_per_decision_usd"]
        runs = " / ".join(pct(v) for v in r["precision_by_run"])
        lines.append(
            f"| {r['backend']} | {r['threshold']:.3f} | {r['routed']} ({r['wrong']}) | {pct(r['precision'], r['precision_ci'])} | {runs} | "
            f"{pct(r['coverage'], r['coverage_ci'])} | {r['calls_saved_per_100']:.1f} ({ci[0]:.1f}–{ci[1]:.1f}) | "
            f"{r['net_ms_per_message']:,.0f} | {'unknown' if r['net_usd_per_1000'] is None else f'{r[\'net_usd_per_1000\']:.2f}'} | "
            f"{r['latency_mean_ms']} / {r['latency_p50_ms']} / {r['latency_p95_ms']} | {r['errors']}/{r['calls']} | "
            f"{'unknown' if cost is None else f'{cost * 1000:.4f}'} |"
        )
    lines += ["", "| Pair (correct fast paths, per-case majority of runs) | Only first | Only second | McNemar p |", "|---|---|---|---|"]
    for c in comparisons:
        lines.append(f"| {c['a']} vs {c['b']} | {c['only_a']} | {c['only_b']} | {c['p']:.3g} |")
    return "\n".join(lines)
