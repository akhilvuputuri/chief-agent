"""Walk-forward leaderboard of open-weight forecasters and baselines on daily bars.

Every engine forecasts the same origins of the same symbols, and every forecast is scored on
log returns against the realised move (docs/kronos-trading-experiment.md, journal 121).

Engines, with settings fixed in SETTINGS before a run:
- ewma: zero-drift random walk with an EWMA (lambda 0.94) spread; the reference for skill.
- garch: zero-mean GARCH(1,1) with Student-t errors, fitted per origin with `arch`.
- kronos-small: sampled paths in eval mode (kronos_runner), quantiles from the samples.
- chronos-2 and timesfm-2.5: their quantile heads on the close series, pinned by revision.

Output: JSON with, per engine and horizon, pooled scores, the pinball difference to ewma with
a 95% interval from resampling whole origin dates, per-symbol skill and a 2026-only subset.
Usage: python leaderboard.py --bars-dir DIR --symbols AAPL,MSFT,... [--engines ...]
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
import scoring  # noqa: E402

SETTINGS = {
    "horizon": 5,
    "horizons": [1, 5],
    "origins": 60,
    "step": 5,
    "volWindow": 500,
    "kronos": {"model": "Kronos-small", "lookback": 64, "samples": 64, "mode": "eval", "topP": 0.9},
    "chronos": {"repo": "amazon/chronos-2", "revision": "29ec3766d36d6f73f0696f85560a422f50e8498c", "context": 512},
    "timesfm": {
        "repo": "google/timesfm-2.5-200m-pytorch",
        "revision": "1d952420fba87f3c6dee4f240de0f1a0fbc790e3",
        "context": 512,
    },
    "seed": 7,
}
LEVELS = [round(0.1 * i, 1) for i in range(1, 10)]
ENGINES = ["ewma", "garch", "kronos-small", "chronos-2", "timesfm-2.5"]


def closes_of(df):
    return df["close"].to_numpy(dtype=float)


def origin_indices(n):
    """Most recent origins first in time order; each has volWindow bars before it and a full
    horizon of realised bars after it."""
    need = max(SETTINGS["volWindow"], SETTINGS["chronos"]["context"], SETTINGS["timesfm"]["context"])
    last = n - 1 - SETTINGS["horizon"]
    picks = [last - k * SETTINGS["step"] for k in range(SETTINGS["origins"])]
    return [t for t in picks if t - need + 1 >= 0][::-1]


def from_levels(log_q):
    """Quantile dict for TAUS plus P(up) from log-return quantiles at LEVELS."""
    q = {tau: float(log_q[LEVELS.index(tau)]) for tau in scoring.TAUS}
    return q, scoring.p_up_from_quantiles(LEVELS, log_q)


def ewma_engine(df, origins):
    c, w = closes_of(df), SETTINGS["volWindow"]
    out = []
    for t in origins:
        sigma = scoring.ewma_sigma(c[t - w + 1 : t + 1])
        out.append({h: (scoring.random_walk_quantiles(sigma, h), 0.5) for h in SETTINGS["horizons"]})
    return out


def garch_engine(df, origins):
    from arch import arch_model
    from scipy.stats import t as student

    c, w = closes_of(df), SETTINGS["volWindow"]
    out = []
    for t in origins:
        r = 100 * np.diff(np.log(c[t - w + 1 : t + 1]))
        fit = arch_model(r, mean="Zero", vol="GARCH", p=1, q=1, dist="t").fit(disp="off")
        var = fit.forecast(horizon=SETTINGS["horizon"], reindex=False).variance.to_numpy()[-1]
        nu = float(fit.params["nu"])
        unit = math.sqrt((nu - 2) / nu)  # Student-t scaled to unit variance
        per_h = {}
        for h in SETTINGS["horizons"]:
            s = math.sqrt(float(var[:h].sum())) / 100
            per_h[h] = ({tau: s * unit * float(student.ppf(tau, nu)) for tau in scoring.TAUS}, 0.5)
        out.append(per_h)
    return out


def kronos_engine(df, origins):
    import torch

    import kronos_runner as kr

    k = SETTINGS["kronos"]
    torch.manual_seed(SETTINGS["seed"])
    tokenizer, model = kr.load_model(os.environ.get("KRONOS_WEIGHTS", "/opt/kronos-weights"), k["model"], k["mode"])
    windows = [df.iloc[t - k["lookback"] + 1 : t + 1] for t in origins]
    futures = [list(df["datetime"].iloc[t + 1 : t + 1 + SETTINGS["horizon"]]) for t in origins]
    with torch.no_grad():
        paths = kr.sample_paths(tokenizer, model, windows, futures, SETTINGS["horizon"], k["samples"], 64, 1.0, k["topP"])
    c = closes_of(df)
    out = []
    for i, t in enumerate(origins):
        per_h = {}
        for h in SETTINGS["horizons"]:
            sampled = np.log(paths[i, :, h - 1, kr.CLOSE] / c[t])
            per_h[h] = (scoring.sample_quantiles(sampled), float(np.mean(sampled > 0)))
        out.append(per_h)
    return out


def chronos_engine(df, origins):
    import torch
    from chronos import Chronos2Pipeline

    s = SETTINGS["chronos"]
    with contextlib.redirect_stdout(sys.stderr):
        pipe = Chronos2Pipeline.from_pretrained(s["repo"], revision=s["revision"], device_map="cpu")
    c = closes_of(df)
    inputs = [torch.tensor(c[t - s["context"] + 1 : t + 1], dtype=torch.float32) for t in origins]
    quantiles, _ = pipe.predict_quantiles(inputs, prediction_length=SETTINGS["horizon"], quantile_levels=LEVELS)
    out = []
    for i, t in enumerate(origins):
        q = quantiles[i][0].numpy()  # (horizon, levels) for the single variate
        out.append({h: from_levels(np.log(q[h - 1] / c[t])) for h in SETTINGS["horizons"]})
    return out


def timesfm_engine(df, origins):
    import timesfm

    s = SETTINGS["timesfm"]
    with contextlib.redirect_stdout(sys.stderr):
        model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(s["repo"], revision=s["revision"])
        model.compile(
            timesfm.ForecastConfig(
                max_context=s["context"],
                max_horizon=128,
                normalize_inputs=True,
                use_continuous_quantile_head=True,
                force_flip_invariance=True,
                infer_is_positive=True,
                fix_quantile_crossing=True,
            )
        )
    c = closes_of(df)
    _, quantiles = model.forecast(
        horizon=SETTINGS["horizon"], inputs=[c[t - s["context"] + 1 : t + 1] for t in origins]
    )
    out = []
    for i, t in enumerate(origins):
        q = np.asarray(quantiles[i])[:, 1:10]  # column 0 is the mean, then deciles 0.1-0.9
        out.append({h: from_levels(np.log(q[h - 1] / c[t])) for h in SETTINGS["horizons"]})
    return out


RUNNERS = {
    "ewma": ewma_engine,
    "garch": garch_engine,
    "kronos-small": kronos_engine,
    "chronos-2": chronos_engine,
    "timesfm-2.5": timesfm_engine,
}


def mean_pinball(y, q):
    return sum(scoring.pinball(y, q[tau], tau) for tau in scoring.TAUS) / len(scoring.TAUS)


def summarize_engine(rows, reference):
    """rows and reference: records with y, q, p_up, date and symbol, aligned one to one."""
    if not rows:
        return {"n": 0}
    records = [{"y": r["y"], "model": r["q"], "baseline": b["q"], "p_up": r["p_up"]} for r, b in zip(rows, reference)]
    by_date, by_symbol = {}, {}
    for r, b in zip(rows, reference):
        d = mean_pinball(r["y"], r["q"]) - mean_pinball(b["y"], b["q"])
        by_date.setdefault(r["date"], []).append(d)
        by_symbol.setdefault(r["symbol"], []).append((mean_pinball(r["y"], r["q"]), mean_pinball(b["y"], b["q"])))
    summary = scoring.summarize(records)
    summary["pinballDiffVsEwma"] = scoring.cluster_bootstrap_ci(by_date, seed=SETTINGS["seed"])
    skills = {s: 1 - sum(m for m, _ in v) / sum(b for _, b in v) for s, v in by_symbol.items()}
    summary["symbolSkill"] = {s: round(v, 3) for s, v in sorted(skills.items())}
    summary["symbolsBeatingEwma"] = sum(v > 0 for v in skills.values())
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bars-dir", required=True)
    parser.add_argument("--symbols", type=lambda s: s.split(","), required=True)
    parser.add_argument("--engines", type=lambda s: s.split(","), default=ENGINES)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    unknown = set(args.engines) - set(RUNNERS)
    if unknown or "ewma" not in args.engines:
        raise SystemExit(f"Unknown engines {sorted(unknown)}; ewma is required as the reference")

    import torch

    torch.set_num_threads(args.threads)
    import kronos_runner as kr

    rows = {e: {h: [] for h in SETTINGS["horizons"]} for e in args.engines}
    seconds = {e: 0.0 for e in args.engines}
    coverage = {}
    for symbol in args.symbols:
        _, df = kr.load_bars(os.path.join(args.bars_dir, f"{symbol}.json"))
        origins = origin_indices(len(df))
        c = closes_of(df)
        coverage[symbol] = [str(df["datetime"].iloc[origins[0]].date()), str(df["datetime"].iloc[origins[-1]].date()), len(origins)]
        for engine in args.engines:
            started = time.perf_counter()
            forecasts = RUNNERS[engine](df, origins)
            seconds[engine] += time.perf_counter() - started
            for t, per_h in zip(origins, forecasts):
                for h, (q, p_up) in per_h.items():
                    rows[engine][h].append(
                        {
                            "symbol": symbol,
                            "date": str(df["datetime"].iloc[t].date()),
                            "y": float(math.log(c[t + h] / c[t])),
                            "q": q,
                            "p_up": p_up,
                        }
                    )
            print(f"{symbol} {engine} done", file=sys.stderr, flush=True)

    results = {}
    for engine in args.engines:
        results[engine] = {"seconds": round(seconds[engine], 1)}
        for h in SETTINGS["horizons"]:
            ref = rows["ewma"][h]
            mine = rows[engine][h]
            recent = [i for i, r in enumerate(mine) if r["date"] >= "2026-01-01"]
            results[engine][f"h{h}"] = {
                "all": summarize_engine(mine, ref),
                "2026": summarize_engine([mine[i] for i in recent], [ref[i] for i in recent]),
            }
            if "garch" in rows:
                g = rows["garch"][h]
                results[engine][f"h{h}"]["pinballSkillVsGarch"] = 1 - sum(
                    mean_pinball(r["y"], r["q"]) for r in mine
                ) / sum(mean_pinball(r["y"], r["q"]) for r in g)
    json.dump({"settings": SETTINGS, "symbols": coverage, "results": results}, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
