# Usage evidence collected on 14 September 2026

This is the numeric evidence for [journal 03](../../03-token-cost.md), collected after the initial cost investigation. It combines original OpenRouter **daily/model exports** with an anonymized numeric projection of production **individual charge, completion and run records**. These datasets have different coverage and must not be summed together.

## What the account exports show

| UTC date              | Reported spend (USD) |   Requests |
| --------------------- | -------------------: | ---------: |
| 6 September           |             6.357478 |        270 |
| 7 September           |             8.301171 |        324 |
| 8 September           |           0 exported | 0 exported |
| 9 September           |             0.129481 |          7 |
| 10 September          |             0.505862 |         29 |
| 11 September          |             0.307691 |         15 |
| 12 September          |             0.156835 |          7 |
| 13 September, partial |             1.482645 |        103 |

![OpenRouter daily spend and request volume, showing a drop in both](usage.png)

The earlier heavy-use days, 6–7 September, contain 594 requests costing $14.658649. The later comparison, 9–12 September, contains 58 requests costing $1.099869. Normalized for their different lengths, spending went from $7.3293/day to $0.2750/day (**96.25% lower**) and requests from 297/day to 14.5/day (**95.12% lower**). Account-wide cost/request fell **23.16%**. These are observed changes across different usage windows, not equivalent-workload savings.

Restricting the comparison to the same model removes one confounder, but still does not hold task complexity, context, provider pricing, routing or output quality constant:

| Sol only                               |     6–7 September |    9–12 September |
| -------------------------------------- | ----------------: | ----------------: |
| Requests                               |               310 |                57 |
| Reported spend                         |        $11.479258 |         $1.089207 |
| Average spend/request                  |          $0.03703 |          $0.01911 |
| Average prompt tokens/request          |         13,511.76 |          8,473.28 |
| Completion tokens, including reasoning |           102,263 |            18,611 |
| Cached prompt tokens / prompt tokens   | 6,040 / 4,188,647 | 103,435 / 482,977 |
| Token-weighted cached prompt fraction  |             0.14% |            21.42% |

Sol cost/request was **48.40% lower** and prompt tokens/request **37.29% lower**. This supports the narrower observation that later Sol traffic was less input-heavy and had more reported prompt-cache reuse. It does not isolate how much the code changes saved or prove equal-quality task completion. Across _all_ models, the cached fraction actually fell from 36.93% to 21.36%, because earlier Gemini traffic already had substantial caching. A single blended cache rate would tell a misleading story about Sol.

