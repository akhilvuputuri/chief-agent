-- What the nightly judge has found (docs/learning.md#nightly-judge). Read-only: eight SELECTs.
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

-- 5. The judge checked against planted errors, last 30 days: copies of supported facts the
-- host broke in a known way. "caught" is a verdict other than supported; for the unchanged
-- control copies it is a false alarm.
SELECT 'probe' AS row, data->>'mutation' AS mutation, count(*) AS probes,
  count(*) FILTER (WHERE data->>'verdict' NOT IN ('supported','missed')) AS caught,
  count(*) FILTER (WHERE data->>'verdict'='missed') AS missed
FROM events WHERE type='judge.probe' AND created_at>now()-interval '30 days'
GROUP BY data->>'mutation' ORDER BY data->>'mutation';

-- 6. Planted decoy memories, last 30 days: judged turns that carried one, and how many times
-- the judge called it relevant.
SELECT 'decoy' AS row, count(*) AS turns,
  count(*) FILTER (WHERE (data->>'decoyHit')::boolean) AS called_relevant
FROM events WHERE type='judge.turn' AND data->>'state'='judged'
  AND created_at>now()-interval '30 days';

-- 7. Verdicts judged again, last 30 days: how often the same model repeated its first
-- verdict (a repeat that gave no verdict is "missed" and is not stable), and how often the
-- second model, which reads facts only, agreed with it.
SELECT 'check' AS row, data->>'kind' AS kind, count(*) AS checked,
  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(data->'repeats') r
    WHERE r<>data->>'first')) AS stable,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(data->'repeats') r
    WHERE r='missed')) AS repeat_missed,
  count(*) FILTER (WHERE data ? 'second' AND data->>'second'<>'missed') AS cross_checked,
  count(*) FILTER (WHERE data->>'second'=data->>'first') AS agreed
FROM events WHERE type='judge.check' AND created_at>now()-interval '30 days'
GROUP BY data->>'kind' ORDER BY data->>'kind';

-- 8. What the owner had to say again, by memory key.
SELECT 'restated' AS row, r->>'key' AS key, count(*) AS times
FROM events e CROSS JOIN LATERAL jsonb_array_elements(e.data->'restated') AS r
WHERE e.type='judge.turn' GROUP BY r->>'key' ORDER BY count(*) DESC, r->>'key';
