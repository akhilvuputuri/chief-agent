import math
import unittest

import strategy_replication as sr

NO_COST = {"cost": 0.0, "buffer": 0.0, "cash": "zero", "returns": "total"}


class SignalTests(unittest.TestCase):
    def test_rolling_mean_waits_for_a_full_window(self):
        self.assertEqual(sr.rolling_mean([1.0, 2.0, 3.0, 4.0], 2), [None, 1.5, 2.5, 3.5])

    def test_month_end_flags_mark_each_months_last_date(self):
        dates = ["2024-01-30", "2024-01-31", "2024-02-01", "2024-02-29", "2024-03-01"]
        self.assertEqual(sr.month_end_flags(dates), [False, True, False, True, True])

    def test_sma_weights_split_equally_among_active_assets_and_cap(self):
        closes = {"UP": [float(i) for i in range(1, 11)], "DOWN": [float(i) for i in range(10, 0, -1)]}
        rows = sr.sma_weights(closes, 2, 4, 0.25)
        self.assertEqual(rows[2], {"UP": 0.0, "DOWN": 0.0})
        self.assertEqual(rows[-1], {"UP": 0.25, "DOWN": 0.0})
        self.assertEqual(sr.sma_weights(closes, 2, 4, 1.0)[-1], {"UP": 1.0, "DOWN": 0.0})

    def test_inverse_vol_favours_the_calmer_asset_after_the_lookback(self):
        calm = [100 * (1.001 if i % 2 else 0.999) ** i for i in range(30)]
        wild = [100 * (1.02 if i % 2 else 0.98) ** i for i in range(30)]
        rows = sr.inverse_vol_weights({"CALM": calm, "WILD": wild}, 10, 1.0)
        self.assertEqual(rows[9], {"CALM": 0.0, "WILD": 0.0})
        self.assertGreater(rows[-1]["CALM"], rows[-1]["WILD"])
        self.assertAlmostEqual(sum(rows[-1].values()), 1.0)
        self.assertLessEqual(max(sr.inverse_vol_weights({"CALM": calm, "WILD": wild}, 10, 0.6)[-1].values()), 0.6)

    def test_vol_target_rescales_monthly_and_respects_the_leverage_cap(self):
        dates = [f"2024-01-{d:02d}" for d in range(1, 29)] + [f"2024-02-{d:02d}" for d in range(1, 29)]
        n = len(dates)
        rows = [{"A": 1.0}] * n
        calm = {"A": [0.0001 * (-1) ** i for i in range(n)]}
        capped = sr.apply_vol_target(rows, calm, dates, 0.10, 20, 1.5)
        # Volatility below 1% a year falls back to a scale of one.
        self.assertEqual(capped[-1]["A"], 1.0)
        mild = {"A": [0.002 * (-1) ** i for i in range(n)]}
        self.assertEqual(sr.apply_vol_target(rows, mild, dates, 0.10, 20, 1.5)[-1]["A"], 1.5)
        wild = {"A": [0.02 * (-1) ** i for i in range(n)]}
        scaled = sr.apply_vol_target(rows, wild, dates, 0.10, 20, 1.5)
        self.assertLess(scaled[-1]["A"], 1.0)
        # The scale is only set on a month's first date, so it holds through the month.
        self.assertEqual(scaled[29]["A"], scaled[-1]["A"])
        self.assertEqual(scaled[10]["A"], 1.0)


