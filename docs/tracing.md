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
  - _Pushback_ (only when the rules above find nothing): Jev's answer to a second question asked with the message's first effort decision ([reasoning effort](reasoning-effort.md#redirect-question)), whether the message pushes back on the last reply: a doubt ("but it's cloudy?"), asking why something stopped, restating an ignored constraint. It counts when Jev's probability is at least `redirect.apply` in `config/reasoning-effort.json` (0.5), and only when the exchange scored is the one Jev was shown: Jev sees the last turns of the owner's whole history, so its answer is used only if the last turn it saw is this thread's latest exchange (same request and same reply, so not a reminder or job result delivered since) and the owner is not replying to an older message. Jev sees only the first 300 characters of the reply, so pushback about later parts of a long reply can be missed. The probability itself is recorded on the same span as a numeric `jev_redirect_probability` evaluation, so the threshold can be tuned against real messages. Because Jev answers with the effort decision, the score is sent after that decision returns (it times out after 1.5 seconds), so a second message sent before then can be the one that scores the turn.
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

## Judging traces

agentwatch can ask a model about each new conversation turn and store its answer as a score ([agentwatch's design notes](https://github.com/akhilvuputuri/agentwatch/blob/main/docs/design.md#llm-judges)). On the host, the `agentwatch` service gets `OPENROUTER_API_KEY` from the host `.env` (the gateway's own key; agentwatch reads it only when a switched-on judge calls a model) and asks OpenRouter to report each call's cost.

The owner approved one judge on 30 October:

- **What it judges:** conversation turns only (`sessions_only`): a turn's root carries the owner's message and the final model output; background jobs have no question and are skipped. Every new turn is sampled, from when the judge is switched on; history is not judged.
- **Model:** `openai/gpt-6.1-sol`, a different family from Chief's main model, so it is not grading its own answers.
- **Question:** did the reply do what the owner asked, correctly and completely, given what the tools returned; a `true`/`false` score named `answer_ok`, with a one-sentence explanation.
- **Limit:** 20 model calls in any 24 hours, failures included; beyond that, turns are recorded `OVER_LIMIT` and never judged later.

Create, change or switch it off through agentwatch's Judges page or API, over the SSH tunnel ([lightsail](lightsail.md#traces-agentwatch)). **The key.** agentwatch's API has no login, so whoever can reach it (the SSH tunnel, a shell on the host, another container on the Compose network) could otherwise point a judge at their own server and receive the key, or raise its spending. On the host, agentwatch therefore starts with a judge policy it cannot be talked out of: judges may call only `https://openrouter.ai/api/v1`, use only `OPENROUTER_API_KEY`, and have at most 50 calls a day. Those who can reach agentwatch can already read the host's `.env`, so this is a new route for the key rather than new readers; a separate OpenRouter key with its own credit limit would cap spend and could be revoked alone.

A judge's verdicts are evidence to read beside `user_redirected`, not ground truth: trace content is untrusted, and whether this judge agrees with the owner has not been measured.

## Backfilling history

Live export to the host's agentwatch started on 29 October 2026 at 15:00:16 UTC (the gateway's `trace.export_enabled` line), and no run started between then and the first live trace. Runs from before then (Chief's Postgres keeps them from 6 September 2026) can be rebuilt into agentwatch from the database, in the same shape as live traces. Code: [scripts/trace-backfill.sql](../scripts/trace-backfill.sql) reads the rows, [src/trace-backfill.ts](../src/trace-backfill.ts) turns them into spans and evaluations and posts them. Tests: [tests/trace-backfill.test.ts](../tests/trace-backfill.test.ts), which drives a real `Execution` on PGlite with live export on, runs the query over the same database and checks that the rebuilt spans have the live spans' names, kinds, status, tree, trace IDs and attributes.

**What is rebuilt.** The span builders are the live exporter's own (`runSpan`, `modelSpan`, `toolSpan` in `otel.ts`), so names, attributes and error rules are the same.

- One `invoke_agent` span per run started in the window, from `started_at` to its `runtime.stopped` event (else its `turn.failed` event, else `updated_at`), with the stop reason from that event (else `runtime_runs.stop_reason`). Children join their parent's trace through every ancestor in the window; a child whose parent started before the window becomes its own root. A root run that consumed an owner input gets `gen_ai.conversation.id=thread.<threadId or 0>`.
- One `chat <model>` span per `model.completed` or `model.failed` event, ending when the event was recorded and starting `latencyMs` earlier, with the attempt from its `model.started` event.
- One `execute_tool` span per finished `runtime_calls` row, from `started_at` to `finished_at`, with the call's current state (a later reconciliation, such as `uncertain` to `failed`, shows). Calls that never finished are skipped, as live export skips them.
- `user_redirected` evaluations, as live scores them where the record allows: a root turn is scored only if it has a saved conversation context with no pending message (as live's `lastExchangeHere`), against its last user message (1,500 characters) and last delivered reply (2,000), by the next root turn's first input in the same thread if it arrived within 6 hours after this turn stopped. A message with none of the owner's words gives no score. Unlike live, a turn whose context still had a pending message gets no score (live would compare the next message with the thread's latest delivered exchange instead), a reply to an older message is not followed, and a forward or uncaptioned photo gives no score instead of leaving the turn for the next message; the window is measured to the next input's arrival.

**What is not.** Model spans carry no messages even with `--content`: Chief does not record each call's input and output. A root's output is its last delivered reply (an assistant message without tool calls), not the run's last model output as live. Runs recorded before `model.started` carried `attempt`, or `model.completed` carried `effort`, have no `chief.attempt` or `chief.effort`. Spans carry no `service.version`, since the release that ran them is not recorded per run. JSON keys in tool payloads come back in Postgres's `jsonb` order.

**Content** only with `--content`: the root's input (the owner's input messages, joined; live records the turn's message as given) and output, tool arguments and results, through the same scrubbing and caps as live ([Message content](#message-content)). The query selects tool payloads whole, so credential-named keys are scrubbed before anything is cut; a payload over 1 MB is replaced by a placeholder rather than cut into text that could no longer be scrubbed by key. The CLI refuses to follow a redirect, so content cannot be sent on from the local port.

**Procedure.** Run by the operator; the query is read-only and the CLI posts only to `localhost` or `127.0.0.1`.

1. Read the rows through the weekly review's read-only path, with the window at the top of the SQL. Use the live-export start as `until`, so runs already exported live (with random span IDs) are not sent again as duplicates:

   ```bash
   umask 077
   { printf '%s\n' "\\set since '2026-09-06T00:00:00Z'" "\\set until '2026-10-29T15:00:16Z'"; cat scripts/trace-backfill.sql; } \
     | ~/Dev/hermes-companion-ops/weekly-review/q.sh > ~/backfill-rows.jsonl
   chmod 600 ~/backfill-rows.jsonl
   ```

   The file holds the owner's messages, replies and tool payloads: keep it in a private scratch location. psql's header line (`j`) is skipped; any other non-JSON line (a psql error) stops the CLI.

2. Check the counts without sending anything; a dry run prints only counts (runs, spans, model calls, tool calls, unfinished calls, evaluations true and false, requests and bytes), never content:

   ```bash
   npx tsx src/trace-backfill.ts ~/backfill-rows.jsonl --dry-run --content --until 2026-10-29T15:00:16Z
   ```

3. Open the tunnel to the host's agentwatch in another terminal, and post:

   ```bash
   ssh -F ../hermes-companion-ops/ssh_config -N -L 14318:127.0.0.1:4318 chief-lightsail
   npx tsx src/trace-backfill.ts ~/backfill-rows.jsonl --endpoint http://localhost:14318 --content --until 2026-10-29T15:00:16Z
   ```

   Spans go to `/v1/traces` in requests of at most 256 spans and about 4 MB (the exporter's size estimate), then evaluations to `/v1/logs`. The first failed request stops the run with its HTTP status; rerunning is safe.

4. Delete the rows file: `rm ~/backfill-rows.jsonl`.

`--since` and `--until` on the CLI drop rows whose run started outside that range, a guard in case the query's window was set wrongly; the query's `until` is the cutoff that matters. Any endpoint that is not `http(s)://localhost` or `http(s)://127.0.0.1` (any port, no credentials) is refused.

**Idempotence.** IDs are derived from Chief's own: the trace ID is the root run's ID without dashes (as live), a run's span ID the first 16 hex characters of `sha256("run:" + run ID)`, a model call's of `sha256("model:" + invocationId)`, a tool call's of `sha256("call:" + runtime_calls.id)`. Each evaluation's time is the next input's arrival. agentwatch upserts spans on trace and span ID, and a score's ID is a hash of its trace, span, name, time, value and label, so posting the same rows again replaces what was there instead of adding copies. (A score whose value changed between runs, because `redirectOf` changed, is added beside the old one.) Live spans have random span IDs, which is why the window must end where live export began.

**Retention.** agentwatch ages traces from when they last arrived (`received_ns`), not from when they ran, so backfilled traces are kept for 90 days from the backfill, not from the original runs.

## What leaves the process

Spans carry the same kind of values as the [operational log](operational-logs.md): IDs, model names that pass the model-name shape, fixed provider slugs (`providerName` in `ops-log.ts`), token counts, cost, durations, fixed finish reasons, host-defined tool names (`logOperation`, so a model-invented tool name becomes `unknown`), stop reasons and error codes that pass the code shape. Feedback evaluations carry only a fixed name, a boolean and a fixed label. Unless message content is switched on (above), never prompts, replies, tool arguments or results, error messages or OpenRouter's provider display text. The integration test checks the exported bytes for planted private strings.

## Failure behaviour

Hooks only record state in memory and enqueue finished spans; they never await the network, and each exported hook catches its own errors. A full batch is sent on the next event-loop turn, so encoding never runs on a turn's call stack. The exporter sends batches of up to 256 spans every 2 seconds with a 3-second timeout. If the collector is down or answers with an error, the batch is dropped, not retried. The queue holds at most 4,096 spans; beyond that, new spans are dropped. Evaluations wait in their own queue of at most 256 (overflow is counted with dropped spans) and are sent after the queued spans, so their trace has usually arrived first; when a span batch fails, the queued evaluations are dropped with it. Drops are reported in `trace.export_dropped` at most once a minute, and once more at shutdown for any not yet reported. Open-span bookkeeping is capped at 2,000 entries per kind, oldest evicted first. At shutdown, the gateway spends at most 300 ms sending what is queued, after its handlers have stopped, so the stop still fits the container's 10-second grace period.
