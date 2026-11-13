-- Where one coding job's time and money went, on the one-session loop (journals 190 to 193;
-- journal 194 describes this script). Old-loop jobs (planner, leader role, OpenAI-shaped call
-- records, host check stage, repair sessions) are not supported: the script says so in one
-- line and stops instead of printing wrong numbers.
--
-- Read-only: SELECTs inside a read-only transaction with short timeouts, filtered on the job
-- id only, no dynamic SQL. It prints counts, token sums, costs, durations and known names:
-- roles, call purposes, Pi's tool names, a coarse class of each bash command, review verdicts,
-- inbox sources, pause causes, hash prefixes and a PR number. Anything else in those places is
-- shown as "(other)". It never prints prompts, message text, thinking, tool arguments, owner
-- messages, file contents, secrets or the environment.
--
--   ssh HOST 'sudo docker exec -i hermes-companion-postgres-1 sh -c "psql -X -v job=<prefix> -U \$POSTGRES_USER -d \$POSTGRES_DB"' < scripts/coding-job-profile.sql
--
-- `job` is a job id or a prefix of one that matches exactly one job. Times are minutes since
-- coding_start ("at_min"). Attempts (one per box) are numbered by their first activity.
\set ON_ERROR_STOP on
\pset pager off
\pset footer off
\pset null '-'
\if :{?job}
\else
\echo 'Usage: psql -v job=<job id or prefix> ... < scripts/coding-job-profile.sql'
\quit
\endif
BEGIN READ ONLY;
-- coding_model_calls has no job_id index: give up rather than hold up a migration.
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';
SELECT count(*) = 1 AS profile_found, count(*) = 0 AS profile_none, min(id::text) AS profile_job FROM coding_jobs
  WHERE :'job' ~ '^[0-9a-f-]{4,36}$' AND id::text LIKE :'job' || '%' \gset
\if :profile_found
\elif :profile_none
\echo 'No coding job matches that id prefix.'
ROLLBACK;
\quit
\else
\echo 'Several coding jobs match that id prefix; give a longer one.'
ROLLBACK;
\quit
\endif
-- The one-session loop records every model call through the Pi Messages route with the
-- request's shape (journal 192); the old loop's calls have none, or a leader role.
SELECT (j.settings->>'runtime' IS DISTINCT FROM 'pi' OR EXISTS(SELECT 1 FROM coding_model_calls c
    WHERE c.job_id = j.id AND (c.role NOT IN ('coder', 'reviewer') OR NOT c.input ? 'shape'))) AS profile_old
  FROM coding_jobs j WHERE j.id = :'profile_job'::uuid \gset
\if :profile_old
\echo 'This job was recorded by the old coding loop (planner, OpenAI-shaped calls or host checks); this script reads only the one-session loop. Use the journal 172 draft for it.'
ROLLBACK;
\quit
\endif

\echo
\echo 'Approximate (what the host does not record exactly): a run''s duration and cost (usage records carry no call id, so they are matched to runs by time);'
\echo 'write_1h (from stored responses, so a billed call that did not finish is missing); thinking share (only where Anthropic reported thinking tokens);'
\echo 'an inbox item''s first_seen (the first request carrying it, not a recorded delivery); "no change" for an earlier attempt (from the worker''s summary).'
\echo 'Exact: tokens, cost, machine time, owner waits, and the end causes the host records (lifetime, eight hours, crash and retry, ask, PR).'
\echo
\echo '1. Summary: wall time to the end (or now), owner waits, machine time from boxes, loop counts'
\x on
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
starts AS (
  SELECT v.created_at FROM coding_revisions v, j WHERE v.job_id = j.id
    AND v.request_key IN (SELECT e.id::text FROM coding_events e WHERE e.job_id = j.id AND e.payload->>'decision' = 'approved')),
act AS (
  SELECT created_at FROM coding_events WHERE job_id = :'profile_job'::uuid
  UNION ALL SELECT created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid),
stops AS (
  SELECT DISTINCT ON (split_part(e.event_key, ':', 1)) split_part(e.event_key, ':', 1) AS attempt, e.created_at AS at
  FROM coding_events e WHERE e.job_id = :'profile_job'::uuid AND e.event_key ~ '^[0-9a-f-]{36}:(paused|finished)$'
    AND NOT EXISTS(SELECT 1 FROM coding_events p WHERE p.job_id = e.job_id AND p.event_key = split_part(e.event_key, ':', 1) || ':publish-approved')
  ORDER BY split_part(e.event_key, ':', 1), e.created_at),
waits AS (
  SELECT s.*, n.created_at AS next_at, n.request_key AS next_key FROM stops s
  LEFT JOIN LATERAL (SELECT v.created_at, v.request_key FROM coding_revisions v
    WHERE v.job_id = :'profile_job'::uuid AND v.created_at > s.at ORDER BY v.created_at LIMIT 1) n ON true),
owner_waits AS (
  SELECT coalesce(w.next_at, CASE WHEN j.state IN ('awaiting_input', 'paused', 'failed') AND j.attempt_id::text = w.attempt THEN now() END) - w.at AS waited
  FROM waits w, j
  WHERE w.next_key IS NULL OR NOT (w.next_key LIKE ANY (ARRAY['auto-retry:%', 'continue-box:%', 'mr-feedback:%', 'rebase:%']))),
boxes_used AS (
  SELECT b.created_at, b.running_ms + CASE WHEN b.running_since IS NULL THEN 0
      ELSE GREATEST(0, (extract(epoch FROM now() - b.running_since) * 1000)::bigint) END AS ms
  FROM boxes b WHERE b.subject = 'coding:' || :'profile_job'),
-- The eight hours count from the owner's latest Start, resume, reply or PR fix request
-- (journal 193, CodingController.machineMs).
since_owner AS (
  SELECT GREATEST(
    coalesce((SELECT max(v.created_at) FROM coding_revisions v WHERE v.job_id = :'profile_job'::uuid
      AND NOT (v.request_key LIKE ANY (ARRAY['auto-retry:%', 'continue-box:%', 'mr-feedback:%', 'rebase:%']))), '-infinity'::timestamptz),
    coalesce((SELECT max(e.created_at) FROM coding_events e WHERE e.job_id = :'profile_job'::uuid
      AND (e.event_key LIKE 'owner-feedback:%' OR e.event_key LIKE 'continue:%' OR (e.event_key LIKE 'inbox:%' AND e.payload ? 'heldBy'))), '-infinity'::timestamptz)) AS at),
