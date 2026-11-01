"""Independent replication of three quants.md strategies from public daily prices.

W01 (daily SMA trend), W05 (monthly inverse volatility) and W17 (volatility-targeted trend)
are reimplemented here from their published rules (QuantJourney Backtester, Apache-2.0, read
at commit 16fe1ac). No QuantJourney code or service is used.

Each rule runs under fixed scenarios and is compared, after its warm-up, with SPY, an equal
weight of its own universe and, for the multi-asset rules, 60/40 SPY/IEF. Standard library
only, so the tests run in the repository's check. See journal 123.

Usage: python strategy_replication.py --bars-dir DIR
Bars: DIR/<SYMBOL>.json with {"bars": [{"datetime", "close", "adjclose"}]}, where close is
split-adjusted and adjclose also includes dividends. DIR/IRX.json gives the 13-week T-bill
yield in percent as its close.
"""

import argparse
import json
import math
import os
import random
from statistics import fmean, stdev

SECTORS = ["XLB", "XLE", "XLF", "XLI", "XLK", "XLP", "XLU", "XLV", "XLY"]
MULTI = ["SPY", "EFA", "EEM", "TLT", "IEF", "GLD", "DBC", "VNQ"]
PUBLISHED_END = "2026-01-01"
RISK_FREE = 0.02
BOOTSTRAP = {"draws": 5000, "blockMonths": 12, "seed": 7}

RULES = {
    "W01": {
        "kind": "sma",
        "universe": SECTORS,
        "start": "2000-01-03",
        "fast": 50,
        "slow": 200,
        "cap": 0.25,
        "rebalance": "daily",
        "published": {"totalReturn": 5.3696, "cagr": 0.0738, "sharpe": 0.45, "maxDrawdown": -0.3468},
    },
    "W05": {
        "kind": "inverse_vol",
        "universe": MULTI,
        "start": "2007-01-03",
        "lookback": 63,
        "cap": 0.35,
        "rebalance": "monthly",
        "published": {"totalReturn": 1.7415, "cagr": 0.0545, "sharpe": 0.45, "maxDrawdown": -0.2042},
    },
    "W17": {
        "kind": "sma",
        "universe": MULTI,
        "start": "2007-01-03",
        "fast": 50,
        "slow": 200,
        "cap": 0.34,
        "rebalance": "monthly",
        "volTarget": {"target": 0.10, "lookback": 63, "maxLeverage": 1.5},
        "published": {"totalReturn": 1.69, "cagr": 0.0535, "sharpe": 0.36, "maxDrawdown": -0.2887},
    },
}

# Costs are per unit traded, per side. "total" includes dividends, "price" excludes them and
# "withheld" keeps 70% of them (a flat 30% US withholding, a rough assumption for a
# Singapore resident that ignores any interest-income exemption).
SCENARIOS = {
    "publishedTotal": {"cost": 0.0001, "buffer": 0.05, "cash": "zero", "returns": "total"},
    "publishedPrice": {"cost": 0.0001, "buffer": 0.05, "cash": "zero", "returns": "price"},
    "realistic": {"cost": 0.0005, "buffer": 0.05, "cash": "tbill", "returns": "total"},
    "stress": {"cost": 0.0015, "buffer": 0.05, "cash": "tbill", "returns": "total"},
    "singapore": {"cost": 0.0005, "buffer": 0.05, "cash": "tbill", "returns": "withheld"},
}
BORROW_SPREAD = 0.01

NEIGHBOURS = {
    "W01": [{"fast": 40, "slow": 160}, {"fast": 60, "slow": 240}],
    "W05": [{"lookback": 42}, {"lookback": 126}],
    "W17": [
        {"fast": 40, "slow": 160},
        {"fast": 60, "slow": 240},
        {"volTarget": {"target": 0.08, "lookback": 63, "maxLeverage": 1.5}},
        {"volTarget": {"target": 0.12, "lookback": 63, "maxLeverage": 1.5}},
    ],
}
SUBPERIODS = {
    "W01": [("2000-01-03", "2009-12-31"), ("2010-01-01", "2019-12-31"), ("2020-01-01", PUBLISHED_END)],
    "W05": [("2007-01-03", "2015-12-31"), ("2016-01-01", PUBLISHED_END)],
    "W17": [("2007-01-03", "2015-12-31"), ("2016-01-01", PUBLISHED_END)],
}


def rolling_mean(values, window):
    """Trailing mean including the current value; None until the window is full."""
    out, total = [None] * len(values), 0.0
    for i, v in enumerate(values):
        total += v
        if i >= window:
            total -= values[i - window]
        if i >= window - 1:
            out[i] = total / window
    return out


def month_end_flags(dates):
    """True on each month's last date in the data (ISO date strings)."""
    return [i + 1 == len(dates) or dates[i][:7] != dates[i + 1][:7] for i in range(len(dates))]


