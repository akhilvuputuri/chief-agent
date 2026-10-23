# 121 — Does any open-weight forecaster beat a random walk on ten US stocks?

Work dates: 2026-10-23 to 24. Written: 2026-10-24.
Status: tested locally; nothing deployed. None of Kronos-small, Chronos-2 or TimesFM 2.5 beat a zero-drift EWMA random walk on 600 forecasts across ten stocks. GARCH(1,1) tied it.

## User-visible problem and preceding iteration

[Journal 120](120-kronos-cpu-spike.md) found Kronos cheap on CPU but worse than a random walk on AAPL. The owner asked for a wider, fair test before building the daily box (design phase 2). It covers more stocks, two more open-weight models and a stronger volatility baseline, with settings fixed before the run.

## Evidence

**Pre-registration (tested).** Every setting is in `SETTINGS` in [`leaderboard.py`](../../forecast_runtime/leaderboard.py). It was committed in `bfcacaf` before the full run, and the run used that commit unchanged. The settings:

- **Symbols:** AAPL, MSFT, NVDA, AMZN, JPM, XOM, JNJ, WMT, KO and SPY.
- **Forecast dates:** 60 per symbol, five sessions apart, 2025-08-13 to 2026-10-15; horizons 1 and 5 sessions.
- **Kronos-small:** lookback 64, 64 samples, eval mode, top-p 0.9. The lookback was the spike's best setting on AAPL, so AAPL is in-sample for that choice.
- **Chronos-2:** `amazon/chronos-2` at `29ec376`, context 512, quantile head.
- **TimesFM 2.5:** `google/timesfm-2.5-200m-pytorch` at `1d95242`, context 512, continuous quantile head with crossing fixed.
- **GARCH:** `arch` GARCH(1,1), zero mean, Student-t, fitted to 500 bars per date.
- **EWMA reference:** λ 0.94 over the same 500 bars.

**Data (measured).** About five years of split-adjusted daily bars per symbol from Yahoo's public chart endpoint, used locally and not committed; Twelve Data had no local key. AAPL closes matched the Twelve Data bars used in journal 120 to within 0.1% on all 1,200 shared days (largest difference 0.000%).

**Scores (measured).** 600 forecasts per engine and horizon, all scored on log returns.

- **Pinball skill** is 1 − (engine's loss ÷ EWMA's loss); below 0 is worse than the random walk.
- **Δ vs EWMA** is the mean pinball difference in basis points; its 95% interval comes from resampling whole forecast dates, because the stocks move together.
- **Coverage** is for the 10–90% interval; a Brier score of 0.25 is a coin flip.

| Engine       | Horizon | Pinball skill | Δ vs EWMA, bp [95% CI] | Stocks beating EWMA | 80% coverage | Brier |
| ------------ | ------- | ------------- | ---------------------- | ------------------- | ------------ | ----- |
| EWMA (ref.)  | 1 day   | 0             | —                      | —                   | 80%          | 0.250 |
| GARCH-t      | 1 day   | +0.002        | −0.1 [−0.5, +0.4]      | 6/10                | 76%          | 0.250 |
| Chronos-2    | 1 day   | −0.042        | +1.7 [+0.6, +2.8]      | 1/10                | 81%          | 0.264 |
| TimesFM 2.5  | 1 day   | −0.029        | +1.1 [+0.4, +1.8]      | 2/10                | 85%          | 0.254 |
| Kronos-small | 1 day   | −0.162        | +6.4 [+4.3, +8.5]      | 0/10                | 59%          | 0.316 |
| EWMA (ref.)  | 5 days  | 0             | —                      | —                   | 81%          | 0.250 |
| GARCH-t      | 5 days  | +0.007        | −0.6 [−1.4, +0.2]      | 6/10                | 79%          | 0.250 |
| Chronos-2    | 5 days  | −0.010        | +0.8 [−0.8, +2.9]      | 4/10                | 76%          | 0.257 |
| TimesFM 2.5  | 5 days  | −0.019        | +1.7 [+0.4, +3.0]      | 3/10                | 79%          | 0.257 |
| Kronos-small | 5 days  | −0.249        | +21.4 [+14.4, +29.0]   | 0/10                | 51%          | 0.323 |