The cost change merged at **7 September 16:54:25 UTC / 8 September 00:54:25 SGT**, and the deployment record was committed at 00:56:03 SGT ([PR #16](https://github.com/akhilvuputuri/companion-agent/pull/16), [deployment record](https://github.com/akhilvuputuri/companion-agent/commit/bb8793b9a0aa5cd7b8f65aa909d301ffea73497c)). The chart's 7 September bucket includes that boundary. It is deliberately labeled an early/later comparison rather than a pure pre/post experiment. September 8 has no rows in these account exports; zero exported usage is not proof of application health or a free completed task. September 13 is shown for context and excluded from the comparison because the export ends at 17:03 UTC, before the day is complete.

## Reconciling the original screenshot

The owner-supplied screenshot showed **$15.70** and date labels 6–12 September. The current export over those labels totals **$15.758518**. We retained this difference and checked its timing rather than adjusting source values.

The filename implies capture at **13 September 01:32:30 SGT / 12 September 17:32:30 UTC**. A separate read-only [cutoff query](screenshot-cutoff.sql) found three subsequent production calls that day totaling **$0.054992**, independently agreeing in both the charge ledger and completion events. Subtracting that later usage gives **$15.703526**, which rounds to **$15.70**. The [cutoff result](screenshot-cutoff.json) preserves the evidence. This is consistent with a partially elapsed final day and displayed rounding; the filename is not independently verified image metadata, and we did not inspect the dashboard's internal billing implementation.

The screenshot's percentage comparison against its almost-zero previous period is not an efficiency metric. We do not use it. Nor do we infer exact per-day values by measuring bar heights.

## Production records and the original incident

The projection recovered **229 completed-model records**, including 24 from the preserved reset archive. There were no shared event or run IDs between the archive and current tables. The exported identifiers are local ordinals, not production IDs.

Anonymous **run 8** reproduces the original investigation: **16 completed Sol calls, 100 tool dispatches, 326,051 prompt tokens, 7,193 completion tokens, 394 reasoning tokens within completion, zero cached prompt tokens, and $0.8870335 reported main-model cost**. The export did not recover that run's search cost. The original report's 57 searches/37 distinct strings remains historical evidence; this new numeric projection does not contain queries and does not independently recalculate that distinct-query count.

The earliest observed charge reservation is **7 September 17:04 UTC / 8 September 01:04 SGT**. At capture, the ledger contained:

| Ledger channel                           | Reservations | Known actual costs | Unknown actual costs | Known reported cost subtotal |
| ---------------------------------------- | -----------: | -----------------: | -------------------: | ---------------------------: |
| Main adapter, including specialist calls |          127 |                126 |                    1 |                   $2.2536187 |
| Separate search helper                   |           37 |                 35 |                    2 |                   $0.3482765 |
| Total                                    |          164 |                161 |                    3 |                   $2.6018952 |

An additional **103 pre-ledger completed-model records** retain $6.985573 of main-model usage, 2,591,527 prompt tokens and zero cached tokens. They cover part of earlier application usage; they do not recover all historical Hermes calls, search/helper charges or local development calls. The 126 later main completion records total **the same $2.2536187 as the main ledger**: these are overlapping representations, not additional spend. All 229 recovered completion records name Sol and provider `OpenAI`; that does not establish the account-wide provider mix.

For 9–12 September UTC, account and application costs agree closely, with small differences at the CSV's six-decimal precision. They are not guaranteed to reconcile request by request: successful generation IDs were not retained by the adapter. September 13's account export has 103 requests/$1.482645; the production ledger has 104 reservations, 102 known costs totaling $1.48034395 and two unknowns. A reservation is written before a network call, so it does not prove a billable request occurred. Different scope, capture time, precision and failure accounting remain possible explanations; we do not assign the residual to one without evidence.

## Files and provenance

- `openrouter-*.csv`: six **unchanged original exports**, each with 13 `(date__day, model)` rows and one metric: reported USD, requests, prompt/completion/reasoning/cached tokens. Only date, public model display name and numeric values appear. The one GLM record on 5 September is retained, although outside the screenshot comparison. Four models were visible, below the selected top-10 limit, and every metric export has the same keys.
- [Export metadata](export-metadata.json): original filenames, hashes, selected range and collection method. Export window: **14 August 17:03 UTC to 13 September 17:03 UTC**. The page initially displayed GMT+8 but warned that older ranges retain UTC calendar days. A spend re-export after explicitly selecting UTC was byte-identical. UI settings are evidence of the selected scope, not a new account configuration.
- [Application charges](application-charges.jsonl), [model events](application-model-events.jsonl), [runs](application-runs.jsonl): one anonymized numeric record per line. Keys, owner IDs, actual run/invocation IDs, prompts, replies, search queries, attachments, source URLs and saved records are excluded. Times are reduced to day/hour; missing values remain `null`.
- [Application metadata](application-metadata.json) and [projection SQL](application-export.sql): capture time, source coverage, archive-overlap checks and exact field selection. The query is historical and expects the named archive schema. It was executed in a read-only transaction through the authorized operator connection, without provider calls or production changes. No connection details or credentials are included.
- [Analysis](analyze.py) and [summary](summary.json): checksum/row-key validation, decimal arithmetic, explicit denominators, missing-cost counts and computed comparisons. Decimal results are strings in JSON to preserve precision.

Charge timestamps mark **reservation start**, while completion-event timestamps mark **completion recording**. A call crossing midnight can fall on different days. A run's stored model is its latest recorded main model, not proof of every search helper's model; the ledger lacks per-search model identity, so that field stays absent. `model_event_latency_ms` includes host context/tracing/persistence overhead for successful calls. It is neither pure provider latency nor time until the user receives a text/voice reply. Run row lifetime includes waits and updates and is not active execution time.

OpenRouter's [Activity export guide](https://openrouter.ai/docs/cookbook/administration/activity-export) documents UI exports. Its [activity API](https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity-grouped-by-endpoint) requires a management key; we used the existing signed-in UI instead of creating broader credentials. [Prompt-cache documentation](https://openrouter.ai/docs/guides/best-practices/prompt-caching) distinguishes cached tokens from newly supplied tokens. Reasoning is already part of completion usage, and cached tokens are already part of prompt usage: neither is added again. Provider cache reuse and application-level search-result reuse are distinct mechanisms. Current list prices are not substituted for historical reported charges.

## Reproduce and extend

From this directory:

```sh
python3 analyze.py
```

The standard-library analysis performs no network or database requests. To regenerate the chart, install `matplotlib` in an isolated development environment and run `python3 analyze.py --chart`. Use `MPLCONFIGDIR` pointing to a writable temporary directory where required. The committed chart was visually checked for labels, scales and clipping. Regenerating it may vary fonts between machines; the numeric summary is deterministic.

To extend the observation window, create a **new dated evidence directory** and export the same metrics with a stated timezone/range. Preserve this snapshot. Authorized operators can rerun the SELECT-only projection inside `BEGIN READ ONLY`/`ROLLBACK` on a private connection, inspect the numeric projection before committing, and retain new checksums. Never export full event JSON or credentials to simplify collection.

Next useful evidence is cost **per comparable completed task**, together with quality review, task complexity, model/provider settings, main/search calls, cache reuse and unknown charges. These records do not supply a matched quality outcome, a controlled replay, marginal dollar savings from caching, or end-to-end voice latency. The next comparison should record these outcomes alongside usage.
