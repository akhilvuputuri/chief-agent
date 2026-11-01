# 143 — Can Chief find what the owner half-remembers?

Work date: 2026-11-01. Written: 2026-11-01.
Status: tested on synthetic data and in CI; not deployed. No retrieval evaluation yet, so nothing here shows that it answers better.

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

Independent review: pending.

## Verification and outcome

- 1,452 TypeScript tests pass locally, and the 18 rollout tests pass.
- The image has not been built on this laptop, because Docker is not running here. Its first real build was in CI on `edd6a13` (1 November), where the Postgres smoke test passed on it. That is a fresh database, not the production volume.
- CI on `edd6a13` failed 20 script tests: `scripts/gathering-boundaries.test.mjs` applies every migration on a PGlite without `vector`. I had fixed two such tests but not this one or `evals/context/replay.ts`. Both now load it.
- Pending: review, CI, the owner's go-ahead for the rollout, the backfill, then the [evaluation](../recall.md#evaluation), which decides whether this stays.
