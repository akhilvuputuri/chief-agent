# 131 — Can Chief's runs be viewed as standard traces without risking a turn?

Work date: 2026-10-29 (Singapore; 28 October UTC). Written: 2026-10-29.
Status: released in `7ba6831`. Chief exports runs, model calls and tool calls as OTLP traces when an endpoint is set; production sets none, so export is off there.

## User-visible problem and preceding iteration

Issue #323 asks for one place to view, compare and alert on Chief's model calls, tool calls and costs. Chief already records them: `model.started`/`model.completed`/`model.failed` events with OpenRouter usage and latency, `runtime_calls` rows for tool calls, `provider_charges` for cost, and the sanitized operational log shipped to CloudWatch ([journal 118](118-telemetry-gaps.md) made its token and cache fields complete). What was missing is the structure: which model and tool calls belonged to which turn and which child agent, in a form a trace viewer can draw. Reading that today means joining `events`, `runtime_runs` and `runtime_calls` by hand.

The first phase of #323 builds the receiving side as a separate project, agentwatch (OTLP ingest, DuckDB storage, a trace list and span waterfall). This entry covers Chief's half: an exporter.

## Evidence

- Tested: `tests/otel.test.ts` drives real `Execution` objects on PGlite through a root run, a child agent, a completed and a failed model call and two tool calls, then compares the exported spans with the `events` rows. Input, output, cache-read and cache-write tokens and cost equal the recorded `usage`; the model span's duration equals the recorded `latencyMs`; the tree is root run → child run → model call, and root run → tool call; all spans share the root run's ID as trace ID.
- Tested: the exported bytes contain none of the planted private strings (tool arguments, a tool error message, a tool result, OpenRouter provider display text).
- Tested: nested children (root → research → researcher) share one trace with correct parents; a failed turn's run span is closed with an error.
- Tested: with the collector throwing, the exporter drops the batch, does not throw, and logs one `trace.export_dropped`; with a collector that never answers, shutdown returns after its deadline.
- Measured on a laptop, synthetic: the same flow with real `fetch` against a running agentwatch (`f528234`) produced one complete trace with 5 spans, 2 model calls, 1 tool call, 40,001 input tokens, 36,000 cached and $0.10, matching the inputs, and drew the expected tree in its UI.
- Not measured: anything on production traffic. Export stays off there until a collector exists on or next to the host, which is a separate decision.

## Diagnosis and alternatives

- **Hook point.** `Execution` already sees every run start and stop (with its parent), every traced event and every tool call, so the exporter hooks there instead of in `db.event` or the log projection. That gives the parent link directly from `Execution.parent` rather than reconstructing it from `agent.child_started` payloads.
- **Hand-written OTLP/JSON instead of the OpenTelemetry SDK.** Chief's records are paired events (started/completed) rather than live spans, and the SDK would add several dependencies for a few hundred lines of behaviour. OTLP/JSON is a small, stable encoding; agentwatch's ingest tests decode it identically to protobuf. Switching to the SDK later would not change the spans.
- **Drop rather than retry.** A collector that is down for a long time should cost nothing but a log line. Retrying would hold memory for spans nobody may read.
- **Trace ID = root run ID.** Lets a trace in the viewer be found in Postgres and the reverse, without a mapping table.
- **Provider.** `gen_ai.provider.name` is `openrouter` (the API Chief calls); the upstream provider goes into `chief.upstream_provider` as the operational log's fixed slug, so provider display text never leaves the process.

## Implementation and review

[src/otel.ts](../../src/otel.ts) holds the exporter and the span assembly; [src/execution.ts](../../src/execution.ts) calls `runStarted`, `runEvent`, `callStarted` and `callFinished`; [src/main.ts](../../src/main.ts) starts export when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set and flushes for at most 300 ms at shutdown. `finishName` and `providerName` in `ops-log.ts` are now exported so spans use the same fixed names as the log. Design: [tracing](../tracing.md).

Independent review (Opus 5.5) of `6fa316d` approved, with findings fixed in the next commit:

- Provider HTTP failures exported `error.type=_OTHER`, because `errorCode` is a number and `httpStatus` was ignored. Now the code or status is used as a string (tested with HTTP 429).
- A turn that failed before `Execution.finish` (the catch in `Assistant.turn`) never ended its run span, leaving its model and tool spans as orphans. That path now ends it with an error.
- Only `runEvent` caught its own errors; all exported hooks do now.
- With export on, the 1-second shutdown flush could push a stop past Docker's 10-second grace; it is 300 ms.
- Smaller items: status left unset on success; a full batch is flushed on the next event-loop turn instead of on the caller's stack; pending drop counts are reported at shutdown; a malformed endpoint now disables export with a warning instead of stopping the gateway; the no-endpoint test now asserts that nothing is sent; nested children and the research label are tested.

## Verification and outcome

`tests/otel.test.ts` passes 7/7. The full local `kite run check` on `909a400` passed 1,349 of 1,351 tests; the failure was the corrupt-gzip test, which needs Node 22.23.4 ([journal 126](126-fetch-hygiene-and-node.md)) while the laptop had 22.15. Hosted CI, on Node 22.23.4, passed every job on `909a400`.

### Release closure — 2026-10-28

[PR 347](https://github.com/akhilvuputuri/chief-agent/pull/347) merged at the reviewed head `909a400` as `7ba68314ddd4617f305c6d8471fac0a2a1c6ade2`. The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/40745519047) deployed that commit at 18:35 UTC and reported `{"deployed": "7ba6831…", "healthy": true}`. No endpoint is configured in production, so no spans leave the host; that the export works is shown only by the tests and the synthetic run above.

## Follow-up and next iteration

- Trace Jev decisions, embeddings, coding jobs (`coding_events`) and the learner.
- Record 👍/👎 reactions as trace scores (#323 phase 4); Telegram reactions are not received today (`allowed_updates` has only messages and callback queries).
- Memory lifecycle events for #323 phase 6 need write, retire and rollback events that `MemoryStore` does not emit yet.
- Decide where a collector runs for production data (a laptop pulling from the host, or a loopback-only service on the host); either needs owner approval.
