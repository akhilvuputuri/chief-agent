# Recall over conversations and memories

Status (1 November 2026): live in `48d22d1`, indexed in two passes (571 messages, 14 memories, 1.9 MB, nothing skipped). The fusion fix from the first evaluation is live in `40e9a6f`. That evaluation favours keeping it. Chief's real use is not measured yet. Step 2 of [issue 326](https://github.com/akhilvuputuri/chief-agent/issues/326); see [journal 143](journey/143-recall-with-pgvector.md).

## What it does

Chief gets one more read-only tool, `memory_recall(query, limit?)`, for what the owner half-remembers ("that thing about the lease"). It searches past messages and current memories by meaning and by keyword, and returns up to eight results by default and 20 at most. Each result gives its source, an excerpt or the memory's value, and `meaningRank` and `keywordRank`.

Chief decides when to call it. Nothing is added to the prompt automatically, so ordinary turns cost the same. `conversation_search` stays for exact words and `conversation_read` still returns the full text.

## How it works

- **Store.** `embeddings` in the same Postgres ([migration 034](../db/034_embeddings.sql)), with pgvector. Vectors are 512 dimensions from `text-embedding-3-small` through OpenRouter, the model mail recall already uses.
- **Indexing.** Every 60 seconds, a background pass embeds up to five batches of 64 inputs for each allowed owner: active memories, then messages newest first, so today's messages are searchable before the backlog is done. It uses the same filter as `conversation_search`, so tool output, internal worker messages and blank messages stay out. A message is split into chunks of 1,500 characters with 200 of overlap, six at most, so only about the first 8,000 characters of a very long message are indexed by meaning. Keyword search still covers all of it.
- **Search.** Exact cosine distance gives up to 30 candidates. Postgres full-text search gives up to 30 from messages and 30 from memories, and all the words must match. If there is no embedding to fuse with, any word may match. Reciprocal rank fusion (k = 60) combines the lists, as in [mail recall](mail-recall.md).
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

Measured on 1 November 2026 against production's index, read-only, with `text-embedding-3-small`. Each question targets one real message, and a hit means it appears in the top 8. The questions and targets stay private.

| Question set                       | `conversation_search` | Keywords, any word | Meaning only | As released | All words must match |
| ---------------------------------- | --------------------- | ------------------ | ------------ | ----------- | -------------------- |
| Reworded (27)                      | 0                     | 5                  | 21           | 14          | 21                   |
| Reworded, second sample (16)       | 0                     | 4                  | 13           | 9           | 13                   |
| Using the message's own words (18) | 15                    | 15                 | 17           | 17          | 18                   |

- **What it suggests.** Meaning search finds what today's search misses when the wording differs, and costs nothing when it matches.
- **The fault.** As released in `48d22d1`, any-word keywords lowered results. A message appearing in both lists, even low in each, scored above the top meaning match alone. With all words required, results matched meaning search on the reworded sets, without beating it, and found all 18 word-based questions. The first run of that column came from a test variant. Re-running the same 61 questions through the live `40e9a6f` code gave the same 21, 13 and 18.
- **Limits.** The operator wrote these questions after reading the target messages, so they are not the owner's own. The reworded sets deliberately avoid the message's words, so `conversation_search`, which needs every word, scores close to zero by design and the gap is overstated. The fix was chosen after seeing the fault, on these same questions. The variants were compared on all three sets in one run, so "second sample" is a separate sample and not a blind test of the fix. It is 61 questions with one acceptable target each.
- **Not measured.** Precision and questions with no answer: every question here has one, and meaning search returns its nearest results even when nothing is relevant, so the noise Chief reads is unknown. Also whether Chief calls the tool when it should, and whether answers improve. Check how often `recall.searched` appears over the coming weeks. If Chief rarely calls it, fix that or remove the tool.

Median search time on `40e9a6f` was about 1.2 seconds (61 questions, slowest 2.1 seconds). The embedding call was not timed separately. Search covered 585 sources, with exact search.
