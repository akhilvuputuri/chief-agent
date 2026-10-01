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
from stats import bootstrap, mcnemar_exact, mean, percentile, wilson

NAME = "routing"
FIXTURES = "routing.json"
ROOT = Path(__file__).resolve().parents[2]

# Production coordinator calls, 25–30 Sep 2026 (CloudWatch model.completed, n=203, before
# #129): mean latency and reported cost per main-model call. Used only to express a saved
# call in seconds and dollars.
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


def _decisions(records: list[dict[str, Any]]) -> dict[str, list[tuple[str, float]]]:
    out: dict[str, list[tuple[str, float]]] = {}
    for r in records:
        if r["error"] is None and r["agent"] is not None:
            out.setdefault(r["id"], []).append((r["agent"], float(r["confidence"])))
    return out


def route(answers: list[tuple[str, float]] | None, threshold: float) -> str:
    """Fast-path target, or chief. Runs must agree on the agent and average >= threshold."""
    if not answers:
        return "chief"
    agents = {a for a, _ in answers}
    if len(agents) != 1:
        return "chief"
    agent = agents.pop()
    if agent == "chief" or mean([c for _, c in answers]) < threshold:
        return "chief"
    return agent


def _score(cases, decided, threshold):
    routed = correct = 0
    hits = []
    for c in cases:
        target = route(decided.get(c["id"]), threshold)
        hit = target != "chief" and target == c["gold"]
        routed += target != "chief"
        correct += hit
        hits.append(1.0 if hit else 0.0)
    return routed, correct, hits


def _tune(cases, decided, min_precision):
    best = (1.01, -1)
    for t in sorted({0.0} | {c for v in decided.values() for _, c in v}):
        routed, correct, _ = _score(cases, decided, t)
        precision = correct / routed if routed else 1.0
        if precision + 1e-12 >= min_precision and correct > best[1]:
            best = (t, correct)
    return best[0]


def evaluate(cases, records_by_backend, args):
    tuning = [c for c in cases if c["split"] == "tuning"]
    held = [c for c in cases if c["split"] == "held-out"]
    held_ids = {c["id"] for c in held}
    routable = sum(c["gold"] != "chief" for c in held)
    results, hits_by = [], {}
    for name, records in records_by_backend.items():
        decided = _decisions(records)
        threshold = _tune(tuning, decided, args.min_precision) if name in PAID else 0.0
        routed, correct, hits = _score(held, decided, threshold)
        hits_by[name] = hits
        calls = [r for r in records if r["id"] in held_ids]
        latencies = [r["latency_ms"] for r in calls if r["error"] is None]
        costs = [r["cost"] for r in calls if isinstance(r.get("cost"), (int, float))]
        # One decision call per message in production; each eval call is one such call.
        per_message_decision_usd = sum(costs) / len(calls) if calls else 0.0
        saved_rate = correct / len(held)
        p50 = percentile(latencies, 0.5) or 0
        results.append({
            "backend": name,
            "threshold": threshold,
            "routed": routed,
            "correct": correct,
            "wrong": routed - correct,
            "precision": correct / routed if routed else None,
            "precision_ci": wilson(correct, routed),
            "coverage": correct / routable if routable else None,
            "coverage_ci": wilson(correct, routable),
            "calls_saved_per_100": saved_rate * 100,
            "calls_saved_per_100_ci": [v * 100 for v in bootstrap(hits, mean)],
            # Net wall time per message: saved coordinator calls minus the decision's own latency.
            "net_ms_per_message": saved_rate * MAIN_CALL_MS - p50,
            "net_usd_per_1000": saved_rate * MAIN_CALL_USD * 1000 - per_message_decision_usd * 1000,
            "latency_p50_ms": percentile(latencies, 0.5),
            "latency_p95_ms": percentile(latencies, 0.95),
            "errors": sum(r["error"] is not None for r in calls),
            "calls": len(calls),
            "cost_per_1000_usd": per_message_decision_usd * 1000,
            "unstable_cases": sorted(k for k, v in decided.items() if k in held_ids and len({a for a, _ in v}) > 1),
            "wrong_routes": sorted(
                c["id"] for c in held
                if route(decided.get(c["id"]), threshold) not in ("chief", c["gold"])
            ),
        })
    names = list(records_by_backend)
    comparisons = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            only_a = sum(x == 1 and y == 0 for x, y in zip(hits_by[a], hits_by[b]))
            only_b = sum(y == 1 and x == 0 for x, y in zip(hits_by[a], hits_by[b]))
            comparisons.append({"a": a, "b": b, "only_a": only_a, "only_b": only_b, "p": mcnemar_exact(only_a, only_b)})
    return results, comparisons, _table(results, comparisons, len(held), routable)


def _table(results, comparisons, n, routable) -> str:
    def pct(v, ci=None):
        if v is None:
            return "–"
        return f"{v * 100:.1f}%" + (f" ({ci[0] * 100:.1f}–{ci[1] * 100:.1f})" if ci else "")

    lines = [
        f"Held-out: {n} messages, {routable} routable to one agent.",
        "",
        "| Backend | Routed | Precision of routes (95% CI) | Coverage of routable (95% CI) | Coordinator calls saved / 100 msgs (95% CI) | Net ms / message (before wrong-route cost) | Net $ / 1k msgs (same) | p50 / p95 ms | Errors | Decision $ / 1k |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        ci = r["calls_saved_per_100_ci"]
        lines.append(
            f"| {r['backend']} | {r['routed']} ({r['wrong']} wrong) | {pct(r['precision'], r['precision_ci'])} | {pct(r['coverage'], r['coverage_ci'])} | "
            f"{r['calls_saved_per_100']:.1f} ({ci[0]:.1f}–{ci[1]:.1f}) | {r['net_ms_per_message']:,.0f} | {r['net_usd_per_1000']:.2f} | "
            f"{r['latency_p50_ms']} / {r['latency_p95_ms']} | {r['errors']}/{r['calls']} | {r['cost_per_1000_usd']:.4f} |"
        )
    lines += ["", "| Pair (correct fast paths) | Only first | Only second | McNemar p |", "|---|---|---|---|"]
    for c in comparisons:
        lines.append(f"| {c['a']} vs {c['b']} | {c['only_a']} | {c['only_b']} | {c['p']:.3g} |")
    return "\n".join(lines)
