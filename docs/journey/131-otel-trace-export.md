# 131 — Can Chief's runs be viewed as standard traces without risking a turn?

Work date: 2026-10-29. Written: 2026-10-29.
Status: in review. Chief exports runs, model calls and tool calls as OTLP traces when an endpoint is set; production sets none. Not released.

## User-visible problem and preceding iteration

Issue #323 asks for one place to view, compare and alert on Chief's model calls, tool calls and costs. Chief already records them: `model.started`/`model.completed`/`model.failed` events with OpenRouter usage and latency, `runtime_calls` rows for tool calls, `provider_charges` for cost, and the sanitized operational log shipped to CloudWatch ([journal 118](118-telemetry-gaps.md) made its token and cache fields complete). What was missing is the structure: which model and tool calls belonged to which turn and which child agent, in a form a trace viewer can draw. Reading that today means joining `events`, `runtime_runs` and `runtime_calls` by hand.

The first phase of #323 builds the receiving side as a separate project, agentwatch (OTLP ingest, DuckDB storage, a trace list and span waterfall). This entry covers Chief's half: an exporter.

## Evidence

- Tested: `tests/otel.test.ts` drives real `Execution` objects on PGlite through a root run, a child agent, a completed and a failed model call and two tool calls, then compares the exported spans with the `events` rows. Input, output, cache-read and cache-write tokens and cost equal the recorded `usage`; the model span's duration equals the recorded `latencyMs`; the tree is root run → child run → model call, and root run → tool call; all spans share the root run's ID as trace ID.
- Tested: the exported bytes contain none of the planted private strings (tool arguments, a tool error message, a tool result, OpenRouter provider display text).
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

[src/otel.ts](../../src/otel.ts) holds the exporter and the span assembly; [src/execution.ts](../../src/execution.ts) calls `runStarted`, `runEvent`, `callStarted` and `callFinished`; [src/main.ts](../../src/main.ts) starts export when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set and flushes for at most 1 second at shutdown. `finishName` and `providerName` in `ops-log.ts` are now exported so spans use the same fixed names as the log. Design: [tracing](../tracing.md).

## Verification and outcome

Exporter tests pass locally. Remaining before release: independent review, the full `kite run check`, and CI on the PR head. After release nothing changes in production, because no endpoint is configured.

## Follow-up and next iteration

- Trace Jev decisions, embeddings, coding jobs (`coding_events`) and the learner.
- Record 👍/👎 reactions as trace scores (#323 phase 4); Telegram reactions are not received today (`allowed_updates` has only messages and callback queries).
- Memory lifecycle events for #323 phase 6 need write, retire and rollback events that `MemoryStore` does not emit yet.
- Decide where a collector runs for production data (a laptop pulling from the host, or a loopback-only service on the host); either needs owner approval.
