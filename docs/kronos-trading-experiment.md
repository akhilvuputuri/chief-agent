# Kronos short-term trading experiment — design

Status: design and a local CPU spike, 23 October 2026. Nothing here is deployed. Journal: [120](journey/120-kronos-cpu-spike.md).

## Owner decisions — 23 October 2026

- **Purpose.** Test whether Kronos, an open-weight forecasting model for price candles ([shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos), MIT), gives a usable short-horizon edge on US stocks once costs are counted. This is an experiment, not an investment engine. Value investing was considered and set aside, because Kronos reads only prices and volume and is tested only up to 12 trading days ahead.
- **Suggestions, not automation.** Chief suggests and the owner decides. The owner may send any suggestion to IBKR whenever they like through the existing approval-gated [order drafts](ibkr-portfolio.md#order-drafts): every draft needs the owner's request in Chief and then Review & Submit in an IBKR app. Chief never places, changes or cancels an order.
- **No subscriptions.** Data stays on the Twelve Data free plan. The only spend is EC2 box time.
- **Horizons.** 1-day and 5-day signals, scored separately.
- **Model size.** The spike measures Kronos-small and Kronos-base on CPU; the choice follows from speed and early scores.

This crosses the "no buy or sell advice" boundary in the stocks and portfolio agents and in [stock rules](stock-rules.md#out-of-scope). The change is limited to this experiment: its suggestions are labelled as an experimental model signal, go only to the owner, and never reach the watchlist rules, briefings or other agents.

## What the evidence says before we start

Measured or read on 23 October 2026; the research behind this summary stayed outside the repository.

- **Repository.** 43,295 stars and 7,136 forks, but no commits since 13 April 2026, no releases and 285 open issues and pull requests. Kronos-large is not public. The code is pinned here by commit and the weights by revision and SHA-256 ([lock file](../forecast_runtime/kronos.lock.json)).
- **What the paper tested** ([arXiv 2508.02739](https://arxiv.org/abs/2508.02739), AAAI-26): daily forecasts up to 12 bars ahead, no random-walk or persistence baseline in the forecasting tables, and one investment backtest on Chinese A-shares. Its own appendix shows GARCH beating every Kronos variant on NASDAQ realised volatility.
- **Independent tests, all self-reported in issues and not rerun here:** Kronos-mini worse than persistence on daily AAPL ([#354](https://github.com/shiyu-coder/Kronos/issues/354)); no stable edge on 30-minute US stocks ([#355](https://github.com/shiyu-coder/Kronos/issues/355)); a cross-sectional test on 182 US stocks after the pretraining cutoff with IC +0.022 (t = 1.39) that fails after costs ([#375](https://github.com/shiyu-coder/Kronos/issues/375)); no edge on futures ([#387](https://github.com/shiyu-coder/Kronos/issues/387)).

The experiment is therefore expected to find little or no edge. A clean negative result is a valid outcome.

## Upstream behaviours the runtime must handle

Read in the pinned code (`model/kronos.py` at `67b630e`) and `huggingface_hub` 0.33.1:

- **Samples are averaged away.** `auto_regressive_inference` reshapes its samples and returns their mean, so `predict()` gives one path with no spread. The runner draws each sample as its own batch row with `sample_count=1` and keeps them.
- **Inference runs in training mode.** Checkpoints load through `PyTorchModelHubMixin`'s safetensors path, which never calls `.eval()`, and `KronosPredictor` never calls it either. README-style use therefore has two side effects:
  - dropout is active: Kronos-small's config sets FFN and residual dropout to 0.25 and attention and token dropout to 0.1; Kronos-base sets FFN and residual dropout to 0.2;
  - the s2 head's cross-attention becomes causal (`is_causal = self.training` in `module.py`). Its single query, the sampled s1 token, then sees only the oldest context position, so the s2 half of each token no longer depends on the sampled s1.

  The runner sets the mode explicitly. The spike compares `eval` with this upstream default, called `train`; the comparison measures both effects together, not dropout alone.

- **top-p is skipped when top-k is set.** `top_k_top_p_filtering` returns right after top-k filtering. The runner uses top-k 0 and top-p 0.9, the README defaults.
- **Normalisation** uses the lookback window's own mean and standard deviation, which is causal.
- **Reported hang.** `predict()` hangs after 20–40 calls in a loop on Windows ([#403](https://github.com/shiyu-coder/Kronos/issues/403)); the runner loads once and makes a few large batched calls.

## Architecture

```text
Chief (Lightsail, after the US close, e.g. 06:30 SGT Tue–Sat)
 ├─ fetch daily bars per experiment symbol (Twelve Data, 1 credit each, shared CreditBucket)
 ├─ launch a `forecast` box ──► task: bars + run settings
 │                               box: kronos_runner (CPU, no secrets, pinned image)
 │                               result: per symbol and horizon — quantiles, P(up), sample count,
 │                                       model, commit, weight hashes, mode, seed, timings
 ├─ store forecasts (append-only) and close the box
 ├─ score each forecast when its horizon closes, against the baselines, net of costs
 └─ send suggestions that pass the pre-registered rule, each with the arm's running scorecard
         owner: "draft it" ──► existing portfolio_order_draft (US shares, ≤ USD 100, review-and-approve)
```

- **Box profile.** A new `forecast` profile on the existing [box layer](boxes.md), with no retention (terminate after the run) and concurrency 1. Its image builds the Node worker (the box agent is installed from `/opt/chief-worker/dist/boxes` in the profile image) and adds the Python runtime, Kronos source and checkpoints fetched and verified at build time by [`fetch_artifacts.py`](../forecast_runtime/fetch_artifacts.py). A small `forecast-task.js` speaks the box task protocol and calls the runner, so the task needs no network. The owner applies the AWS change (a launch template and the instance type in the controller policy), as for the other profiles.
- **Instance size.** Chosen from the [spike timings](journey/120-kronos-cpu-spike.md) and confirmed by the first EC2 run, because the Mac numbers do not transfer directly to x86.
- **Future dates.** Kronos uses calendar features of the bars it forecasts. Chief sends the next session dates from `src/market-calendar.ts`, so live runs see the same holiday-aware dates the backtest used.
- **Storage.** New tables (one migration): runs, forecasts and signals, all append-only, each forecast carrying its model provenance; owner trades link to a signal ID when the owner drafts from one.
- **Baselines** are computed host-side in TypeScript beside `src/stock-stats.ts`, so they do not depend on the box: no trade (zero-drift random walk with an EWMA band), a simple momentum rule on the same symbols, and holding SPY.
- **Suggestions.** A separate experiment agent formats them; the stocks and portfolio agents keep their facts-only instructions. Drafting stays a foreground owner request with explicit terms, exactly as today.

## Signals and scoring (pre-registered)

Fixed before the ledger starts, so results cannot be tuned after the fact:

- **Forecast.** At least 32 samples per symbol; quantiles 10/50/90 of the log return at 1 and 5 days, taken at Weibull plotting positions so a calibrated model's 10–90% interval covers 80% on average (the linear method covers about 75% with 32 samples); P(up) is the share of samples above zero.
- **Signal.** Long only: P(up) ≥ 0.55 and a median move above the assumed round-trip cost of 0.30%. No shorting, margin or options.
- **Engine ledger.** Every signal is recorded whether or not the owner acts, and scored net of cost when its horizon closes. The owner's trades are scored separately, so the model's record and the owner's selection can be told apart.
- **Forecast scores.** Pinball loss (skill against the EWMA random-walk band), coverage of the 80% interval, Brier score of P(up) and sign hit rate, per horizon.
- **Stop rule.** After at least 100 signals in a horizon, the arm is reported as failed if its mean net return is not above zero at 95% confidence or its pinball skill is not above zero. Daily 5-day signals overlap and same-day signals move together, so the test uses Newey–West standard errors (at least 4 lags) clustered by signal date, not a plain t-test. The owner may keep the arm running; the report still says failed.

## Spike — 23 October 2026

See [journal 120](journey/120-kronos-cpu-spike.md) for the measurements, method and limits.

- **Runtime.** [`forecast_runtime/`](../forecast_runtime): `kronos_runner.py` (`bench` for timings and memory, `walk` for walk-forward scores), `scoring.py` (standard library; its tests run in `npm test`), `fetch_artifacts.py` and the lock file. [`scripts/kronos-spike-bars.mjs`](../scripts/kronos-spike-bars.mjs) fetches split-adjusted daily bars and drops an unfinished session.
- **Local run.**

  ```bash
  python3 -m venv .venv-forecast && .venv-forecast/bin/pip install torch==2.8.0 -r forecast_runtime/requirements.txt
  .venv-forecast/bin/python forecast_runtime/fetch_artifacts.py forecast_runtime/kronos.lock.json .forecast/kronos .forecast/weights
  node scripts/kronos-spike-bars.mjs AAPL 1200 > .forecast/AAPL.json
  KRONOS_SRC=.forecast/kronos KRONOS_WEIGHTS=.forecast/weights .venv-forecast/bin/python forecast_runtime/kronos_runner.py walk --bars .forecast/AAPL.json --models Kronos-small --modes eval,train
  ```

## Phases

1. **Spike** (this change): pinned runtime, CPU timings, walk-forward sanity check, design.
2. **Box profile**: image and `forecast-task`, the profile in `config/boxes.json`, the owner-applied AWS change, and one manual EC2 run with timings.
3. **Daily shadow run**: schedule, migration, forecast storage, host-side baselines and scoring. No Telegram output.
4. **Suggestions**: the experiment agent, Telegram messages with the scorecard, and linking owner drafts to signals.
5. **Review** after 100 signals per horizon, by the stop rule.

## Open questions

- Which symbols: the existing watchlist, or a fixed list of liquid US stocks chosen before the ledger starts?
- Whether to keep Kronos-base at all if the spike shows no quality gain over Kronos-small.
- Dividend handling: Twelve Data bars are split-adjusted only, so 5-day scores around ex-dividend dates carry a small bias.
