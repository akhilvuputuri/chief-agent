"""Scores probabilistic return forecasts against realised log returns.

A forecast for one origin and horizon is a set of sampled log returns. It is compared with
the baseline any engine must beat: a zero-drift random walk whose spread comes from an EWMA
of the context's daily log returns (RiskMetrics lambda 0.94). Standard library only, so the
tests run in the repository's check without the runtime's dependencies.
"""

import math
import random
from statistics import fmean, median

TAUS = (0.1, 0.5, 0.9)
# Standard normal quantiles for TAUS.
NORMAL_Z = {0.1: -1.2815515655446004, 0.5: 0.0, 0.9: 1.2815515655446004}


def pinball(y: float, q: float, tau: float) -> float:
    d = y - q
    return max(tau * d, (tau - 1.0) * d)


def ewma_sigma(closes, lam: float = 0.94, seed_days: int = 20) -> float:
    """Daily log-return volatility, seeded with the mean square of the first returns."""
    logs = [math.log(float(c)) for c in closes]
    r = [b - a for a, b in zip(logs, logs[1:])]
    if len(r) < 2:
        raise ValueError("Need at least three closes")
    var = fmean(x * x for x in r[:seed_days])
    for x in r[seed_days:]:
        var = lam * var + (1.0 - lam) * x * x
    return math.sqrt(var)


def random_walk_quantiles(sigma_daily: float, horizon: int) -> dict:
    s = sigma_daily * math.sqrt(horizon)
    return {tau: NORMAL_Z[tau] * s for tau in TAUS}


def quantile(values, tau: float) -> float:
    """Linear interpolation between order statistics (numpy's default method)."""
    s = sorted(float(v) for v in values)
    if not s:
        raise ValueError("No samples")
    h = (len(s) - 1) * tau
    lo = math.floor(h)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (h - lo) * (s[hi] - s[lo])


def weibull_quantile(values, tau: float) -> float:
    """Interpolates at rank (n + 1) * tau, so the expected coverage of the interval between
    two sample quantiles equals their nominal coverage. With 32 samples the linear method's
    10-90% interval covers about 75% for a perfectly calibrated model."""
    s = sorted(float(v) for v in values)
    if not s:
        raise ValueError("No samples")
    h = (len(s) + 1) * tau
    if h <= 1:
        return s[0]
    if h >= len(s):
        return s[-1]
    lo = math.floor(h)
    return s[lo - 1] + (h - lo) * (s[lo] - s[lo - 1])


def sample_quantiles(samples) -> dict:
    s = [float(v) for v in samples]
    return {tau: weibull_quantile(s, tau) for tau in TAUS}


def _side(records, key):
    return {
        "coverage80": fmean(r[key][0.1] <= r["y"] <= r[key][0.9] for r in records),
        "pinball": fmean(fmean(pinball(r["y"], r[key][t], t) for t in TAUS) for r in records),
        "medianWidth80": median(r[key][0.9] - r[key][0.1] for r in records),
    }


def summarize(records) -> dict:
    """Each record has y (realised log return), model and baseline quantiles, and p_up.

    Coverage is for the 10-90% interval (80% nominal). Pinball is averaged over TAUS; skill
    above 0 means the model beat the baseline. A Brier score of 0.25 is a coin flip.
    """
    if not records:
        return {"n": 0}
    model, baseline = _side(records, "model"), _side(records, "baseline")
    up = [1.0 if r["y"] > 0 else 0.0 for r in records]
    signed = [(r["model"][0.5], r["y"]) for r in records if r["y"] != 0 and r["model"][0.5] != 0]
    return {
        "n": len(records),
        "model": model,
        "baseline": baseline,
        "pinballSkill": 1 - model["pinball"] / baseline["pinball"] if baseline["pinball"] > 0 else None,
        "brier": fmean((r["p_up"] - u) ** 2 for r, u in zip(records, up)),
        "upRate": fmean(up),
        "medianSignHitRate": fmean((m > 0) == (y > 0) for m, y in signed) if signed else None,
    }


def p_up_from_quantiles(levels, values) -> float:
    """P(value > 0) from quantile forecasts, interpolating the CDF linearly between them.

    Crossed quantiles are rearranged into order. Beyond the outermost quantile, half of the
    remaining tail mass is assumed to lie on each side of zero.
    """
    ls, xs = sorted(levels), sorted(float(v) for v in values)
    if 0 < xs[0]:
        cdf = ls[0] / 2
    elif 0 > xs[-1]:
        cdf = (1 + ls[-1]) / 2
    elif 0 == xs[-1]:
        cdf = ls[-1]
    else:
        i = max(k for k in range(len(xs)) if xs[k] <= 0)
        span = xs[i + 1] - xs[i]
        cdf = ls[i] + (ls[i + 1] - ls[i]) * ((0 - xs[i]) / span if span else 0.5)
    return 1 - cdf


def cluster_bootstrap_ci(values_by_cluster: dict, draws: int = 2000, seed: int = 0, block: int = 1) -> dict:
    """Mean of all values with a 95% interval from resampling whole clusters (e.g. dates),
    so values that move together on the same day are not counted as independent.

    With block > 1, runs of `block` consecutive clusters (in sorted key order) are resampled
    together, so dependence between nearby dates, such as volatility clustering, is kept.
    """
    keys = sorted(values_by_cluster)
    sums = {k: sum(values_by_cluster[k]) for k in keys}
    counts = {k: len(values_by_cluster[k]) for k in keys}
    if not keys or not sum(counts.values()):
        raise ValueError("No values")
    block = max(1, min(block, len(keys)))
    starts = len(keys) - block + 1
    rng = random.Random(seed)
    stats = []
    for _ in range(draws):
        pick = []
        while len(pick) < len(keys):
            first = rng.randrange(starts)
            pick.extend(keys[first : first + block])
        pick = pick[: len(keys)]
        stats.append(sum(sums[k] for k in pick) / sum(counts[k] for k in pick))
    stats.sort()
    return {
        "mean": sum(sums.values()) / sum(counts.values()),
        "low": stats[int(0.025 * draws)],
        "high": stats[int(0.975 * draws) - 1],
    }


def ranks(values) -> list:
    """1-based ranks, ties sharing their average rank."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    out = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for k in range(i, j + 1):
            out[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return out


def spearman(xs, ys) -> float:
    """Rank correlation; 0 when either side has no variation."""
    if len(xs) != len(ys) or len(xs) < 3:
        raise ValueError("Need at least three paired values")
    rx, ry = ranks(xs), ranks(ys)
    mx, my = fmean(rx), fmean(ry)
    sxy = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    sxx = sum((a - mx) ** 2 for a in rx)
    syy = sum((b - my) ** 2 for b in ry)
    return sxy / math.sqrt(sxx * syy) if sxx and syy else 0.0


def toy_long_signals(records, p_threshold: float = 0.55, round_trip_cost: float = 0.003) -> dict:
    """Long-only picks whose P(up) and median move clear the threshold and the cost.

    A toy check of whether any signal survives costs, not a trading simulation: no sizing,
    no overlap handling and log returns treated as additive.
    """
    nets = [
        r["y"] - round_trip_cost
        for r in records
        if r["p_up"] >= p_threshold and r["model"][0.5] > round_trip_cost
    ]
    return {
        "signals": len(nets),
        "meanNetLogReturn": fmean(nets) if nets else None,
        "netWinRate": fmean(n > 0 for n in nets) if nets else None,
    }
