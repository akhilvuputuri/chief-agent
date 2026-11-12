-- Where one coding job's time and money went, per attempt and role: phases, model usage,
-- latency, tool use and thinking summaries (docs/coding.md#profiling-a-job, journal 172).
-- Read-only: SELECTs inside a read-only transaction. It prints counts, token sums, costs,
-- durations, fixed stage labels and a bash command's first word; never prompts, message
-- text, other tool arguments, thinking text, secrets or the environment.
--
--   ssh chief-prod 'sudo docker exec -i hermes-companion-postgres-1 sh -c "psql -X -v job=9600af57 -U \$POSTGRES_USER -d \$POSTGRES_DB"' < scripts/coding-job-profile.sql
--
-- `job` is a job id or a prefix of one that matches exactly one job. Attempts are numbered
-- by their first activity; "n 1127593e" is attempt n and its id prefix.
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
SELECT count(*) = 1 AND :'job' ~ '^[0-9a-f-]{4,36}$' AS profile_found, min(id::text) AS profile_job FROM coding_jobs WHERE id::text LIKE :'job' || '%' \gset
\if :profile_found
\else
\echo 'No single coding job matches that id prefix.'
\quit
\endif

\echo
\echo '1. Job'
\x on
SELECT left(id::text, 8) AS job, state, stage, revision, mode,
  settings->>'runtime' AS runtime, settings->>'effort' AS effort,
  settings->>'leaderModel' AS leader_model, settings->>'model' AS coder_model,
  settings->>'reviewerModel' AS reviewer_model,
  round((settings->'limits'->>'ms')::numeric / 60000) AS limit_minutes,
  settings->'limits'->>'models' AS limit_model_calls, settings->'limits'->>'tools' AS limit_tool_calls,
  settings->>'maxOutputTokens' AS max_output_tokens,
  settings->>'reviewerMaxOutputTokens' AS reviewer_max_output_tokens,
  right(settings->>'image', 12) AS image_tail, used_models,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS created_utc,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS updated_utc,
  to_char(attempt_deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS attempt_deadline_utc,
  left(attempt_id::text, 8) AS current_attempt, pr_url IS NOT NULL AS has_pr
FROM coding_jobs WHERE id = :'profile_job'::uuid;
\x off

\echo '2. Attempts: wall time from first to last activity, end markers, rejected worker requests and model requests by role'
WITH e AS (
  SELECT split_part(event_key, ':', 1) AS attempt, split_part(event_key, ':', 2) AS marker, payload, created_at
  FROM coding_events WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'),
c AS (SELECT attempt_id::text AS attempt, role, state, created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(created_at)) AS n, min(created_at) AS started, max(created_at) AS last_activity
  FROM (SELECT attempt, created_at FROM e UNION ALL SELECT attempt, created_at FROM c) a GROUP BY attempt)
SELECT a.n || ' ' || left(a.attempt, 8) AS attempt,
  to_char(a.started AT TIME ZONE 'UTC', 'MM-DD HH24:MI:SS') AS started_utc,
  to_char(a.last_activity AT TIME ZONE 'UTC', 'MM-DD HH24:MI:SS') AS last_utc,
  round(extract(epoch FROM a.last_activity - a.started) / 60, 1) AS wall_min,
  (SELECT string_agg(marker, ',' ORDER BY created_at) FROM e
    WHERE e.attempt = a.attempt AND marker IN ('finished', 'paused', 'pr', 'cancelled'))
    || CASE WHEN j.attempt_id::text = a.attempt AND j.state IN ('provisioning', 'running') THEN ' (running)' ELSE '' END AS ended,
  (SELECT string_agg(code || ' x' || n, ', ' ORDER BY code) FROM (
    SELECT coalesce(payload->>'code', '?') AS code, count(*) AS n FROM e
    WHERE e.attempt = a.attempt AND payload->>'kind' = 'worker_request_rejected' GROUP BY 1) r) AS rejected,
  (SELECT string_agg(role || ' ' || n || CASE WHEN open > 0 THEN ' (' || open || ' not complete)' ELSE '' END, ', ' ORDER BY role) FROM (
    SELECT role, count(*) AS n, count(*) FILTER (WHERE state <> 'complete') AS open FROM c
    WHERE c.attempt = a.attempt GROUP BY role) m) AS model_requests
FROM att a CROSS JOIN coding_jobs j WHERE j.id = :'profile_job'::uuid ORDER BY a.n;

\echo '2b. Timeline: stage reports, end markers and rejected requests; min_to_next runs to the next row or the attempt''s last activity'
WITH e AS (
  SELECT split_part(event_key, ':', 1) AS attempt, split_part(event_key, ':', 2) AS marker, payload, created_at
  FROM coding_events WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'),
c AS (SELECT attempt_id::text AS attempt, created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(created_at)) AS n, max(created_at) AS last_activity
  FROM (SELECT attempt, created_at FROM e UNION ALL SELECT attempt, created_at FROM c) a GROUP BY attempt),
t AS (
  SELECT attempt, created_at,
    CASE WHEN marker = 'pi' THEN coalesce(payload->>'stage', '')
      WHEN payload->>'kind' = 'worker_request_rejected' THEN 'rejected' ELSE marker END AS what,
    -- Stage summaries are the worker's fixed progress labels (src/coding/progress-text.ts).
    CASE WHEN marker = 'pi' THEN left(payload->>'summary', 60)
      WHEN payload->>'kind' = 'worker_request_rejected'
        THEN concat_ws(' ', payload->>'phase', payload->>'code', payload->>'timeoutKind')
      WHEN marker = 'paused' THEN payload->>'cause' END AS detail
  FROM e WHERE marker IN ('pi', 'finished', 'paused', 'pr', 'cancelled') OR payload->>'kind' = 'worker_request_rejected')
SELECT a.n || ' ' || left(t.attempt, 8) AS attempt, to_char(t.created_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI:SS') AS at_utc,
  t.what, t.detail,
  round(extract(epoch FROM coalesce(lead(t.created_at) OVER w, a.last_activity) - t.created_at) / 60, 1) AS min_to_next
FROM t JOIN att a USING (attempt)
WINDOW w AS (PARTITION BY t.attempt ORDER BY t.created_at)
ORDER BY t.created_at;

\echo '3. Model usage (model_usage events): thinking_pct is reasoning of completion tokens, cached_pct cache reads of prompt tokens'
WITH u AS (
  SELECT split_part(event_key, ':', 1) AS attempt, coalesce(payload->>'role', '?') AS role, payload->>'model' AS model,
    coalesce((payload->>'incomplete')::boolean, false) AS incomplete, payload->'usage'->>'route' AS route,
    coalesce((payload->'usage'->>'cost')::numeric, 0) AS cost,
    coalesce((payload->'usage'->>'prompt_tokens')::bigint, 0) AS prompt,
    coalesce((payload->'usage'->'prompt_tokens_details'->>'cached_tokens')::bigint, 0) AS cached,
    coalesce((payload->'usage'->'prompt_tokens_details'->>'cache_write_tokens')::bigint, 0) AS cache_write,
    coalesce((payload->'usage'->>'completion_tokens')::bigint, 0) AS completion,
    coalesce((payload->'usage'->'completion_tokens_details'->>'reasoning_tokens')::bigint, 0) AS reasoning
  FROM coding_events WHERE job_id = :'profile_job'::uuid AND payload->>'kind' = 'model_usage'),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(created_at)) AS n FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at FROM coding_events
    WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt_id::text, created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid) a GROUP BY attempt)