ended AS (
  SELECT CASE WHEN j.state = 'cancelled' THEN coalesce((SELECT min(created_at) FROM coding_events WHERE job_id = j.id AND event_key = 'cancelled'), j.updated_at)
    WHEN j.state = 'pr_ready' AND j.stage IN ('merged_on_github', 'closed_on_github', 'deployed') THEN j.updated_at END AS at FROM j),
calls AS (
  SELECT role, coalesce(input->>'purpose', 'agent') AS purpose, result, created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid),
segs AS (
  SELECT role, attempt_id, lag(role) OVER w AS prev_role, lag(attempt_id) OVER w AS prev_attempt
  FROM coding_model_calls WHERE job_id = :'profile_job'::uuid WINDOW w AS (ORDER BY created_at, id)),
-- A rebase item reaches the coder only when git left conflicts (journal 193); a clean rebase
-- goes straight to review.
rebase_items AS (
  SELECT EXISTS(SELECT 1 FROM coding_model_calls c WHERE c.job_id = e.job_id AND c.role = 'coder' AND c.created_at >= e.created_at
    AND strpos(coalesce((c.input->'request'->'messages'->-1)::text, '') || coalesce((c.input->'request'->'messages'->-2)::text, '')
      || coalesce((c.input->'request'->'messages'->-3)::text, '') || coalesce((c.input->'request'->'messages'->-4)::text, ''),
      '[inbox:' || e.id::text || ' ') > 0) AS coder_saw
  FROM coding_events e WHERE e.job_id = :'profile_job'::uuid AND e.event_key LIKE 'inbox:rebase:%'),
verdicts AS (
  SELECT b->'input'->>'verdict' AS verdict FROM calls c,
    jsonb_array_elements(CASE WHEN jsonb_typeof(c.result->'content') = 'array' THEN c.result->'content' ELSE '[]' END) b
  WHERE c.role = 'reviewer' AND c.purpose = 'agent' AND b->>'type' = 'tool_use' AND b->>'name' = 'report' AND b->'input'->>'kind' = 'review')
SELECT left(j.id::text, 8) AS job, j.state, j.stage, j.revision,
  j.settings->>'model' AS coder_model, j.settings->>'reviewerModel' AS reviewer_model, j.settings->>'effort' AS effort,
  to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS coding_start_utc,
  round(extract(epoch FROM (SELECT min(created_at) FROM starts) - j.created_at) / 60, 1) AS start_at_min,
  (SELECT at FROM ended) IS NOT NULL AS ended,
  round(extract(epoch FROM coalesce((SELECT at FROM ended), now()) - j.created_at) / 60, 1) AS wall_min,
  round(extract(epoch FROM (SELECT max(created_at) FROM act) - j.created_at) / 60, 1) AS last_activity_min,
  round(extract(epoch FROM coalesce((SELECT min(created_at) FROM starts), CASE WHEN j.mode = 'plan' THEN now() END) - j.created_at) / 60, 1) AS waiting_before_start_min,
  round(extract(epoch FROM coalesce((SELECT sum(waited) FROM owner_waits), interval '0')) / 60, 1) AS waiting_at_asks_and_pauses_min,
  round(coalesce((SELECT sum(ms) FROM boxes_used), 0) / 60000.0, 1) AS machine_min,
  round(coalesce((SELECT sum(ms) FROM boxes_used, since_owner WHERE boxes_used.created_at >= since_owner.at), 0) / 60000.0, 1) AS machine_since_owner_min,
  -- JOB_MACHINE_MS in src/coding/controller.ts: eight hours from the owner's latest Start or resume.
  round(GREATEST(0, 28800000 - coalesce((SELECT sum(ms) FROM boxes_used, since_owner WHERE boxes_used.created_at >= since_owner.at), 0)) / 60000.0, 1) AS machine_left_of_eight_hours_min,
  (SELECT count(*) FROM coding_events WHERE job_id = j.id AND event_key LIKE 'machine-time:%') AS eight_hour_pauses,
  (SELECT count(*) FROM boxes_used) AS boxes,
  (SELECT count(DISTINCT a) FROM (SELECT attempt_id::text AS a FROM coding_model_calls WHERE job_id = j.id
    UNION ALL SELECT split_part(event_key, ':', 1) FROM coding_events WHERE job_id = j.id AND event_key ~ '^[0-9a-f-]{36}:') x) AS attempts,
  (SELECT count(*) FROM segs WHERE role = 'coder' AND (prev_role IS DISTINCT FROM role OR prev_attempt IS DISTINCT FROM attempt_id)) AS coder_runs,
  (SELECT count(*) FROM segs WHERE role = 'reviewer' AND (prev_role IS DISTINCT FROM role OR prev_attempt IS DISTINCT FROM attempt_id)) AS review_rounds,
  (SELECT count(*) FROM verdicts WHERE verdict = 'REQUEST_CHANGES') AS findings_reports,
  (SELECT count(*) FROM verdicts WHERE verdict = 'APPROVE') AS approvals,
  (SELECT count(*) FROM coding_revisions WHERE job_id = j.id AND request_key LIKE 'rebase:%') AS rebases,
  (SELECT count(*) FROM rebase_items r WHERE r.coder_saw) AS conflicting_rebases,
  (SELECT count(*) FROM coding_revisions WHERE job_id = j.id AND request_key LIKE 'mr-feedback:%') AS pr_feedback_rounds,
  j.pr_url IS NOT NULL AS has_pr,
  substring(j.pr_url FROM '/pull/([0-9]{1,9})$') AS pr_number
FROM j;
\x off

\echo '1b. Waiting on the owner: before Start, and at each ask or pause (resumed_by automatic is host time, not owner time)'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
starts AS (
  SELECT min(v.created_at) AS at FROM coding_revisions v, j WHERE v.job_id = j.id
    AND v.request_key IN (SELECT e.id::text FROM coding_events e WHERE e.job_id = j.id AND e.payload->>'decision' = 'approved')),
