# OpenTelemetry trace export

Chief can send its runs, model calls and tool calls as OpenTelemetry traces over OTLP/HTTP, following the [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai). The intended receiver is [agentwatch](https://github.com/akhilvuputuri/agentwatch), a local trace viewer built for issue #323, but any OTLP/HTTP collector that accepts JSON works. Export is off unless an endpoint is configured. In production, `compose.yaml` points the gateway at the `agentwatch` service on the same host, with message content on; `CHIEF_TRACE_ENDPOINT` and `CHIEF_TRACE_CONTENT` in the host `.env` switch either off ([lightsail](lightsail.md#traces-agentwatch)).

Code: [src/otel.ts](../src/otel.ts), hooked from [src/execution.ts](../src/execution.ts) and [src/agent.ts](../src/agent.ts), and started in [src/main.ts](../src/main.ts). Tests: [tests/otel.test.ts](../tests/otel.test.ts) and [tests/turn-feedback.test.ts](../tests/turn-feedback.test.ts). History: [journal 131](journey/131-otel-trace-export.md) and [journal 133](journey/133-implicit-redirect-feedback.md).

## Turning it on

Set one of the standard variables:

- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`: the full traces URL, used as given.
- `OTEL_EXPORTER_OTLP_ENDPOINT`: a base URL; `/v1/traces` is appended.

Implicit feedback (below) is sent as OTLP logs to `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` if set, else the base URL plus `/v1/logs`, else a traces URL ending in `/v1/traces` with `/v1/logs` in its place. With none of those, feedback is not sent.

The URL must be `http` or `https` and carry no credentials. Anything else leaves export off and logs `trace.export_disabled` with `errorCode=OTEL_ENDPOINT_INVALID`; telemetry never stops the gateway. With a valid endpoint, the gateway logs `trace.export_enabled` once.

For local development with agentwatch:

```bash
uvx agentwatch serve
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

## Spans

Each `Execution` is one `invoke_agent` span. A run started without a parent is the trace root, and its run ID without dashes is the trace ID, so a trace can be found from `runtime_runs.id` and the reverse. A child run (an agent, research or job-alignment child) is a child span of its parent's run span and shares its trace.

| Span                                          | Kind     | Built from                                                                       | Attributes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | -------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke_agent chief` or `invoke_agent <type>` | internal | `Execution.start` to `runtime.stopped`                                           | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name` (`chief`, the `agent.child_started` type, or `research`), `gen_ai.conversation.id` (`thread.<Telegram thread ID>`, `thread.0` for the main chat; foreground turns only), `chief.run_id`, `chief.task_id`, `chief.stop_reason`; error status and `error.type=failed` when the run failed                                                                                                                                                                                                                                                                                       |
| `chat <model>`                                | client   | `model.started` and `model.completed` / `model.failed`, paired by `invocationId` | `gen_ai.operation.name=chat`, `gen_ai.provider.name=openrouter`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `gen_ai.usage.reasoning.output_tokens`, `gen_ai.response.finish_reasons`, `agentwatch.usage.cost_usd`, `error.type` (the diagnostics `failureCode`, else the provider error code or HTTP status as a string, else `_OTHER`; `context_limit` when the context did not fit), `chief.upstream_provider` (fixed slug), `chief.attempt`, `chief.effort`, `chief.invocation_id` |
| `execute_tool <operation>`                    | internal | `Execution.beginCall` to `endCall`                                               | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.type=function`, `chief.tool.write`, `chief.tool.state`, `error.type` (the tool's error code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

A turn that fails before `Execution.finish` (for example while loading context) still ends its run span with an error, from the turn's failure path in `agent.ts`.

A model span ends when `model.completed` or `model.failed` is recorded and starts `latencyMs` earlier, so its duration equals the journal's `latencyMs` exactly. Token counts and cost are copied from the OpenRouter `usage` object that `model.completed` records. The GenAI conventions define no cost attribute; `agentwatch.usage.cost_usd` is agentwatch's. Cache writes use `gen_ai.usage.cache_write.input_tokens`, the name after the conventions renamed `cache_creation` (semantic-conventions-genai changelog 440). Successful spans leave the status unset, as the conventions ask of instrumentation; failed ones set it to error.

Not traced yet: Jev decisions and other direct model calls (`effort.ts`, `tool-picker.ts`, `shadow.ts`), embeddings, coding jobs and the learner. Spans of runs that are still open when the process stops are lost; their children then show as orphans.

## Implicit feedback

The owner does not rate answers. When one is not what they wanted, their next message says so: "try again", "do something else", a correction, or the same request in other words. At the start of each foreground turn, Chief checks the owner's message against the exchange it follows and records a `user_redirected` evaluation on that earlier turn's root span, as a `gen_ai.evaluation.result` OTLP log record. agentwatch stores it as a boolean score on that trace.

- **Which turn.** The turn whose message the owner replied to in Telegram, else the last delivered exchange in the same thread (`conversationState` in [src/conversation-state.ts](../src/conversation-state.ts)). When the owner replies to an older message, the last exchange's turn loses its chance to be scored, so "first message only" holds.
- **Value.** `true` with `gen_ai.evaluation.score.label` set to `retry`, `correction` or `rephrase`, or `false` with no label. A turn the owner never answered gets no score, so the share of `true` is over answered turns only. A message with none of the owner's words (a forward, a photo without a caption) says nothing about the answer, so the turn before it gets no score; the forward's own turn becomes the one the next message is compared with.
- **Detection** ([src/turn-feedback.ts](../src/turn-feedback.ts)), in order, on the owner's own words (`ownerWords`, so attached quotes and forwards are ignored). There is no model call.
  - _Retry_: the message opens, after at most a short lead-in such as "hmm," or "no,", with a request for another attempt ("try again", "retry", "regenerate", "redo it", "start over", "try a different approach", "do something else"), or the whole message is a short form such as "again", "another one" or "something different, please", or a request of at most five words ending in "again" that is not a question ("add haircut again").
  - _Not a redirect_: a request for another attempt anywhere in the opening, together with a time or an extension ("try again tomorrow", "do it again next week", "redo it for Friday too"). It asks for a later or further attempt and rejects nothing, so it is neither a retry nor a correction, unless the rest of the message is a correction ("that's wrong, try again for Friday"). "Too" counts as an extension only at the end of the message, so "try again, that's too long" is a retry.
  - _Correction_: otherwise, the nightly learner's `isCorrection`, unchanged. A plain "no" after a reply that asked a question is an answer, not a correction; "redo" anywhere counts as one.
  - _Rephrase_: at least four content words in each message and at least 70% of their union shared with the previous request, unless exactly one word was swapped for another or only dates, days, times and numbers changed ("today" to "tomorrow"): those are new requests on the same subject. A reply to an older message is compared with the request only when it is the last exchange.
- **Limits.**
  - Only the first owner message after a turn counts, and only within 6 hours of the turn's end (the learner's follow-up window).
  - Only conversation turns this process exported can be scored. Background runs are not remembered. Finished turns are kept in memory, up to 200, and a restart forgets them.
  - A turn the owner interrupts with a new message is not scored, although an interruption is arguably the strongest redirect.

Its words never leave the process: only the fixed name, the boolean and a fixed label.

## Message content

Off by default. With `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` (the variable the OpenTelemetry GenAI instrumentations use) and export on, spans also carry what was said, in the conventions' message format (a role and typed parts: `text`, `tool_call`, `tool_call_response`, and `image` as a placeholder):

| Span                                 | Attributes                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke_agent chief` (a turn's root) | `gen_ai.input.messages`: the owner's message as given to the turn (including attached context); `gen_ai.output.messages`: the run's last model output                                                   |
| `chat <model>`                       | `gen_ai.input.messages`: the messages sent (system prompt, history, tool results); `gen_ai.output.messages`: the reply, with any tool calls; `chief.content.truncated` when older messages were dropped |
| `execute_tool <operation>`           | `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` as JSON text                                                                                                                                    |

Code: [src/otel-content.ts](../src/otel-content.ts). Every text is scrubbed before it is cut (each string first bounded to 36,000 characters, so scrubbing costs at most a few milliseconds whatever a tool returns): the event journal's credential patterns (`scrubTrace`) plus Google, AWS and Slack token shapes, and any value under a credential-named key (`password`, `token`, `access_token`, `cookie`, `authorization` and similar) at any depth, including inside tool results and arguments that are JSON text. Inline `data:` URLs and unbroken runs of 2,000 or more base64 characters (which also catches long hex strings and very long words) are replaced by placeholders, and image parts are never sent. Each text part, argument or result is capped at 32,000 characters, and each message list at 128,000, keeping the newest messages; a single message larger than that has its parts cut to fit. The gateway logs `contentCaptured` in `trace.export_enabled`.

Scrubbing is best effort. Once content is on, the owner's own data is exported as the tools return it: email and calendar contents, including one-time codes or reset links in an email, and the full tool result rather than the shortened observation the model saw. The root span's output is the run's last successful model output, usually its `finish_turn` call; if the final model call fails, it is an earlier output. Tool arguments are the object the model sent.

Content makes spans large, so the exporter batches by size as well as count (about 4 MB of escaped UTF-8 a request) and bounds its queue at 32 MB as well as 4,096 spans; beyond either, spans are dropped and counted in `trace.export_dropped`. Content waiting for its span to end (a long run's input, a tool call in flight) is held up to 32 MB in total, oldest dropped first, so a run that never ends cannot keep it. Serializing a model call's messages happens on the turn's stack when content is on, about a millisecond for a long context.

Where the content goes is the endpoint's business: in production it is the agentwatch service next to the gateway, which keeps traces for 90 days ([journal 134](journey/134-agentwatch-on-the-host.md)).

## What leaves the process

Spans carry the same kind of values as the [operational log](operational-logs.md): IDs, model names that pass the model-name shape, fixed provider slugs (`providerName` in `ops-log.ts`), token counts, cost, durations, fixed finish reasons, host-defined tool names (`logOperation`, so a model-invented tool name becomes `unknown`), stop reasons and error codes that pass the code shape. Feedback evaluations carry only a fixed name, a boolean and a fixed label. Unless message content is switched on (above), never prompts, replies, tool arguments or results, error messages or OpenRouter's provider display text. The integration test checks the exported bytes for planted private strings.

## Failure behaviour

Hooks only record state in memory and enqueue finished spans; they never await the network, and each exported hook catches its own errors. A full batch is sent on the next event-loop turn, so encoding never runs on a turn's call stack. The exporter sends batches of up to 256 spans every 2 seconds with a 3-second timeout. If the collector is down or answers with an error, the batch is dropped, not retried. The queue holds at most 4,096 spans; beyond that, new spans are dropped. Evaluations wait in their own queue of at most 256 (overflow is counted with dropped spans) and are sent after the queued spans, so their trace has usually arrived first; when a span batch fails, the queued evaluations are dropped with it. Drops are reported in `trace.export_dropped` at most once a minute, and once more at shutdown for any not yet reported. Open-span bookkeeping is capped at 2,000 entries per kind, oldest evicted first. At shutdown, the gateway spends at most 300 ms sending what is queued, after its handlers have stopped, so the stop still fits the container's 10-second grace period.
