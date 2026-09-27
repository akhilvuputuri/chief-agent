# 37 — Picking tool domains with Jev (issue #77 stage 3)

Work date(s): 2026-09-27. Written/revised: 2026-09-27.
Status: released 27 September 2026 in `d4436df`; production recall, latency and cache effects not yet measured on real messages.

## User-visible problem and preceding iteration

[Journal 36](36-bounded-context.md) stage 2 stopped sending all 71 tool schemas on every call. It picks domains with word cues, task binding, pending approvals and recent tool use. The owner judged the cues weak: they are not dynamic, and every phrasing they miss costs an extra `tools_load` step. The owner asked for an objective look at a picker driven entirely by TypeSafe's Jev decision model on OpenRouter, and treated it as an optimisation: a missed domain costs a step, not an outage.

## Evidence

**Synthetic scenarios (tested).** 174 labelled messages written by the developer: 101 for tuning and 73 held out. They cover each domain, small talk, several domains in one message, follow-ups with earlier turns, and host signals such as pending approvals. They are not production traffic. They are in `evals/picker/scenarios.json`.

**Measured, 27 September 2026.** Runs used the production gateway image on Lightsail (Singapore) and the `typesafe/jev-1.13` alias, 2 runs each. "Recall" is the share of labelled domains loaded.

| Held-out (73)                                          | Recall     | Extra domains per message | Schema share of all tools |
| ------------------------------------------------------ | ---------- | ------------------------- | ------------------------- |
| Stage 2 word cues                                      | 55.4%      | 0.26                      | 15%                       |
| Jev yes/no per domain, ≥0.5, cap 3, best ≥0.15 if none | 96.9–98.5% | 0.29                      | 18%                       |
| Same plus a "primary domain or core only" choice       | 96.9–98.5% | 0.33                      | 18%                       |
| Same plus a "needs any tools?" gate                    | 95.4%      | 0.37                      | 19%                       |

- The cues reached 74% on the tuning set, so the held-out figure probably overstates their weakness. The held-out messages were written after the cues and avoided their words.
- The extra choice question raised cost per call from about $0.000075 to $0.000116 without improving recall.
- The "needs any tools?" question was poorly calibrated: 42 of 296 tool-needing calls scored below 0.3.
- Carrying the last turn's domains forward made no difference on this set.
- Latency from Singapore: p50 about 283 ms, p95 about 363 ms. There were no errors in 1,072 calls.
- The picked set changed between identical runs for 7 of 174 scenarios.

**Pinned snapshot, measured 27 September.** `npm run eval:picker` ran from a developer Mac against `typesafe/jev-1.13-20260917`, 3 runs, 522 calls:

- recall 97.9% (tuning and held-out alike), 98.1% of calls fully covered;
- 0.29 extra domains per call, schemas at 18.1% of all tools;
- no errors, total cost $0.039;
- p50 498 ms and p95 785 ms from the Mac, which is further from the provider than the server.

Persistent misses were:

- a job-interview prep message that also needs the calendar;
- a vague request for a book "I can read tonight";
- a request to create a routine whose runs will read email; the label is arguable, since the routine reads email when it runs rather than at creation;
- a step-by-step study plan, which needed the work domain in 1 of 3 runs.

**Research (reported, not tested here).** The notes are outside the repository. Community Jev routers generally make one call per turn, pin the model, log probabilities, fail open and cap the number of loaded groups. Only one published measurement shows a gain, and it came from suggesting tools rather than removing them. Hard-filtering implementations published no evaluations.

## Diagnosis and alternatives

- **Word cues.** They are cheap and deterministic, but miss paraphrases, names and tickers. They stay as the fallback.
- **Choice or score questions.** They performed the same as per-domain yes/no questions, and cost more or were harder to threshold.
- **Per-domain thresholds.** They were fitted on the tuning set and overfitted on the held-out set, so one global threshold was kept.
- **Chosen mechanism.** Per-domain yes/no questions with one threshold, a cap and a single-best fallback. Hard host facts and domains offered in the last hour stay loaded.

Hypotheses not yet measured in production:

- that fewer `tools_load` steps outweigh the added ~300 ms per message;
- that holding domains for an hour keeps prompt-cache reuse acceptable.