stops AS (
  SELECT DISTINCT ON (split_part(e.event_key, ':', 1)) split_part(e.event_key, ':', 1) AS attempt, e.created_at AS at,
    CASE WHEN EXISTS(SELECT 1 FROM coding_events m WHERE m.job_id = e.job_id AND m.event_key = 'machine-time:' || split_part(e.event_key, ':', 1)) THEN 'eight-hour pause'
      WHEN e.payload->>'cause' = 'lifetime' THEN 'box lifetime'
      WHEN e.payload->>'cause' IN ('sandbox_stopped', 'heartbeat_lost') THEN 'crash'
      WHEN coalesce(e.payload->>'question', '') <> '' THEN 'ask'
      WHEN e.payload->>'summary' LIKE 'Nothing needed changing.%' OR e.payload->>'summary' LIKE 'Main already contains this change%'
        OR (j0.attempt_id::text = split_part(e.event_key, ':', 1) AND j0.result->>'kind' = 'no_change') THEN 'no change'
      ELSE 'pause' END AS kind
  FROM coding_events e JOIN coding_jobs j0 ON j0.id = e.job_id
  WHERE e.job_id = :'profile_job'::uuid AND e.event_key ~ '^[0-9a-f-]{36}:(paused|finished)$'
    AND NOT EXISTS(SELECT 1 FROM coding_events p WHERE p.job_id = e.job_id AND p.event_key = split_part(e.event_key, ':', 1) || ':publish-approved')
  ORDER BY split_part(e.event_key, ':', 1), e.created_at),
rows AS (
  SELECT 'before Start' AS wait, j.created_at AS from_at,
    coalesce((SELECT at FROM starts), CASE WHEN j.mode = 'plan' THEN now() END) AS to_at,
    CASE WHEN (SELECT at FROM starts) IS NULL THEN '(still waiting)' ELSE 'owner' END AS resumed_by
  FROM j
  UNION ALL
  SELECT s.kind, s.at, coalesce(n.created_at, CASE WHEN j.state IN ('awaiting_input', 'paused', 'failed') AND j.attempt_id::text = s.attempt THEN now() END),
    CASE WHEN n.request_key IS NULL THEN CASE WHEN j.state IN ('awaiting_input', 'paused', 'failed') AND j.attempt_id::text = s.attempt THEN '(still waiting)' ELSE '(not resumed)' END
      WHEN n.request_key LIKE ANY (ARRAY['auto-retry:%', 'continue-box:%', 'mr-feedback:%', 'rebase:%']) THEN 'automatic'
      ELSE 'owner' END
  FROM stops s CROSS JOIN j
  LEFT JOIN LATERAL (SELECT v.created_at, v.request_key FROM coding_revisions v
    WHERE v.job_id = j.id AND v.created_at > s.at ORDER BY v.created_at LIMIT 1) n ON true)
SELECT r.wait, round(extract(epoch FROM r.from_at - j.created_at) / 60, 1) AS from_min,
  round(extract(epoch FROM r.to_at - j.created_at) / 60, 1) AS to_min,
  round(extract(epoch FROM r.to_at - r.from_at) / 60, 1) AS minutes, r.resumed_by
FROM rows r CROSS JOIN j ORDER BY r.from_at;

\echo '1c. Attempts (one per box): when, machine time, model calls and why each ended'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
box AS (
  SELECT substr(b.request_key, 8) AS attempt, b.state, b.created_at,
    b.running_ms + CASE WHEN b.running_since IS NULL THEN 0 ELSE GREATEST(0, (extract(epoch FROM now() - b.running_since) * 1000)::bigint) END AS ms
  FROM boxes b WHERE b.subject = 'coding:' || :'profile_job' AND b.request_key ~ '^coding:[0-9a-f-]{36}$'),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(t)) AS n, min(t) AS started, max(t) AS last_activity FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at AS t FROM coding_events
      WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt_id::text, created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid
    UNION ALL SELECT attempt, created_at FROM box) a GROUP BY attempt),
e AS (SELECT event_key, payload FROM coding_events WHERE job_id = :'profile_job'::uuid),
v AS (SELECT request_key FROM coding_revisions WHERE job_id = :'profile_job'::uuid)
SELECT a.n || ' ' || left(a.attempt, 8) AS attempt, coalesce(box.state, '(no box row)') AS box,
  round(extract(epoch FROM a.started - j.created_at) / 60, 1) AS start_min,
  round(extract(epoch FROM a.last_activity - a.started) / 60, 1) AS wall_min,
  round(box.ms / 60000.0, 1) AS machine_min,
  (SELECT count(*) FROM coding_model_calls c WHERE c.job_id = j.id AND c.attempt_id::text = a.attempt AND c.role = 'coder') AS coder_calls,
  (SELECT count(*) FROM coding_model_calls c WHERE c.job_id = j.id AND c.attempt_id::text = a.attempt AND c.role = 'reviewer') AS reviewer_calls,
  CASE WHEN EXISTS(SELECT 1 FROM e WHERE event_key = a.attempt || ':pr') THEN 'done (PR opened)'
    WHEN EXISTS(SELECT 1 FROM e WHERE event_key = a.attempt || ':publish-approved') THEN 'publishing'
    WHEN EXISTS(SELECT 1 FROM e WHERE event_key = 'machine-time:' || a.attempt) THEN 'eight-hour pause'
    WHEN EXISTS(SELECT 1 FROM e WHERE event_key IN (a.attempt || ':paused', a.attempt || ':finished') AND payload->>'cause' = 'lifetime')
      THEN CASE WHEN EXISTS(SELECT 1 FROM v WHERE request_key = 'continue-box:' || a.attempt) THEN 'box lifetime, continued'
        WHEN EXISTS(SELECT 1 FROM e WHERE event_key = 'box-stuck:' || a.attempt) THEN 'box lifetime, box did not shut down'
        ELSE 'box lifetime' END
    WHEN EXISTS(SELECT 1 FROM v WHERE request_key = 'auto-retry:' || a.attempt) THEN 'crash, retried once'
    WHEN EXISTS(SELECT 1 FROM e WHERE event_key = a.attempt || ':paused' AND payload->>'cause' IN ('sandbox_stopped', 'heartbeat_lost')) THEN 'crash'
    WHEN EXISTS(SELECT 1 FROM e WHERE event_key = a.attempt || ':finished' AND coalesce(payload->>'question', '') <> '') THEN 'ask'
    WHEN j.attempt_id::text = a.attempt AND j.result->>'kind' = 'no_change' THEN 'no change'
    WHEN EXISTS(SELECT 1 FROM e WHERE event_key = a.attempt || ':finished' AND (payload->>'summary' LIKE 'Nothing needed changing.%'
      OR payload->>'summary' LIKE 'Main already contains this change%')) THEN 'no change (from its summary)'
    WHEN EXISTS(SELECT 1 FROM e WHERE event_key IN (a.attempt || ':paused', a.attempt || ':finished')) THEN 'paused'
    WHEN j.attempt_id::text = a.attempt AND j.state IN ('provisioning', 'running', 'publishing') THEN '(running)'
    WHEN j.state = 'cancelled' AND j.attempt_id::text = a.attempt THEN 'cancelled'
    ELSE '(no end recorded)' END AS ended
