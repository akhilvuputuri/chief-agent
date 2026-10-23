"""Kronos CPU spike runner (docs/kronos-trading-experiment.md).

Runs pinned Kronos checkpoints on daily bars and prints one JSON document on stdout.

- `bench` measures checkpoint load time, sampling time and peak memory for a watchlist-sized
  batch.
- `walk` scores sampled forecasts at past origins against realised log returns and a
  zero-drift EWMA random-walk band.

Two upstream behaviours are handled here rather than patched:
- `auto_regressive_inference` averages its samples, so each sample is drawn as its own batch
  row (sample_count=1) and the spread is kept.
- Before huggingface_hub 2.0 (Kronos pins 0.33.1), checkpoints load through a safetensors
  path that never calls `.eval()`, and KronosPredictor does not either, so upstream
  inference runs in training mode. That
  turns on dropout (up to 0.25 in Kronos-small) and also makes the s2 head's cross-attention
  causal (`is_causal = self.training` in module.py): its single sampled-s1 query then sees
  only the oldest context position, so s2 loses its s1 conditioning. `--modes` compares
  "eval" with this upstream default, "train".

`peakRssMiB` is the process peak so far; run one model per process for a clean figure.
"""

import argparse
import contextlib
import json
import os
import resource
import sys
import time

import numpy as np
import pandas as pd
import torch

