# 92 — Jev ranks the news bulletin, with an exploration slot and a full candidate log

Work date(s): 2026-10-18. Written: 2026-10-18.
Status: in review. Jev orders each bulletin's shortlist; one slot per edition is an exploration pick; every ranked candidate is logged. Not deployed.

## User-visible problem and preceding iteration

- **Before.** The bulletin ([journal 86](86-news-reader-saves.md)) ranked feed items by topic phrases, recency, site affinity and TF-IDF word overlap with Reader saves.
- **Measured on 17 October.**

  | Since 29 September      | Count |
  | ----------------------- | ----- |
  | Editions                | 19    |
  | Items shown             | 133   |
  | Saves from the bulletin | 6     |
  | Followed sources        | 3     |

  Each edition's trace kept only candidate counts, so the items it did not show were lost, and labels existed only for the ranker's own picks.

- **The plan.** It was proposed on [#128](https://github.com/akhilvuputuri/chief-agent/issues/128#issuecomment-6232430354) as the first Laya use case: labels first, then compare scorers, then fine-tune.
- **The owner's decisions.**
  - Use Jev to rank for real, not in shadow, and learn from logs in real use.
  - Add one exploration slot.

## Evidence

Two research passes on 18 October. These are reported findings with sources, not measurements of Chief.

- **Jev's documentation and usage** (TypeSafe and OpenRouter docs, third-party reports):
  - `noul` returns P(yes), and questions in one request share one state.
  - TypeSafe's re-ranking cookbook scores one `noul` per candidate and sorts in code ([re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md)).
  - An open-source feed client measured Jev accuracy falling as more posts share one state: 8/8 at 8 posts, 19/22 at 22, 28/44 at 44. One post per request gave 22/22 ([xplorertui design note](https://github.com/jessearmand/xplorertui/blob/main/docs/jev-design.md)).
  - Calibration is reported good on verification and moderation tasks and weak on others ([Vals AI](https://www.vals.ai/blogs/independent-evaluation-of-jev)).
  - Price: $0.042 per million input tokens ([TypeSafe models](https://docs.typesafe.ai/models.md)).
- **Small-data recommendation literature:**
  - Zero-shot LLM ranking beats keyword matching (BM25) but trails trained models and popularity priors ([Hou et al., ECIR 2024](https://arxiv.org/abs/2305.08845)).
  - Plain yes/no prompting can be near random without tuning ([TALLRec, RecSys 2023](https://arxiv.org/abs/2305.00447)).
  - With few labels, the recommended combination is a blend such as reciprocal-rank fusion.
  - Logged random exploration enables unbiased offline evaluation ([Li et al., WSDM 2011](https://arxiv.org/abs/1003.5956)).
  - Shown-but-unsaved items are better negatives than unseen ones ([Saito et al., WSDM 2020](https://arxiv.org/abs/1909.03601)).
  - At about one save every three days, an online A/B comparison is infeasible. Offline replay of logged candidate pools, and later interleaving, are the practical evaluations.
- **Tested only.** This change was tested with mocked Jev and feed transports. No production measurement yet.

## Diagnosis and alternatives

- **Jev order by default (chosen, owner decision).** Jev's probability orders the regular picks and the deterministic score breaks ties. `order: "rrf"` in the config switches to reciprocal-rank fusion, which the literature favours with few labels, without a code change.
- **One request per candidate (chosen)** rather than many candidates in one state, following the measured degradation above. Eight requests run in parallel with one retry. Thirty candidates cost about $0.0005 per edition.
- **All-or-nothing ranking.** One failed request falls back to the deterministic order for the whole edition. Mixing scored and unscored candidates would bias the order.
- **Exploration** comes from the top 20 of the active order, outside the regular picks, at a uniformly random position, with its probability logged. Drawing from everything left would mostly pick weak items. A fixed last position would confound position with exploration.
- **Not chosen yet:**
  - Jev's graded `score` question type (an expected relevance level), which the literature favours over yes/no.
  - Retrieving the saves most similar to each candidate.
  - Weighting library saves below bulletin saves.
  - A logistic model over all sub-scores once 30–50 bulletin saves exist.

## Implementation and review

- [src/news-ranker.ts](../../src/news-ranker.ts): `JevNewsRanker.score`.
  - One `noul` request per shortlisted candidate.
  - Bounded state: topics, the 10 strongest saves, and the candidate's title, site, excerpt and date.
  - Concurrency and retry from [config/news-ranker.json](../../config/news-ranker.json).
  - A config `version` hash is logged with each ranking.
  - Never throws.
- [src/news.ts](../../src/news.ts):
  - `chooseItems` (the per-site cap, extracted).
  - `composeSelection`: Jev or RRF order, plus the exploration slot.
  - The edition build calls the ranker, records `jev`, `rankedBy` and `explore`/`exploreProbability` on each item's score, adds `ranker` and `candidates` (top 50, shown or not, every sub-score) to the trace, and writes a `news.ranked` log line.
- [src/config.ts](../../src/config.ts), [config/runtime.json](../../config/runtime.json), [src/main.ts](../../src/main.ts): `NEWS_RANKER` (`jev` default, or `off`).
  - An unreadable ranker config logs `news.ranker_config_failed` and keeps the deterministic ranker.
  - The Dockerfile copies the new config file; `tests/dockerfile-config.test.ts` enforces that.
- Tests:
  - [tests/news-ranker.test.ts](../../tests/news-ranker.test.ts):
    - one request per candidate, bounded concurrency and state;
    - retry, failure and unknown-cost paths;
    - Jev and RRF ordering;
    - the exploration window, position and probability.
  - [tests/news.test.ts](../../tests/news.test.ts):
    - a full edition ranked by Jev, with the trace candidates, scores and the log line without titles;
    - a Jev failure falling back to the rules while the edition is still sent.
  - Existing bulletin tests use a fixed random draw.
- Design: [news bulletin](../news-bulletin.md#jev-ranking-and-the-exploration-slot).
- **Independent review (Claude Opus 5.5) of `36a636c`:** REQUEST CHANGES.
  - **Blocking:** the candidate log cut titles at 200 UTF-16 units. An emoji at the cut left a lone surrogate, which Postgres rejects as JSON, so the whole edition insert failed, even with the ranker off.
    - **Fix:** a shared `clip` removes split surrogates. It is used for trace titles, the stored closest-saved title and the text sent to Jev.
    - A full-build test with an emoji at the cut fails without the fix.
  - **Non-blocking, all addressed:**
    - Jev could delay an edition by about 32 s while the doc said "never held up". There is now a 10-second deadline for the whole ranking, and the doc says Jev can delay but not stop an edition.
    - A 429 was retried at once. It now waits a short random pause.
    - The exploration pick could exceed the per-site cap. It now keeps the cap when another site is available, and the probability stays exact.
    - Jev's cost is not in the per-run provider charges. Documented.
- **Re-review of `3f55045`:** APPROVE.
- **Devin Review** (on `36a636c`, a second signal) found three candidate-log errors that would have mislabelled the learning data. All are fixed, each with a test that fails without the fix:
  - items dropped to fit one Telegram message were logged as shown; `shown` and `position` now come from the delivered message;
  - a delivered item ranked beyond the top 50 was missing from the log; it is now appended;
  - `rank` was the deterministic rank even when Jev set the order; `orderRank` is added.
- Re-review of these fixes: pending.

## Verification and outcome

Tested locally:

- after the review fixes: typecheck, 979 application tests and 51 script tests pass; earlier, the eval tests, `check:pi`, build and format passed;
- `check:coding` needs `ruff`, not installed locally; CI runs it.

Not measured:

- whether Jev's order raises the save rate;
- how its probabilities relate to saves;
- exploration-slot save rate;
- latency and cost per edition in production.

## Follow-up and next iteration

- **After a few weeks**, join `trace.candidates` with Reader saves, including saves of candidates that were never shown. Then compare Jev, the rules and RRF by offline replay: precision@5, recall of saves, and AUC of saves against shown-but-unsaved.
- **Try Jev's graded `score` question**, and retrieved similar saves as context, against the current yes/no question on the same logged pools.
- **Laya ([#128](https://github.com/akhilvuputuri/chief-agent/issues/128))**:
  - Use the logged pools as the evaluation set.
  - Treat about 100 bulletin saves and 1,000+ logged impressions as the earliest point to consider fine-tuning.
  - At the current rate that is many months, so using the whole Reader library matters more than the model.