FROM att a CROSS JOIN j LEFT JOIN box USING (attempt) ORDER BY a.n;

\echo '2. Cost and tokens by role and purpose (from model_usage records; write_1h from the stored responses of completed calls)'
WITH u AS (
  SELECT CASE WHEN payload->>'role' IN ('coder', 'reviewer') THEN payload->>'role' ELSE '(other)' END AS role,
    CASE WHEN coalesce(payload->>'purpose', 'agent') IN ('agent', 'compaction', 'cache_warm') THEN coalesce(payload->>'purpose', 'agent') ELSE '(other)' END AS purpose,
    1 AS calls, CASE WHEN payload->>'incomplete' = 'true' THEN 1 ELSE 0 END AS incomplete,
    CASE WHEN jsonb_typeof(payload->'usage'->'prompt_tokens') = 'number' THEN (payload->'usage'->>'prompt_tokens')::numeric ELSE 0 END AS prompt,
    CASE WHEN jsonb_typeof(payload->'usage'->'prompt_tokens_details'->'cached_tokens') = 'number' THEN (payload->'usage'->'prompt_tokens_details'->>'cached_tokens')::numeric ELSE 0 END AS cache_read,
    CASE WHEN jsonb_typeof(payload->'usage'->'prompt_tokens_details'->'cache_write_tokens') = 'number' THEN (payload->'usage'->'prompt_tokens_details'->>'cache_write_tokens')::numeric ELSE 0 END AS cache_write,
    0::numeric AS write_1h,
    CASE WHEN jsonb_typeof(payload->'usage'->'completion_tokens') = 'number' THEN (payload->'usage'->>'completion_tokens')::numeric ELSE 0 END AS output,
    CASE WHEN jsonb_typeof(payload->'usage'->'completion_tokens_details'->'reasoning_tokens') = 'number' THEN (payload->'usage'->'completion_tokens_details'->>'reasoning_tokens')::numeric END AS thinking,
    CASE WHEN jsonb_typeof(payload->'usage'->'cost') = 'number' THEN (payload->'usage'->>'cost')::numeric ELSE 0 END AS cost,
    CASE WHEN jsonb_typeof(payload->'usage'->'thinking_dropped') = 'number' THEN (payload->'usage'->>'thinking_dropped')::numeric ELSE 0 END AS dropped
  FROM coding_events WHERE job_id = :'profile_job'::uuid AND payload->>'kind' = 'model_usage'),
w AS (
  SELECT CASE WHEN role IN ('coder', 'reviewer') THEN role ELSE '(other)' END,
    CASE WHEN coalesce(input->>'purpose', 'agent') IN ('agent', 'compaction', 'cache_warm') THEN coalesce(input->>'purpose', 'agent') ELSE '(other)' END,
    0, 0, 0::numeric, 0::numeric, 0::numeric,
    CASE WHEN jsonb_typeof(result->'usage'->'cache_creation'->'ephemeral_1h_input_tokens') = 'number'
      THEN (result->'usage'->'cache_creation'->>'ephemeral_1h_input_tokens')::numeric ELSE 0 END,
    0::numeric, NULL::numeric, 0::numeric, 0::numeric
  FROM coding_model_calls WHERE job_id = :'profile_job'::uuid AND state = 'complete'),
r AS (SELECT * FROM u UNION ALL SELECT * FROM w)
SELECT CASE WHEN GROUPING(role) = 1 THEN 'total' ELSE role END AS role,
  CASE WHEN GROUPING(purpose) = 1 THEN '' ELSE purpose END AS purpose,
  sum(calls) AS calls, sum(incomplete) AS incomplete,
  sum(prompt - cache_read - cache_write) AS input, sum(cache_read) AS cache_read, sum(cache_write) AS cache_write,
  sum(write_1h) AS write_1h, sum(output) AS output, sum(thinking) AS thinking,
  round(100 * sum(thinking) / nullif(sum(output) FILTER (WHERE thinking IS NOT NULL), 0), 1) AS thinking_pct,
  round(sum(cost), 4) AS cost_usd, sum(dropped) AS thinking_dropped
FROM r GROUP BY GROUPING SETS ((role, purpose), ()) ORDER BY GROUPING(role), role, purpose;

\echo '3. The loop: each coder run and review round in order (a run is consecutive calls of one role in one box)'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
c AS (
  SELECT id, attempt_id::text AS attempt, role, coalesce(input->>'purpose', 'agent') AS purpose, state, result,
    CASE WHEN input->>'candidate' ~ '^[a-f0-9]{64}$' THEN input->>'candidate' END AS candidate, created_at,
    lag(role) OVER w AS prev_role, lag(attempt_id::text) OVER w AS prev_attempt
  FROM coding_model_calls WHERE job_id = :'profile_job'::uuid WINDOW w AS (ORDER BY created_at, id)),
