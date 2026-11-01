# 145 — Do three quants.md strategies reproduce, and do they beat simple benchmarks?

Work date: 2026-11-01. Written: 2026-11-01.
Status: tested locally; nothing deployed. All three published results reproduced to every published figure from public prices. None showed a significant edge over its benchmarks. All three had much shallower drawdowns than SPY, and over these windows they earned less per year.

## User-visible problem and preceding iteration

The owner asked to explore [quants.md](https://quants.md/), an open library of 50 backtested strategies from the QuantJourney Backtester, and then to test three of them independently. It follows the forecaster experiments in the stacked PRs ([#316](https://github.com/akhilvuputuri/chief-agent/pull/316), [#319](https://github.com/akhilvuputuri/chief-agent/pull/319)), which found no direction edge in off-the-shelf models.

## Evidence

**Method (tested).** [`strategy_replication.py`](../../forecast_runtime/strategy_replication.py) reimplements W01 (daily SMA trend on 9 sector ETFs), W05 (monthly inverse volatility on 8 multi-asset ETFs) and W17 (the same ETFs with SMA trend and a 10% volatility target) from their published rules at QuantJourney commit `16fe1ac`, using no QuantJourney code or service. Targets from one date trade at the next date's close. Prices are daily bars from Yahoo's public chart endpoint, to 2026-10-30, used locally and not committed. Cash uses the 13-week T-bill yield (`^IRX`).

**Order of decisions.** Rules, scenarios, benchmarks and the verdict rule were committed in `148be36` and `8b7db14` before any run on real prices. The first run used split-adjusted closes for SMA signals, and W01 and W17 missed their published figures. Switching signals to dividend-adjusted prices (`48aa119`) reproduced them, so that convention was adopted after seeing the gap. The close-price version stays as a sensitivity check. The verdicts were the same either way.

**Reproduction (measured).** Dividends included, 1 bp cost, 5% cash buffer earning nothing, 1× to 1.5× exposure with free borrowing in W17.

| Rule | Published return, CAGR, Sharpe, worst drop | Reproduced                 |
| ---- | ------------------------------------------ | -------------------------- |
| W01  | +537%, 7.38%, 0.45, −34.7%                 | +537%, 7.38%, 0.45, −34.7% |
| W05  | +174%, 5.45%, 0.45, −20.4%                 | +174%, 5.45%, 0.45, −20.4% |
| W17  | +169%, 5.35%, 0.36, −28.9%                 | +169%, 5.35%, 0.36, −28.9% |

**Comparison (measured).** Realistic scenario: 5 bp per side, T-bill on cash, T-bill plus 1% on borrowing. Measured from the end of each rule's warm-up to 2025-12-31, against benchmarks under the same costs. Sharpe uses a 2% risk-free rate. Intervals are 95%, from 12-month circular blocks.

| Rule or benchmark | CAGR   | Vol   | Sharpe | Worst drop | Rule's Sharpe minus benchmark's |
| ----------------- | ------ | ----- | ------ | ---------- | ------------------------------- |
| W01, 2000–2025    | 7.66%  | 13.5% | 0.47   | −34.5%     |                                 |
| SPY               | 8.59%  | 19.3% | 0.42   | −55.2%     | +0.06 [−0.19, +0.30]            |
| Equal-weight      | 9.05%  | 18.3% | 0.46   | −53.5%     | +0.02 [−0.18, +0.24]            |
| W05, 2007–2025    | 5.58%  | 8.2%  | 0.46   | −20.4%     |                                 |
| SPY               | 10.68% | 19.8% | 0.51   | −55.2%     | −0.14 [−0.54, +0.24]            |
| Equal-weight      | 5.91%  | 12.4% | 0.37   | −37.9%     | +0.06 [−0.10, +0.22]            |
| 60/40 SPY/IEF     | 8.07%  | 11.1% | 0.58   | −32.6%     | −0.20 [−0.51, +0.09]            |
| W17, 2007–2025    | 5.40%  | 10.7% | 0.36   | −28.9%     |                                 |
| SPY               | 10.57% | 20.0% | 0.50   | −54.7%     | −0.19 [−0.71, +0.30]            |
| Equal-weight      | 5.57%  | 12.4% | 0.34   | −37.9%     | +0.03 [−0.38, +0.45]            |
| 60/40 SPY/IEF     | 7.96%  | 11.2% | 0.56   | −32.6%     | −0.24 [−0.78, +0.27]            |

**Pre-registered verdicts (measured).** No rule has an edge, because every Sharpe interval includes zero. All three count as risk reduction: a drawdown at least 5 points shallower than SPY's, with a Sharpe interval not entirely below zero.

**Other scenarios (measured, CAGR).**

| Rule | Realistic | 15 bp per side | Flat 30% withholding on dividends | Trades per year (fraction of portfolio) |
| ---- | --------- | -------------- | --------------------------------- | --------------------------------------- |
| W01  | 7.66%     | 7.19%          | 7.11%                             | 4.4                                     |
| W05  | 5.58%     | 5.49%          | 4.92%                             | 0.9                                     |
| W17  | 5.40%     | 4.99%          | 4.71%                             | 3.9                                     |

Withholding also lowers the benchmarks: SPY over W01's window goes from 8.59% to 8.00%. The flat 30% is a rough assumption and ignores any interest-income exemption.

**Sensitivity (measured, realistic CAGR).** W01: 6.54% at SMA 40/160, 8.04% at 60/240, 6.78% on close-price signals. W17: 4.96% to 6.01% across the same changes and 4.56% to 5.85% across 8% to 12% volatility targets. W05 barely moved (5.48% to 5.60%) with a 42- or 126-day lookback.

**Subperiods (measured).** W01 returned +44% over 2000-10 to 2009 while SPY returned −2%, then trailed SPY in both later periods (+150% vs +247%, +74% vs +129%). W05 and W17 trailed SPY's return in both of their periods.

**After the published window (measured, 2026-01-02 to 2026-10-30).** W01 +13%, W05 +6%, W17 +11%, SPY +11.5%. Ten months is too short to judge.

## Diagnosis and alternatives

- **The published numbers are honest.** Dashboards for these three show a failed sanity flag; what it covers was not investigated, and it did not affect the reproduced figures.
- **Realistic assumptions roughly offset.** Higher costs and earned T-bill interest nearly cancel, so the published figures are close to realistic ones. W01 is about 0.5 points a year sensitive to tripling the cost.
- **The trade is less return for shallower drops,** consistent with the earlier finding that risk is more predictable than direction. 60/40 had the higher point Sharpe than W05 and W17, with a worst drop about 12 points deeper than W05's and 4 deeper than W17's. Whether a rule beats it on drawdown-adjusted terms was not tested.
- **Window dependence.** Most of this period favoured US stocks. W01's only win over SPY on return was the decade containing two large bear markets.
- **Fragility.** W01's yearly return moves by more than a point on SMA length or signal price, a change the card's figure does not show.

## Implementation and review

Standard library only; 28 tests in `npm test` cover the one-bar delay, future-price independence, costs, cash and borrowing, volatility targeting, universe isolation and the bootstrap. Two bugs were found before any real run (`8b7db14`): benchmark prices could have entered a rule's universe, and W01's window required IEF, which starts in 2002. No independent review of this code has been done; the exact reproduction validates the simulator and rules, but not the benchmark comparison or bootstrap.

## Verification and outcome

Measured: the tables above. Not measured: the other 47 strategies, taxes beyond the flat withholding assumption, execution at real fills, and any live or paper trading.

## Follow-up and next iteration

No rule justifies automated trading on these results. The drawdown finding supports risk context in Chief rather than signals. Whether the owner wants to act on it is their decision.
