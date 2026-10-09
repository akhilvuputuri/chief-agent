# 74 — Recover a reasoning-only provider response and verify a real plan

Work date(s): 2026-10-09. Written/revised: 2026-10-09.
Status: in progress; host recovery fix, review/release and owner-authorized live planning acceptance pending.

## User-visible problem and preceding iteration

[Journal 72](72-coding-approval-brief.md) shipped concise complete planning reports but did not run a real provider acceptance trial. A fresh planning job then paused with `model_provider_failed`. The owner explicitly requested fixing and repeatedly testing through the real server until a concise complete brief and retained task understanding were verified. This authorizes planning trials and ordinary message delivery, not implementation approval or changes to live task/reminder records.

## Evidence

Measured 9 October on deployed v0.3.53 (`48840e99d55bf3432b3ead5716cae95eeb4bb200`), Python 0.1.6/harness v2, DeepSeek V4.1 Flash high and the shared two-hour/400-model/1000-tool allocation: one plan job completed 34 provider calls, then the 35th became uncertain after about 2.4 seconds. It retained one compaction and 68 tool calls, no saved plan, cleanup complete. Private saved notes retained the correct audit objective and relevant evidence but had not yet inspected the principal delivery module.

Sanitized logs and attempt-scoped rejection metadata identify `409/model_provider_failed`; no provider status or exact error subtype was retained. OpenRouter's read-only generation metadata reports HTTP/provider 200, `stop`, not cancelled, Relace, normalized completion tokens 323 and native reasoning tokens 323 (native completion 343). This supports a reasoning-only/empty-output hypothesis. The failed wire/error subtype is not available in the original journal, so metadata alone does not establish every detail of the discarded response.

## Diagnosis and implementation

A verified code defect loses a known recovery classification: the adapter marks a completed empty response transient, but the enhanced coding gateway only forwards transport/HTTP/provider failure categories, falling back to non-recoverable `model_provider_failed` for an empty answer. The fix adds the fixed `empty` subtype and maps it to existing `model_transient_failure`; Python 0.1.6 already supports one fresh generation after a recognized transient failure. Original uncertain call IDs remain non-replayable, consumed allocation remains consumed and no tool response from the failed generation is executed. Authentication, invalid requests, incomplete and malformed wire batches are not made transient. Fixed `empty`/`malformed` subtypes become available in private status metadata without raw provider text.

No worker-image, model/effort/price-filter/allocation/permission, database or Compose change. Regression fixtures cover completed reasoning-only SSE output, host classification/metadata, uncertain-key replay refusal, fresh IDs and malformed-response refusal. The existing Python recovery test proves a fresh generation rather than tool replay; The pre-review 998-test full suite/build/format passed. GPT-6 Astra requested changes on `cb887f0032be18ab1d7fcbddf39fc9eea87b1016`: invalid streamed content objects could be discarded and then classified as recoverable empty output. The parser now rejects invalid choice/delta/content/reasoning/tool-collection/role types before empty classification; regressions preserve nonretryable malformed admission. Updated-head full checks/review and live acceptance remain pending.

## Live acceptance design

Use the existing owner-scoped coding controller to queue new, labelled, plan-only jobs for the exact reported audit. The operator artifact reads the original objective/context on the host, validates the owner and source job, uses reviewed current settings and trusted base resolution, has stable request keys and cannot call models, provision, publish or approve directly. The running gateway and actual CodeBuild worker perform the normal dispatch/model/checkpoint/delivery path. Provider and publication credentials stay on the server; no fake Telegram user identity or secret export.

Verify the delivered brief against requested behavior, complete scope, regression checks and only necessary questions. Independently compare working notes/source reads with the actual repository: distinguish static reminder text from current pending-task delivery, preserve owner scoping and ordinary reminders, handle updated/completed/combined tasks and empty lists, and retain Singapore-time behavior. Historical examples remain fixtures, not current records. Check normal Main delivery/complete plan hash, unchanged plan-only mode, cleanup and no changed files/publication. Repeat independent planning attempts if output or task understanding fails acceptance; record failures as well as successes.

## Review, outcome and follow-up

Code review, exact release/current health and live trial results will be appended after measurement. No completed coding/review/PR workflow or universal provider reliability is implied by a successful planning trial. Unknown failure usage stays separate from completed-call cost. See [coding-agent lessons](coding-agent-lessons.md) and [research](73-coding-model-efficiency.md) for the distinction between a mechanism and a measured result.

## Deployed recovery and failed first live acceptance — 9 October 2026

GPT-6 Astra approved corrected exact `2f38fbfabdaf7be808b4796d12b1c5e7ccdd8be0` in [PR #197](https://github.com/akhilvuputuri/chief-agent/pull/197). Required PR/main checks passed 999 tests and container smoke. Exact `6d59c4d069ebfb46951c03fdf042324003c7ee7b` [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37878710996) succeeded at 2026-10-09T03:21:40Z; separate production reads confirmed v0.3.54, healthy gateway/Postgres and unchanged Python 0.1.6/models/effort/limits/pins.

The separately reviewed private operator artifact queued a new plan-only audit through the real controller. It reached 33 complete model calls then paused before a plan: a correct-shaped context summary exceeded the findings bound (6,511 versus 6,000 UTF-16 units). No provider rejection occurred. Cleanup completed and no files changed or PR was published. This is a failed end-to-end planning acceptance, not a passing trial. [Journal 75](75-coding-summary-repair.md) records the next correction and pending new-image trials.