s AS (SELECT *, sum(CASE WHEN role IS DISTINCT FROM prev_role OR attempt IS DISTINCT FROM prev_attempt THEN 1 ELSE 0 END) OVER (ORDER BY created_at, id) AS seg FROM c),
seg AS (
  SELECT seg, min(role) AS role, min(attempt) AS attempt, min(created_at) AS started, max(created_at) AS last_call,
    count(*) FILTER (WHERE purpose = 'agent') AS agent, count(*) FILTER (WHERE purpose = 'cache_warm') AS warm,
    count(*) FILTER (WHERE purpose = 'compaction') AS compaction, count(*) FILTER (WHERE state <> 'complete') AS unfinished,
    min(candidate) AS candidate, count(DISTINCT candidate) AS candidates
  FROM s GROUP BY seg),
-- A usage record is written when its call's stream ends: it belongs to the latest run of its
-- role in its box that started before it.
u AS (
  SELECT split_part(event_key, ':', 1) AS attempt, payload->>'role' AS role, created_at,
    CASE WHEN jsonb_typeof(payload->'usage'->'cost') = 'number' THEN (payload->'usage'->>'cost')::numeric ELSE 0 END AS cost
  FROM coding_events WHERE job_id = :'profile_job'::uuid AND payload->>'kind' = 'model_usage' AND event_key ~ '^[0-9a-f-]{36}:model:'),
ua AS (
  SELECT u.*, (SELECT max(seg.seg) FROM seg WHERE seg.attempt = u.attempt AND seg.role = u.role AND seg.started <= u.created_at) AS seg FROM u),
rep AS (
  SELECT DISTINCT ON (s.seg) s.seg, b->'input'->>'kind' AS kind, b->'input'->>'verdict' AS verdict
  FROM s, jsonb_array_elements(CASE WHEN jsonb_typeof(s.result->'content') = 'array' THEN s.result->'content' ELSE '[]' END) b
  WHERE s.purpose = 'agent' AND b->>'type' = 'tool_use' AND b->>'name' = 'report'
  ORDER BY s.seg, s.created_at DESC, s.id DESC),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(t)) AS n FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at AS t FROM coding_events
      WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt_id::text, created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid
    UNION ALL SELECT substr(request_key, 8), created_at FROM boxes
      WHERE subject = 'coding:' || :'profile_job' AND request_key ~ '^coding:[0-9a-f-]{36}$') a GROUP BY attempt)
SELECT CASE seg.role WHEN 'coder' THEN 'coder run ' WHEN 'reviewer' THEN 'review round ' ELSE '(other) ' END
    || row_number() OVER (PARTITION BY seg.role ORDER BY seg.started) AS run,
  att.n AS attempt, round(extract(epoch FROM seg.started - j.created_at) / 60, 1) AS start_min,
  round(extract(epoch FROM GREATEST(seg.last_call, (SELECT max(created_at) FROM ua WHERE ua.seg = seg.seg)) - seg.started) / 60, 1) AS minutes,
  seg.agent AS agent_calls, seg.warm AS cache_warm, seg.compaction, seg.unfinished,
  round(coalesce((SELECT sum(cost) FROM ua WHERE ua.seg = seg.seg), 0), 4) AS cost_usd,
  CASE WHEN rep.kind = 'review' AND rep.verdict IN ('APPROVE', 'REQUEST_CHANGES') THEN rep.verdict
    WHEN rep.kind IN ('done', 'ask') THEN rep.kind WHEN rep.kind IS NOT NULL THEN '(other)' END AS report,
  left(seg.candidate, 12) || CASE WHEN seg.candidates > 1 THEN ' (+' || (seg.candidates - 1) || ')' ELSE '' END AS candidate
FROM seg CROSS JOIN j LEFT JOIN rep USING (seg) LEFT JOIN att ON att.attempt = seg.attempt ORDER BY seg.started;

\echo '3b. Milestones: Start, boxes continued or retried, rebases, publication, PR and its feedback rounds'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(t)) AS n FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at AS t FROM coding_events
      WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt_id::text, created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid
    UNION ALL SELECT substr(request_key, 8), created_at FROM boxes
      WHERE subject = 'coding:' || :'profile_job' AND request_key ~ '^coding:[0-9a-f-]{36}$') a GROUP BY attempt),