- **2026-only subset (400 forecasts per engine).** The ranking is the same. TimesFM's 1-day interval includes zero (−0.014, Δ +0.6 bp [−0.5, +1.6]). Chronos-2's 5-day result is −0.003. Kronos-small is worse again: −0.172 at 1 day and −0.273 at 5 days.
- **Direction.** No model's median called the sign of the move better than about 50%: 45–52% across engines and horizons.
- **Compute (measured, Apple M4, 4 threads, all 600 dates).** Including model loading: Chronos-2 24 s, TimesFM 76 s, Kronos-small 1,090 s, GARCH 6 s. Kronos's time comes from sampling 64 paths autoregressively.

## Diagnosis and alternatives

- **Observed.** The two general-purpose models, Chronos-2 and TimesFM 2.5, produce well-calibrated intervals close to the random walk's and lose by 1–4% on pinball loss. Their medians add no directional information. Kronos-small's intervals are far too narrow (coverage 51–59%) and its medians carry the directional bias seen in journal 120.
- **Interpretation.** These results are consistent with daily returns of large US stocks being close to unpredictable from their own price history at 1–5 days. That is the hypothesis behind the random-walk baseline, which no engine beat here. GARCH's tie with EWMA matches the volatility literature: GARCH is hard to beat, and EWMA is a GARCH special case.
- **Not tried:**
  - fine-tuning on US daily bars;
  - covariates such as market, sector or volume features;
  - calibration wrappers;
  - other lookbacks, sample counts or temperatures for Kronos;
  - intraday data;
  - cross-sectional ranking rather than per-stock forecasts.

  The test cannot rule these out. It does show that the off-the-shelf models give no edge as an input to Chief's suggestions.

- **Possible training overlap.** Chronos-2's weights were last updated on 2026-06-05 and TimesFM 2.5's in September 2025; their training corpora may include part of this window. Overlap would favour those models, which still lost.

## Implementation and review

- **Leaderboard.** [`leaderboard.py`](../../forecast_runtime/leaderboard.py) adds the five engines. `scoring.py` gains `p_up_from_quantiles` (CDF interpolation for quantile-only models) and `cluster_bootstrap_ci`, both standard library, with tests in `npm test`. Model dependencies are in [`requirements-leaderboard.txt`](../../forecast_runtime/requirements-leaderboard.txt); installing them upgrades `huggingface_hub` to 2.x.
- **Upstream report.** While preparing it, I found that the training-mode problem from journal 120 depends on the `huggingface_hub` version: 2.0.0 added `model.eval()` to the safetensors load path. Tested: `model.training` was `True` with 0.33.1, which Kronos pins, and `False` with 2.3.0. Also tested: in training mode with dropout set to zero, the s2 logits did not change when the sampled s1 changed. Reported upstream as [shiyu-coder/Kronos#415](https://github.com/shiyu-coder/Kronos/issues/415).
- **Independent review of `bfcacaf`:** pending at the time of writing; its findings and fixes will be added here.

## Verification and outcome

- **Measured:** scores for five engines on ten symbols, two horizons and a 2026 subset, with date-clustered intervals.
- **Not measured:**
  - EC2 timings;
  - symbols outside large US stocks;
  - any trading rule's net returns (forecast quality failed first, so no trading simulation was run).

## Follow-up and next iteration

By the design's pre-registered rule (pinball skill above zero), every model arm would be reported as failed. A daily box and ledger would re-measure a negative result, so phase 2 is not started.

What happens next is the owner's choice:

- stop the trading track;
- keep the harness as a benchmark to rerun when new models appear;
- test one of the untried directions above.
