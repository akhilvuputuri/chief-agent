# 171 — Can a coding job's call record say what the model was thinking about?

Work dates: 12 November 2026. Written: 12 November 2026.
Status: Pi coding calls on the direct Anthropic route ask for summarized thinking, and each call record keeps the summary. Tested with mocked requests; not called live. Not yet released; waits for job `9600af57` and the owner's go.

## User-visible problem and preceding iteration

[Journal 169](169-three-hour-coding-attempts.md) found that the first Opus 5.5 coding job, `9600af57`, ran out of time because the model thought at length on most steps: 83% of the coder's output tokens were thinking, and its longest call thought for 251 s, with 25,982 thinking tokens and 133 visible ones. The call records could show how long each call thought but not what about. The direct adapter ([journal 160](160-direct-anthropic-provider.md)) sent `thinking: {type: "adaptive"}` without `display`, and the API's default for Opus 5.5 is `"omitted"`: every thinking block came back with an empty `thinking` string and only a signature.

## Evidence

- **Reported (Anthropic's migration guidance in the claude-api reference, read 12 November 2026):** `display: "summarized"` returns a readable summary of the reasoning in each `thinking` block; `"omitted"` is the default on Opus 5.5, Sonnet 5.5 and Haiku 5.5. Display controls visibility only: thinking happens and is billed the same under every setting, and the raw chain of thought is never returned. Blocks must be passed back exactly as received, including blocks whose text is empty. The history-editing check binds a block to `system`, `tools` and every earlier message; changing a request parameter outside those (the guidance lists `max_tokens`, `output_config` and `effort`, `tool_choice`, `metadata`) keeps later blocks valid. `display` is a field of `thinking`, outside all three, but the guidance does not name `display` in that list.
- **Read in code, 12 November 2026:** Pi's OpenAI-completions client (`@earendil-works/pi-ai` 1.1.0, `dist/api/openai-completions.js`) keeps a response's `reasoning_details` entry only when its type is `reasoning.text`, `reasoning.summary` or `reasoning.encrypted`. The direct route's entries (`anthropic.thinking`) are skipped, so the worker never sends them back to the host; [model providers](../model-providers.md#limitations) already recorded this. The Python squad (`coding_runtime`) copies `reasoning_details` back unchanged and compacts its history towards 80 KB, with a 170 KB hard bound.
- **Tested (mocked API, below):** the opt-in sends `display: "summarized"` and changes nothing else in the request; a summarized block, with non-ASCII text and a trailing space, is stored and replayed byte for byte; an empty-text block from before the opt-in replays unchanged beside it; OpenRouter requests, direct or as a fallback, are byte-identical with and without the opt-in.
- **Not measured:** how long the summaries are, how much they add to the stored records, whether summarized display changes latency or cache reads, and whether the API invalidates the messages cache when `display` changes between calls. No live call was made.

## Diagnosis and alternatives

- **Per-call opt-in, Pi coding calls only (chosen).** `ModelAdapter.generate` takes an optional `thinkingDisplay: "summarized"`. Only `AnthropicDirect` reads it; the OpenRouter adapter builds its body field by field and ignores it. `CodingController.generate` sets it for Pi jobs, beside `requireComplete`, so it covers the planner, coder, reviewer and plan check, which all reach the host through the Pi proxy.
- **Global (rejected).** Chief's own conversations store `reasoning_details` in their histories and replay them on later calls of a turn; summaries would grow those histories and requests, which needs its own decision.
- **Every coding job (rejected).** The Python squad would replay the summaries inside its 80 KB history and compact sooner. New jobs run on Pi (`config/coding-backend.json`), so leaving the squad out costs nothing today.
- **`display: "updates"` (not chosen).** It returns only the short notes between tool calls, behind another beta, and would not say what the long thinking phases were about.

What would change this: summaries that turn out large enough to matter in storage, or a Pi version that starts replaying the direct route's entries (requests would then grow; see below).

## Implementation and review

- `src/model.ts`: the optional `thinkingDisplay` field on the adapter input.
- `src/anthropic.ts`: `thinking` becomes `{type: "adaptive", display: "summarized", block_binding: {prefix_mismatch_behavior: "drop_block"}}` when the field is set; unchanged otherwise.
- `src/coding/controller.ts`: Pi jobs set the field. The call's request hash covers the worker's input only, so existing call records and retries keep their hashes.

**Replay, checked in code.** Stored blocks are deep copies of the streamed block (`JSON.parse(JSON.stringify(block))`) and are replayed as shallow copies (`{ ...block }`) wherever they stood. Cache marks are never put on `thinking` or `redacted_thinking` blocks. `ThinkingStates` and `RejectedReplays` key on the signature (or `data`), never on the text. The rejected-replay retry leaves blocks out whole; it never edits them. No path trims, truncates or rewrites the text. Pi does not replay these entries at all (above). The readable copy in `coding_model_calls.result` goes through `scrubTrace` and `storable` (credential-shaped substrings replaced, NUL removed), but it is never replayed: the worker gets the exact generation, and a repeated call id gets the exact sealed copy (`result_box`).

**Mixed display within one conversation (hypothesis from the guidance, not tested live).** A resumed job can hold blocks from before the change (empty text) and after it (summaries). Replaying either kind unchanged is what the guidance requires, and `display` is outside the bound prefix. In Pi jobs the question does not arise, because no thinking blocks are replayed.

**No earlier thinking in any Pi request (read in code; behaviour from before this change).** Coding calls run without a spending scope, so `callScope()` in `src/anthropic.ts` returns nothing for them and `ThinkingStates` records and inserts nothing. Pi also drops the `anthropic.thinking` entries (above). Every Pi request therefore carries no earlier thinking at all. Hypothesis, not measured: the model may think again on each turn about what it already worked out, which could explain part of the long thinking in journal 169. This change does not alter that; the summaries may help test it.

**Prompt cache (reported, not measured).** Anthropic's caching guidance lists a change to the `thinking` settings among the changes that invalidate the messages cache; it does not single out `display`. Within a Pi job, display is the same on every call, so only a job running across the deploy can see one cache miss, at its first call after the release.

**What the summaries hold (reported).** On Opus 5.5, the progress notes the model writes between tool calls come back as `thinking` blocks too, and under `"summarized"` they carry text. Stored entries therefore mix those short progress notes with reasoning summaries, and a profiling script cannot tell them apart by type.

**Where the summary is stored.** In `coding_model_calls.result` (jsonb), for each entry of `result->'message'->'reasoning_details'` with `type = 'anthropic.thinking'` and `block->>'type' = 'thinking'`, the summary is `block->>'thinking'` and `position` is where it stood among the visible blocks. A `redacted_thinking` block has `data` and no text. For example:

```sql
SELECT c.id, c.role, c.created_at, (d->>'position')::int AS position,
       d->'block'->>'thinking' AS summary
FROM coding_model_calls c,
     jsonb_array_elements(c.result->'message'->'reasoning_details') d
WHERE c.job_id = $1 AND d->>'type' = 'anthropic.thinking'
  AND d->'block'->>'type' = 'thinking'
ORDER BY c.created_at, position;
```

Calls served by the OpenRouter fallback carry OpenRouter's own entries instead, and failed-but-billed calls keep only a usage event, so neither has a summary.

**Request size.** Pi jobs: no growth, because Pi drops the entries before its next request. The worker's own bound (`maxRequestBytes` 3,990,000) and the host's 4,000,000-byte model-input check therefore see the same requests as before. Each response to the worker grows by that call's summary only. Had Pi replayed them (hypothesis, upper bound): a summary is at most as long as the call's thinking. The coder in job `9600af57` thought 458,408 tokens over 173 calls, about 2,650 a call; over a 200-call job that is about 530,000 tokens, or about 2.1 MB of text at four characters a token. Added to the largest prompt journal 169 reports (the reviewer's, about 152,000 tokens or 0.6 MB), a late request would be about 2.7 MB before JSON escaping: under 3,990,000 bytes, with about a third of the room left, and before Pi's own compaction. Real summaries are expected to be much shorter than the thinking (not measured). The response stream bound (the larger of 1.6 MB and 1 KB per allowed output token: about 131 MB for the coder and planner, about 66 MB for the reviewer) is far above any summary.

**Review.** Pending: needs an independent reviewer's verdict for the exact head.

> **Update, 12 November 2026:** an independent review of `7b37751` (PR 466) approved, with non-blocking notes. This revision addresses them: the failure mode if the API rejects the request shape, the plan to check it before release, the cache and progress-note notes above, the absence of earlier thinking in Pi requests, and a code comment in `src/anthropic.ts` that is now worded as an inference. The new head needs its own review verdict.

## Verification and outcome

Tested locally on 12 November 2026 (Node 22.23.4, Kite 0.2.0, PGlite): `kite run typecheck` passed; `tsx --test tests/anthropic.test.ts` (30 passed), `tests/model-router.test.ts` (12 passed) and `tests/coding-output-allowance.test.ts` (5 passed). With the changes to `src/anthropic.ts` and `src/coding/controller.ts` reverted, the two opt-in tests fail and the replay test still passes, as expected for behaviour that was already correct (the OpenRouter test was not rerun that way). The full TypeScript suite (`kite run build && kite run test:ts`) ran 1,679 tests: 1,678 passed, 1 skipped, none failed.

Not verified: that the live API accepts `display: "summarized"` together with `block_binding` under the thinking-binding beta on this account (the guidance documents both fields on adaptive thinking, not this exact combination), what the summaries look like, and their size. The first live Pi job after release answers all three; its records can be read with the query above.

**If the API rejects the shape (read in code).** The 400 would be classified `rejected`, which has no cooldown (`DirectCooldown.seconds` in `src/model-router.ts`; only the beta-enrollment code cools). Pi calls send no earlier thinking, so the adapter's retry without thinking does not apply. Every Pi call would then make one failed direct request and fall back to OpenRouter for that call, paid from OpenRouter credit, and the owner would get a fallback message on Telegram at most once an hour per fault. Coding would be slower and costlier, not broken. Rollback is a revert of this change.

**Plan before release (needs the owner's go).** One synthetic direct call with this exact request shape (adaptive thinking with `display: "summarized"` and `block_binding`, under the thinking-binding beta) against the real API, to confirm a 200 and a non-empty summary.

## Follow-up and next iteration

- After release, read one job's summaries with the query above, record their total size against the job's thinking tokens, and use them to revisit journal 169's open effort decision.
- If the summaries prove useful outside coding, decide separately whether Chief's own conversations should ask for them.