m AS (
  SELECT v.created_at AS at, NULL::text AS attempt,
    CASE WHEN v.revision = 1 THEN 'coding_start'
      WHEN v.request_key IN (SELECT e.id::text FROM coding_events e WHERE e.job_id = v.job_id AND e.payload->>'decision' = 'approved') THEN 'Start'
      WHEN v.request_key LIKE 'auto-retry:%' THEN 'automatic retry after a crash'
      WHEN v.request_key LIKE 'continue-box:%' THEN 'continued in a new box'
      WHEN v.request_key LIKE 'rebase:%' THEN 'rebase onto main'
      WHEN v.request_key LIKE 'mr-feedback:%' THEN 'PR feedback round'
      ELSE 'owner revision (reply or resume)' END AS what,
    CASE WHEN v.request_key LIKE 'rebase:%' AND split_part(v.request_key, ':', 2) ~ '^[0-9a-f]{7,64}$'
      THEN 'onto ' || left(split_part(v.request_key, ':', 2), 12) END AS detail
  FROM coding_revisions v WHERE v.job_id = :'profile_job'::uuid
  UNION ALL
  SELECT e.created_at, CASE WHEN e.event_key ~ '^[0-9a-f-]{36}:' THEN split_part(e.event_key, ':', 1) END,
    CASE WHEN e.event_key LIKE '%:publish-approved' THEN 'publication committed'
      WHEN e.event_key ~ '^[0-9a-f-]{36}:pr$' THEN 'PR opened'
      WHEN e.event_key ~ '^[0-9a-f-]{36}:paused$' THEN 'paused'
      WHEN e.event_key ~ '^[0-9a-f-]{36}:finished$' THEN 'finished'
      WHEN e.event_key LIKE 'machine-time:%' THEN 'eight hours of machine time used'
      WHEN e.event_key LIKE 'box-stuck:%' THEN 'box did not shut down'
      WHEN e.event_key LIKE 'ci-wait:%' THEN 'an hour waiting for CI or review'
      WHEN e.event_key = 'cancelled' THEN 'cancelled' END,
    CASE WHEN e.event_key LIKE '%:publish-approved' AND e.payload->>'hash' ~ '^[a-f0-9]{64}$' THEN left(e.payload->>'hash', 12)
      WHEN e.event_key ~ '^[0-9a-f-]{36}:pr$' THEN '#' || substring(e.payload->>'url' FROM '/pull/([0-9]{1,9})$')
      WHEN e.event_key ~ '^[0-9a-f-]{36}:paused$' THEN CASE WHEN e.payload->>'cause' IN ('lifetime', 'sandbox_stopped', 'heartbeat_lost') THEN e.payload->>'cause' END
      WHEN e.event_key ~ '^[0-9a-f-]{36}:finished$' THEN CASE
        WHEN EXISTS(SELECT 1 FROM coding_events p WHERE p.job_id = e.job_id AND p.event_key = split_part(e.event_key, ':', 1) || ':publish-approved') THEN 'candidate'
        WHEN e.payload->>'cause' = 'lifetime' THEN 'lifetime'
        WHEN coalesce(e.payload->>'question', '') <> '' THEN 'ask'
        WHEN (SELECT j1.attempt_id::text = split_part(e.event_key, ':', 1) AND j1.result->>'kind' = 'no_change' FROM coding_jobs j1 WHERE j1.id = e.job_id)
          OR e.payload->>'summary' LIKE 'Nothing needed changing.%' OR e.payload->>'summary' LIKE 'Main already contains this change%' THEN 'no change'
        ELSE 'pause' END END
  FROM coding_events e WHERE e.job_id = :'profile_job'::uuid
    AND (e.event_key LIKE '%:publish-approved' OR e.event_key ~ '^[0-9a-f-]{36}:(pr|paused|finished)$'
      OR e.event_key LIKE 'machine-time:%' OR e.event_key LIKE 'box-stuck:%' OR e.event_key LIKE 'ci-wait:%' OR e.event_key = 'cancelled'))
SELECT round(extract(epoch FROM m.at - j.created_at) / 60, 1) AS at_min, att.n AS attempt, m.what, m.detail
FROM m CROSS JOIN j LEFT JOIN att ON att.attempt = m.attempt ORDER BY m.at, m.what;

\echo '3c. Inbox items by source; first_seen is the first model call whose newest messages carry the item'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
i AS (
  SELECT e.id, e.created_at, e.payload ? 'heldBy' AS held,
    CASE WHEN jsonb_typeof(e.payload->'seq') = 'number' THEN (e.payload->>'seq')::numeric ELSE 0 END AS seq,
    CASE WHEN e.payload->>'source' IN ('owner', 'ask', 'ci', 'review', 'chief', 'rebase') THEN e.payload->>'source' ELSE '(other)' END AS source
  FROM coding_events e WHERE e.job_id = :'profile_job'::uuid AND e.event_key LIKE 'inbox:%'),
-- Pi delivers an item as the newest user message of a request; a request repeats the whole
-- history, so only its last four messages are searched, for the item's header only.
seen AS (
  SELECT x.id, c.created_at, c.role
  FROM coding_model_calls c
  CROSS JOIN LATERAL (SELECT m[1]::uuid AS id FROM regexp_matches(
    coalesce((c.input->'request'->'messages'->-1)::text, '') || coalesce((c.input->'request'->'messages'->-2)::text, '')
      || coalesce((c.input->'request'->'messages'->-3)::text, '') || coalesce((c.input->'request'->'messages'->-4)::text, ''),
    '\[inbox:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) ', 'g') AS m) x
  WHERE c.job_id = :'profile_job'::uuid)
SELECT i.source, round(extract(epoch FROM i.created_at - j.created_at) / 60, 1) AS at_min, i.held,
  coalesce(j.checkpoint->'piState'->'delivered', '[]'::jsonb) ? i.id::text AS delivered,
  round(extract(epoch FROM f.created_at - j.created_at) / 60, 1) AS first_seen_min, f.role AS seen_by
FROM i CROSS JOIN j
LEFT JOIN LATERAL (SELECT seen.created_at, seen.role FROM seen WHERE seen.id = i.id ORDER BY seen.created_at LIMIT 1) f ON true
-- The host's own inbox order (CodingController.inbox).
ORDER BY i.created_at, i.seq, i.id;

\echo '3d. Rebases onto main: clean (straight to review) or conflicting (the coder resolved them), and the review round that followed'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
c AS (
  SELECT id, attempt_id::text AS attempt, role, coalesce(input->>'purpose', 'agent') AS purpose, result, created_at,
    lag(role) OVER w AS prev_role, lag(attempt_id::text) OVER w AS prev_attempt
  FROM coding_model_calls WHERE job_id = :'profile_job'::uuid WINDOW w AS (ORDER BY created_at, id)),
