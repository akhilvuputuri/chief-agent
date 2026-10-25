"""Weekly cross-sectional ranking test: can a model order stocks by their next-week return?

Every origin date, each engine scores every eligible stock; the scores are compared with the
realised 5-session log returns (docs/kronos-trading-experiment.md, journal 122).

Engines, with settings fixed in SETTINGS before a run:
- chronos-2 and timesfm-2.5: the median forecast 5-session log return (models and revisions
  as in leaderboard.SETTINGS), from up to `context` closes.
- momentum: the log return from 65 to 5 sessions before the origin (skipping the last week).
- reversal: minus the last week's log return.

Scores per engine: the per-date Spearman rank correlation (IC); a long-short spread (top
minus bottom decile) and a long-only spread (top decile minus the universe average), gross
and net of a round-trip cost on the names that changed. Intervals resample blocks of
consecutive dates. Universe: today's S&P 100 members, so it is survivorship-biased.
Usage: python ranking.py --bars-dir DIR --symbols-file FILE [--engines ...] [--rows-out FILE]
"""

import argparse
import contextlib
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import leaderboard  # noqa: E402
import scoring  # noqa: E402

SETTINGS = {
    "calendar": "SPY",
    "horizon": 5,
    "origins": 60,
    "step": 5,
    "minHistory": 252,
    "context": 512,
    "decile": 0.1,
    "minNames": 20,
    "roundTripCost": 0.003,
    "bootstrapBlock": 4,
    "momentum": {"from": 65, "to": 5},
    "seed": 7,
}
ENGINES = ["chronos-2", "timesfm-2.5", "momentum", "reversal"]


def load(bars_dir, symbol):
    import kronos_runner as kr

    _, df = kr.load_bars(os.path.join(bars_dir, f"{symbol}.json"))
    return [str(d.date()) for d in df["datetime"]], df["close"].to_numpy(dtype=float)


def eligible(dates, closes, origin_dates):
    """(origin date, index) pairs with enough history before and a full horizon after."""
    at = {d: i for i, d in enumerate(dates)}
    out = []
    for d in origin_dates:
        i = at.get(d)
        if i is not None and i >= SETTINGS["minHistory"] and i + SETTINGS["horizon"] < len(closes):
            out.append((d, i))
    return out


class Models:
    """Loads each model once for the whole universe."""

    def __init__(self, engines):
        self.chronos = self.timesfm = None
        with contextlib.redirect_stdout(sys.stderr):
            if "chronos-2" in engines:
                from chronos import Chronos2Pipeline

                s = leaderboard.SETTINGS["chronos"]
                self.chronos = Chronos2Pipeline.from_pretrained(s["repo"], revision=s["revision"], device_map="cpu")
            if "timesfm-2.5" in engines:
                import timesfm

                s = leaderboard.SETTINGS["timesfm"]
                self.timesfm = timesfm.TimesFM_2p5_200M_torch.from_pretrained(s["repo"], revision=s["revision"])
                self.timesfm.compile(
                    timesfm.ForecastConfig(
                        max_context=SETTINGS["context"],
                        max_horizon=128,
                        normalize_inputs=True,
                        use_continuous_quantile_head=True,
                        force_flip_invariance=True,
                        infer_is_positive=True,
                        fix_quantile_crossing=True,
                    )
                )

    def medians(self, engine, contexts):
        """Median close at the horizon for each context."""
        h = SETTINGS["horizon"]
        if engine == "chronos-2":
            import torch

            q, _ = self.chronos.predict_quantiles(
                [torch.tensor(c, dtype=torch.float32) for c in contexts], prediction_length=h, quantile_levels=[0.5]
            )
            return [float(x[0][h - 1][0]) for x in q]
        _, q = self.timesfm.forecast(horizon=h, inputs=contexts)
        return [float(np.asarray(x)[h - 1][5]) for x in q]  # column 5 is the 0.5 quantile


def score_symbol(models, engine, closes, points):
    if engine == "momentum":
        m = SETTINGS["momentum"]
        return [math.log(closes[i - m["to"]] / closes[i - m["from"]]) for _, i in points]
    if engine == "reversal":
        return [-math.log(closes[i] / closes[i - SETTINGS["horizon"]]) for _, i in points]
    contexts = [closes[max(0, i - SETTINGS["context"] + 1) : i + 1] for _, i in points]
    return [math.log(m / closes[i]) for m, (_, i) in zip(models.medians(engine, contexts), points)]