class SimulationTests(unittest.TestCase):
    def test_trades_use_the_previous_dates_weights_and_earn_the_next_move(self):
        returns = {"A": [0.0, 0.10, 0.10]}
        weights = [{"A": 0.0}, {"A": 1.0}, {"A": 1.0}]
        navs = sr.simulate(weights, returns, [True] * 3, NO_COST, [0.0] * 3)["navs"]
        # Target from date 1 trades at date 2's close, so neither move is earned.
        self.assertEqual(navs, [1.0, 1.0, 1.0])
        navs = sr.simulate([{"A": 1.0}] * 3, returns, [True] * 3, NO_COST, [0.0] * 3)["navs"]
        self.assertAlmostEqual(navs[-1], 1.1)

    def test_future_prices_cannot_change_earlier_results(self):
        closes = [100 + i + 5 * math.sin(i / 3) for i in range(60)]
        changed = closes[:40] + [c * 1.5 for c in closes[40:]]
        dates = [f"20{20 + i // 12:02d}-{i % 12 + 1:02d}-15" for i in range(60)]
        rule = {"kind": "sma", "universe": ["A"], "fast": 3, "slow": 8, "cap": 1.0, "rebalance": "daily"}

        def run(prices):
            data = {"dates": dates, "close": {"A": prices}, "adj": {"A": prices}, "tbill": [0.0] * 60}
            return sr.run_rule(rule, data, NO_COST)["navs"]

        self.assertEqual(run(closes)[:40], run(changed)[:40])

    def test_a_rule_never_trades_benchmark_prices_outside_its_universe(self):
        rising = [100.0 + i for i in range(20)]
        data = {"close": {"A": rising, "SPY": rising}, "adj": {"A": rising, "SPY": rising}}
        rule = {"kind": "sma", "universe": ["A"], "fast": 2, "slow": 4, "cap": 1.0}
        self.assertEqual(sr.rule_weights(rule, data)[-1], {"A": 1.0})

    def test_costs_are_charged_on_traded_value(self):
        out = sr.simulate(
            [{"A": 1.0}] * 2,
            {"A": [0.0, 0.0]},
            [True, True],
            {**NO_COST, "cost": 0.01},
            [0.0, 0.0],
        )
        self.assertAlmostEqual(out["traded"][1], 1.0)
        self.assertAlmostEqual(out["navs"][1], 0.99)

    def test_buffer_leaves_cash_that_earns_the_bill_rate_only_in_that_scenario(self):
        weights = [{"A": 1.0}] * 253
        returns = {"A": [0.0] * 253}
        flags = [i == 1 for i in range(253)]
        zero = sr.simulate(weights, returns, flags, {**NO_COST, "buffer": 0.05}, [0.05] * 253)
        self.assertAlmostEqual(zero["navs"][-1], 1.0)
        bills = sr.simulate(weights, returns, flags, {**NO_COST, "buffer": 0.05, "cash": "tbill"}, [0.05] * 253)
        self.assertAlmostEqual(bills["navs"][-1], 1 + 0.05 * (0.05 * 251 / 252 + 0.05 / 252) * 1, places=2)
        self.assertGreater(bills["navs"][-1], 1.002)

    def test_leverage_pays_the_borrow_spread(self):
        weights = [{"A": 1.5}] * 253
        returns = {"A": [0.0] * 253}
        flags = [i == 1 for i in range(253)]
        out = sr.simulate(weights, returns, flags, {**NO_COST, "cash": "tbill"}, [0.02] * 253)
        # Half the account is borrowed at about 3% for about a year.
        self.assertAlmostEqual(out["navs"][-1], 1 - 0.5 * 0.03, places=2)
        self.assertLess(out["navs"][-1], 0.99)

    def test_withholding_keeps_seventy_percent_of_dividends(self):
        data = {"adj": {"A": [100.0, 102.0]}, "close": {"A": [100.0, 101.0]}}
        self.assertAlmostEqual(sr.scenario_returns(data, "withheld")["A"][1], 0.01 + 0.7 * 0.01)
        self.assertAlmostEqual(sr.scenario_returns(data, "price")["A"][1], 0.01)
        self.assertAlmostEqual(sr.scenario_returns(data, "total")["A"][1], 0.02)


class StatisticsTests(unittest.TestCase):
    def test_metrics_measure_return_drawdown_and_sharpe(self):
        out = sr.metrics([1.0, 1.2, 0.9, 1.1], ["2020-01-01", "2020-06-01", "2020-12-01", "2021-01-01"])
        self.assertAlmostEqual(out["totalReturn"], 0.1)
        self.assertAlmostEqual(out["maxDrawdown"], -0.25)
        self.assertAlmostEqual(out["cagr"], 1.1 ** (365.25 / 366) - 1, places=3)

    def test_monthly_returns_chain_from_the_first_value(self):
        dates = ["2024-01-30", "2024-01-31", "2024-02-28", "2024-02-29"]
        out = sr.monthly_returns([1.0, 1.1, 1.1, 1.21], dates)
        self.assertAlmostEqual(out[0], 0.1)
        self.assertAlmostEqual(out[1], 0.1)

    def test_paired_bootstrap_brackets_a_clear_difference(self):
        a = [0.02 + 0.01 * ((i * 7) % 5 - 2) for i in range(120)]
        b = [x - 0.01 for x in a]
        out = sr.paired_bootstrap(a, b, draws=200)
        self.assertAlmostEqual(out["annualDiff"], 0.12)
        self.assertAlmostEqual(out["annualDiffLow"], 0.12)
        self.assertGreater(out["sharpeDiffLow"], 0)
        with self.assertRaises(ValueError):
            sr.paired_bootstrap([0.1], [])

    def test_verdict_requires_every_benchmark_and_a_real_drawdown_gap(self):
        bench = lambda low, high, dd: {"sharpeDiffLow": low, "sharpeDiffHigh": high, "maxDrawdown": dd}
        edge = {"rule": {"maxDrawdown": -0.2}, "benchmarks": {"SPY": bench(0.1, 0.5, -0.5), "equalWeight": bench(0.1, 0.4, -0.3)}}
        self.assertEqual(sr.verdict(edge), {"edge": True, "riskReduction": True})
        mixed = {"rule": {"maxDrawdown": -0.48}, "benchmarks": {"SPY": bench(0.1, 0.5, -0.5), "equalWeight": bench(-0.1, 0.4, -0.3)}}
        self.assertEqual(sr.verdict(mixed), {"edge": False, "riskReduction": False})
        worse = {"rule": {"maxDrawdown": -0.2}, "benchmarks": {"SPY": bench(-0.5, -0.1, -0.5)}}
        self.assertEqual(sr.verdict(worse), {"edge": False, "riskReduction": False})


if __name__ == "__main__":
    unittest.main()
