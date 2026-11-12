# 190 — Pi speaks Anthropic's protocol to the host

Work date(s): 2026-11-13. Written/revised: 2026-11-13.
Status: implemented and tested offline on branch `coding-revamp/b-native-protocol` from `2910171b`; review, merge and release are pending. No paid model call was made.

## User-visible problem and preceding iteration

The first full Pi coding job (`9600af57`, [journal 179](179-first-full-coding-job-review.md) on its branch) took 10 machine-hours and $104. One cause the review named: the worker reached Claude through an OpenAI-shaped proxy that we added in October, when coding models went through OpenRouter. Pi registered the host as an `openai-completions` provider; the host converted each request to an Anthropic Messages request (`src/anthropic.ts`) and converted the answer back. The conversion kept text and tool calls but not the assistant's thinking blocks, so every request the model saw had an edited history, and Pi could not place its own cache breakpoints. The proxy's schema also carried caps of ours: 20 tool calls per assistant message, 12 tools, 2,048 messages and a 4 MB request.

Since 11 November the coder, reviewer and planner are Claude models called directly at Anthropic ([journal 161](161-enabling-direct-anthropic.md)). The OpenAI hop no longer had a reason.

## Evidence

- **Read in source (pi-ai 1.1.0):** Pi's Anthropic client posts to `{baseUrl}/v1/messages?beta=true` with the SDK's `x-api-key`, `anthropic-version: 2023-06-01` and an `anthropic-beta` list; for Opus 5.5 and Sonnet 5.5 it sends adaptive thinking with `drop_block`, a hard-coded top-level `output_config.effort: "high"` and an effort-only system message after each assistant turn carrying the session's effort (`dist/api/anthropic-messages.js`, `buildParams` and `insertThinkingLevelMessages`). It stores each turn's thinking (with signature), text and tool calls and rebuilds the same blocks on the next request (`convertMessages`). Both model ids are in its bundled catalogue (`providers/data/anthropic.json`), so no model definition of ours is needed.
- **Read in source:** the old route's Pi-only machinery (`coding_runtime_pi/src/terminal-http-recovery.ts`, `patient-fetch.ts`, the 409 receipt in `src/coding/api.ts`, `retryOf` and stored-response replay in `controller.generate`) existed because the host answered only after the whole generation.
- **Tested (synthetic):** with a loopback fake of the Messages API, Pi's stock client resends every earlier response's content blocks, including an empty-text thinking block with its signature, so that `JSON.stringify` of the replayed `content` equals the response's content exactly. Measured directly against the fake (`coding_runtime_pi/tests/native-protocol.test.ts`, 1 and 32 investigation turns) and through the real host route and `AnthropicMessagesGateway` (`tests/coding-pi-messages.test.ts`, last test).
- **Tested (synthetic):** the host forwards the worker's request unchanged apart from `max_tokens` (capped at the role's allowance) and the top-level `output_config` (set to the job's effort), and relays Anthropic's stream to the worker byte for byte (`response.body === messagesStream(turn)`).
- **Not measured:** a real Anthropic call through the new route, cache hit rates, or a full job's cost and time. These need a release and a job.

## Diagnosis and alternatives

The cause was our protocol choice, not Pi: Pi already speaks Anthropic's protocol for Claude. The fix is to stop converting.

- **Streaming relay (chosen) or buffered reply.** The host now relays Anthropic's stream as it arrives and keeps its own copy (a `tee`) to record the call. Buffering would keep the reasons the patient fetch, the 300-second header workaround and the 409 receipt protocol existed; relaying removes them.
- **Fallback (none, chosen).** A failed direct call used to fall back to OpenRouter. Thinking blocks are bound to the account that made them, so blocks would be dropped crossing to OpenRouter's account and back, and OpenRouter's prices differ (whether OpenRouter's Anthropic-compatible endpoint would round-trip these blocks was not checked). Instead Anthropic's error reply reaches Pi with its status, `retry-after` and `x-should-retry`, and Pi's stock retry (re-enabled; it had been switched off with `maxRetries: 0`) decides. Each retry is a new recorded call.
- **Per-call timers (removed).** The host's total, first-output and idle timers for Pi calls are gone (the legacy workers keep theirs). A silent upstream stream is now bounded by the Anthropic SDK's defaults on the host's call and by the job's attempt deadline. A call also stops on cancellation and when the worker's connection closes.
- **Effort.** Pi's per-turn effort markers are part of the history Pi records, so the host does not rewrite them. The worker sets Pi's thinking level from the job's effort; the host sets the top-level `output_config.effort` (Pi's hard-coded `high`) to the job's effort and refuses a request whose markers name another level.
- **Old sessions.** Sessions written under the old protocol are not migrated. Pi treats their assistant turns as another model's (different `api`) and replays them as text and tool calls; they held no thinking. No job was open.

## Implementation and review

Worker (`coding_runtime_pi`):

- `src/model.ts`: `anthropicModel` replaces `compatibleModel`. It registers Pi's catalogue entry for the native model id under provider `runtime` with `api: "anthropic-messages"`, pointed at the host, and passes the attempt capability as Pi's API key. Only the window and output limit can be overridden. Admission before each call is unchanged. A purpose header (`x-runtime-purpose: agent|compaction`) names compaction calls for the host's record.
- `src/types.ts`, `src/index.ts`, `src/cli.ts`: the new `ModelConfig`; the standalone CLI defaults to `claude-opus-5-5` with Pi's stock Anthropic endpoint.
- Deleted: `src/terminal-http-recovery.ts`, `src/patient-fetch.ts`, the `undici` dependency, the request byte envelope (`maxRequestBytes`, `didRejectContextLocally`, `requestByteLimit` in `runtime.ts` and `context-maintenance.ts`), and the `retry: { enabled: false, provider: { maxRetries: 0 } }` override in `runtime.ts`.

Host:

- `src/coding/pi-messages.ts` (new; replaces `src/coding/pi-proxy.ts`): the request checks (`messagesRequest`), Anthropic-shaped refusals, relayed errors and `assembleStream`, which reads the host's copy with the SDK's own accumulator (`BetaMessageStream`).
- `src/coding/controller.ts`: `piMessages` claims the model slot, records the request body as the call's input, sends it, relays the stream, and `recordPiStream` stores the assembled Anthropic message as the result (readable and sealed copies), writes `model_usage` in the existing shape (now also for billed incomplete calls) and records `worker_request_rejected` with the existing codes (`model_rate_limited` and `model_transient_failure` with `providerStatus`, so automatic retry works as before; `model_cancelled`, `model_timeout` with `timeoutKind: total`, `model_disconnected`). `hasPiReviewerProof` reads the `report` `tool_use` block. Pi jobs and coding model choices are refused unless every role's model has a direct Anthropic route. The assignment carries `nativeModels`; the context-window snapshot is gone (Pi's catalogue has the windows). `generate` now serves the legacy workers only.
- `src/coding/api.ts`: routes `POST /coding/worker/:id/pi/{coder,reviewer}/v1/messages` with a 32 MiB body limit (Anthropic's own request limit); the capability comes from `x-api-key`. The chat-completions routes and the receipt protocol are deleted.
- `src/anthropic.ts`: `AnthropicMessagesGateway` (the SDK with the host's key, `maxRetries: 0` so Pi owns retries, and the worker's `anthropic-version` forwarded) and `anthropicUsage`, shared with `AnthropicDirect`. `src/model-router.ts`: `anthropicRoute`. `src/main.ts` wires them.
- `src/coding/rejection-reason.ts`: reasons for the new refusals; the recovery reasons are removed.

Tests: the runtime fakes now speak Anthropic SSE (`coding_runtime_pi/tests/anthropic-sse.ts`). New: `tests/coding-pi-messages.test.ts` (relay, refusals, relayed 429, cancellation, deadline, worker disconnect, direct-route validation, the end-to-end replay test). Workflow tests whose subject is not the protocol keep their scripted replies through a flat view of the request in `tests/helpers/coding-fixture.ts`. Deleted with the behaviour they covered: terminal recovery, patient fetch, the byte envelope, the context-window snapshot and the OpenAI facade tests.

## Verification and outcome

Run on 13 November 2026 in the worktree (results in the builder's report): `kite run check` and `kite run format:check`. The runtime package suite passed 68 of 68 on its second run; on the first, the timing-based test "planning reserves time for reporting and saves the completed investigation before handoff" (a 7.6-second wait under a 10-second limit) failed once under parallel load and passed alone and on the rerun; it involves no model error or retry.

Not verified: a live call, the real stream's ping and error events through the relay, and Pi's stock retry against real 429 or 529 replies.

## Deployment status

Not released. The worker image must be rebuilt and pinned with this runtime, and the gateway released with the host change, together: an old worker calls routes that no longer exist and a new worker needs the new routes.

## Follow-up and next iteration

- The profile script (`scripts/coding-job-profile.sql` on `origin/coding-job-profile`) reads `result->'message'->'tool_calls'`; it needs `result->'content'` with `tool_use` blocks. The orchestrator will update it.
- The manual acceptance kits (`scripts/pi-acceptance/`, `scripts/fixtures/pi-report-proxy.mjs`) still describe the OpenRouter route and the terminal-recovery probe; they need porting or retiring.

> **Update, 13 November 2026:** retired. The runner, broker, provider helper and report proxy and their tests are deleted; the workload manifest, oracle template, `prepare-oracle.mjs`, `metrics.mjs` (its test passes) and recorded results are kept unchanged ([verification contract](../pi-runtime-verification.md)).

- Measure on the first job: cache reads per call, cost per role and whether `thinking_dropped` stays at zero.

## Update, 13 November 2026: after rebasing onto main

Rebased onto main with builder C's piece ([journal 182](182-pi-tools-and-prompt-as-shipped.md)); there were no conflicts.

- **Retry, tested.** The question was whether `runtime.ts`, which ends the agent loop on an error turn, stops Pi's stock retry. Measured with a throwaway probe against a fake Messages API: a 429 with `retry-after: 1` on the second request was resent and the plan finished (`waiting_approval`, three requests); a 529 on every later request was resent three times (Pi's default) and then paused the task after about 14 seconds. Ending the loop run does not pre-empt the retry, because Pi's session retries after the agent run ends, so no code change was needed beyond correcting the comment there. A permanent test now runs a real Pi session through the host route with a 429 then success: the retry carries the same messages, the session continues, and the calls are recorded `complete`, `uncertain`, `complete` with one `model_rate_limited` (429) rejection.
- **Images.** `images: { blockImages: true }` (in `runtime.ts`) and `autoResizeImages: false` (in `tools.ts`) existed only because the OpenAI-shaped proxy could not carry images; both are removed, so image reads are Pi's defaults. Tested through the host: a PNG read by the model reaches the fake API as a base64 `image` block in the `tool_result`. Not tested: Pi's image resizing (it runs in a worker thread) inside the real sandbox under the process guard.
- **Final-report phase text.** With Claude, Pi sends the host's changed prompt section (the final-report phase) as a mid-conversation system message instead of rewriting the top-level system prompt, which keeps the cached prefix. The native-protocol test now looks for it there.
- **The test not counted as a pass** is `tests/box-docker.test.ts`, skipped unless `CHIEF_BOX_DOCKER_IMAGE` is set; it is skipped on main too.