def pct_returns(prices):
    return [0.0] + [b / a - 1 for a, b in zip(prices, prices[1:])]


def sma_weights(closes, fast, slow, cap):
    """Equal weight across assets whose fast SMA is above the slow SMA, capped per asset."""
    n = len(next(iter(closes.values())))
    means = {s: (rolling_mean(c, fast), rolling_mean(c, slow)) for s, c in closes.items()}
    rows = []
    for t in range(n):
        active = [s for s, (f, w) in means.items() if f[t] is not None and w[t] is not None and f[t] > w[t]]
        weight = min(1.0 / len(active), cap) if active else 0.0
        rows.append({s: weight if s in active else 0.0 for s in closes})
    return rows


def inverse_vol_weights(adj, lookback, cap):
    """Inverse of the trailing return standard deviation, normalised and then capped."""
    n = len(next(iter(adj.values())))
    returns = {s: pct_returns(p) for s, p in adj.items()}
    rows = []
    for t in range(n):
        if t < lookback:
            rows.append({s: 0.0 for s in adj})
            continue
        inverse = {}
        for s, r in returns.items():
            sd = stdev(r[t - lookback + 1 : t + 1])
            inverse[s] = 1.0 / sd if sd > 0 else 0.0
        total = sum(inverse.values())
        rows.append({s: min(v / total, cap) if total else 0.0 for s, v in inverse.items()})
    return rows


def apply_vol_target(rows, returns, dates, target, lookback, max_leverage):
    """Scale all weights towards a portfolio volatility target, re-estimated on each month's
    first date from the prior `lookback` returns at the current weights (as VolTargetModel)."""
    out = [dict(r) for r in rows]
    scale = 1.0
    for i in range(lookback, len(rows)):
        total = sum(abs(v) for v in rows[i].values())
        if total < 1e-8:
            out[i] = {s: 0.0 for s in rows[i]}
            continue
        if dates[i][:7] != dates[i - 1][:7]:
            unit = {s: v / total for s, v in rows[i].items()}
            portfolio = [sum(unit[s] * returns[s][j] for s in unit) for j in range(i - lookback, i)]
            realised = stdev(portfolio) * math.sqrt(252)
            scale = min(target / realised, max_leverage) if realised > 0.01 else 1.0
        out[i] = {s: v * scale for s, v in rows[i].items()}
    return out


def simulate(weights, returns, rebalance_flags, scenario, cash_rates):
    """Daily account: moves holdings and cash, then on rebalance dates trades at the close to
    the targets computed from the previous date's data. Returns NAVs and traded value."""
    symbols = list(returns)
    n = len(rebalance_flags)
    holdings = {s: 0.0 for s in symbols}
    cash = 1.0
    navs, traded, costs = [], [0.0] * n, 0.0
    for t in range(n):
        if t > 0:
            for s in symbols:
                holdings[s] *= 1 + returns[s][t]
            if scenario["cash"] == "tbill":
                rate = cash_rates[t] if cash >= 0 else cash_rates[t] + BORROW_SPREAD
                cash *= 1 + rate / 252
        nav = cash + sum(holdings.values())
        if t > 0 and rebalance_flags[t]:
            targets = {s: weights[t - 1].get(s, 0.0) * (1 - scenario["buffer"]) * nav for s in symbols}
            turnover = sum(abs(targets[s] - holdings[s]) for s in symbols)
            cost = turnover * scenario["cost"]
            cash += sum(holdings.values()) - sum(targets.values()) - cost
            holdings = targets
            traded[t] = turnover
            costs += cost
            nav = cash + sum(holdings.values())
        navs.append(nav)
    return {"navs": navs, "traded": traded, "costs": costs}


def metrics(navs, dates):
    years = (date_ordinal(dates[-1]) - date_ordinal(dates[0])) / 365.25
    daily = [b / a - 1 for a, b in zip(navs, navs[1:])]
    vol = stdev(daily) * math.sqrt(252)
    peak, worst = navs[0], 0.0
    for v in navs:
        peak = max(peak, v)
        worst = min(worst, v / peak - 1)
    return {
        "totalReturn": navs[-1] / navs[0] - 1,
        "cagr": (navs[-1] / navs[0]) ** (1 / years) - 1,
        "vol": vol,
        "sharpe": (fmean(daily) * 252 - RISK_FREE) / vol if vol else 0.0,
        "maxDrawdown": worst,
    }


def date_ordinal(iso):
    from datetime import date

    return date.fromisoformat(iso).toordinal()


def monthly_returns(navs, dates):
    ends = [i for i, flag in enumerate(month_end_flags(dates)) if flag]
    points = [navs[0]] + [navs[i] for i in ends]
    return [b / a - 1 for a, b in zip(points, points[1:])]


