# 120 — Can Kronos run cheaply on CPU, and do its forecasts beat a random walk?

Work date: 2026-10-23. Written: 2026-10-23.
Status: tested locally; nothing deployed. Kronos runs comfortably on CPU, but on one stock over 60 post-cutoff dates its forecasts lost to a zero-drift EWMA random walk in every configuration tried.

## User-visible problem and preceding iteration

The owner asked to test Kronos, an open-weight candlestick forecasting model, for short-term trading suggestions: Chief suggests and the owner decides whether to draft an IBKR order. Before building a box profile and a daily ledger ([design](../kronos-trading-experiment.md)), two things needed measuring: whether a daily run is cheap enough on CPU, and whether the forecasts look usable at all. Earlier evidence was mostly negative but self-reported (issues [#354](https://github.com/shiyu-coder/Kronos/issues/354), [#355](https://github.com/shiyu-coder/Kronos/issues/355), [#375](https://github.com/shiyu-coder/Kronos/issues/375), [#387](https://github.com/shiyu-coder/Kronos/issues/387)).

## Evidence

**Setup (tested).** Kronos commit `67b630e`; Kronos-small and Kronos-base with Kronos-Tokenizer-base, every file checked against the SHA-256 values in [`kronos.lock.json`](../../forecast_runtime/kronos.lock.json). torch 2.8.0 CPU, Python 3.12, 4 torch threads, on an Apple M4 Mac (arm64) in a local virtual environment; Docker Desktop did not respond, so the container path was not used. Sampling: temperature 1.0, top-p 0.9, top-k 0, 32 samples per forecast, horizon 5 bars. Bars: AAPL daily, split-adjusted, from Twelve Data's public demo key (1,200 bars, 2022-01-11 to 2026-10-22).

**Timings (measured, `bench`, 25 windows × 32 samples, lookback 400, one model per process).**

| Model        | Load  | Sampling for 25 symbols | Per symbol | Peak memory |
| ------------ | ----- | ----------------------- | ---------- | ----------- |
| Kronos-small | 0.5 s | 134 s                   | 5.4 s      | 3.2 GB      |
| Kronos-base  | 1.4 s | 696 s                   | 27.8 s     | 3.4 GB      |

With a 64-bar lookback, Kronos-small sampled 1,920 rows (60 dates × 32) in 73 s, so a 25-symbol batch takes about 30 s (derived). Memory is dominated by the 64-row sampling chunk.

**Forecast scores (measured, `walk`).** 60 forecast dates five sessions apart, 2025-08-13 to 2026-10-15, all after Kronos's June 2024 pretraining cutoff. Scored on log returns against a zero-drift random walk whose spread is an EWMA (λ 0.94) of the same window. Pinball skill below 0 means worse than the baseline; the baseline's 80% intervals covered 82% (1 day) and 83% (5 days); a Brier score of 0.25 is a coin flip.

| Model, lookback, mode | Horizon | 80% coverage | Pinball skill | Median 80% width (baseline) | Brier | Median sign hit rate |
| --------------------- | ------- | ------------ | ------------- | --------------------------- | ----- | -------------------- |
| small, 400, eval      | 1 day   | 55%          | −0.99         | 4.0% (3.9%)                 | 0.376 | 43%                  |
| small, 400, eval      | 5 days  | 35%          | −2.13         | 9.2% (8.7%)                 | 0.351 | 62%                  |
| small, 400, train     | 1 day   | 62%          | −0.54         | 4.0% (3.9%)                 | 0.382 | 38%                  |
| small, 400, train     | 5 days  | 43%          | −1.33         | 8.9% (8.7%)                 | 0.352 | 57%                  |
| base, 400, eval       | 1 day   | 35%          | −3.65         | 7.4% (3.9%)                 | 0.406 | 53%                  |
| base, 400, eval       | 5 days  | 13%          | −5.56         | 6.6% (8.7%)                 | 0.488 | 47%                  |
| base, 400, train      | 1 day   | 33%          | −2.73         | 7.6% (3.9%)                 | 0.397 | 50%                  |
| base, 400, train      | 5 days  | 12%          | −5.50         | 7.4% (8.7%)                 | 0.483 | 47%                  |
| small, 128, eval      | 1 day   | 60%          | −0.26         | 2.7% (3.9%)                 | 0.351 | 45%                  |
| small, 128, eval      | 5 days  | 43%          | −0.33         | 5.1% (8.7%)                 | 0.367 | 48%                  |
| small, 64, eval       | 1 day   | 62%          | −0.10         | 2.7% (3.9%)                 | 0.286 | 45%                  |
| small, 64, eval       | 5 days  | 48%          | −0.23         | 4.7% (8.7%)                 | 0.299 | 53%                  |

The runner's toy long-only rule (P(up) ≥ 0.55 and a median move above 0.30% round-trip cost) fired 0–41 times per row. With one rising stock and overlapping evidence it says nothing about an edge, so it is not reported as a result.

**Wrapper check (tested).** On five of the dates, the runner's median 5-day close paths matched the means from Kronos's own `KronosPredictor.predict` to within a few percent. The poor scores therefore come from the model, not from the wrapper.

## Diagnosis and alternatives

- **Observed.** With a 400-bar lookback, Kronos forecast large declines whenever AAPL was near the top of its window. On 2025-10-30 the median 5-day forecast was about −12%, and the actual move was −0.6%. On 2026-07-22 the forecast was about −13%, and the actual move was +3.8%. Shorter lookbacks shrank the bias and the losses but did not remove them, and they made the intervals narrower than the baseline's.
- **Hypothesis.** Kronos normalises each window by its own mean and standard deviation, and forecasts revert toward that mean. A trending stock near its window high is then forecast to fall. This fits the lookback results but was not isolated.
- **Training mode.** The upstream default (training mode: dropout on, and the s2 cross-attention made causal) scored less badly than eval for Kronos-small at lookback 400, apparently because its extra noise widened the intervals. It did not fix the bias. Kronos-base was worse than Kronos-small throughout.
- **What would change this.** Results on many symbols and regimes, a lookback and temperature chosen on data before the scoring window, fine-tuning on US daily bars, or recalibrating the quantiles (for example a conformal wrapper). None of these was tried.

## Implementation and review

- **Commit `4dca980`.** Added the pinned runtime ([`forecast_runtime/`](../../forecast_runtime)), the bars script and the [design](../kronos-trading-experiment.md).
- **Independent review of `4dca980`** (Opus 5.5, read-only):
  - **No leakage or misalignment** was found in the walk-forward indices, denormalisation or scoring maths.
  - **High: "train" mode is more than dropout.** Training mode also makes the s2 cross-attention causal (`is_causal = self.training`), so the sampled s1 token no longer conditions s2. I confirmed this in `module.py` and corrected the docstring and design.
  - **Interval coverage.** Linearly interpolated quantiles from 32 samples cover only about 75% for a calibrated model, so sample quantiles now use Weibull plotting positions. All walks above ran with this fix.
  - **Lower-severity fixes:**
    - the stop rule uses Newey–West errors clustered by signal date;
    - live runs use holiday-aware session dates;
    - downloads are written to `.part` files;
    - the cumulative-memory field is documented.

  The fixes are in commit `15e8bf4`.

- **Checks.** `scoring.py` uses the standard library only, and its tests run in `npm test`. The Weibull and linear quantiles were cross-checked against numpy.

## Verification and outcome

- **Measured:** CPU cost and memory for both models, and walk-forward scores for 12 configurations on one symbol.
- **Not measured:**
  - x86 EC2 timings;
  - the container image;
  - more than one symbol;
  - GARCH as a baseline (only EWMA was used);
  - other sampling settings;
  - fine-tuned weights.
- **Not claimed:** Kronos may do better on other stocks or settings. Sixty dates on one stock cannot show that it never works, but they give no reason to expect an edge.

## Follow-up and next iteration

- **Cost.** A daily box is cheap: Kronos-small takes under a minute per 25-symbol batch at lookback 64 on this CPU. Kronos-base is about 5× slower and scored worse, so it can be dropped.
- **Quality.** Before building the box profile (design phase 2), repeat the walk on about ten liquid US symbols with the owner's free Twelve Data key. Fix the lookback, temperature and sample count first, and keep GARCH(1,1) beside EWMA as a baseline. If Kronos still loses on pinball and coverage, the daily ledger would mostly re-measure a negative result. Whether to build it anyway is the owner's decision.
