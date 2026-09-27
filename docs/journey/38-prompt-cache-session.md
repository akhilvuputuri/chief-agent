# 38 — Why every message's first model call missed the prompt cache

Work date(s): 2026-09-27. Written/revised: 2026-09-27.
Status: in review. A stable per-owner cache key is on a review branch; the production effect is not yet measured.

## User-visible problem and preceding iteration

While measuring context after the Jev tool picker ([journal 37](37-jev-tool-picker.md)), the first model call of every message had no cached input tokens. Later calls in the same message were cached. This makes every message's first call pay full input price plus a cache write. It also adds latency.

## Evidence

**Measured in production** (stored `model.completed` usage):

- 13–26 September: the first call of 69 of 69 runs had 0 cached tokens.
- 27 September, after the picker release: 0 of 8 first calls were cached, even when the previous model call was only 11–50 seconds earlier. So cache expiry does not explain it. Later calls in the same run cached about 7,000–10,500 of about 10,000–12,600 prompt tokens.

**Controlled experiment** (27 September, `openai/gpt-6-sol` via OpenRouter, served by OpenAI):

- The same 8,700-token prompt, with the same tools and messages, was sent six times about 4 seconds apart.
- The prompt started with a fresh random nonce, so no earlier cache could apply.

| Call | `session_id` | Cached tokens     | Cost    |
| ---- | ------------ | ----------------- | ------- |
| A1   | new A        | 0 (8,697 written) | $0.0218 |
| A2   | A again      | 8,697             | $0.0018 |
| B1   | new B        | 0 (8,697 written) | $0.0218 |
| C1   | none         | 0 (8,697 written) | $0.0218 |
| C2   | none again   | 8,697             | $0.0018 |
| A3   | A again      | 8,697             | $0.0018 |

This is one call per condition, on one model and provider. It is enough to show the mechanism, not to estimate savings. The provider cache is partitioned by `session_id`. Chief sent the run ID as `session_id` (`src/custom-agent.ts`), so every message started a new partition.

## Diagnosis and alternatives

- **Change:** send a stable, derived per-owner key (`chief-` plus 16 hex digits of a SHA-256 of the owner ID) as `session_id`. The run ID stays the internal `sessionId`, which tests and per-run logic rely on.
- **Rejected alternative:** omitting `session_id` also caches (C2). It was rejected because, without an explicit partition, cache hits would presumably depend on provider routing. That is a hypothesis, not tested.
- **Privacy:** the key is an unsalted hash of the owner's Telegram ID. The raw ID is never sent, but anyone holding the key could recover the ID by trying every possible Telegram ID, so the key is a pseudonym, not an anonymous value. OpenRouter already receives the owner's messages under this account, so this adds little exposure.
- **Session grouping:** OpenRouter's own grouping becomes per owner rather than per run.
- **Specialists are unchanged on purpose.** Research, plugin, media and alignment runs have their own instructions and tools, so they keep their child run ID as `session_id`. Their first call still misses the cache.
- **What is still unknown:** how much of the prompt is shared between consecutive messages. That shared part is the cacheable part. It changes with the offered tool domains and with the excerpt archive in the system message, which changes each turn. Within one message the cached share was 70–85%.

## Implementation and review

- The new field is `AgentRequest.cacheKey`, set once per owner in `src/agent.ts`.
- `ModelAdapter.generate` gains `cacheKey`, which the OpenRouter adapter sends as `session_id` when present (`src/model.ts`).
- Tests cover the adapter and the case where two messages from one owner share a key but have different run sessions.

## Verification and outcome

Pending release. Then compare first-call `cached_tokens` and cost in `model.completed` against the 0-of-77 baseline above.
