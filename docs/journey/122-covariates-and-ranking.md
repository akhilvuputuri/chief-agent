# 122 — Do market inputs or cross-sectional ranking give the models an edge?

Work dates: 2026-10-25 to 26. Written: 2026-10-26.
Status: tested locally; nothing deployed. Neither did. Adding market, sector, VIX and volume inputs made Chronos-2 slightly worse. Ranking 100 large US stocks by next-week return gave Chronos-2 a rank correlation of zero and TimesFM 2.5 a significantly negative one. Simple momentum and reversal rules were not significant either.

## User-visible problem and preceding iteration

[Journal 121](121-forecaster-leaderboard.md) found that no open-weight model beat a random walk when forecasting single stocks from their own prices. The owner asked when such models would be effective. Two of the suggested conditions could be tested for free with the same harness:

- **A. Information beyond the price chart:** give Chronos-2 the market, the stock's sector, VIX and its own volume.
- **B. Relative rather than absolute calls:** rank about 100 stocks against each other every week.

## Evidence

**Pre-registration (tested).** Both experiments' settings were committed in `d528887` before the full runs, which used that commit unchanged. Small smoke runs on subsets came first: AAPL, KO and SPY for A, and 25 stocks for B. No setting changed after them.

**Data (measured).** Split-adjusted daily bars from Yahoo's public chart endpoint, fetched on 2026-10-24, used locally and not committed:

- 100 stocks: today's S&P 100 members from Wikipedia's component table, with GOOG dropped as a duplicate share class;
- SPY, the 11 SPDR sector ETFs and VIX.

Because these bars end a day later than journal 121's, every forecast date here falls one session later.

### A. Chronos-2 with past-only covariates

`chronos-2-cov` in [`leaderboard.py`](../../forecast_runtime/leaderboard.py) gives Chronos-2 its usual close series plus four inputs, aligned to the stock's dates:

- log closes of SPY;
- log closes of the stock's sector ETF (SPY itself gets neither);
- the VIX level;
- the stock's log volume.

The test covers the same 10 stocks as journal 121, with 60 dates each from 2025-08-14 to 2026-10-16. Skill is pinball skill against the zero-drift EWMA random walk. Δ is in basis points, with a 95% interval from blocks of four consecutive dates.

| Engine        | 1 day: skill, Δ [95% CI]  | 1 day coverage | 5 days: skill, Δ [95% CI] | 5 days coverage |
| ------------- | ------------------------- | -------------- | ------------------------- | --------------- |
| GARCH-t       | +0.010, −0.4 [−0.8, +0.1] | 80%            | +0.006, −0.5 [−1.4, +0.3] | 83%             |
| Chronos-2     | −0.074, +2.8 [+1.9, +4.1] | 81%            | −0.013, +1.1 [−0.9, +3.0] | 76%             |
| Chronos-2-cov | −0.090, +3.4 [+2.2, +5.2] | 77%            | −0.024, +2.1 [−0.0, +4.5] | 70%             |

- **The inputs did not help.** Chronos-2 with them lost by more at both horizons, and its 5-day intervals became too narrow (70% coverage). The 2026-only subset shows the same ordering.
- **Plain Chronos-2's result moved with the dates.** Its 1-day skill was −0.042 in journal 121 and −0.074 here, with the forecast dates shifted by one session. Single-stock skill figures of this size are therefore sensitive to the exact dates. The sign, worse than the random walk, did not change.

### B. Weekly cross-sectional ranking

[`ranking.py`](../../forecast_runtime/ranking.py) scores, on each of 60 dates five sessions apart (2025-08-14 to 2026-10-16):

- **Eligibility.** Every stock with at least 252 earlier bars counts, on average 99.6 stocks per date.
- **Model engines.** Chronos-2 and TimesFM 2.5 score each stock by the median of its forecast 5-day log return, from up to 512 closes.
- **Baselines.** Momentum is the log return from 65 to 5 sessions before the date. Reversal is minus the last week's return.
- **Metrics:**
  - the Spearman rank correlation (IC) with the realised 5-day return;
  - long-short: top minus bottom decile;
  - long-only: top decile minus the universe average.

  Both spreads are per week, net of 0.30% round-trip cost on the names that changed.

