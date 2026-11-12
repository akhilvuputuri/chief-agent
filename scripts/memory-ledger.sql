-- The ledger of learned memory (docs/learning.md#the-ledger): one row for each learned item
-- in force, the most worth pruning first. Read-only: one SELECT. Keys are the owner's private
-- data; keep the output off the repo.
--
--   psql -At -F ' | ' < scripts/memory-ledger.sql
--
-- Columns: key; kind (fact, note of one occasion, dated, procedure, lesson); characters; age
-- in days; separate days it was seen on; the judge's latest verdict on it; host flags; judged
-- turns it was in the context of; how often it was relevant, followed, ignored, and acted
-- against (a claim without a quote the host could find included); how often the owner had to
-- say it again; the last day it was relevant.
-- Order: facts the judge faulted, then items Chief acted against, then items never relevant
-- in the most turns. To drop one, tell Chief to forget it, which calls memory_forget.
WITH items AS (
  SELECT r.id, r.user_id, r.key, r.kind, r.value, r.flags, r.source, r.created_at
  FROM memory_heads h
  JOIN memory_revisions r ON r.user_id=h.user_id AND r.id=h.revision_id
  WHERE r.status='active' AND (r.origin='learned'
    OR (r.origin='rollback' AND r.source->>'restoredOrigin'='learned'))),
verdicts AS (
  SELECT DISTINCT ON (data->>'revisionId') data->>'revisionId' AS revision,
    data->>'verdict' AS verdict
  FROM events WHERE type='judge.fact' ORDER BY data->>'revisionId', id DESC),
turns AS (
  SELECT DISTINCT ON (data->>'turnRunId') user_id, data, created_at FROM events
  WHERE type='judge.turn' AND data->>'state'='judged'
  ORDER BY data->>'turnRunId', id DESC),
context AS (
  SELECT c.user_id, r.key, count(*) AS in_context FROM turns t
  JOIN memory_context c ON c.run_id::text=t.data->>'turnRunId'
  CROSS JOIN LATERAL unnest(c.selected) AS s(id)
  JOIN memory_revisions r ON r.user_id=c.user_id AND r.id=s.id
  GROUP BY c.user_id, r.key),
used AS (
  SELECT t.user_id, u->>'key' AS key, count(*) AS relevant,
    count(*) FILTER (WHERE u->>'use'='followed') AS followed,
    count(*) FILTER (WHERE u->>'use'='ignored') AS ignored,
    count(*) FILTER (WHERE u->>'use'='contradicted' OR u->>'claimed'='contradicted') AS against,
    max(t.created_at)::date AS last_relevant
  FROM turns t CROSS JOIN LATERAL jsonb_array_elements(t.data->'relevant') AS u
  GROUP BY t.user_id, u->>'key'),
restated AS (
  SELECT t.user_id, r->>'key' AS key, count(*) AS times FROM turns t
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(t.data->'restated','[]'::jsonb)) AS r
  GROUP BY t.user_id, r->>'key')
SELECT 'item' AS row, i.key,
  CASE WHEN i.key LIKE 'lesson:procedure:%' THEN 'procedure'
       WHEN i.kind='lesson' THEN 'lesson'
       WHEN i.source->>'durability'='one_off' THEN 'note'
       WHEN i.source ? 'until' THEN 'dated' ELSE 'fact' END AS kind,
  length(i.value) AS chars,
  (now()::date - i.created_at::date) AS age_days,
  CASE WHEN jsonb_typeof(i.source->'seenDays')='array'
       THEN jsonb_array_length(i.source->'seenDays') ELSE 1 END AS days_seen,
  coalesce(v.verdict,'') AS verdict,
  array_to_string(i.flags,',') AS flags,
  coalesce(c.in_context,0) AS in_context,
  coalesce(u.relevant,0) AS relevant,
  coalesce(u.followed,0) AS followed,
  coalesce(u.ignored,0) AS ignored,
  coalesce(u.against,0) AS against,
  coalesce(rs.times,0) AS restated,
  coalesce(u.last_relevant::text,'') AS last_relevant
FROM items i
LEFT JOIN verdicts v ON v.revision=i.id::text
LEFT JOIN context c ON c.user_id=i.user_id AND c.key=i.key
LEFT JOIN used u ON u.user_id=i.user_id AND u.key=i.key
LEFT JOIN restated rs ON rs.user_id=i.user_id AND rs.key=i.key
ORDER BY
  CASE coalesce(v.verdict,'') WHEN 'contradicted' THEN 0 WHEN 'unsupported' THEN 1
    WHEN 'overstated' THEN 2 ELSE 3 END,
  coalesce(u.against,0) DESC,
  (coalesce(u.relevant,0)=0) DESC,
  coalesce(c.in_context,0) DESC,
  i.key;