sys.path.insert(0, os.environ.get("KRONOS_SRC", "/opt/kronos"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from model import Kronos, KronosTokenizer  # noqa: E402
from model.kronos import auto_regressive_inference, calc_time_stamps  # noqa: E402

import scoring  # noqa: E402

FEATURES = ["open", "high", "low", "close", "volume", "amount"]
CLOSE = FEATURES.index("close")
TOKENIZER = "Kronos-Tokenizer-base"
MAX_CONTEXT = 512
# Enough bars for a meaningful window and for the EWMA baseline's three-close minimum.
MIN_LOOKBACK = 16
CLIP = 5


def load_bars(path):
    with open(path) as f:
        doc = json.load(f)
    df = pd.DataFrame(doc["bars"])
    df["datetime"] = pd.to_datetime(df["datetime"])
    df = df.sort_values("datetime").reset_index(drop=True)
    # Kronos's own default when amount is missing.
    df["amount"] = df["volume"] * df[["open", "high", "low", "close"]].mean(axis=1)
    if df[FEATURES].isnull().values.any() or (df["close"] <= 0).any():
        raise SystemExit("Bars contain missing or non-positive values")
    return doc.get("symbol", "?"), df


def load_model(weights, name, mode):
    with contextlib.redirect_stdout(sys.stderr):
        tokenizer = KronosTokenizer.from_pretrained(os.path.join(weights, TOKENIZER))
        model = Kronos.from_pretrained(os.path.join(weights, name))
    for module in (tokenizer, model):
        module.eval() if mode == "eval" else module.train()
    return tokenizer, model


def sample_paths(tokenizer, model, windows, futures, horizon, samples, chunk, temperature, top_p):
    """Returns (len(windows), samples, horizon, len(FEATURES)) sampled bars in price units."""
    xs, stamps, ystamps, means, stds = [], [], [], [], []
    for window, future in zip(windows, futures):
        x = window[FEATURES].to_numpy(dtype=np.float32)
        mean, std = x.mean(axis=0), x.std(axis=0)
        xs.append(np.clip((x - mean) / (std + 1e-5), -CLIP, CLIP))
        stamps.append(calc_time_stamps(window["datetime"].reset_index(drop=True)).to_numpy(np.float32))
        ystamps.append(calc_time_stamps(pd.Series(future)).to_numpy(np.float32))
        means.append(mean)
        stds.append(std)
    rows = [(i, x, s, y) for i, (x, s, y) in enumerate(zip(xs, stamps, ystamps)) for _ in range(samples)]
    out = np.empty((len(rows), horizon, len(FEATURES)), dtype=np.float32)
    for start in range(0, len(rows), chunk):
        part = rows[start : start + chunk]
        preds = auto_regressive_inference(
            tokenizer,
            model,
            torch.from_numpy(np.stack([r[1] for r in part])),
            torch.from_numpy(np.stack([r[2] for r in part])),
            torch.from_numpy(np.stack([r[3] for r in part])),
            MAX_CONTEXT,
            horizon,
            CLIP,
            temperature,
            0,
            top_p,
            1,
            False,
        )
        out[start : start + len(part)] = preds[:, -horizon:, :]
    for row, (i, *_rest) in enumerate(rows):
        out[row] = out[row] * (stds[i] + 1e-5) + means[i]
    return out.reshape(len(windows), samples, horizon, len(FEATURES))


def future_business_days(last, horizon):
    # Weekdays only, so a market holiday can appear. Only `bench` uses this, for timings and
    # spread; `walk` uses the real next bars, and live runs send exchange session dates.
    return list(pd.bdate_range(last + pd.Timedelta(days=1), periods=horizon))


def peak_rss_mib():
    # ru_maxrss is KiB on Linux and bytes on macOS; the process peak only grows.
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(peak / (1024 * 1024 if sys.platform == "darwin" else 1024), 1)


def bench(args):
    symbol, df = load_bars(args.bars)
    if len(df) < args.lookback + args.series:
        raise SystemExit("Not enough bars for the requested lookback and series")
    # Distinct windows of the same symbol stand in for a watchlist of `series` symbols:
    # sampling cost depends on shape, not content.
    ends = [len(df) - 1 - i for i in range(args.series)]
    windows = [df.iloc[e - args.lookback + 1 : e + 1] for e in ends]
    futures = [future_business_days(df["datetime"].iloc[e], args.horizon) for e in ends]
    results = []
    for name in args.models:
        for mode in args.modes:
            torch.manual_seed(args.seed)
            started = time.perf_counter()
            tokenizer, model = load_model(args.weights, name, mode)
            loaded = time.perf_counter()
            paths = sample_paths(
                tokenizer, model, windows, futures, args.horizon, args.samples, args.chunk, args.temperature, args.top_p
            )
            finished = time.perf_counter()
            last = np.array([w["close"].iloc[-1] for w in windows])
            final = np.log(paths[:, :, -1, CLOSE] / last[:, None])
            results.append(
                {
                    "model": name,
                    "mode": mode,
                    "loadSeconds": round(loaded - started, 2),
                    "sampleSeconds": round(finished - loaded, 2),
                    "secondsPerSeries": round((finished - loaded) / args.series, 3),
                    "peakRssMiB": peak_rss_mib(),
                    "medianWidth80": float(
                        np.median(np.quantile(final, 0.9, axis=1) - np.quantile(final, 0.1, axis=1))
                    ),
                }
            )
            del tokenizer, model
    return {
        "command": "bench",
        "symbol": symbol,
        "series": args.series,
        "samples": args.samples,
        "lookback": args.lookback,
        "horizon": args.horizon,
        "threads": torch.get_num_threads(),
        "torch": torch.__version__,
        "results": results,
    }


def walk(args):
    symbol, df = load_bars(args.bars)
    closes = df["close"].to_numpy(dtype=float)
    horizons = sorted({1, args.horizon})
    last_origin = len(df) - 1 - args.horizon
    origins = [last_origin - k * args.step for k in range(args.origins)]
    origins = [t for t in origins if t - args.lookback + 1 >= 0][::-1]
    if not origins:
        raise SystemExit("Not enough bars for any origin")
    windows = [df.iloc[t - args.lookback + 1 : t + 1] for t in origins]
    # In a backtest the next bars' dates are known; live runs use business days.
    futures = [list(df["datetime"].iloc[t + 1 : t + 1 + args.horizon]) for t in origins]
    runs = []
    for name in args.models:
        for mode in args.modes:
            torch.manual_seed(args.seed)
            tokenizer, model = load_model(args.weights, name, mode)
            started = time.perf_counter()
            paths = sample_paths(
                tokenizer, model, windows, futures, args.horizon, args.samples, args.chunk, args.temperature, args.top_p
            )
            seconds = time.perf_counter() - started
            by_horizon = {}
            for h in horizons:
                records = []
                for i, t in enumerate(origins):
                    sampled = np.log(paths[i, :, h - 1, CLOSE] / closes[t])
                    records.append(
                        {
                            "y": float(np.log(closes[t + h] / closes[t])),
                            "model": scoring.sample_quantiles(sampled),
                            "baseline": scoring.random_walk_quantiles(
                                scoring.ewma_sigma(closes[t - args.lookback + 1 : t + 1]), h
                            ),
                            "p_up": float(np.mean(sampled > 0)),
                        }
                    )
                by_horizon[f"h{h}"] = {
                    **scoring.summarize(records),
                    "toyLongSignals": scoring.toy_long_signals(records),
                }
            runs.append(
                {
                    "model": name,
                    "mode": mode,
                    "sampleSeconds": round(seconds, 1),
                    "peakRssMiB": peak_rss_mib(),
                    "scores": by_horizon,
                }
            )
            del tokenizer, model
    return {
        "command": "walk",
        "symbol": symbol,
        "origins": len(origins),
        "firstOrigin": str(df["datetime"].iloc[origins[0]].date()),
        "lastOrigin": str(df["datetime"].iloc[origins[-1]].date()),
        "step": args.step,
        "samples": args.samples,
        "lookback": args.lookback,
        "horizon": args.horizon,
        "threads": torch.get_num_threads(),
        "runs": runs,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("bench", "walk"):
        p = sub.add_parser(name)
        p.add_argument("--bars", required=True)
        p.add_argument("--weights", default=os.environ.get("KRONOS_WEIGHTS", "/opt/kronos-weights"))
        p.add_argument("--models", type=lambda s: s.split(","), default=["Kronos-small"])
        p.add_argument("--modes", type=lambda s: s.split(","), default=["eval"])
        p.add_argument("--lookback", type=int, default=400)
        p.add_argument("--horizon", type=int, default=5)
        p.add_argument("--samples", type=int, default=32)
        p.add_argument("--chunk", type=int, default=64)
        p.add_argument("--temperature", type=float, default=1.0)
        p.add_argument("--top-p", type=float, default=0.9)
        p.add_argument("--threads", type=int, default=0)
        p.add_argument("--seed", type=int, default=7)
    sub.choices["bench"].add_argument("--series", type=int, default=25)
    sub.choices["walk"].add_argument("--origins", type=int, default=60)
    sub.choices["walk"].add_argument("--step", type=int, default=5)
    args = parser.parse_args()
    if not MIN_LOOKBACK <= args.lookback <= MAX_CONTEXT:
        raise SystemExit(f"--lookback must be {MIN_LOOKBACK}..{MAX_CONTEXT}")
    if any(m not in ("eval", "train") for m in args.modes):
        raise SystemExit("--modes takes eval and/or train")
    if args.threads:
        torch.set_num_threads(args.threads)
    with torch.no_grad():
        result = bench(args) if args.command == "bench" else walk(args)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
