-- What the nightly judge has found (docs/learning.md#nightly-judge). Read-only: four SELECTs.
-- Keys and the judge's reasons are the owner's private data; keep the output off the repo.
--
--   psql -At -F ' | ' < scripts/judge-report.sql

-- 1. Current learned facts by the judge's latest verdict.
WITH verdicts AS (
  SELECT DISTINCT ON (data->>'revisionId') data->>'revisionId' AS revision,
    data->>'verdict' AS verdict
  FROM events WHERE type='judge.fact' ORDER BY data->>'revisionId', id DESC)
SELECT 'facts' AS row, v.verdict, count(*) AS facts FROM verdicts v
JOIN memory_heads h ON h.revision_id::text=v.revision
GROUP BY v.verdict ORDER BY count(*) DESC, v.verdict;

-- 2. The current learned facts the judge did not find supported, with its reason.
WITH verdicts AS (
  SELECT DISTINCT ON (data->>'revisionId') data->>'revisionId' AS revision,
    data->>'key' AS key, data->>'verdict' AS verdict, data->>'reason' AS reason
  FROM events WHERE type='judge.fact' ORDER BY data->>'revisionId', id DESC)
SELECT 'fact' AS row, v.key, v.verdict, v.reason FROM verdicts v
JOIN memory_heads h ON h.revision_id::text=v.revision
WHERE v.verdict<>'supported' ORDER BY v.verdict, v.key;

-- 3. Each memory key: judged turns it was in the context of, how often it was relevant,
-- and how it was used then. A key never relevant is a candidate for pruning, or for leaving
-- out of turns it does not concern.
WITH turns AS (
  SELECT DISTINCT ON (data->>'turnRunId') data FROM events
  WHERE type='judge.turn' AND data->>'state'='judged'
  ORDER BY data->>'turnRunId', id DESC),
context AS (
  SELECT r.key, count(*) AS in_context FROM turns t
  JOIN memory_context c ON c.run_id::text=t.data->>'turnRunId'
  CROSS JOIN LATERAL unnest(c.selected) AS s(id)
  JOIN memory_revisions r ON r.user_id=c.user_id AND r.id=s.id GROUP BY r.key),
used AS (
  SELECT u->>'key' AS key, count(*) AS relevant,
    count(*) FILTER (WHERE u->>'use'='followed') AS followed,
    count(*) FILTER (WHERE u->>'use'='ignored') AS ignored,
    count(*) FILTER (WHERE u->>'use'='contradicted') AS contradicted,
    count(*) FILTER (WHERE u->>'use'='unclear') AS unclear
  FROM turns t CROSS JOIN LATERAL jsonb_array_elements(t.data->'relevant') AS u
  GROUP BY u->>'key')
SELECT 'use' AS row, c.key, c.in_context, coalesce(u.relevant,0) AS relevant,
  coalesce(u.followed,0) AS followed, coalesce(u.ignored,0) AS ignored,
  coalesce(u.contradicted,0) AS contradicted, coalesce(u.unclear,0) AS unclear
FROM context c LEFT JOIN used u ON u.key=c.key
ORDER BY coalesce(u.relevant,0) DESC, c.key;

-- 4. Judge runs, newest first: state, counts and how far each has read.
SELECT 'run' AS row, started_at, state, summary FROM learner_runs
WHERE prompt_version LIKE 'judge-%' ORDER BY started_at DESC LIMIT 14;
