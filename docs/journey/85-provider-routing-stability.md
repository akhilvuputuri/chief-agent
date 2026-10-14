# 85 — Why do coding jobs keep pausing on provider faults?

Work date: 2026-10-15. Written: 2026-10-15.
Status: in progress. Candidate v0.3.72 removes OpenRouter's price-sorted routing and moves the main model and standard agent tier to Gemini 4 Argon; the coding reviewer stays on GPT-6.1 Sol for now. Review, release and a canary remain.

## User-visible problem and preceding iteration

[Journal 83](83-pi-context-verification.md) released the Pi context, review-evidence and terminal-provider-recovery work as v0.3.70 and selected worker 0.1.4 in v0.3.71. The owner's first released-artifact canary, a small documentation job sent through Telegram on 14 October, paused during planning with "Model run did not finish cleanly". The owner reported this as the same failure seen before.

## Evidence

Measured from sanitized production logs and a read-only structural database query (no prompts, generations or task content):

- The canary used worker `sha256:d8d28eb2…`, DeepSeek V4.1 Flash for planning and GPT-6.1 Sol as the configured reviewer. No saved coding-model preferences exist, so configured defaults applied.
- Eight planning generations completed between 16:08 and 16:11 UTC. The ninth streamed from OpenRouter provider OpenInference: 65,305 bytes in 46 seconds, then about 7 KB over the next 90 seconds, then a disconnect at 136.7 seconds (`model_disconnected`, HTTP 409 to the worker). The job paused with its session retained.
- Recovery did not apply by design: v0.3.70 retries only a confirmed terminal 429/5xx receipt, never an unknown-outcome disconnect.
- Over the preceding 14 days, every coding pause attributed to a provider came from a small DeepSeek host: Relace (339 streamed calls; 7 transient 5xx failures across 4 jobs, plus 1 provider failure), Morph (117 calls; 8 incomplete responses in 1 job) and OpenInference (9 calls; this disconnect). Wafer (66 calls) had none.
- Every OpenRouter request has set `provider.sort: "price"` since the owned runtime was introduced ([#7](https://github.com/akhilvuputuri/chief-agent/pull/7)).

## Diagnosis and alternatives

Hypothesis, supported by the provider distribution but not a controlled comparison: forcing the cheapest provider pins DeepSeek traffic to small hosts and disables OpenRouter's default load balancing, which deprioritizes providers with recent outages. Without `sort`, OpenRouter still prefers cheaper providers and still enforces the `max_price` ceilings and `require_parameters`.

Alternatives considered: extending recovery to disconnects by resolving the generation ID's billing first (a policy change, deferred unless routing alone is insufficient); excluding named providers (brittle as provider lists change). Trade-off: some calls may route to a pricier provider, still under the unchanged $2/M input and $10/M output ceilings.

## Implementation and review

- `src/model.ts`: removes `sort: "price"`; `max_price` and `require_parameters` are unchanged. This adapter serves the main assistant, subagents and Pi coding calls. The legacy Python runtime keeps its own copy in a separately pinned image that new jobs do not use.
- Owner-directed model change: `config/model-policy.json` `main` and the `standard` agent tier move from `openai/gpt-6.1-sol` to `google/gemini-4-argon`. OpenRouter lists Argon at $2/M input and $10/M output with tools, reasoning and a 1,048,576-token context, so it fits the existing ceilings. The fast tier (Gemini 3.8 Flash) and DeepSeek coding/planning defaults are unchanged.
- The owner also asked for the coding reviewer to move to Argon. Independent review of the first head (`86d775c`) found that Pi 1.1.0's bundled model catalog has no Argon entry, so `coding_runtime_pi/src/model.ts` would fall back to a 32,000-token context window (and drop catalog compat flags) for a Pi reviewer; the worker passes no explicit window. Reviewer compaction would then start near 24k tokens, risking the context failures journal 83 addressed. The owner chose to keep the Pi and legacy coding reviewer defaults on GPT-6.1 Sol until a worker change passes the selected model's real context window; that follow-up also needs Argon in the acceptance helpers' model allowlists.
- Review also noted OpenRouter's default routing weights providers by price, so much Argon traffic may go to its cheapest endpoint (listed at $1/$5); the canary should record the serving provider.
- Tests now assert the request's provider block has no sort and the policy's standard tier resolves to Argon.

## Verification and outcome

Pending: full local and hosted checks, exact-head independent review, release, a post-release check of the effective main model, and a canary. Gemini 4 Argon has no prior evidence as main assistant in this repository; the earlier [Gemini 3.8 Flash coder diagnosis](83-pi-context-verification.md#gemini-convergence-diagnosis-and-owner-selected-lean-release--14-october-2026) concerns a different model and role and does not transfer either way.

## Follow-up and next iteration

Pass the selected model's context window from host to worker (new worker image and pin), then move the coding reviewer to Argon. If pauses continue on routed providers, measure provider distribution after release and consider resolving disconnect billing by generation ID before allowing one fresh generation.

### Worker context-window follow-up — 15 October 2026

The host now snapshots each selected Pi model's context length from the live OpenRouter catalog into the job settings at creation (`contextWindows`, at most three bounded entries; catalog failure or missing metadata omits it rather than guessing). The worker assignment carries those windows beside `settings`, because workers built before this change strictly validate `settings` but ignore unknown top-level fields; jobs created during the host-before-image rollout therefore still run on worker 0.1.4. Pi runtime 0.1.5 uses a host window only as a fallback for models missing from Pi's bundled catalog, so catalogued models keep their existing windows. Synthetic tests cover catalog snapshot, failure and missing metadata, the old-worker settings schema, bounds and fallback precedence. Moving the coding reviewer to Argon still requires publishing and pinning the 0.1.5 worker; no paid evidence exists yet.
