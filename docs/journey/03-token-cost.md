# 03 — Investigating expensive but useful responses

Work: 8 September 2026. Status: released; post-change savings not yet established.

## What we observed

The owner found response quality useful but API cost unexpectedly high. The recorded 22-role run showed:

| Measurement                              | Recorded value |
| ---------------------------------------- | -------------: |
| Main-model calls                         |             16 |
| Cumulative input tokens                  |        326,051 |
| Output tokens                            |          7,193 |
| Reasoning tokens, within reported output |            394 |
| Reported cache hits                      |              0 |
| Reported main-model cost                 |     $0.8870335 |
| Input component                          |     $0.8151035 |
| Search attempts / distinct query strings |        57 / 37 |
| Tool allocation reached                  |            100 |

Input represented about 92% of the reported main-model cost. These are cumulative tokens across calls, not one 326k-token prompt. The search adapter discarded usage, so this was not the complete task bill. Speech and infrastructure were also outside the total. Evidence: the existing [cost investigation](../cost-controls.md); raw private traces are not copied into this journal.

## Root-cause hypothesis

The sequential loop repeatedly sent growing context and repeated research. A token is paid for again each time it is supplied unless provider caching applies. Context eviction and repeated bookkeeping can also encourage redundant discovery. Zero observed cache hits did not establish a provider bug or guarantee that a stable prefix would fix it.

## Changes and why

1. Reduced total context allowance from 100,000 to 48,000 characters, accounting for instructions, schemas, memories and state before choosing history. Kept complete tool/result groups and retrievable full observations.
2. Separated a stable opening prompt from changing timestamps and task state. Added a per-run OpenRouter session ID to encourage provider stickiness. This creates an opportunity for cache reuse, not a guarantee.
3. Reused normalized identical successful searches for one hour within the same owner and task/run. Different tasks search fresh; expiry does not slide on cache reads. Semantic variants remain distinct.
4. Persisted usage for both the main model and search helper. Reported cost and unknown-cost estimates remain separate; unavailable cost is not zero.
5. Instructed the model to reuse research, inspect promising original pages and synthesize rather than keep searching marginally different queries.

We retained Sol medium reasoning and the output allowance because input dominated the observed cost. The owner declined a proposed $1 task cap; it was removed before deployment. Existing provider unit-price filters remain. Cost visibility does not stop work based on dollars.

## Verification and outcome

[PR #16](https://github.com/akhilvuputuri/companion-agent/pull/16), commit `a31813bd167e3916c1914966a386a4a480f54320`, shipped these mechanisms. The release record reports 78 tests and CI passing, healthy deployment, migration 008 present and no dollar-cap column. Tests cover context grouping, search isolation/expiry, persisted accounting and non-blocking costs above $1.

No controlled post-change production comparison was run. We can claim reduced configured context and eliminated repeat network searches on tested cache hits. We cannot yet claim a percentage cost reduction, improved cache-hit rate or equal-quality faster completion.

## Next measurement

Compare equivalent target sets, model/provider settings and task outcomes. Capture calls, input/output/cache tokens, actual main/search cost, unknown charges, elapsed time, duplicate searches and useful completion. Include quality review: a cheaper incomplete result is not a win. Start with ordinary usage; do not automatically restart paid evals.

## Interview explanation

“I traced an expensive agent run and found repeated input dominated the recorded bill, while search costs were missing from our accounting. I bounded context, reused identical task-local searches and added usage visibility. I preserved reasoning quality settings and kept unknown costs explicit. I have mechanism-level tests; a controlled savings claim still needs measurement.”
