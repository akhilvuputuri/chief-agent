# 68 — Planning stopped after a valid model tool response

Work date: 8 October 2026. Status: reproduced, tested and independently reviewed. Final revision and release evidence are recorded on [PR #183](https://github.com/akhilvuputuri/chief-agent/pull/183).

## User-visible problem and preceding iteration

The first reported coding attempt announced planning, then paused with “stopped before verified completion.” Chief's status read could show the retained planning checkpoint but no cause. The [squad](61-coding-squad.md) and [automation](64-coding-automation.md) foundations had passed synthetic tests; they had not demonstrated successful live planning. This incident supplies the first specific continuation compatibility failure.

## Evidence

Measured through bounded, authorized production metadata on 8 October, for the reported attempt at approximately 10:32 SGT: the pinned repository checkout and initial checkpoint succeeded; one leader call using `deepseek/deepseek-v4.1-flash` completed; the attempt paused seconds later, with zero saved plan characters, zero changed files and completed cleanup. Production was `c1b72c7ce394d8cfb52870d5228568c195a3999d` (v0.3.45). No allocation/deadline exhaustion was recorded. No owner task was resumed or replayed during investigation.

The response's two tool calls contained `id`, `type`, `index` and `function`. The Python loop retains the complete calls, while Chief's strict continuation schema accepted only `id`, `type` and `function`. An anonymized indexed two-call regression reproduced HTTP 409 before the fix and HTTP 200 afterward. Request validation occurs before admitting a model call, consistent with the single completed call and no second model journal entry. This is a reproduced protocol mismatch, not evidence that the coding model or sandbox was unavailable.

## Diagnosis and alternatives

[OpenRouter's tool-calling contract](https://openrouter.ai/docs/guides/features/tool-calling) carries the assistant tool response into the next request with tool results. The recorded provider response included ordering metadata. Accepting the known optional integer field preserves tool arguments and reasoning, retains strict rejection of unrelated fields, and works with the deployed Python image. Removing metadata from stored responses or broadly allowing arbitrary fields would be a larger contract change.

A second observability gap hid the error: worker exceptions become a generic paused outcome, and the host returned a generic conflict without a persisted technical cause. The host now records fixed rejection categories, stage and HTTP status in suppressed coding events and sanitized operational logs. `coding_status(id)` exposes the latest category for the current attempt. Raw exception text, tool arguments, provider payloads and credentials are excluded.

## Implementation and verification

The HTTP model schema accepts optional nonnegative integer tool-call `index`; the shared TypeScript type declares it. Unknown metadata and malformed indices still fail before model allocation. The existing Python reasoning-continuation regression now also verifies exact preservation of tool calls with this field; no Python runtime/image update is required.

Synthetic tests cover indexed continuation, unchanged messages/arguments/reasoning and idempotent call accounting; strict invalid inputs; authenticated owner scope; attempt fencing; forged progress keys; and provider errors without secret text. Five focused host regressions passed initially. The full local check passed 817 application tests, 50 script tests, 42 Python evaluation tests and 32 Python runtime tests (941 total), plus TypeScript, Ruff and mypy. Separate build and formatting passed. Independent GPT-6 Astra review approved implementation head `c9e6f03e24016945eea2577f1b7bcfb98f870a58`, independently running all 49 host coding tests, all 32 Python runtime tests and two additional failure tests for context bounds, diagnostic storage failure, duplicate accounting and inactive attempts. No blocking findings; the journal table formatting nit was corrected. The final documentation revision, hosted checks, merge/deployed SHA, health and version/tag receipt are linked from [PR #183](https://github.com/akhilvuputuri/chief-agent/pull/183).

## Outcome and follow-up

Implementation does not automatically resume the reported paused job. After the fix is deployed, the owner can explicitly resume the same audit in Telegram; its saved checkpoint and scope remain retained. A successful synthetic continuation or startup health check does not prove a complete live plan/code/review cycle. [The benchmark pack](66-coding-benchmarks.md) remains the separate offline quality foundation.