def sharpe_of(monthly):
    sd = stdev(monthly) if len(monthly) > 1 else 0.0
    return (fmean(monthly) * 12 - RISK_FREE) / (sd * math.sqrt(12)) if sd else 0.0


def paired_bootstrap(a, b, draws=BOOTSTRAP["draws"], block=BOOTSTRAP["blockMonths"], seed=BOOTSTRAP["seed"]):
    """95% intervals for a minus b: Sharpe and annualised mean return, from circular blocks
    of consecutive months resampled together."""
    if len(a) != len(b) or not a:
        raise ValueError("Need paired monthly returns")
    n, rng = len(a), random.Random(seed)
    sharpes, means = [], []
    for _ in range(draws):
        picks = []
        while len(picks) < n:
            start = rng.randrange(n)
            picks.extend((start + k) % n for k in range(block))
        picks = picks[:n]
        ra, rb = [a[i] for i in picks], [b[i] for i in picks]
        sharpes.append(sharpe_of(ra) - sharpe_of(rb))
        means.append((fmean(ra) - fmean(rb)) * 12)
    sharpes.sort()
    means.sort()
    low, high = int(0.025 * draws), int(0.975 * draws) - 1
    return {
        "sharpeDiff": sharpe_of(a) - sharpe_of(b),
        "sharpeDiffLow": sharpes[low],
        "sharpeDiffHigh": sharpes[high],
        "annualDiff": (fmean(a) - fmean(b)) * 12,
        "annualDiffLow": means[low],
        "annualDiffHigh": means[high],
    }


def load_market(bars_dir, symbols):
    """Prices aligned to SPY's dates, forward-filling isolated gaps."""

    def bars(symbol):
        with open(os.path.join(bars_dir, f"{symbol}.json")) as f:
            return {b["datetime"]: b for b in json.load(f)["bars"]}

    calendar = sorted(bars("SPY"))
    market = {"dates": calendar, "close": {}, "adj": {}}
    for symbol in symbols:
        rows, close, adj, last = bars(symbol), [], [], None
        for d in calendar:
            last = rows.get(d, last)
            close.append(last["close"] if last else None)
            adj.append(last["adjclose"] if last else None)
        market["close"][symbol], market["adj"][symbol] = close, adj
    rates, tbill, last = bars("IRX"), [], 0.0
    for d in calendar:
        if d in rates:
            last = rates[d]["close"] / 100
        tbill.append(last)
    market["tbill"] = tbill
    return market


def window(market, symbols, start, end):
    idx = [i for i, d in enumerate(market["dates"]) if start <= d <= end]
    first, last = idx[0], idx[-1] + 1
    for s in symbols:
        if market["adj"][s][first] is None:
            raise SystemExit(f"{s} has no price on {start}")
    return {
        "dates": market["dates"][first:last],
        "close": {s: market["close"][s][first:last] for s in symbols},
        "adj": {s: market["adj"][s][first:last] for s in symbols},
        "tbill": market["tbill"][first:last],
    }


def scenario_returns(data, kind):
    total = {s: pct_returns(p) for s, p in data["adj"].items()}
    price = {s: pct_returns(p) for s, p in data["close"].items()}
    if kind == "total":
        return total
    if kind == "price":
        return price
    if kind == "withheld":
        return {s: [p + 0.7 * (t - p) for t, p in zip(total[s], price[s])] for s in total}
    raise ValueError(kind)


def rule_weights(rule, data):
    if rule["kind"] == "sma":
        rows = sma_weights(data["close"], rule["fast"], rule["slow"], rule["cap"])
    else:
        rows = inverse_vol_weights(data["adj"], rule["lookback"], rule["cap"])
    if "volTarget" in rule:
        v = rule["volTarget"]
        total = {s: pct_returns(p) for s, p in data["adj"].items()}
        rows = apply_vol_target(rows, total, data["dates"], v["target"], v["lookback"], v["maxLeverage"])
    return rows


def run_rule(rule, data, scenario):
    flags = month_end_flags(data["dates"]) if rule["rebalance"] == "monthly" else [True] * len(data["dates"])
    return simulate(rule_weights(rule, data), scenario_returns(data, scenario["returns"]), flags, scenario, data["tbill"])


def run_benchmark(weights, data, scenario, flags):
    """A fixed-weight benchmark, fully invested with no cash buffer."""
    symbols = list(weights)
    subset = {
        "adj": {s: data["adj"][s] for s in symbols},
        "close": {s: data["close"][s] for s in symbols},
    }
    return simulate(
        [weights] * len(data["dates"]),
        scenario_returns(subset, scenario["returns"]),
        flags,
        {**scenario, "buffer": 0.0},
        data["tbill"],
    )


