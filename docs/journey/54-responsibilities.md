# 54 — Which changes deserve the owner's attention

Work date(s): 1–2 October 2026. Written: 2 October 2026.
Status: implementation candidate; disabled by default, not deployed or accepted in real use.

## User-visible problem and preceding iteration

[Scheduled routines](24-scheduled-routines.md) isolate recurring work but report each pass. [Parcel tracking](33-delivery-tracker.md) stores on-demand delivery facts. [Stock windows](39-watch-monitoring-window.md), [news](42-news-bulletin.md) and [feed destinations](53-feed-destinations.md) establish deterministic checks and independent delivery paths. [Issue 131](https://github.com/akhilvuputuri/chief-agent/issues/131) adds explicit standing concerns, meaningful-change investigations, attention decisions and lifecycle completion.

## Evidence

Source inspection used freshly fetched main `9b76fc5b6c7a4767d32a1d67f9476d9a0804ae81`; the subsequent documentation-only `78ad212182a34cf18b77a60c9e0d6d5cce8b7c0b` was fetched during implementation. Before review, fresh main advanced to `aacdc2ac9d9c9a92a11f74c19d88b93daa189a35`; its Libby refusal handling and reviewed runtime configuration were incorporated, preserving both documentation paths. Its successful release reported that exact SHA and startup health on 2 October SGT; a later failed attempt is not treated as a new deployment. The migration script now pins that baseline and still rechecks live RELEASE. The main/source baseline is distinct from production acceptance. Before implementation, 124 existing focused mocked tests passed. Synthetic new scenarios cover parcel/email investigation, evening delivery, external meetings, unchanged scheduled research, ownership, confirmation, permissions, restart, budgets, feedback and ambiguous delivery. Final suite/review evidence is pending below; this is not a production measurement.

Gmail remains a small IDs-only adapter. Official [message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [search timestamp semantics](https://developers.google.com/workspace/gmail/api/guides/filtering) and [Calendar occurrence identity](https://developers.google.com/workspace/calendar/api/guides/recurringevents) informed the mocks. Model quality, useful-notification ratio and model cost per useful finding remain unmeasured.

## Diagnosis and alternatives

Reusing routine delivery directly would send progress and final responses before attention filtering. Reusing the generic background context would expose unrelated feeds, memories and approvals. Scope therefore lives at the dispatcher, with a dedicated investigation context and a durable inbox/report/outbox path.

U6 has a disclosed contract clarification: a scheduled research occurrence can use a bounded model investigation even when its eventual result is unchanged. Source checks remain model-free, and unchanged findings remain silent. A guarantee of zero-model discovery on arbitrary topics would require a deterministic source contract; that broader source framework is not part of this change.

## Implementation and review

See [the behaviour and rollout contract](../responsibilities.md). Migration 023 is additive and preserves existing owner data and approval operations. Monitoring is default-off. During development, automatic approval review rejected enabling an unfinished default-on implementation; the safer disabled candidate was accepted for continued implementation. Activation remains a separate reviewed operator step.

The first full application suite found three Telegram mock-startup regressions because legacy mocks omitted `assistant.tools`; guarded optional integration fixed those failures. A subsequent run identified an out-of-date offline Python picker domain list; it was synchronized without running a paid evaluation. The combined local check passed 586 application tests, 21 JavaScript script tests and 30 offline Python tests. Final Calendar-filter, urgency and history-view refinements then passed 21 responsibility tests, typecheck, build and repository formatting. Exact-head CI and independent review remain pending. No paid smoke or eval was run. Existing provider pricing filters and ordinary foreground allocations are unchanged.

## Verification and outcome

### Independent review — 2 October 2026

GPT-6 Astra returned REQUEST CHANGES for head `e2c49613e50124e357775067b18e68729dee4a4b` against `aacdc2ac9d9c9a92a11f74c19d88b93daa189a35`. Independent repros found that one changed meeting suppressed other valid meetings in a batch, ongoing meetings could still receive late preparation, and a confirmation race could make a stale pause falsely report success and suppress newer findings. Fixes give each Calendar occurrence a separate investigation, require future start time at delivery, and serialize/recheck lifecycle updates before revision-scoped suppression. Three focused regressions cover the failures.

GPT-6 Astra re-reviewed and APPROVED exact code head `d4c74dda004aeb8cf79403dc02c39c444a631e51`, independently passing 46 focused application tests, 15 rollout tests and 4 separate rechecks. No actionable finding remains. [Exact-head CI](https://github.com/akhilvuputuri/chief-agent/actions/runs/36899722990) passed. This is code approval, not a claim of migration, activation or production acceptance.

An additional Tavily evidence finding was withdrawn after rechecking the exact commit through JobTools and normal execution journaling: the existing host adapter already supplies sourceUrl. The original repro bypassed that adapter. No provider change was required. The reviewer independently ran 43 focused tests and 15 rollout tests; live providers, paid evaluation and deployment were outside that review.

After incorporating current main, `npm run check` passed 596 application, 21 JavaScript and 30 offline Python tests; build and repository format check passed. After the three review regressions were added, the full check passed 599 application, 21 JavaScript and 30 offline Python tests; build/format and 15 rollout tests passed again. Those operator tests cover exact baseline/archive, preserved environment/data, active-work refusal, validated changes including refusal of implicit default-on activation, build/health failure and rollback. The source baseline's successful [release receipt](https://github.com/akhilvuputuri/chief-agent/actions/runs/36895492925) was observed, but no candidate release or capability activation is claimed.

### Release closure

Candidate [PR 148](https://github.com/akhilvuputuri/chief-agent/pull/148) remains disabled and unmerged. Code review and CI passed at the head above. A read-only operator preflight on 2 October SGT confirmed the pinned baseline, healthy startup, no active runtime/pending inputs, and no migration 023. Private aggregate preservation counters were checked locally and are not copied here. Reviewed migration installation, separate activation, exact release/health verification and owner Telegram acceptance remain pending.

## Follow-up and next iteration

Measure one week of explicitly requested real use: useful/all notifications, duplicates, owner-reported misses, incorrect claims, reported/estimated provider usage per useful finding, and recorded reasons for suppression. Generic semantic duplicate detection and provider indexing delay remain limitations. The migration/activation path is shared and tested, but cloud execution still needs an explicitly authorized operator capability.