SELECT CASE WHEN grouping(a.n) = 1 THEN 'all' ELSE a.n || ' ' || left(u.attempt, 8) END AS attempt,
  CASE WHEN grouping(u.role) = 1 THEN 'all' ELSE u.role END AS role,
  count(*) AS calls, count(*) FILTER (WHERE incomplete) AS incomplete, round(sum(cost), 2) AS cost_usd,
  sum(prompt) AS prompt_tokens, sum(cached) AS cached_tokens, sum(cache_write) AS cache_write_tokens,
  sum(completion) AS completion_tokens, sum(reasoning) AS reasoning_tokens,
  round(100.0 * sum(reasoning) / nullif(sum(completion), 0)) AS thinking_pct,
  round(100.0 * sum(cached) / nullif(sum(prompt), 0)) AS cached_pct, max(prompt) AS max_prompt,
  string_agg(DISTINCT route, ',') AS routes, string_agg(DISTINCT model, ',') AS models
FROM u JOIN att a USING (attempt)
GROUP BY GROUPING SETS ((a.n, u.attempt, u.role), (u.role), ())
ORDER BY grouping(a.n), a.n, grouping(u.role), u.role;

-- Roles take turns inside an attempt (review, repair, review again), so requests are split into
-- runs of one role, and a run's first gap starts at its first request: the time between runs
-- (checks, hand-over) is not charged to either role.
\echo '4. Gaps between consecutive model_usage events in each run of one role (model time plus tool and host time)'
WITH c0 AS (
  SELECT id, attempt_id::text AS attempt, role, created_at,
    CASE WHEN role IS DISTINCT FROM lag(role) OVER (PARTITION BY attempt_id ORDER BY created_at, id) THEN 1 ELSE 0 END AS change
  FROM coding_model_calls WHERE job_id = :'profile_job'::uuid),