s AS (SELECT *, sum(CASE WHEN role IS DISTINCT FROM prev_role OR attempt IS DISTINCT FROM prev_attempt THEN 1 ELSE 0 END) OVER (ORDER BY created_at, id) AS seg FROM c),
rounds AS (
  SELECT seg, min(created_at) AS started, row_number() OVER (ORDER BY min(created_at)) AS n,
    (SELECT CASE WHEN b->'input'->>'verdict' IN ('APPROVE', 'REQUEST_CHANGES') THEN b->'input'->>'verdict' END
     FROM s x, jsonb_array_elements(CASE WHEN jsonb_typeof(x.result->'content') = 'array' THEN x.result->'content' ELSE '[]' END) b
     WHERE x.seg = s.seg AND x.purpose = 'agent' AND b->>'type' = 'tool_use' AND b->>'name' = 'report' AND b->'input'->>'kind' = 'review'
     ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS verdict
  FROM s WHERE role = 'reviewer' GROUP BY seg),
r AS (
  SELECT e.id, e.created_at, CASE WHEN e.payload->>'onto' ~ '^[0-9a-f]{40}$' THEN left(e.payload->>'onto', 12) END AS onto,
    (SELECT min(c.created_at) FROM coding_model_calls c WHERE c.job_id = e.job_id AND c.role = 'coder' AND c.created_at >= e.created_at
      AND strpos(coalesce((c.input->'request'->'messages'->-1)::text, '') || coalesce((c.input->'request'->'messages'->-2)::text, '')
        || coalesce((c.input->'request'->'messages'->-3)::text, '') || coalesce((c.input->'request'->'messages'->-4)::text, ''),
        '[inbox:' || e.id::text || ' ') > 0) AS coder_saw
  FROM coding_events e WHERE e.job_id = :'profile_job'::uuid AND e.event_key LIKE 'inbox:rebase:%')
SELECT round(extract(epoch FROM r.created_at - j.created_at) / 60, 1) AS at_min, r.onto,
  CASE WHEN r.coder_saw IS NOT NULL THEN 'conflicting' WHEN f.n IS NOT NULL THEN 'clean' ELSE '(not yet rebased)' END AS kind,
  round(extract(epoch FROM r.coder_saw - j.created_at) / 60, 1) AS coder_told_min,
  f.n AS review_round, round(extract(epoch FROM f.started - j.created_at) / 60, 1) AS review_start_min, f.verdict
FROM r CROSS JOIN j
LEFT JOIN LATERAL (SELECT rounds.n, rounds.started, rounds.verdict FROM rounds WHERE rounds.started > coalesce(r.coder_saw, r.created_at)
  ORDER BY rounds.started LIMIT 1) f ON true
ORDER BY r.created_at, r.id;

\echo '4. Tool use per assistant turn (completed agent calls; Anthropic tool_use blocks)'
WITH t AS (
  SELECT c.role, (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.result->'content') = 'array' THEN c.result->'content' ELSE '[]' END) b
    WHERE b->>'type' = 'tool_use') AS n
  FROM coding_model_calls c WHERE c.job_id = :'profile_job'::uuid AND c.state = 'complete' AND coalesce(c.input->>'purpose', 'agent') = 'agent')
SELECT role, count(*) AS turns, count(*) FILTER (WHERE n = 0) AS no_tool, count(*) FILTER (WHERE n = 1) AS one,
  count(*) FILTER (WHERE n = 2) AS two, count(*) FILTER (WHERE n >= 3) AS three_or_more, sum(n) AS tool_calls, max(n) AS most_in_one_turn
FROM t GROUP BY role ORDER BY role;

\echo '4b. Tool calls by name (a name that is not one of Pi''s tools or report is shown as (other))'
WITH t AS (
  SELECT c.role, CASE WHEN b->>'name' IN ('read', 'edit', 'write', 'bash', 'grep', 'find', 'ls', 'report') THEN b->>'name' ELSE '(other)' END AS tool
  FROM coding_model_calls c, jsonb_array_elements(CASE WHEN jsonb_typeof(c.result->'content') = 'array' THEN c.result->'content' ELSE '[]' END) b
  WHERE c.job_id = :'profile_job'::uuid AND c.state = 'complete' AND coalesce(c.input->>'purpose', 'agent') = 'agent' AND b->>'type' = 'tool_use')
SELECT role, tool, count(*) AS calls FROM t GROUP BY role, tool ORDER BY role, count(*) DESC, tool;

\echo '4c. bash commands by class, from the first program word against a fixed list (no command text is printed)'
WITH b AS (
  SELECT c.role, CASE WHEN jsonb_typeof(b->'input') = 'object' THEN coalesce(b->'input'->>'command', '') ELSE '' END AS command
  FROM coding_model_calls c, jsonb_array_elements(CASE WHEN jsonb_typeof(c.result->'content') = 'array' THEN c.result->'content' ELSE '[]' END) b
  WHERE c.job_id = :'profile_job'::uuid AND c.state = 'complete' AND coalesce(c.input->>'purpose', 'agent') = 'agent'
    AND b->>'type' = 'tool_use' AND b->>'name' = 'bash'),
