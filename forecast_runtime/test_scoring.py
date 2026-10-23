import math
import unittest

import scoring


def record(y, model, baseline, p_up):
    return {"y": y, "model": model, "baseline": baseline, "p_up": p_up}


class ScoringTest(unittest.TestCase):
    def test_pinball_penalises_each_side_by_tau(self):
        self.assertAlmostEqual(scoring.pinball(1.0, 0.0, 0.9), 0.9)
        self.assertAlmostEqual(scoring.pinball(-1.0, 0.0, 0.9), 0.1)
        self.assertAlmostEqual(scoring.pinball(0.5, 0.5, 0.1), 0.0)

    def test_ewma_sigma_tracks_constant_moves(self):
        flat_growth = [100 * math.exp(0.01 * i) for i in range(60)]
        self.assertAlmostEqual(scoring.ewma_sigma(flat_growth), 0.01, places=9)
        zigzag = [100 * math.exp(0.02 * (i % 2)) for i in range(60)]
        self.assertAlmostEqual(scoring.ewma_sigma(zigzag), 0.02, places=9)
        with self.assertRaises(ValueError):
            scoring.ewma_sigma([1.0, 2.0])

    def test_random_walk_quantiles_scale_with_square_root_of_horizon(self):
        one = scoring.random_walk_quantiles(0.01, 1)
        four = scoring.random_walk_quantiles(0.01, 4)
        self.assertAlmostEqual(four[0.9], 2 * one[0.9])
        self.assertAlmostEqual(one[0.1], -one[0.9])
        self.assertEqual(one[0.5], 0.0)

    def test_quantile_interpolates_like_numpy(self):
        self.assertAlmostEqual(scoring.quantile([4, 1, 3, 2], 0.1), 1.3)
        self.assertAlmostEqual(scoring.quantile([4, 1, 3, 2], 0.5), 2.5)
        self.assertEqual(scoring.quantile([5.0], 0.9), 5.0)
        with self.assertRaises(ValueError):
            scoring.quantile([], 0.5)

    def test_sample_quantiles_use_unbiased_plotting_positions(self):
        values = [float(v) for v in range(1, 33)]
        out = scoring.sample_quantiles(values)
        self.assertAlmostEqual(out[0.1], 3.3)
        self.assertAlmostEqual(out[0.5], 16.5)
        self.assertAlmostEqual(out[0.9], 29.7)
        # Expected coverage of [X(3.3), X(29.7)] among 32 draws is (29.7 - 3.3) / 33 = 0.8.
        self.assertAlmostEqual((out[0.9] - out[0.1]) / 33, 0.8)
        self.assertEqual(scoring.sample_quantiles([0.0, 1.0, 2.0]), {0.1: 0.0, 0.5: 1.0, 0.9: 2.0})
        with self.assertRaises(ValueError):
            scoring.weibull_quantile([], 0.5)

    def test_summarize_reports_coverage_skill_and_brier(self):
        wide = {0.1: -0.05, 0.5: 0.0, 0.9: 0.05}
        narrow = {0.1: -0.001, 0.5: 0.0, 0.9: 0.001}
        records = [
            record(0.02, wide, narrow, 1.0),
            record(-0.02, wide, narrow, 0.0),
        ]
        out = scoring.summarize(records)
        self.assertEqual(out["n"], 2)
        self.assertEqual(out["model"]["coverage80"], 1.0)
        self.assertEqual(out["baseline"]["coverage80"], 0.0)
        self.assertEqual(out["brier"], 0.0)
        self.assertEqual(out["upRate"], 0.5)
        self.assertIsNone(out["medianSignHitRate"])
        self.assertLess(out["pinballSkill"], 1.0)
        self.assertEqual(scoring.summarize([]), {"n": 0})

    def test_p_up_interpolates_the_quantile_cdf(self):
        levels = [0.1, 0.5, 0.9]
        self.assertAlmostEqual(scoring.p_up_from_quantiles(levels, [-0.02, 0.0, 0.02]), 0.5)
        self.assertAlmostEqual(scoring.p_up_from_quantiles(levels, [-0.03, -0.01, 0.01]), 0.3)
        self.assertAlmostEqual(scoring.p_up_from_quantiles(levels, [0.01, 0.02, 0.03]), 0.95)
        self.assertAlmostEqual(scoring.p_up_from_quantiles(levels, [-0.03, -0.02, -0.01]), 0.05)
        # A quantile exactly at zero gives that level's CDF on either edge.
        self.assertAlmostEqual(scoring.p_up_from_quantiles(levels, [0.0, 0.01, 0.02]), 0.9)
        self.assertAlmostEqual(scoring.p_up_from_quantiles(levels, [-0.02, -0.01, 0.0]), 0.1)
        # Crossed quantiles are put back in order rather than trusted.
        self.assertAlmostEqual(scoring.p_up_from_quantiles(levels, [0.02, 0.0, -0.02]), 0.5)

    def test_cluster_bootstrap_resamples_whole_clusters(self):
        out = scoring.cluster_bootstrap_ci({"d1": [1.0, 1.0], "d2": [3.0]}, draws=500)
        self.assertAlmostEqual(out["mean"], 5 / 3)
        self.assertGreaterEqual(out["low"], 1.0)
        self.assertLessEqual(out["high"], 3.0)
        self.assertLess(out["low"], out["high"])
        same = scoring.cluster_bootstrap_ci({"a": [2.0], "b": [2.0]}, draws=50)
        self.assertEqual((same["low"], same["high"]), (2.0, 2.0))
        with self.assertRaises(ValueError):
            scoring.cluster_bootstrap_ci({})

    def test_block_bootstrap_keeps_runs_of_consecutive_clusters(self):
        values = {f"d{i:02d}": [float(i // 5)] for i in range(20)}
        out = scoring.cluster_bootstrap_ci(values, draws=400, block=5)
        self.assertAlmostEqual(out["mean"], 1.5)
        self.assertLessEqual(out["low"], 1.5)
        self.assertGreaterEqual(out["high"], 1.5)
        # A block as long as the data always resamples everything, so the interval collapses.
        whole = scoring.cluster_bootstrap_ci(values, draws=50, block=99)
        self.assertEqual((whole["low"], whole["high"]), (1.5, 1.5))

    def test_toy_signals_need_probability_and_a_move_above_cost(self):
        base = {0.1: -0.01, 0.5: 0.0, 0.9: 0.01}
        records = [
            record(0.010, {0.1: 0.0, 0.5: 0.005, 0.9: 0.01}, base, 0.7),
            record(-0.010, {0.1: 0.0, 0.5: 0.005, 0.9: 0.01}, base, 0.6),
            record(0.050, {0.1: 0.0, 0.5: 0.002, 0.9: 0.01}, base, 0.9),
            record(0.050, {0.1: 0.0, 0.5: 0.010, 0.9: 0.02}, base, 0.5),
        ]
        out = scoring.toy_long_signals(records)
        self.assertEqual(out["signals"], 2)
        self.assertAlmostEqual(out["meanNetLogReturn"], -0.003)
        self.assertEqual(out["netWinRate"], 0.5)


if __name__ == "__main__":
    unittest.main()