c AS (SELECT *, sum(change) OVER (PARTITION BY attempt ORDER BY created_at, id ROWS UNBOUNDED PRECEDING) AS run FROM c0),
runs AS (SELECT attempt, run, min(created_at) AS first_request FROM c GROUP BY 1, 2),
u AS (
  SELECT split_part(event_key, ':', 1) AS attempt, coalesce(payload->>'role', '?') AS role, created_at,
    coalesce((payload->'usage'->>'completion_tokens')::bigint, 0) AS completion,
    coalesce((payload->'usage'->'completion_tokens_details'->>'reasoning_tokens')::bigint, 0) AS reasoning
  FROM coding_events WHERE job_id = :'profile_job'::uuid AND payload->>'kind' = 'model_usage'),
ur AS (
  SELECT u.*, (SELECT c.run FROM c WHERE c.attempt = u.attempt AND c.role = u.role AND c.created_at <= u.created_at
    ORDER BY c.created_at DESC LIMIT 1) AS run
  FROM u),
g AS (
  SELECT ur.attempt, ur.role, ur.completion, ur.reasoning,
    extract(epoch FROM ur.created_at - coalesce(lag(ur.created_at) OVER (PARTITION BY ur.attempt, ur.run ORDER BY ur.created_at), runs.first_request)) AS gap
  FROM ur LEFT JOIN runs USING (attempt, run)),
b AS (
  SELECT *, CASE WHEN gap IS NULL THEN '5 unknown' WHEN gap < 15 THEN '1 <15 s' WHEN gap < 60 THEN '2 15-60 s'
    WHEN gap < 180 THEN '3 1-3 min' ELSE '4 >3 min' END AS bucket FROM g),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(created_at)) AS n FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at FROM coding_events
    WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt_id::text, created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid) a GROUP BY attempt)
SELECT a.n || ' ' || left(b.attempt, 8) AS attempt, b.role,
  CASE WHEN grouping(b.bucket) = 1 THEN 'all' ELSE substr(b.bucket, 3) END AS gap,
  count(*) AS calls, round(sum(gap) / 60, 1) AS minutes, round(max(gap)) AS max_s,
  sum(completion) AS completion_tokens, sum(reasoning) AS reasoning_tokens
FROM b JOIN att a USING (attempt)
GROUP BY GROUPING SETS ((a.n, b.attempt, b.role, b.bucket), (a.n, b.attempt, b.role))
ORDER BY a.n, b.role, grouping(b.bucket), b.bucket;

\echo '4b. Model time: each request to its model_usage event, against the runs'' span; progress is the longest model_progress elapsedMs per call, saved at most every 10 s while streaming'
WITH c0 AS (
  SELECT id, attempt_id::text AS attempt, role, created_at,
    CASE WHEN role IS DISTINCT FROM lag(role) OVER (PARTITION BY attempt_id ORDER BY created_at, id) THEN 1 ELSE 0 END AS change
  FROM coding_model_calls WHERE job_id = :'profile_job'::uuid),
