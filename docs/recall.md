# Recall over conversations and memories

Status (1 November 2026): built and tested on synthetic data, not deployed. It needs the operator rollout below. Whether it stays depends on the evaluation below. Step 2 of [issue 326](https://github.com/akhilvuputuri/chief-agent/issues/326); see [journal 143](journey/143-recall-with-pgvector.md).

## What it does

Chief gets one more read-only tool, `memory_recall(query, limit?)`, for what the owner half-remembers ("that thing about the lease"). It searches past messages and current memories by meaning and by keyword, and returns up to eight results by default and 20 at most. Each result gives its source, an excerpt or the memory's value, and `meaningRank` and `keywordRank`.

Chief decides when to call it. Nothing is added to the prompt automatically, so ordinary turns cost the same. `conversation_search` stays for exact words and `conversation_read` still returns the full text.

## How it works

- **Store.** `embeddings` in the same Postgres ([migration 034](../db/034_embeddings.sql)), with pgvector. Vectors are 512 dimensions from `text-embedding-3-small` through OpenRouter, the model mail recall already uses.
- **Indexing.** Every 60 seconds, a background pass embeds up to five batches of 64 inputs for each allowed owner: active memories, then messages newest first, so today's messages are searchable before the backlog is done. It uses the same filter as `conversation_search`, so tool output, internal worker messages and blank messages stay out. A message is split into chunks of 1,500 characters with 200 of overlap, six at most, so only about the first 8,000 characters of a very long message are indexed by meaning. Keyword search still covers all of it.
- **Search.** Exact cosine distance gives up to 30 candidates. Postgres full-text search gives up to 30 from messages and 30 from memories, and any word may match. Reciprocal rank fusion (k = 60) combines the lists, as in [mail recall](mail-recall.md).
- **Source of truth.** Vectors are only an index. Every result is read again from its source row. A retired or replaced memory and an excluded message cannot come back, even while its old vector exists.
- **Failure.** If embedding fails or takes over 10 seconds, search still answers by keyword and says `keyword_only`. If an indexing batch fails, each source is tried alone. A source the provider refuses while a probe succeeds is skipped and logged as `recall.source_skipped`, and retried after a restart. If the probe also fails, it is an outage: the pass ends and the next one retries.
- **Cost.** Indexing is not in `provider_charges`, like the mail index build, because it runs outside any turn's ledger. A query's embedding is charged to its turn.
- **No HNSW index yet.** Exact search reads every vector, which is fine at a few thousand rows. Add an index only when a measured search is too slow.

`RECALL_INDEX=off` stops the background pass. Search keeps working with what is already indexed.

## Privacy and retention

Every indexed message and memory is sent to the embedding provider through OpenRouter, including text Chief never reads again. See [security](security.md). `/reset` does not remove vectors, just as it does not remove the immutable messages they point to. Deleting an owner removes that owner's vectors. `recall.searched` events and logs hold counts, never the query or the results. Like every tool call, the call record keeps its arguments and result, and traces include them when content capture is on ([security](security.md)).

## Rollout

[scripts/deploy-pgvector.py](../scripts/deploy-pgvector.py) is a reviewed one-time rollout. Earlier migrations only added tables, but this one replaces the Postgres image, so the gateway and the database restart. It is run by the operator after merge, with the owner's go-ahead.

[Dockerfile.postgres](../Dockerfile.postgres) compiles pgvector 0.8.7 in a build stage, with the source checksum pinned, and copies only its files onto the exact `postgres:17-alpine` digest production runs (`sha256:b0f9560a…`, read from the host on 1 November). The compiler's package upgrades stay in the build stage, so the final image has the same binaries, libc and collation. The data volume stays. Changing this file needs a new image tag in `compose.yaml` and an operator rollout. The release guard covers `compose.yaml` and `db/` but not this file, so nothing else catches it.

The script checks that the source differs from the baseline only as reviewed, refuses unless the running Postgres is the digest the image is built on, builds both images, and refuses to start while work is active. It then takes a fresh backup with `hermes-backup.service` and checks that a new dump exists, stops the gateway, swaps the image, checks that the version and collation are unchanged, applies the migration, proves a vector distance query, starts the new gateway, and publishes the source.

Rollback depends on how far it got:

- **Before the migration:** plain image, old Compose file and old gateway all come back. Nothing is retained.
- **After the migration:** the old gateway comes back on the pgvector image, because the plain image cannot read vector columns. The new Compose file, `Dockerfile.postgres` and the migration file stay, so a full Compose start still works. The old gateway ignores the new table. The script cannot run again. The release guard now passes, so automatic releases are no longer refused, and a release of this commit deploys the same candidate with its own rollback. Find the cause first; a merged fix or a rerun of the release finishes the rollout.
- **If the rollback itself fails:** it stops and asks for operator inspection, and the fresh backup exists. It never reverses the database or replays tasks.

A restore or a host move must use this image, or the dump's `CREATE EXTENSION` fails. `docker compose up` builds it from the checked-in Dockerfile.

## Host checks

```sql
-- Backfill: sources indexed so far, and the size of the index.
SELECT source_type, count(DISTINCT source_id) AS sources, count(*) AS chunks,
       pg_size_pretty(pg_total_relation_size('embeddings')) AS size
FROM embeddings WHERE user_id = '<owner>' GROUP BY 1;
-- Searches: which mode each used, and what each search found.
SELECT data->>'mode', count(*), avg((data->>'resultCount')::int)
FROM events WHERE type = 'recall.searched' GROUP BY 1;
```

## Evaluation

Not run yet, and it decides whether this stays. After the backfill, take real-style questions whose answers are in past conversations. Compare what today's `conversation_search` finds against `memory_recall`. If meaning search adds little over keywords, remove the tool, the table and the image. Also watch how often Chief actually calls it, because a tool it never calls helps nothing.
