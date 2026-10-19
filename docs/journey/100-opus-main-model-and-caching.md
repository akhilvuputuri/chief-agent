# 100 — Why did prompt caching stop, and what does Opus 5.5 need?

Work date(s): 2026-10-19. Written/revised: 2026-10-19.
Status: released (v0.3.89, `f94e699`, 19 October 2026). The main model and `standard` agent tier run Claude Opus 5.5 with owner-approved $4/$20 price ceilings and provider-specific cache markers. No production model call on Opus had been measured at release closure.

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

  Independent review found a confound in those last Opus rows. Their reads match the entries the earlier runs had just written, and the Anthropic cache is not partitioned by OpenRouter `session_id`. So they don't show that a changing tail leaves the prefix cached.

- **Measured, synthetic tool loop shaped like Chief's, 19 October 2026.** Each run used a fresh nonce in the system prompt, about 12.8k tokens and 25 tools. The model called `lookup` twice, then answered, so each run made 3 calls. Every call sent back the model's `reasoning_details` and rebuilt the trailing time message. The adapter's provider block was used (`max_price` $4/$20, `require_parameters: true`, medium effort). Total spend was about $0.25.

  | Opus 5.5 markers                                    | HTTP status   | Cached tokens, calls 1→2→3 | Cost, calls 1→2→3          |
  | --------------------------------------------------- | ------------- | -------------------------- | -------------------------- |
  | Top-level only                                      | 200, 200, 200 | 0 → 12,773 → 12,773        | $0.065 → $0.0042 → $0.0050 |
  | Opening system message only                         | 200, 200, 200 | 0 → 12,667 → 12,667        | $0.065 → $0.0045 → $0.0053 |
  | Top-level and opening system message                | 200, 200, 200 | 0 → 12,772 → 12,772        | $0.065 → $0.0041 → $0.0050 |
  | Top-level and the last message before the time line | 200, 200, 200 | 0 → 12,768 → 12,878        | $0.066 → $0.0043 → $0.0045 |

  Every call was served by Claude Platform on AWS.

- **Code-confirmed.** `src/context.ts` ends every request with a system message holding the current state and the Singapore time to the second. No request carried a cache marker.

## Diagnosis and alternatives

- **Why Argon never cached.** Its implicit cache hit only identical requests in the probe, and every Chief request has a different tail (the time line). An explicit marker did not help Argon either. Sol cached within a turn because OpenAI matches the shared prefix. These causes are measured on synthetic requests. They are consistent with, but not re-measured on, the production prompts.
- **What Opus needs.** Anthropic models on OpenRouter cache nothing unless the request is marked.
  - With a top-level marker alone, measured reads stopped growing after the opening prefix (tools, system and first user message): 12,773 tokens on both later calls. The inferred mechanism is that the automatic breakpoint lands on the per-call time message, so each call's new entry ends in a timestamp the next call does not repeat.
  - Adding a marker on the last message before the time line also cached the growing in-turn history (12,878 tokens on the third call).
  - On these short loops the saving over top-level only is small. It grows with large tool results, but that is a hypothesis until production calls are measured.
- **Thinking-signature risk.** Opus binds a thinking block to the prefix before it, and Chief deletes and re-adds the time message on every call. Review flagged that this could fail continuations. All 12 loop calls returned 200 while replaying `reasoning_details`. A 200 shows the edit is not blocked on the upstream account OpenRouter routed to, not that the signature check passed; other accounts may enforce it. The probe also replayed reasoning on every earlier assistant message, while Chief keeps only the latest, and it never reached wire compaction, so those edits were not exercised.
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
- `src/model.ts`: `cacheHints` adds, on the wire only:
  - for `anthropic/` models, a top-level marker and a marker on the last markable message before the trailing state line;
  - for `google/` models, a marker on the opening system message.

  Other models are unchanged.

- Tests:
  - `tests/model-cache-hints.test.ts` checks the wire bodies.
  - `tests/model-policy.test.ts` covers ceilings, their bounds and the bundled pin.
  - Agent tests use the new `standard` tier.
- Docs: [deployment](../deployment.md#changing-the-production-model-through-a-release), [agents](../agents.md), AGENTS.md and the handover.

- `scripts/pi-acceptance/provider-helper.mjs` and `scripts/fixtures/pi-report-proxy.mjs` use the resolved ceilings, so acceptance runs filter like production.

Independent review (Opus 5.5, commit `3a26ad0`) requested changes:

- **High.** The thinking-signature risk, untested in a real tool loop. The loop probe above showed that the routed provider does not block it, with the caveats below.
- **High.** The top-level marker may never produce a read beyond the opening prefix, and the first probe was confounded. Confirmed by the loop probe and fixed with the extra marker. A delta review then found that the acceptance helper's offline test fixture lacked the new `model-policy.js` import; fixed.
- **Medium.** The docs overclaimed. Corrected.
- **Low.** Stale ceiling statements in docs/operating-model.md, docs/deployment.md, docs/configuration.md and the acceptance scripts. Fixed.
- **Low, noted.**
  - The shared 8,000-token `max_tokens` covers Opus thinking and the reply. Watch `finishReason=length` after release.
  - It is unverified whether `require_parameters` narrows routing when `cache_control` is present.

## Verification and outcome

Tested: focused tests pass. Pending:

- the full suite, CI and review;
- the release;
- a post-release owner turn whose `model.completed` names `anthropic/claude-opus-5.5`, reports `cachedTokens > 0` on later calls of the turn, and costs less per call than an uncached estimate. The logs record cached tokens but not cache writes.

Cost per turn on Opus is unmeasured. Opus costs twice Argon's per-token price, and caching is expected to offset part of that, but that is a hypothesis.

### Release closure — 20 October 2026

[PR 273](https://github.com/akhilvuputuri/chief-agent/pull/273) merged as `f94e699` (package 0.3.89). Exact-head independent review approved `6af07f8` in round 4, and hosted CI and Devin passed there. The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39291865454) recorded an exact-commit `success` receipt with startup health at 17:14:44Z on 19 October. Current main, `becf234`, keeps the same policy.

This verifies deployment only. No `model.completed` line had been observed in CloudWatch (`models` query, 16:27–20:27Z on 19 October) at closure, so these remain pending:

- the model name;
- `cachedTokens` on later calls of a turn;
- cost per call against the uncached estimate;
- `finishReason=length`.

They are listed in the weekly review's fixes ledger.

## Follow-up and next iteration

- The opening system message carried the per-turn conversation summary. [Journal 101](101-lean-coordinator-prompt.md) moves it into its own message, so instructions and memories form a stable prefix. For Anthropic this gives no cross-turn reuse yet, because no breakpoint sits after that message and the tool list, which comes first, changes with each turn's domains. A marker on the opening message is the next thing to measure.
- Domain-gated tools change the tool list, which comes first in the prefix. Keep tool order stable when gating.
- Reply style rules that hold for any model.
