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