c AS (
  SELECT *, sum(change) OVER (PARTITION BY attempt ORDER BY created_at, id ROWS UNBOUNDED PRECEDING) AS run,
    lead(created_at) OVER (PARTITION BY attempt, role ORDER BY created_at, id) AS next_request
  FROM c0),
u AS (
  SELECT split_part(event_key, ':', 1) AS attempt, payload->>'role' AS role, created_at
  FROM coding_events WHERE job_id = :'profile_job'::uuid AND payload->>'kind' = 'model_usage'),
p AS (
  SELECT payload->>'callId' AS call_id, max((payload->>'elapsedMs')::bigint) AS elapsed_ms
  FROM coding_events WHERE job_id = :'profile_job'::uuid AND payload->>'kind' = 'model_progress' GROUP BY 1),
w AS (
  SELECT c.attempt, c.role, c.run, c.created_at,
    (SELECT min(u.created_at) FROM u WHERE u.attempt = c.attempt AND u.role = c.role
      AND u.created_at >= c.created_at AND u.created_at < coalesce(c.next_request, 'infinity')) AS answered_at,
    p.elapsed_ms
  FROM c LEFT JOIN p ON p.call_id = c.id::text),
r AS (
  SELECT attempt, role, run, extract(epoch FROM coalesce(max(answered_at), max(created_at)) - min(created_at)) AS span
  FROM w GROUP BY 1, 2, 3),
rs AS (SELECT attempt, role, count(*) AS runs, sum(span) AS span FROM r GROUP BY 1, 2),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(created_at)) AS n FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at FROM coding_events
    WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt_id::text, created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid) a GROUP BY attempt)
SELECT a.n || ' ' || left(w.attempt, 8) AS attempt, w.role, rs.runs, count(*) AS requests, count(answered_at) AS answered,
  round(rs.span / 60, 1) AS span_min,
  round(sum(extract(epoch FROM answered_at - w.created_at)) / 60, 1) AS model_wait_min,
  round((rs.span - coalesce(sum(extract(epoch FROM answered_at - w.created_at)), 0)) / 60, 1) AS between_calls_min,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM answered_at - w.created_at))::numeric) AS median_wait_s,
  round(max(extract(epoch FROM answered_at - w.created_at))) AS max_wait_s,
  count(elapsed_ms) AS with_progress, round(sum(elapsed_ms) / 60000.0, 1) AS progress_min,
  round(max(elapsed_ms) / 1000.0) AS max_progress_s
FROM w JOIN att a USING (attempt) JOIN rs USING (attempt, role)
GROUP BY a.n, w.attempt, w.role, rs.runs, rs.span ORDER BY a.n, w.role;

\echo '5. Tool calls per response (coding_model_calls results)'
WITH r AS (
  SELECT attempt_id::text AS attempt, role,
    CASE WHEN jsonb_typeof(result->'message'->'tool_calls') = 'array' THEN jsonb_array_length(result->'message'->'tool_calls') ELSE 0 END AS tools
  FROM coding_model_calls WHERE job_id = :'profile_job'::uuid AND result IS NOT NULL),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(created_at)) AS n FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at FROM coding_events
    WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt_id::text, created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid) a GROUP BY attempt)
SELECT a.n || ' ' || left(r.attempt, 8) AS attempt, r.role, count(*) AS responses,
  count(*) FILTER (WHERE tools = 0) AS "0", count(*) FILTER (WHERE tools = 1) AS "1",
  count(*) FILTER (WHERE tools = 2) AS "2", count(*) FILTER (WHERE tools >= 3) AS "3+",
  max(tools) AS max, sum(tools) AS tool_calls
FROM r JOIN att a USING (attempt) GROUP BY a.n, r.attempt, r.role ORDER BY a.n, r.role;

\echo '5b. Tool names'
WITH t AS (
  SELECT attempt_id::text AS attempt, role, left(coalesce(tc->'function'->>'name', tc->>'name', '?'), 40) AS tool
  FROM coding_model_calls, jsonb_array_elements(result->'message'->'tool_calls') AS tc
  WHERE job_id = :'profile_job'::uuid AND jsonb_typeof(result->'message'->'tool_calls') = 'array'),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(created_at)) AS n FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at FROM coding_events
    WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt_id::text, created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid) a GROUP BY attempt)
