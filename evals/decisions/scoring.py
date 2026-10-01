"""Shared per-call scoring helpers. Production makes one decision call per message, so every
call is scored on its own; repeated runs add samples and show run-to-run spread."""

from __future__ import annotations

from typing import Any, Callable

from stats import mean, percentile


def call_stats(records: list[dict[str, Any]], held_ids: set[str], paid: bool) -> dict[str, Any]:
    calls = [r for r in records if r["id"] in held_ids]
    ok = [r for r in calls if r["error"] is None]
    latencies = [r["latency_ms"] for r in ok]
    costs = [r["cost"] for r in calls if isinstance(r.get("cost"), (int, float))]
    return {
        "calls": len(calls),
        "errors": len(calls) - len(ok),
        "calls_without_cost": len(calls) - len(costs) if paid else 0,
        "latency_mean_ms": round(mean(latencies)) if latencies else 0,
        "latency_p50_ms": percentile(latencies, 0.5) or 0,
        "latency_p95_ms": percentile(latencies, 0.95) or 0,
        # Mean reported cost of one decision; unknown (None) when a paid backend reports none.
        "cost_per_decision_usd": (sum(costs) / len(costs)) if costs else (None if paid else 0.0),
    }


def majority(per_case: dict[str, list[bool]]) -> dict[str, bool]:
    """A case counts as right when most of its calls are right (ties count as wrong)."""
    return {k: sum(v) * 2 > len(v) for k, v in per_case.items()}


def by_run(calls: list[dict[str, Any]], metric: Callable[[list[dict[str, Any]]], float | None]) -> list[float | None]:
    runs = sorted({c["run"] for c in calls})
    return [metric([c for c in calls if c["run"] == r]) for r in runs]