def benchmarks_for(rule, full, scenario):
    dates = full["dates"]
    monthly = month_end_flags(dates)
    buy_hold = [i == 1 for i in range(len(dates))]
    universe = rule["universe"]
    out = {
        "SPY": run_benchmark({"SPY": 1.0}, full, scenario, buy_hold),
        "equalWeight": run_benchmark({s: 1.0 / len(universe) for s in universe}, full, scenario, monthly),
    }
    if universe is MULTI:
        out["sixtyForty"] = run_benchmark({"SPY": 0.6, "IEF": 0.4}, full, scenario, monthly)
    return out


def annual_turnover(result, dates):
    years = (date_ordinal(dates[-1]) - date_ordinal(dates[0])) / 365.25
    navs, traded = result["navs"], result["traded"]
    return sum(t / n for t, n in zip(traded, navs)) / years


def compare(rule, full, scenario, start_index, end_index):
    """Rule and benchmarks over [start_index, end_index], all rebased to the same first date."""
    dates = full["dates"][start_index : end_index + 1]
    result = run_rule(rule, full, scenario)
    navs = result["navs"][start_index : end_index + 1]
    out = {
        "from": dates[0],
        "to": dates[-1],
        "rule": metrics(navs, dates),
        "turnoverPerYear": annual_turnover(
            {"navs": navs, "traded": result["traded"][start_index : end_index + 1]}, dates
        ),
        "benchmarks": {},
    }
    mine = monthly_returns(navs, dates)
    for name, bench in benchmarks_for(rule, full, scenario).items():
        bench_navs = bench["navs"][start_index : end_index + 1]
        out["benchmarks"][name] = {
            **metrics(bench_navs, dates),
            **paired_bootstrap(mine, monthly_returns(bench_navs, dates)),
        }
    return out


def first_active(rule, data):
    """The first date after a non-zero target exists, once the warm-up is over."""
    for t, row in enumerate(rule_weights(rule, data)):
        if any(v != 0 for v in row.values()):
            return t + 1
    raise SystemExit("The rule never takes a position")


def verdict(comparison):
    """Pre-registered reading of the realistic scenario. An edge needs the Sharpe difference
    interval above zero against every benchmark; risk reduction needs a drawdown at least
    5 points shallower than SPY's without a Sharpe interval entirely below zero."""
    benches = comparison["benchmarks"]
    edge = all(b["sharpeDiffLow"] > 0 for b in benches.values())
    spy = benches["SPY"]
    risk = comparison["rule"]["maxDrawdown"] >= spy["maxDrawdown"] + 0.05 and spy["sharpeDiffHigh"] >= 0
    return {"edge": edge, "riskReduction": risk}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bars-dir", required=True)
    args = parser.parse_args()
    symbols = sorted(set(SECTORS + MULTI))
    market = load_market(args.bars_dir, symbols)
    latest = market["dates"][-1]

    results = {"latestBar": latest, "settings": {"scenarios": SCENARIOS, "bootstrap": BOOTSTRAP}, "rules": {}}
    for name, rule in RULES.items():
        symbols_for_rule = sorted(set(rule["universe"] + ["SPY", "IEF"]))
        published = window(market, symbols_for_rule, rule["start"], PUBLISHED_END)
        out = {"published": rule["published"], "replication": {}, "scenarios": {}}
        for scenario in ("publishedTotal", "publishedPrice"):
            navs = run_rule(rule, published, SCENARIOS[scenario])["navs"]
            out["replication"][scenario] = metrics(navs, published["dates"])
        start = first_active(rule, published)
        end = len(published["dates"]) - 1
        for scenario in ("realistic", "stress", "singapore"):
            out["scenarios"][scenario] = compare(rule, published, SCENARIOS[scenario], start, end)
        out["verdict"] = verdict(out["scenarios"]["realistic"])

        out["subperiods"] = []
        for lo, hi in SUBPERIODS[name]:
            lo_index = max(start, next(i for i, d in enumerate(published["dates"]) if d >= lo))
            hi_index = max(i for i, d in enumerate(published["dates"]) if d <= hi)
            out["subperiods"].append(compare(rule, published, SCENARIOS["realistic"], lo_index, hi_index))

        out["neighbours"] = []
        for change in NEIGHBOURS[name]:
            variant = {**rule, **change}
            out["neighbours"].append(
                {"change": change, "metrics": compare(variant, published, SCENARIOS["realistic"], start, end)["rule"]}
            )

        extended = window(market, symbols_for_rule, rule["start"], latest)
        holdout = next(i for i, d in enumerate(extended["dates"]) if d >= PUBLISHED_END)
        out["afterPublication"] = compare(rule, extended, SCENARIOS["realistic"], holdout, len(extended["dates"]) - 1)
        results["rules"][name] = out
    print(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
