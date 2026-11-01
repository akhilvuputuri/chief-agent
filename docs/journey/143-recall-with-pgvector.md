# 143 — Can Chief find what the owner half-remembers?

Work date: 2026-11-01. Written: 2026-11-01.
Status: released in `48d22d1` on 1 November with the operator rollout. A first operator-written evaluation favours keeping it and found one fusion fault. Chief's real use is not measured.

## User-visible problem and preceding iteration

Chief can search past conversations only with `conversation_search`, which needs every query word to match. A question phrased differently from the original misses. The owner wanted to try retrieval over their own history, as step 2 of [issue 326](https://github.com/akhilvuputuri/chief-agent/issues/326), after the [learner fixes](130-nightly-learner.md) in step 1.

[Mail recall](120-email-memory-mvp.md) already embeds email, stored as float arrays and searched in application code. Its evaluation showed that fusing meaning and keywords beat either alone on mail. That is evidence about mail, not about conversations.

## Evidence

- **Measured (production, 1 November):** 1,121 user and assistant messages, of which 533 have no text and are never indexed; about 2 million characters; database 346 MB.
- **Estimate, not measured:** about 500,000 tokens to backfill, so roughly a cent at the model's list price, and about 2 KB per vector.
- **Reported:** the owner chose Postgres with pgvector over a separate vector store.
- **Tested:** synthetic tests in [tests/recall.test.ts](../../tests/recall.test.ts) with a fake embedder. They do not show retrieval quality on real questions.

## Diagnosis and alternatives

The chosen design is one table in the existing database, an exact search, and a tool Chief chooses to call.

- **A separate vector store: rejected by the owner.** It adds a service, a second backup and a sync problem, for a few thousand rows.
- **Injecting results into every prompt: rejected.** It costs tokens on every turn and would break the cached prefix, before anything shows it helps.
- **An HNSW index: deferred.** An approximate index solves a speed problem nobody has measured here.
- **Reusing the mail index's storage: rejected.** Float arrays in application memory do not scale with a growing history, and trying pgvector is part of the point.

The main cost is operational. Earlier database changes only added tables. This one replaces the Postgres image, so it needs about a minute of downtime and a rollback that cannot always go back.

## Implementation and review

See [recall](../recall.md) for the design and rollout.

- [db/034_embeddings.sql](../../db/034_embeddings.sql), [Dockerfile.postgres](../../Dockerfile.postgres), [src/recall.ts](../../src/recall.ts), [scripts/deploy-pgvector.py](../../scripts/deploy-pgvector.py).
- CI builds the real image and runs the Postgres smoke test against it. PGlite loads its own pgvector build for the other tests.

**Bug found by the rollout's tests (1 November):** if publishing the source failed after the migration, the rollback restored the old Compose file, which names the plain image. The next full start would then have run a database with vector columns on an image that cannot read them. A later failure left the new Compose file without the migration file it names. Now everything the new Compose file needs stays once the migration has run.

Independent review of `edd6a13` (Opus 5.5, 1 November): changes requested.

- **Indexer could stall (confirmed with a fake embedder).** One input the provider refused blocked its batch on every pass. Chunking could also cut an emoji in half, a likely trigger, though the provider's response to that is unverified. Chunks now respect emoji, a failing batch falls back to one source at a time, and a probe separates a refused source from an outage.
- **Rollback message was false (confirmed).** It said automatic releases stay refused after a post-migration failure, but the guard passes in that state. The message and doc now say what happens.
- **Digest unchecked and image inexact (confirmed).** Nothing compared the running digest, and the build upgraded musl in the final image. The script now refuses on a digest mismatch and compares version and collation across the swap. A multi-stage build keeps the upgrade out of the final image. Measured on the host on 1 November: production runs the pinned digest.
- **Also fixed:** a restored learned memory reported as not learned; memories outranking messages in the keyword list; NUL in a query; a hung query embedding holding the turn; a backup that exits 0 without a dump; and a lost reply after COMMIT choosing the wrong rollback.
- **Accepted, documented:** indexing cost is not in `provider_charges`, and `Dockerfile.postgres` is outside the release guard.

Re-review of `06fe7fe` (Opus 5.5, 1 November): changes requested. All the earlier findings were fixed, but the fixes added two faults. The identity query was invalid on Postgres 17 (`text || "char"`), and my Python stubs hid it because they never parse SQL; a TypeScript test now runs the rollout's real queries on PGlite. A new CI probe compared two lines of `psql` output with one value, so it failed; it is now two commands.

## Verification and outcome

- 1,452 TypeScript tests pass locally, and the 18 rollout tests pass.
- The image has not been built on this laptop, because Docker is not running here. Its first real build was in CI on `edd6a13` (1 November), where the Postgres smoke test passed on it. That is a fresh database, not the production volume.
- CI on `edd6a13` failed 20 script tests: `scripts/gathering-boundaries.test.mjs` applies every migration on a PGlite without `vector`. I had fixed two such tests but not this one or `evals/context/replay.ts`. Both now load it.

Final review: Opus 5.5 approved `1af0c48` on 1 November, after CI run 41272989257 passed on that head, including the final image loading pgvector and answering a distance query.

### Release closure — 2026-11-01

- PR [392](https://github.com/akhilvuputuri/chief-agent/pull/392), approved head `1af0c48`, merged as `48d22d1` with no diff from that head. The owner gave the go-ahead for the merge and rollout.
- **Measured:** `scripts/deploy-pgvector.py` exited 0 with migration 34 and `chief-postgres:17-alpine-pgvector-0.8.7`. A fresh backup was written at 06:15:28 UTC. Afterwards the server was 17.11 with pgvector 0.8.7, provider `c`, `en_US.utf8`, and the production data volume read normally.
- **Release:** the merge's release workflow failed at 06:16:51, then passed on rerun. It restarted the gateway once more, at 06:17:50. Its failure reason is not recorded here because the failed log showed only the exit code.
- **Backfill (measured):** two passes, 585 sources and 616 vectors, 1.9 MB, no skipped source.
- Downtime was not measured.

### Evaluation — 2026-11-01

See [recall](../recall.md#evaluation). As released, fusion found fewer than meaning search alone: 14 against 21 of 27 reworded questions. A message with any-word keyword hits in both lists outranked the best meaning match. Requiring all words matched meaning search on both reworded sets (21 and 13 of 16), and found all 18 word-based questions.

This corrects a design choice, not the mail evaluation: mail's keywords come from precise Gmail queries, so its result did not predict this. These are operator-written questions, so they favour meaning search and are not owner acceptance.
