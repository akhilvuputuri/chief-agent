# Verification record

Custom runtime release, 6 September 2026.

- Strict TypeScript build and regression suite: 62 Node tests plus 2 Google OAuth scope tests pass.
- Request-body tests confirm Sol, medium reasoning, price-first routing and 2/10 ceilings; no eligible provider fails clearly.
- Runtime tests cover actual observations, invalid identity arguments, durable budgets, cancellation, retries, approval stops, uncertain writes, paused-task isolation and migration idempotence.
- Migration tests preserve original history JSON and schedule next-run timestamps, seed text-only context, and pause tasks once.
- Existing tests retain ownership, approval expiry/replay, unknown experience, mismatched source evidence, Telegram formatting, voice provider contracts and Google integration checks.
- Paid Sol smoke against synthetic in-memory data passed: memory_set → memory_list → natural confirmation. Three model calls; OpenRouter returned OpenAI as provider and total cost $0.016633. No production records or Telegram messages were used for that test.
- Production preflight: existing gateway, Hermes and Postgres healthy; 22 roles retained; the 47-step task was already paused at revision 3. No schedules currently stored.

Production cutover completed from PR #7 (`f1664bb`). Gateway and Postgres healthy; Hermes container removed, historical volume retained. All 22 roles and the paused revision-3 task remain, with 26 done and 21 pending steps. One original history was archived and seeded into the custom conversation format.

Post-cutover checks passed: Telegram getMe; a bounded server-side Sol request (OpenAI provider, $0.000084 reported); Gmail search; read-only Calendar listing; both Sheet metadata reads (three tabs each); ElevenLabs Flash v2.5 synthesis followed by Scribe v2 transcription. These were provider checks, not a claim that a new human Telegram voice note has been sent since cutover. This does not claim semantic correctness, exhaustive requirement coverage or production-scale resilience. The historical Hermes test record is archived in `docs/history/hermes-verification.md`.