| Engine      | Mean IC [95% CI]        | Dates with IC > 0 | Long-short net, per week | Long-only net, per week | Top-decile turnover |
| ----------- | ----------------------- | ----------------- | ------------------------ | ----------------------- | ------------------- |
| Chronos-2   | −0.001 [−0.037, +0.029] | 52%               | −0.37% [−1.26, +0.47]    | +0.01% [−0.44, +0.58]   | 69%                 |
| TimesFM 2.5 | −0.043 [−0.080, −0.019] | 38%               | −1.30% [−2.46, −0.65]    | −0.45% [−1.03, −0.11]   | 65%                 |
| Momentum    | +0.010 [−0.045, +0.066] | 55%               | +0.32% [−1.13, +1.92]    | +0.59% [−0.24, +1.55]   | 24%                 |
| Reversal    | +0.031 [−0.030, +0.089] | 53%               | −0.39% [−1.51, +1.01]    | +0.12% [−0.55, +0.90]   | 90%                 |

- **2026-only subset (40 dates).** Same ordering. TimesFM's IC was −0.061 [−0.102, −0.025]; Chronos-2's was −0.003.
- **Compute (measured, Apple M4, 4 threads, about 6,000 forecasts per model).** Chronos-2 took 108 s and TimesFM 685 s.

## Diagnosis and alternatives

- **A: the inputs added noise, not information.** A hypothesis consistent with the result: past market, sector and VIX moves say little about a single stock's next 1–5 days beyond its own volatility, and the extra variates widen what the model has to fit. No feature subset was tried, by design.
- **B: Chronos-2 ranks at random. TimesFM ranks reliably the wrong way.** Its significantly negative IC fits a model that extends each stock's recent move while short-term returns among large US stocks tend to partly reverse; reversal's positive but non-significant IC points the same way. This was not isolated.
  - Inverting TimesFM's ranking was not tested. It would be a choice made after seeing these results, and the reversal rule, which needs no model, already captures that idea without a significant result.
- **Baselines are not edges either.** Neither momentum nor reversal had an IC interval above zero over 60 weeks. Momentum's long-only figure (+0.59% a week) has an interval that includes zero.
- **Universe bias.** Today's S&P 100 members are the companies that survived and grew, which favours momentum-style rules in hindsight. That makes the models' failure more telling, not less.
- **Not tried:**
  - fine-tuning;
  - smaller, less efficient stocks, where costs are higher;
  - fundamentals or news as inputs;
  - longer holding periods;
  - a covariate subset chosen in advance on other data.

## Implementation and review

- **Code.** `chronos-2-cov` and `covariates_for` in `leaderboard.py`; `ranking.py`; `scoring.ranks` and `scoring.spearman`, cross-checked against scipy. All the scoring tests run in `npm test`.
- **Data assembly.** Covariates are forward-filled onto each stock's dates. Ranking uses SPY's sessions as the calendar, and a stock enters a date only with 252 earlier bars and a full horizon after.
- **Review.** No independent review of `d528887` yet.

## Verification and outcome

- **Measured:** both experiments on the stated universes and dates, with block-bootstrap intervals.
- **Not measured:**
  - EC2 timings;
  - results before August 2025;
  - other horizons or rebalancing intervals;
  - any trading rule beyond the decile spreads.

## Follow-up and next iteration

- **Across journals 120–122:**
  - off-the-shelf price forecasters gave no usable edge on large US stocks, whether forecasting one stock, adding market inputs or ranking 100 stocks;
  - their calibrated ranges, and GARCH's, are a sound basis for risk context and unusual-move alerts;
  - simple momentum and reversal rules were not significant over these 60 weeks.
- **Phases.** Design phases 2–5 stay on hold. The harness remains available to rerun when new models appear.