def summarize(by_date):
    """by_date: {date: [(symbol, score, realised log return), ...]} for one engine."""
    k = SETTINGS["decile"]
    cost = SETTINGS["roundTripCost"]
    ics, longshort, longonly, turnovers = {}, {}, {}, []
    previous_top = previous_bottom = None
    for date in sorted(by_date):
        rows = by_date[date]
        if len(rows) < SETTINGS["minNames"]:
            continue
        ics[date] = [scoring.spearman([r[1] for r in rows], [r[2] for r in rows])]
        ordered = sorted(rows, key=lambda r: r[1])
        n = max(1, round(len(rows) * k))
        top, bottom = {r[0] for r in ordered[-n:]}, {r[0] for r in ordered[:n]}
        y = {r[0]: r[2] for r in rows}
        mean = sum(y.values()) / len(y)
        top_mean = sum(y[s] for s in top) / n
        bottom_mean = sum(y[s] for s in bottom) / n
        turn_top = 1.0 if previous_top is None else len(top - previous_top) / n
        turn_bottom = 1.0 if previous_bottom is None else len(bottom - previous_bottom) / n
        previous_top, previous_bottom = top, bottom
        turnovers.append(turn_top)
        longshort[date] = (top_mean - bottom_mean, top_mean - bottom_mean - cost * (turn_top + turn_bottom))
        longonly[date] = (top_mean - mean, top_mean - mean - cost * turn_top)

    def ci(values):
        return scoring.cluster_bootstrap_ci(
            {d: [v] for d, v in values.items()}, seed=SETTINGS["seed"], block=SETTINGS["bootstrapBlock"]
        )

    if not ics:
        return {"dates": 0}
    return {
        "dates": len(ics),
        "meanNames": round(sum(len(by_date[d]) for d in ics) / len(ics), 1),
        "ic": ci({d: v[0] for d, v in ics.items()}),
        "icPositiveShare": sum(v[0] > 0 for v in ics.values()) / len(ics),
        "longShortGross": ci({d: v[0] for d, v in longshort.items()}),
        "longShortNet": ci({d: v[1] for d, v in longshort.items()}),
        "longOnlyGross": ci({d: v[0] for d, v in longonly.items()}),
        "longOnlyNet": ci({d: v[1] for d, v in longonly.items()}),
        "meanTopTurnover": sum(turnovers) / len(turnovers),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bars-dir", required=True)
    parser.add_argument("--symbols-file", required=True, help="Comma- or whitespace-separated symbols")
    parser.add_argument("--engines", type=lambda s: s.split(","), default=ENGINES)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--rows-out")
    args = parser.parse_args()
    unknown = set(args.engines) - set(ENGINES)
    if unknown:
        raise SystemExit(f"Unknown engines {sorted(unknown)}")

    import torch

    torch.set_num_threads(args.threads)
    symbols = [s for s in open(args.symbols_file).read().replace(",", " ").split() if s]
    cal_dates, _ = load(args.bars_dir, SETTINGS["calendar"])
    last = len(cal_dates) - 1 - SETTINGS["horizon"]
    origin_dates = sorted(cal_dates[last - k * SETTINGS["step"]] for k in range(SETTINGS["origins"]))

    models = Models(args.engines)
    rows = {e: {} for e in args.engines}
    seconds = {e: 0.0 for e in args.engines}
    for symbol in symbols:
        dates, closes = load(args.bars_dir, symbol)
        points = eligible(dates, closes, origin_dates)
        if not points:
            continue
        realised = [math.log(closes[i + SETTINGS["horizon"]] / closes[i]) for _, i in points]
        for engine in args.engines:
            started = time.perf_counter()
            scores = score_symbol(models, engine, closes, points)
            seconds[engine] += time.perf_counter() - started
            for (d, _), s, y in zip(points, scores, realised):
                rows[engine].setdefault(d, []).append((symbol, s, y))
        print(f"{symbol} done", file=sys.stderr, flush=True)

    results = {}
    for engine in args.engines:
        recent = {d: v for d, v in rows[engine].items() if d >= "2026-01-01"}
        results[engine] = {
            "seconds": round(seconds[engine], 1),
            "all": summarize(rows[engine]),
            "2026": summarize(recent),
        }
    if args.rows_out:
        with open(args.rows_out, "w") as f:
            json.dump(rows, f)
    json.dump(
        {"settings": SETTINGS, "originDates": [origin_dates[0], origin_dates[-1]], "results": results},
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
