# 146 — Moving mail recall to pgvector

Work date: 2026-11-01. Written: 2026-11-01.
Status: tested on synthetic data; operator rollout pending. No production measurement yet.

## User-visible problem and preceding iteration

Nothing is visibly wrong. [Journal 120](120-email-memory-mvp.md) searched the email index in gateway memory, and [journal 143](143-recall-with-pgvector.md) then installed pgvector for `memory_recall`. Chief had two ways of doing the same search, with the same model and dimensions. The owner asked to move mail recall across.

This should not change what the owner sees. Exact search over the same vectors should rank the same, within floating-point rounding.

## Evidence

- **Measured (production, 1 November):** 2,809 mail chunks for 1,434 messages, 8,216 kB in `mail_index_chunks`; gateway using 109 MiB. The raw vectors are about 6 MB (arithmetic).
- **Tested:** on 60 synthetic messages with one to four chunks each and three queries, the pgvector query returned the same order as an exact scan in JavaScript, with scores within 0.00001.
- **Tested:** converting bytes to the `vector` column preserved every float32 value exactly, on the small test vectors.
- **Not measured:** search time, and equality on real vectors and real questions. Both are planned after the rollout.
- **Hypothesis:** near ties could swap, because pgvector's arithmetic may round differently from the JavaScript scan. The production comparison should show whether this happens.

## Diagnosis and alternatives

- **New `vector(512)` column, filled by the gateway: chosen.** It reuses the existing `decodeVector` and needs no conversion code in SQL. The same step repairs rows written by the previous gateway after a rollback.
- **Convert and drop the bytes in one migration: rejected.** The previous gateway reads those bytes, so a rollback would break `gmail_recall`.
- **Convert in SQL or with a generated column: rejected.** Postgres cannot reinterpret bytes as float4, so it needs a hand-written IEEE 754 decoder inside the database.
- **The shared `embeddings` table: rejected.** It accepts only `message` and `memory` sources and needs UUID ids, and Gmail ids are not UUIDs. Changing it would also touch `memory_recall`.
- **Re-embedding: rejected.** It would repeat about 809,000 tokens and 12 minutes of Gmail reads for vectors already held.
- **HNSW index: deferred,** as in journal 143. It is approximate, so it could lose results, and no speed problem has been measured.

## Implementation and review

See [mail recall](../mail-recall.md#storage-migrations-033-and-035).

- [db/035_mail_index_vectors.sql](../../db/035_mail_index_vectors.sql) adds the nullable column.
- [src/mail-index-store.ts](../../src/mail-index-store.ts) fills it on load, writes both forms and adds `search`, `headers` and `scoreChunks`.
- [src/mail-recall.ts](../../src/mail-recall.ts) no longer holds vectors or headers in memory. The in-memory-only mode is gone, so `gmail_recall` now needs migration 035.
- Search returns every message's ID and score, about 1,400 rows, instead of a top few. Reciprocal rank fusion needs a keyword hit's meaning rank however low it is, so this keeps fusion unchanged without new ranking logic.

Behaviour that changes:

- **Saves are required.** Postgres is now the only copy, so a failed save fails the pass and keeps the messages queued. It used to be logged and repaired on the next start.
- **Excerpts are always Gmail's snippet.** Chunk text was only ever in memory, and already gave way to the snippet after each restart.
- **The eval reads production's index.** It no longer builds its own, so it costs no embedding rebuild and needs no in-memory search. It reads bodies from Gmail instead, because they are not stored, and calls the store directly so that it changes nothing.

Independent review (Opus 5.5) of `73f2e4a` requested changes:

- **One bad email could stop indexing (fixed).** Making saves required meant a sender-controlled NUL in a header failed its group's save for good. The group stayed at the front of the queue, so every call re-read and re-embedded it and newer mail was never stored. On a fresh build `gmail_recall` stayed unavailable. The reviewer reproduced this on the real store. NUL is now removed, and any other data exception leaves that one message out and counts it. Whether Gmail ever returns NUL is unverified.
- **Lost eval rows (fixed).** A failed read during `--export` lost a message's chunks and silently shifted later ranks. Reads now retry, and the summary reports `unreadable`.
- **Rollout check (documented).** The check that `embedding` is filled counts all users, so another owner's rows or `MAIL_INDEX=off` would roll back. That fails safe and does not match production.
- Stale eval README text and an unused variable in the rollout script were also fixed.

## Verification and outcome

Pending the rollout. Planned on production, with private questions kept in the operations folder:

1. All 2,809 chunks have `embedding`, and no embedding tokens were spent.
2. The earlier private eval questions rank the same through the old scan over `vector` and the new query over `embedding`.
3. The query's own time, measured apart from the embedding call.
4. A restart logs `mail_index.loaded`.

## Follow-up and next iteration

- Drop `vector`, `encodeVector` and the fill step in a later migration, once this has run in production.
- Owner-written questions and live use still decide whether `gmail_recall` is worth keeping. This migration does not measure that.