SELECT a.n || ' ' || left(x.attempt, 8) AS attempt, x.role, sum(x.calls) AS tool_calls,
  string_agg(x.tool || ' ' || x.calls, ', ' ORDER BY x.calls DESC, x.tool) AS by_name
FROM (SELECT attempt, role, tool, count(*) AS calls FROM t GROUP BY 1, 2, 3) x JOIN att a USING (attempt)
GROUP BY a.n, x.attempt, x.role ORDER BY a.n, x.role;

\echo '5c. bash commands by first word (after any leading ( or { and cd ... && or ;); chars is the whole command''s length'
WITH b AS (
  SELECT attempt_id::text AS attempt, role,
    CASE jsonb_typeof(tc->'function'->'arguments')
      WHEN 'object' THEN tc->'function'->'arguments'->>'command'
      WHEN 'string' THEN CASE WHEN pg_input_is_valid(tc->'function'->>'arguments', 'jsonb')
        THEN (tc->'function'->>'arguments')::jsonb->>'command' END END AS command
  FROM coding_model_calls, jsonb_array_elements(result->'message'->'tool_calls') AS tc
  WHERE job_id = :'profile_job'::uuid AND jsonb_typeof(result->'message'->'tool_calls') = 'array'
    AND tc->'function'->>'name' = 'bash'),
w AS (
  SELECT attempt, role, length(command) AS chars,
    substring(regexp_replace(coalesce(command, ''), '^[\s({]*(cd\s+[^;&|]*(&&|;)[\s({]*)*', '') FROM '^([^\s;&|()<>{}]+)') AS word
  FROM b),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(created_at)) AS n FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at FROM coding_events
    WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt_id::text, created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid) a GROUP BY attempt)
-- Only a plain command name is printed: an assignment or anything unusual is grouped, never shown.
SELECT a.n || ' ' || left(w.attempt, 8) AS attempt, w.role,
  CASE WHEN w.word IS NULL THEN '(none)' WHEN w.word LIKE '%=%' THEN '(assignment)'
    WHEN w.word ~ '^[A-Za-z0-9._/+-]{1,32}$' THEN w.word ELSE '(other)' END AS first_word,
  count(*) AS calls, round(avg(chars)) AS avg_chars, max(chars) AS max_chars
FROM w JOIN att a USING (attempt)
GROUP BY a.n, w.attempt, w.role, 3 ORDER BY a.n, w.role, count(*) DESC, 3;

\echo '6. Thinking in responses: reasoning_details entries and non-empty summaries (count and characters only)'
WITH d AS (
  SELECT attempt_id::text AS attempt, role, id,
    jsonb_typeof(result->'message'->'reasoning_details') = 'array' AS has_details, x.detail
  FROM coding_model_calls
  LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(result->'message'->'reasoning_details') = 'array'
    THEN result->'message'->'reasoning_details' ELSE '[]' END) AS x(detail) ON true
  WHERE job_id = :'profile_job'::uuid AND result IS NOT NULL),
s AS (
  SELECT *, coalesce(nullif(detail->'block'->>'thinking', ''), nullif(detail->>'summary', ''), nullif(detail->>'text', '')) AS summary
  FROM d),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(created_at)) AS n FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at FROM coding_events
    WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt_id::text, created_at FROM coding_model_calls WHERE job_id = :'profile_job'::uuid) a GROUP BY attempt)
SELECT a.n || ' ' || left(s.attempt, 8) AS attempt, s.role, count(DISTINCT s.id) AS responses,
  count(DISTINCT s.id) FILTER (WHERE has_details) AS with_details, count(detail) AS entries,
  count(summary) AS summaries, coalesce(sum(length(summary)), 0) AS summary_chars,
  count(DISTINCT s.id) FILTER (WHERE summary IS NOT NULL) AS responses_with_summary
FROM s JOIN att a USING (attempt) GROUP BY a.n, s.attempt, s.role ORDER BY a.n, s.role;

ROLLBACK;
