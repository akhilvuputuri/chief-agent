# OpenTelemetry trace export

Chief can send its runs, model calls and tool calls as OpenTelemetry traces over OTLP/HTTP, following the [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai). The intended receiver is [agentwatch](https://github.com/akhilvuputuri/agentwatch), a local trace viewer built for issue #323, but any OTLP/HTTP collector that accepts JSON works. Export is off unless an endpoint is configured, and production does not set one.

Code: [src/otel.ts](../src/otel.ts), hooked from [src/execution.ts](../src/execution.ts) and started in [src/main.ts](../src/main.ts). Tests: [tests/otel.test.ts](../tests/otel.test.ts). History: [journal 131](journey/131-otel-trace-export.md).

## Turning it on

Set one of the standard variables:

- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`: the full traces URL, used as given.
- `OTEL_EXPORTER_OTLP_ENDPOINT`: a base URL; `/v1/traces` is appended.

The URL must be `http` or `https` and carry no credentials; anything else stops the gateway at startup with `OTEL_ENDPOINT_INVALID`. With an endpoint set, the gateway logs `trace.export_enabled` once.

For local development with agentwatch:

```bash
uvx agentwatch serve
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

## Spans

Each `Execution` is one `invoke_agent` span. A run started without a parent is the trace root, and its run ID without dashes is the trace ID, so a trace can be found from `runtime_runs.id` and the reverse. A child run (an agent, research or job-alignment child) is a child span of its parent's run span and shares its trace.

| Span                                          | Kind     | Built from                                                                       | Attributes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | -------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke_agent chief` or `invoke_agent <type>` | internal | `Execution.start` to `runtime.stopped`                                           | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name` (`chief`, the `agent.child_started` type, or `research`), `chief.run_id`, `chief.task_id`, `chief.stop_reason`; error status and `error.type=failed` when the run failed                                                                                                                                                                                                                                                                               |
| `chat <model>`                                | client   | `model.started` and `model.completed` / `model.failed`, paired by `invocationId` | `gen_ai.operation.name=chat`, `gen_ai.provider.name=openrouter`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `gen_ai.usage.reasoning.output_tokens`, `gen_ai.response.finish_reasons`, `agentwatch.usage.cost_usd`, `error.type` (the diagnostics failure code), `chief.upstream_provider` (fixed slug), `chief.attempt`, `chief.effort`, `chief.invocation_id` |
| `execute_tool <operation>`                    | internal | `Execution.beginCall` to `endCall`                                               | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.type=function`, `chief.tool.write`, `chief.tool.state`, `error.type` (the tool's error code)                                                                                                                                                                                                                                                                                                                                              |

A model span ends when `model.completed` or `model.failed` is recorded and starts `latencyMs` earlier, so its duration equals the journal's `latencyMs` exactly. Token counts and cost are copied from the OpenRouter `usage` object that `model.completed` records. The GenAI conventions define no cost attribute; `agentwatch.usage.cost_usd` is agentwatch's.

Not traced yet: Jev decisions and other direct model calls (`effort.ts`, `tool-picker.ts`, `shadow.ts`), embeddings, coding jobs and the learner. Spans of runs that are still open when the process stops are lost; their children then show as orphans.

## What leaves the process

Spans carry the same kind of values as the [operational log](operational-logs.md): IDs, model names that pass the model-name shape, fixed provider slugs (`providerName` in `ops-log.ts`), token counts, cost, durations, fixed finish reasons, host-defined tool names (`logOperation`, so a model-invented tool name becomes `unknown`), stop reasons and error codes that pass the code shape. Never prompts, replies, tool arguments or results, error messages or OpenRouter's provider display text. The integration test checks the exported bytes for planted private strings.

## Failure behaviour

Hooks only record state in memory and enqueue finished spans; they never await the network, and every hook catches its own errors. The exporter sends batches of up to 256 spans every 2 seconds with a 3-second timeout. If the collector is down or answers with an error, the batch is dropped, not retried. The queue holds at most 4,096 spans; beyond that, new spans are dropped. Drops are reported in `trace.export_dropped` at most once a minute. Open-span bookkeeping is capped at 2,000 entries per kind, oldest evicted first. At shutdown, the gateway spends at most 1 second sending what is queued, after its handlers have stopped.
