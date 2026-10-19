# 100 — Why did prompt caching stop, and what does Opus 5.5 need?

Work date(s): 2026-10-19. Written/revised: 2026-10-19.
Status: in review. The main model and `standard` agent tier switch from Gemini 4 Argon to Claude Opus 5.5, with owner-approved price ceilings of $4/M input and $20/M output in the reviewed model policy. Requests carry provider-specific prompt-cache markers. No production call on Opus has been measured yet.

## User-visible problem and preceding iteration

After the owner-directed switch to Gemini 4 Argon on 14 October ([journal 85](85-provider-routing-stability.md)), turns cost more and replies became longer. The owner asked to switch the main model to Opus 5.5, which they find concise and fast, and to understand why caching stopped working, so caching is optimised whichever model runs.

## Evidence

- **Measured, production, 5–17 October 2026** (private telemetry review; aggregates only):
  - The coordinator's prompt-cache hit rate was 0 of 65 calls on Argon (61 routed to Google, 4 to Google AI Studio). On GPT-5.6 Sol it was 39.8%: 50 of 51 later-in-turn calls hit, and 0 of 33 first calls.
  - The median foreground turn cost was $0.047 on Sol and $0.164 on Argon. Per coordinator call, Sol averaged $0.0188 (13.2k prompt tokens, 48% cached) and Argon $0.0529 (24.3k prompt tokens, none cached).
- **Measured, synthetic probes, 19 October 2026.** The probe used a fixed synthetic prompt of about 8–12k tokens (25 synthetic tools, 160 instruction lines, "Say OK."), low reasoning effort and a per-plan `session_id`, with two or three calls a few seconds apart. Total spend was about $0.39. There was no private data.

  | Model, request shape                                                       | Cached tokens on repeat | Cost per repeat call          |
  | -------------------------------------------------------------------------- | ----------------------- | ----------------------------- |
  | Argon, identical request                                                   | 5,869 of 7,923          | $0.0048 (first $0.0159)       |
  | Argon, plus a trailing message with the current time (system or user role) | 0                       | $0.0160                       |
  | Argon, explicit marker on the system message, plus a trailing time         | 0 (3 calls)             | $0.0160                       |
  | Flash 3.8, trailing time, no marker                                        | 0                       | $0.0055                       |
  | Flash 3.8, explicit marker on the system message, trailing time            | 7,185 of 7,226          | $0.0008                       |
  | Opus 5.5, no marker                                                        | 0                       | $0.0471                       |
  | Opus 5.5, top-level marker                                                 | 11,750 of 11,754        | $0.0025 (first write $0.0589) |
  | Opus 5.5, top-level marker, plus a trailing time (system or user role)     | 11,673–11,750 of 11,791 | $0.0027–0.0030                |

- **Code-confirmed.** `src/context.ts` ends every request with a system message holding the current state and the Singapore time to the second. No request carried a cache marker.

## Diagnosis and alternatives

- **Why Argon never cached.** Its implicit cache hit only identical requests in the probe, and every Chief request has a different tail (the time line). An explicit marker did not help Argon either. Sol cached within a turn because OpenAI matches the shared prefix. These causes are measured on synthetic requests. They are consistent with, but not re-measured on, the production prompts.
- **What Opus needs.** Anthropic models on OpenRouter cache nothing unless the request is marked. A top-level marker caches the whole prefix, including the growing in-turn history, and a changing tail does not break it. A repeat call is about 19 times cheaper.
- **What Flash needs.** An explicit marker on the opening system message, which is the stable instructions block. Flash serves the default `fast` agent tier.
- **Alternatives.**
  - Removing the time line would help implicit caches, but the model needs the current time.
  - Moving it into a user message did not help Argon in the probe.
  - Marking every model the same way is not safe: OpenAI and others cache automatically, so their requests are left unchanged.
- **Ceilings.** Opus 5.5 lists at $4/$20, double the previous $2/$10 ceilings. The owner chose to raise the ceilings for every OpenRouter caller rather than only the main model. That also lets agents and coding models route to pricier providers. Moving the ceilings into the reviewed policy file avoids a Compose or server `.env` change.

## Implementation and review

- `config/model-policy.json`:
  - `main` and the `standard` tier are `anthropic/claude-opus-5.5`;
  - `priceCeilings` is `{input: 4, output: 20}`.
- `src/model-policy.ts`: the optional, bounded `priceCeilings` and `resolvePriceCeilings`. `src/main.ts` uses them for every OpenRouter caller.
- `src/model.ts`: `cacheHints` adds a top-level marker for `anthropic/` models and a marker on the opening system message for `google/` models. Other models are unchanged.
- Tests:
  - `tests/model-cache-hints.test.ts` checks the wire bodies.
  - `tests/model-policy.test.ts` covers ceilings, their bounds and the bundled pin.
  - Agent tests use the new `standard` tier.
- Docs: [deployment](../deployment.md#changing-the-production-model-through-a-release), [agents](../agents.md), AGENTS.md and the handover.

Independent review: pending.

## Verification and outcome

Tested: focused tests pass. Pending:

- the full suite, CI and review;
- the release;
- a post-release owner turn whose `model.completed` names `anthropic/claude-opus-5.5` and reports `cachedTokens > 0` on the second call of a turn.

Cost per turn on Opus is unmeasured. Opus costs twice Argon's per-token price, and caching is expected to offset part of that, but that is a hypothesis.

## Follow-up and next iteration

- The opening system message also carries the per-turn conversation summary, so the prefix still changes between turns. Moving the summary is part of the prompt-size work.
- Domain-gated tools change the tool list, which comes first in the prefix. Keep tool order stable when gating.
- Reply style rules that hold for any model.
