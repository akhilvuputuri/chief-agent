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

## Chief fresh start — 7 September 2026

The GitHub repository is now `akhilvuputuri/chief-agent`. The selective reset supersedes the historical task state above: old conversations, runtime traces, task records, research and generated preparation data are recoverably archived in private Postgres schema `reset_archive_20260907`. All 22 job records and six explicit memories remain. Credentials, connections and Telegram update deduplication are unchanged. No private skills existed to migrate.

The current regression suite passes 65 Node tests plus two OAuth scope tests, along with strict typechecking, build and formatting checks. CI passed for the separate key-only current-skill and UUID-based historical-skill operations. A real Sol medium request successfully called `skill_read(key)` and loaded the repository research skill through the owner-scoped implementation.

A fresh two-role acceptance check initially exhausted its deliberately smaller 16-call budget after saving three Cognition assessments (one strength, two unknowns). It preserved the task checkpoint, and a bounded follow-up resumed with OpenAI rather than recreating Cognition's completed work. The original 47-step task was not resumed. This test exercises operational progress and persistence, not independent certification of source interpretation.

The two-role acceptance task completed all five recorded steps: six preparation findings and three shared exercises were saved, and the preparation Sheet synced with counts 22 roles / 6 findings / 3 exercises. Across the initial pass and resumed pass it used 30 model calls and 60 tool calls; the deliberately smaller first allocation exposed and preserved a budget pause. The other 20 roles were not processed.