## Implementation and review

See [context management, stage 3](../context-management.md#stage-3--jev-tool-picker).

- **Code.** `src/tool-picker.ts` holds the config, state, questions, pick rule and client. The wiring is in `src/agent.ts`, with the `TOOL_PICKER` switch in `src/config.ts`. The ops-log projection is `tools.picked`, and the Dockerfile bundles `config/tool-picker.json`.
- **Eval.** `evals/picker/` is standard-library Python and implements the same state, question and pick contract. Two shared fixtures, `pick-cases.json` and `request-golden.json`, are checked by both `tests/tool-picker.test.ts` and `evals/picker/test_pick.py`, so the two implementations cannot drift silently.
- **Code review.** An independent Opus 5.5 review of `63e7e37` requested small changes:
  - tool order depended on which source chose a domain, which would defeat prompt caching for the same set (medium);
  - holds renewed themselves through `tools.selected`, so a domain never expired under steady use;
  - a usage-ledger failure could fail the turn;
  - rejected requests left unsettled estimates;
  - tests were missing for follow-ups, background runs, transport failures and the log projection.

  All were fixed: canonical order, holds from `tools.picked` only, accounting isolated from the pick, zero settlement on HTTP rejection, and tests for each path.

- **Devin review** of the same head found a release blocker: the release handler refuses any `compose.yaml` that differs from the installed one, and the PR had added a `TOOL_PICKER` mapping. The mapping was removed; the setting keeps its application default. It also found:
  - the saved-answer-details pointer replaced the real reply in the picker state;
  - messages longer than the 2,000 characters Jev sees could lose their only cue;
  - the hold window used run start rather than event time.

  All three were fixed. The Opus reviewer's remaining lows were also addressed: zero settlement only for 4xx, and a non-vacuous background test.

- **Plan review.** An independent Fable review of the plan suggested more changes: a least-recently-used cap on held domains, relabelling from production tool use, an 800 ms timeout and skipping the Python eval. The owner kept the original plan. Those remain candidates if production numbers call for them.

## Verification and outcome

- `npm run check` passed with the picker, fallback, hold and cost-ledger tests, plus the Python unit tests.
- The eval passed on the pinned snapshot.
- Not yet measured:
  - production recall, meaning `tools_load` and auto-load rates after release;
  - the latency added per message;
  - cache reuse in `model.completed`.

## Follow-up and next iteration

After release, compare these fields in `tools.picked`, `tools.selected`/`tools.loaded`, `context.selected` and `model.completed` against the stage 2 period:

- picker outcome and latency;
- the rate of domains loaded mid-turn;
- `toolsChars` and cached tokens.

Refit the threshold from the probabilities recorded in production if misses or extras differ from the synthetic set.

### Release closure — 2026-09-27

- **Merge.** [PR #105](https://github.com/akhilvuputuri/chief-agent/pull/105) was merged at approved head `b5e96eb` as `d4436df`. The independent Opus 5.5 review approved `b5e96eb` with low findings only.
- **Release.** The `checks` and `release` workflows succeeded. The `companion/production` status reads "Exact commit deployed; startup health passed". `compose.yaml` and `db/` were unchanged, so the ordinary release path applied.
- **Production smoke check (operator, not owner acceptance).** Three picker calls ran inside the running gateway container with the production key, without the ledger:
  - "has the insurance company got back to me?" picked gmail;
  - "is Dune on Libby?" picked library;
  - "good morning!" picked nothing.

  Latency was 266–598 ms, about $0.000074 per call, and the model reported was `typesafe/jev-1.13-20260917`.

- **Pending.** No owner message had reached the picker at closure. Compare `npm run logs:cloudwatch -- picker` and `models` over the first days against the stage 2 period.
- **Remaining low review findings.**
  - Production has no quick off switch until Compose passes `TOOL_PICKER`.
  - A usage-ledger failure falls back to word cues rather than calling Jev.
  - `tools_used_last_hour` is bounded only by the number of distinct tools (at most 71 names).
  - Holds ignore picks from runs that started over two hours earlier, which foreground budgets currently prevent.