-- Leading ( or {, `cd DIR &&` or `cd DIR;`, and VAR=value assignments are skipped.
s AS (
  SELECT role, regexp_replace(regexp_replace(command, '^[ \t({]*((cd|pushd)[ \t]+[^;&|\n]*(&&|;)[ \t({]*)*', ''), '^([A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+)*', '') AS cmd
  FROM b),
w AS (SELECT role, cmd, regexp_replace(substring(cmd FROM '^([^\s;&|()<>{}]+)'), '^.*/', '') AS word FROM s)
SELECT role, CASE
    WHEN word = 'sed' AND cmd ~ '\s(-[A-Za-z]*i[A-Za-z]*|--in-place)(\s|=|$)' THEN 'edit by script'
    WHEN word IN ('cat', 'echo', 'printf') AND (cmd ~ '<<' OR cmd ~ '(^|[^0-9&>])>{1,2}[ \t]*[^&\s>/]') THEN 'edit by script'
    WHEN word IN ('cat', 'head', 'tail', 'less', 'more', 'wc', 'nl', 'sed', 'awk', 'file', 'stat', 'ls', 'tree', 'du', 'pwd',
      'realpath', 'readlink', 'diff', 'cmp', 'jq', 'sort', 'uniq', 'cut', 'od', 'xxd', 'hexdump', 'column', 'echo', 'printf') THEN 'read'
    WHEN word IN ('grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'locate') THEN 'search'
    WHEN word IN ('npm', 'npx', 'pnpm', 'yarn', 'node', 'kite', 'tsc', 'tsx', 'vitest', 'jest', 'mocha', 'pytest', 'make', 'cmake',
      'cargo', 'go', 'bun', 'deno', 'mvn', 'gradle', 'uv', 'pip', 'pip3', 'ruff', 'mypy', 'eslint', 'prettier', 'biome') THEN 'tests or build'
    WHEN word IN ('python', 'python3') AND cmd ~ '\s-m\s+(pytest|unittest|mypy|ruff|pip)(\s|$)' THEN 'tests or build'
    WHEN word IN ('git', 'gh') THEN 'git'
    WHEN word IN ('python', 'python3', 'perl', 'ruby', 'patch', 'tee', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'chmod', 'ln', 'truncate', 'dd')
      THEN 'edit by script'
    ELSE 'other' END AS class,
  count(*) AS calls
FROM w GROUP BY 1, 2 ORDER BY role, count(*) DESC, 2;

\echo '4d. The coder''s exploration: agent calls before its first edit or write, and the largest request context per role'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
c AS (
  SELECT role, created_at, row_number() OVER (PARTITION BY role ORDER BY created_at, id) AS n,
    EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(result->'content') = 'array' THEN result->'content' ELSE '[]' END) b
      WHERE b->>'type' = 'tool_use' AND b->>'name' IN ('edit', 'write')) AS edits,
    CASE WHEN jsonb_typeof(result->'usage') = 'object' THEN
      CASE WHEN jsonb_typeof(result->'usage'->'input_tokens') = 'number' THEN (result->'usage'->>'input_tokens')::numeric ELSE 0 END
      + CASE WHEN jsonb_typeof(result->'usage'->'cache_read_input_tokens') = 'number' THEN (result->'usage'->>'cache_read_input_tokens')::numeric ELSE 0 END
      + CASE WHEN jsonb_typeof(result->'usage'->'cache_creation_input_tokens') = 'number' THEN (result->'usage'->>'cache_creation_input_tokens')::numeric ELSE 0 END END AS context
  FROM coding_model_calls WHERE job_id = :'profile_job'::uuid AND coalesce(input->>'purpose', 'agent') = 'agent')
SELECT c.role, count(*) AS agent_calls,
  (SELECT min(n) - 1 FROM c e WHERE e.role = c.role AND e.edits) AS calls_before_first_edit,
  round(extract(epoch FROM (SELECT min(created_at) FROM c e WHERE e.role = c.role AND e.edits) - min(c.created_at)) / 60, 1) AS min_to_first_edit,
  max(c.context) AS largest_context,
  round(extract(epoch FROM (SELECT e.created_at FROM c e WHERE e.role = c.role AND e.context IS NOT NULL ORDER BY e.context DESC, e.created_at LIMIT 1) - min(j.created_at)) / 60, 1) AS largest_at_min
FROM c CROSS JOIN j GROUP BY c.role ORDER BY c.role;

\echo '5. Context per agent call (input + cache read + cache write) by run, and Pi''s compactions'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
c AS (
  SELECT id, attempt_id::text AS attempt, role, coalesce(input->>'purpose', 'agent') AS purpose, result, created_at,
    lag(role) OVER w AS prev_role, lag(attempt_id::text) OVER w AS prev_attempt
  FROM coding_model_calls WHERE job_id = :'profile_job'::uuid WINDOW w AS (ORDER BY created_at, id)),
s AS (SELECT *, sum(CASE WHEN role IS DISTINCT FROM prev_role OR attempt IS DISTINCT FROM prev_attempt THEN 1 ELSE 0 END) OVER (ORDER BY created_at, id) AS seg FROM c),
r AS (SELECT seg, role, dense_rank() OVER (PARTITION BY role ORDER BY seg) AS run FROM (SELECT DISTINCT seg, role FROM s) x),
x AS (
  SELECT s.role, r.run, s.created_at, s.purpose,
    CASE WHEN jsonb_typeof(s.result->'usage') = 'object' THEN
      CASE WHEN jsonb_typeof(s.result->'usage'->'input_tokens') = 'number' THEN (s.result->'usage'->>'input_tokens')::numeric ELSE 0 END
      + CASE WHEN jsonb_typeof(s.result->'usage'->'cache_read_input_tokens') = 'number' THEN (s.result->'usage'->>'cache_read_input_tokens')::numeric ELSE 0 END
      + CASE WHEN jsonb_typeof(s.result->'usage'->'cache_creation_input_tokens') = 'number' THEN (s.result->'usage'->>'cache_creation_input_tokens')::numeric ELSE 0 END END AS context
  FROM s JOIN r USING (seg, role))
SELECT role, CASE WHEN GROUPING(run) = 1 THEN 'all' ELSE run::text END AS run,
  count(context) FILTER (WHERE purpose = 'agent') AS agent_calls,
  (array_agg(context ORDER BY created_at) FILTER (WHERE purpose = 'agent' AND context IS NOT NULL))[1] AS first,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY context) FILTER (WHERE purpose = 'agent') AS median,
  max(context) FILTER (WHERE purpose = 'agent') AS max,
  (array_agg(context ORDER BY created_at DESC) FILTER (WHERE purpose = 'agent' AND context IS NOT NULL))[1] AS last,
  count(*) FILTER (WHERE purpose = 'compaction') AS compactions
FROM x GROUP BY GROUPING SETS ((role, run), (role)) ORDER BY role, GROUPING(run), run;

\echo '5b. Each compaction: when, the context it summarised, and the next agent call''s context in that role'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
c AS (
  SELECT role, attempt_id::text AS attempt, state, coalesce(input->>'purpose', 'agent') AS purpose, created_at,
    CASE WHEN jsonb_typeof(result->'usage') = 'object' THEN
      CASE WHEN jsonb_typeof(result->'usage'->'input_tokens') = 'number' THEN (result->'usage'->>'input_tokens')::numeric ELSE 0 END
      + CASE WHEN jsonb_typeof(result->'usage'->'cache_read_input_tokens') = 'number' THEN (result->'usage'->>'cache_read_input_tokens')::numeric ELSE 0 END
      + CASE WHEN jsonb_typeof(result->'usage'->'cache_creation_input_tokens') = 'number' THEN (result->'usage'->>'cache_creation_input_tokens')::numeric ELSE 0 END END AS context
  FROM coding_model_calls WHERE job_id = :'profile_job'::uuid)
SELECT k.role, round(extract(epoch FROM k.created_at - j.created_at) / 60, 1) AS at_min, k.state, k.context AS summarised_context,
  (SELECT n.context FROM c n WHERE n.role = k.role AND n.purpose = 'agent' AND n.created_at > k.created_at ORDER BY n.created_at LIMIT 1) AS next_context
FROM c k CROSS JOIN j WHERE k.purpose = 'compaction' ORDER BY k.created_at;

ROLLBACK;
