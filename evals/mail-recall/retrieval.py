"""Ranking, fusion and scoring for the mail recall eval. Standard library only."""
from __future__ import annotations

import math
import random
import re
from collections import Counter, defaultdict
from typing import Iterable, Sequence

TOKEN = re.compile(r"[a-z0-9]+")
STOP = frozenset(
    "a an and are as at be but by for from has have i in is it its me my of on or our "
    "so that the their there this to was we were what when which who will with you your".split()
)


def tokens(text: str) -> list[str]:
    return [t for t in TOKEN.findall(text.lower()) if t not in STOP and len(t) > 1]


class BM25:
    """Okapi BM25 over whole documents (k1 1.2, b 0.75)."""

    def __init__(self, docs: dict[str, str], k1: float = 1.2, b: float = 0.75):
        self.k1, self.b = k1, b
        self.terms = {doc_id: Counter(tokens(text)) for doc_id, text in docs.items()}
        self.lengths = {doc_id: sum(c.values()) for doc_id, c in self.terms.items()}
        self.average = (sum(self.lengths.values()) / len(self.lengths)) if self.lengths else 0.0
        frequency: Counter[str] = Counter()
        for counts in self.terms.values():
            frequency.update(counts.keys())
        n = len(self.terms)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in frequency.items()}

    def rank(self, query: str) -> list[str]:
        q = set(tokens(query))
        scores: dict[str, float] = {}
        for doc_id, counts in self.terms.items():
            norm = self.k1 * (1 - self.b + self.b * self.lengths[doc_id] / (self.average or 1))
            score = sum(
                self.idf[t] * counts[t] * (self.k1 + 1) / (counts[t] + norm)
                for t in q
                if counts.get(t)
            )
            if score > 0:
                scores[doc_id] = score
        return sorted(scores, key=lambda d: (-scores[d], d))


def dense_ranking(chunk_scores: dict[str, float], chunk_message: dict[str, str], top: int = 1) -> list[str]:
    """Messages ranked by the mean of their best `top` chunk scores (top=1 is production)."""
    by_message: dict[str, list[float]] = defaultdict(list)
    for chunk_id, score in chunk_scores.items():
        message = chunk_message.get(chunk_id)
        if message is not None:
            by_message[message].append(score)
    value = {m: sum(sorted(s, reverse=True)[:top]) / min(top, len(s)) for m, s in by_message.items()}
    return sorted(value, key=lambda m: (-value[m], m))


def keyword_ranking(lists: Sequence[Sequence[str]]) -> list[str]:
    """Gmail results in the order the agent reads them: query by query, each in Gmail's order."""
    seen: list[str] = []
    for results in lists:
        for message in results:
            if message not in seen:
                seen.append(message)
    return seen


def rrf(rankings: Iterable[Sequence[str]], k: int = 60) -> list[str]:
    """Reciprocal rank fusion: each list adds 1 / (k + rank) to every item it ranks."""
    score: dict[str, float] = defaultdict(float)
    for ranking in rankings:
        for position, item in enumerate(ranking, start=1):
            score[item] += 1.0 / (k + position)
    return sorted(score, key=lambda i: (-score[i], i))


def rank_of(target: str, ranking: Sequence[str]) -> int | None:
    try:
        return ranking.index(target) + 1
    except ValueError:
        return None


def found(rank: int | None, k: int) -> bool:
    return rank is not None and rank <= k


def reciprocal(rank: int | None, k: int = 10) -> float:
    return 1.0 / rank if rank is not None and rank <= k else 0.0


def wilson(hits: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if not n:
        return (0.0, 0.0)
    p = hits / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, centre - half), min(1.0, centre + half))


def mcnemar(a: Sequence[bool], b: Sequence[bool]) -> tuple[int, int, float]:
    """Exact two-sided McNemar test on paired outcomes: (only a, only b, p)."""
    only_a = sum(1 for x, y in zip(a, b) if x and not y)
    only_b = sum(1 for x, y in zip(a, b) if y and not x)
    n = only_a + only_b
    if not n:
        return (0, 0, 1.0)
    tail = sum(math.comb(n, i) for i in range(min(only_a, only_b) + 1)) / 2**n
    return (only_a, only_b, min(1.0, 2 * tail))


def paired_bootstrap(a: Sequence[float], b: Sequence[float], rounds: int = 2000, seed: int = 7) -> tuple[float, float, float]:
    """Mean of a - b with a 95% percentile interval, resampling questions with replacement."""
    if not a:
        return (0.0, 0.0, 0.0)
    rng = random.Random(seed)
    n = len(a)
    diffs = [x - y for x, y in zip(a, b)]
    means = sorted(sum(diffs[rng.randrange(n)] for _ in range(n)) / n for _ in range(rounds))
    return (sum(diffs) / n, means[int(0.025 * rounds)], means[int(0.975 * rounds) - 1])
