# 156 — Why did the planner stop while writing its plan?

Work date: 2026-11-09. Written: 2026-11-09.
Status: released in `fa058f9` (9 November); worker image `sha256:e67dc9ea…` built from it and pinned with the 128,000 profile in the following change.

## User-visible problem and preceding iteration

After the fix in [journal 155](155-text-postgres-cannot-store.md) was live, the owner cancelled study-links job `280f2d70` and started job `d5a8bd74` with the original request plus five review fixes. It paused about 2.5 minutes in with "Planning report request failed; investigation and session retained." The owner asked why there was a problem again.

## Evidence

- **Measured (production, read-only):** the job made 18 planning calls, all complete. The 19th was the one structured final report call. It streamed for 54 seconds, about 1.4 MB, and ended with finish reason `length`, so the host refused it as `model_incomplete` (409). The call asked for 16,000 output tokens, the profile's `maxOutputTokens`.
- **Measured:** the largest planner call on each of the eight earlier Pi jobs used 6,783–14,027 output tokens, of which 2,248–11,169 were reasoning. The limit had always been close; this request, the largest so far, crossed it.
- **Code:** a plan document may hold 32,000 characters (`reportLimits.document`). With high-effort reasoning in the same call, 16,000 tokens cannot hold the largest valid plan.
- **External:** OpenRouter lists DeepSeek V4.1 Flash 1017 at about 944,000 maximum output tokens and Claude Opus 5.5 at 128,000, both with 1M context. Pi's bundled model data agrees. DeepSeek output costs about $0.50 per million tokens.

## Diagnosis and alternatives

The cap was Chief's own, not the model's. The schema, the host model client and the profile all capped one call at 16,000 tokens, below what the report contract admits. The owner asked to raise it a lot, especially for DeepSeek.

The fix:

- One maximum, `MAX_OUTPUT_TOKENS` = 128,000 (Opus's limit), in `src/model.ts`; the schema uses it.
- The coder and planner use `maxOutputTokens`. The reviewer uses a new optional `reviewerMaxOutputTokens`, which defaults to the coder allowance capped at 16,000. Opus reviews keep their current allowance, so their cost and latency do not change.
- A model call's total time limit on the host grows with its allowance: at least 100 tokens a second, and never below the earlier 5 minutes (21 minutes at 128,000). The 90-second idle limit still stops a stalled stream.
- The worker waits a minute longer than the host's limit. The host answers a model call only when the generation is done, and Node's built-in fetch gives up after 300 seconds without response headers, while the OpenAI SDK gives up after 10 minutes. At the measured 300 tokens a second, 128,000 tokens take about 7 minutes. Node 22's fetch cannot use a dispatcher from the newer undici the SDK already depends on, so the worker's model requests go through undici 8's own fetch with matching header and body timeouts, and Pi's `timeoutMs` is set to the same value.
- The profile moves to 128,000 in a second change that also pins a worker image built from this one, because the worker validates its settings with the schema it was built with. An older worker refuses 128,000.

Rejected:

- Lowering reasoning for the report call. The plan is written in that call, and its quality depends on that reasoning.
- One allowance for every role. A larger allowance can raise a provider's reasoning budget for Anthropic models, with no evidence that reviews need it.
- Keeping the 5-minute call limit. It would cap a reply at about 90,000 tokens at the measured speed, and far less with a slower provider.
- Sending response headers and keepalive bytes before the generation is done. The worker's recovery reads the HTTP status of a refused call, so that would change the worker protocol.

## Review

Independent review (Claude Opus 5.5) of the first version found one blocking defect: the host allowed a call up to 21 minutes, but the worker's fetch would give up after 5. The worker's retry wrapper would then resend under a new call ID, the host would refuse it because the first call still held the model slot, and the job would pause as a busy slot while the first generation ran on unobserved. This would only have appeared after the profile change. Fixed with the worker timeout above. It also found that the docs described 128,000 as in use while the profile stays at 16,000; corrected.

## Verification and outcome

- **Tested:** `tests/coding-output-allowance.test.ts`. The schema accepts 128,000 and refuses more. Each role's call is sent its own allowance (planner 128,000, reviewer 16,000), a per-call request above the allowance is clamped, and a smaller one is kept. Jobs created with the earlier settings keep their allowances.
- **Tested:** `coding_runtime_pi/tests/patient-fetch.test.ts`. A reply whose headers come after a short timeout fails, and with a longer one arrives with the exact request; an abort still stops it. A Pi run against a server that answers after 1.5 seconds pauses with a 0.4-second `responseTimeoutMs` and plans with 10 seconds. A pause inside the reply body, which only the worker's fetch bounds, does the same with and without the gateway retry wrappers; with Node's built-in fetch in its place the run plans through the pause, so the test fails.
- **Measured:** completed production model calls have taken up to about 88 seconds, so nothing on the path closes a silent request sooner than that. The Caddy route `/coding/worker/*` (`deploy/coding/Caddy.routes`) sets no response timeout; longer silent requests are not yet observed.
- **Not yet measured:** a planning report above 16,000 tokens, or a model call longer than 5 minutes, in production.

## Follow-up and next iteration

After release: publish the worker image from main, pin it and set the profile to 128,000, then cancel `d5a8bd74` and start a fresh job. Stored jobs keep their settings, so resuming `d5a8bd74` would hit the same limit.
