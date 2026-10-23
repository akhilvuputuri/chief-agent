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
        self.assertEqual(
            scoring.sample_quantiles([0.0, 1.0, 2.0]), {0.1: 0.2, 0.5: 1.0, 0.9: 1.8}
        )
        with self.assertRaises(ValueError):
            scoring.quantile([], 0.5)

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
