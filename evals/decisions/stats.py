"""Small, dependency-free statistics for paired decision evals.

Everything is deterministic given a seed, so a report can be reproduced exactly.
"""

from __future__ import annotations

import math
import random
from typing import Callable, Sequence


def percentile(values: Sequence[float], share: float) -> float | None:
    """Nearest-rank percentile; None for no values."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(1, math.ceil(len(ordered) * share)) - 1]


def wilson(successes: int, total: int, z: float = 1.96) -> tuple[float, float] | None:
    """95% Wilson score interval for a proportion; stable at 0 and 1."""
    if total <= 0:
        return None
    p = successes / total
    denominator = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denominator
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return (max(0.0, centre - half), min(1.0, centre + half))


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided exact McNemar p-value.

    b: cases only the first system got right; c: cases only the second got right.
    Concordant cases carry no information about the difference, so they are ignored.
    """
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return min(1.0, 2 * tail)


def bootstrap(
    values: Sequence[float],
    statistic: Callable[[Sequence[float]], float],
    *,
    resamples: int = 4000,
    seed: int = 7,
) -> tuple[float, float] | None:
    """95% percentile bootstrap interval for statistic(values)."""
    if not values:
        return None
    rng = random.Random(seed)
    n = len(values)
    draws = sorted(
        statistic([values[rng.randrange(n)] for _ in range(n)]) for _ in range(resamples)
    )
    return (draws[int(0.025 * resamples)], draws[int(0.975 * resamples) - 1])


def mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else float("nan")


def cluster_bootstrap(
    items: Sequence,
    cluster: Callable,
    statistic: Callable[[Sequence], float | None],
    *,
    resamples: int = 4000,
    seed: int = 7,
) -> tuple[float, float] | None:
    """95% percentile bootstrap that resamples whole clusters.

    Calls of the same case, and cases of the same conversation, are not independent, so
    resampling clusters (not single items) keeps the interval honest. A resample whose
    statistic is undefined (for example no positives) is skipped.
    """
    groups: dict = {}
    for item in items:
        groups.setdefault(cluster(item), []).append(item)
    keys = list(groups)
    if not keys:
        return None
    rng = random.Random(seed)
    draws = []
    for _ in range(resamples):
        sample = [x for _ in keys for x in groups[keys[rng.randrange(len(keys))]]]
        value = statistic(sample)
        if value is not None:
            draws.append(value)
    if not draws:
        return None
    draws.sort()
    return (draws[int(0.025 * len(draws))], draws[max(0, int(0.975 * len(draws)) - 1)])


def cluster_interval(
    items: Sequence,
    cluster: Callable,
    statistic: Callable[[Sequence], float | None],
) -> tuple[float, float] | None:
    """Cluster bootstrap interval, or a Wilson interval over clusters when it is degenerate.

    With no failures (or no successes) every resample gives the same value, so the bootstrap
    would claim certainty. A Wilson interval with n = number of clusters is used instead,
    which treats each conversation or case as one independent observation.
    """
    ci = cluster_bootstrap(items, cluster, statistic)
    value = statistic(list(items))
    if ci is None or value is None or ci[0] != ci[1]:
        return ci
    n = len({cluster(x) for x in items})
    return wilson(round(value * n), n)
