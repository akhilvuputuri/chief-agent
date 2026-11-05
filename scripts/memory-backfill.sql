-- Memory backfill rows (docs/tracing.md#backfilling-memory): one JSON object per memory
-- revision and per run's recorded context in [since, until), for src/memory-backfill.ts.
-- Read-only: one SELECT, no writes, no temporary tables. Set the window with psql variables
-- at the top of the input, e.g.
--   \set since '2026-09-06T00:00:00Z'
--   \set until '2026-11-05T13:39:00Z'
-- The output holds the owner's memories: keep it private.
WITH RECURSIVE
-- Each child run's parent, from the event its parent recorded when starting it.
parents AS (
  SELECT DISTINCT ON (e.run_id) e.run_id AS child, (e.data->>'parentRunId')::uuid AS parent
  FROM events e
  WHERE e.type IN ('agent.child_started', 'research.child_started')
    AND e.data->>'parentRunId' ~ '^[0-9a-f-]{36}$'
  ORDER BY e.run_id, e.id
),
-- A run's root, by following parents (at most 20 levels).
roots(run_id, root, depth) AS (
  SELECT r.id, r.id, 0 FROM runtime_runs r
  UNION ALL
  SELECT roots.run_id, p.parent, roots.depth + 1
  FROM roots JOIN parents p ON p.child = roots.root
  WHERE roots.depth < 20
),
root_of AS (
  SELECT DISTINCT ON (run_id) run_id, root FROM roots ORDER BY run_id, depth DESC
),
-- The key's first revision names the item; the owner's first revision names the store.
items AS (
  SELECT user_id, key, id AS item_id FROM memory_revisions WHERE revision = 1
),
stores AS (
  SELECT DISTINCT ON (user_id) user_id, id AS store_id
  FROM memory_revisions ORDER BY user_id, created_at, id
),
revisions AS (
  SELECT json_build_object(
    'row', 'revision',
    'user_id', r.user_id,
    'store', s.store_id,
    'item_id', i.item_id,
    'id', r.id,
    'key', r.key,
    'revision', r.revision,
    'kind', r.kind,
    'status', r.status,
    'value', r.value,
    'origin', r.origin,
    'trust', r.trust,
    'flags', r.flags,
    'source', r.source,
    'created_at', r.created_at,
    -- The run that made it, and that run's root: a learner run, or an owner's turn.
    'run_id', coalesce(r.source->>'learnerRunId', r.source->>'runId'),
    'root_run_id', ro.root
  ) AS j, r.created_at AS at
  FROM memory_revisions r
  JOIN stores s ON s.user_id = r.user_id
  JOIN items i ON i.user_id = r.user_id AND i.key = r.key
  LEFT JOIN root_of ro
    ON ro.run_id::text = coalesce(r.source->>'learnerRunId', r.source->>'runId')
  WHERE r.created_at >= :'since'::timestamptz AND r.created_at < :'until'::timestamptz
),
contexts AS (
  SELECT json_build_object(
    'row', 'context',
    'user_id', c.user_id,
    'store', s.store_id,
    'run_id', c.run_id,
    'root_run_id', coalesce(ro.root, c.run_id),
    'created_at', c.created_at,
    'omitted', cardinality(c.omitted),
    'items', coalesce((
      SELECT json_agg(json_build_object(
        'id', r.id,
        'item_id', i.item_id,
        'key', r.key,
        'revision', r.revision,
        'kind', r.kind,
        'value', r.value,
        'outcome', r.outcome,
        'domain', r.domain,
        'origin', r.origin,
        'source', r.source
      ) ORDER BY r.key)
      FROM memory_revisions r
      JOIN items i ON i.user_id = r.user_id AND i.key = r.key
      WHERE r.user_id = c.user_id AND r.id = ANY(c.selected)
    ), '[]'::json)
  ) AS j, c.created_at AS at
  FROM memory_context c
  JOIN stores s ON s.user_id = c.user_id
  LEFT JOIN root_of ro ON ro.run_id = c.run_id
  WHERE c.created_at >= :'since'::timestamptz AND c.created_at < :'until'::timestamptz
)
SELECT j FROM (SELECT j, at FROM revisions UNION ALL SELECT j, at FROM contexts) rows
ORDER BY at;
