-- Where one coding job's time and money went, on the one-session loop (journals 190 to 193;
-- journal 194 describes this script). Old-loop jobs (planner, leader role, OpenAI-shaped call
-- records, host check stage, repair sessions) are not supported: the script says so in one
-- line and stops instead of printing wrong numbers.
--
-- Read-only: SELECTs inside a read-only transaction with short timeouts, filtered on the job
-- id only, no dynamic SQL. It prints counts, token sums, costs, durations and known names:
-- roles, call purposes, Pi's tool names, a coarse class of each bash command, review verdicts,
-- inbox sources, pause causes, model ids of a plain form, hash prefixes and a PR number.
-- Anything else in those places is shown as "(other)". It never prints prompts, message text,
-- thinking, tool arguments, owner messages, file contents, secrets or the environment.
--
-- Do not run it during a release: the read-only transaction holds its locks until the end of
-- the run, and a migration would queue behind it.
--
--   ssh HOST 'sudo docker exec -i hermes-companion-postgres-1 sh -c "psql -X -v job=<prefix> -U \$POSTGRES_USER -d \$POSTGRES_DB"' < scripts/coding-job-profile.sql
--
-- `job` is a job id or a prefix of one that matches exactly one job. Times are minutes since
-- coding_start ("at_min"). Attempts (one per box) are numbered by their first activity.
--
-- Cost: a model call's stored request can be megabytes. It is read once, in the statement
-- that fills the psql variable profile_calls with each call's small fields; every section
-- reads that variable (as a quoted literal, like the job id) and never the requests again.
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
-- The old loop's calls have a leader role or an OpenAI-shaped stored response; a job of a
-- legacy runtime is old too. A call without the request's shape (written since journal 192)
-- is caught below, from the one read of the requests.
SELECT (j.settings->>'runtime' IS DISTINCT FROM 'pi' OR EXISTS(SELECT 1 FROM coding_model_calls c
    WHERE c.job_id = j.id AND (c.role NOT IN ('coder', 'reviewer') OR c.result ? 'message'))) AS profile_old
  FROM coding_jobs j WHERE j.id = :'profile_job'::uuid \gset
\if :profile_old
\echo 'This job was recorded by the old coding loop (planner, OpenAI-shaped calls or host checks); this script reads only the one-session loop. Use the journal 172 draft for it.'
ROLLBACK;
\quit
\endif
-- From here a statement that fails (for example by the statement timeout) is rolled back to a
-- savepoint psql sets before it, and the run goes on: every section stands alone, and one
-- that fails prints psql's error in its place.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
\set profile_calls '[]'
\set profile_shapeless f
WITH k AS (
  SELECT x.i ? 'shape' AS shaped, jsonb_build_object(
    'i', c.id, 'a', c.attempt_id, 'r', c.role, 's', c.state, 't', c.created_at,
    'p', CASE WHEN coalesce(x.i->>'purpose', 'agent') IN ('agent', 'compaction', 'cache_warm') THEN coalesce(x.i->>'purpose', 'agent') ELSE '(other)' END,
    'c', CASE WHEN c.role = 'reviewer' AND x.i->>'candidate' ~ '^[a-f0-9]{64}$' THEN x.i->>'candidate' END,
    -- Inbox ids in the request's newest four messages: Pi delivers an item as the newest user
    -- message, and a request repeats the whole history before it.
    'ib', (SELECT coalesce(jsonb_agg(DISTINCT m[1]), '[]') FROM regexp_matches(
        jsonb_path_query_array(x.i, '$.request.messages[last-3 to last]')::text,
        '\[inbox:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) ', 'g') AS m),
    -- Context: input + cache read + cache write, from the stored response's usage.
    'x', CASE WHEN jsonb_typeof(c.result->'usage') = 'object' THEN
      CASE WHEN jsonb_typeof(c.result->'usage'->'input_tokens') = 'number' THEN (c.result->'usage'->>'input_tokens')::numeric ELSE 0 END
      + CASE WHEN jsonb_typeof(c.result->'usage'->'cache_read_input_tokens') = 'number' THEN (c.result->'usage'->>'cache_read_input_tokens')::numeric ELSE 0 END
      + CASE WHEN jsonb_typeof(c.result->'usage'->'cache_creation_input_tokens') = 'number' THEN (c.result->'usage'->>'cache_creation_input_tokens')::numeric ELSE 0 END END,
    'w', CASE WHEN jsonb_typeof(c.result->'usage'->'cache_creation'->'ephemeral_1h_input_tokens') = 'number'
      THEN (c.result->'usage'->'cache_creation'->>'ephemeral_1h_input_tokens')::numeric END,
    -- Each tool call: Pi's tool name (or "(other)") and, for bash, a class of its first program
    -- word against a fixed list. Leading ( or {, `cd DIR &&` or `cd DIR;`, and VAR=value
    -- assignments are skipped. No command text leaves this statement.
    'tools', (SELECT coalesce(jsonb_agg(jsonb_build_array(t.tool, t.class) ORDER BY t.ord), '[]') FROM (
      SELECT b.ord,
        CASE WHEN b.v->>'name' IN ('read', 'edit', 'write', 'bash', 'grep', 'find', 'ls', 'report') THEN b.v->>'name' ELSE '(other)' END AS tool,
        CASE WHEN b.v->>'name' <> 'bash' THEN NULL
          WHEN w.word = 'sed' AND s.cmd ~ '\s(-[A-Za-z]*i[A-Za-z]*|--in-place)(\s|=|$)' THEN 'edit by script'
          WHEN w.word IN ('cat', 'echo', 'printf') AND (s.cmd ~ '<<' OR s.cmd ~ '(^|[^0-9&>])>{1,2}[ \t]*[^&\s>/]') THEN 'edit by script'
          WHEN w.word IN ('cat', 'head', 'tail', 'less', 'more', 'wc', 'nl', 'sed', 'awk', 'file', 'stat', 'ls', 'tree', 'du', 'pwd',
            'realpath', 'readlink', 'diff', 'cmp', 'jq', 'sort', 'uniq', 'cut', 'od', 'xxd', 'hexdump', 'column', 'echo', 'printf') THEN 'read'
          WHEN w.word IN ('grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'locate') THEN 'search'
          WHEN w.word IN ('npm', 'npx', 'pnpm', 'yarn', 'node', 'kite', 'tsc', 'tsx', 'vitest', 'jest', 'mocha', 'pytest', 'make', 'cmake',
            'cargo', 'go', 'bun', 'deno', 'mvn', 'gradle', 'uv', 'pip', 'pip3', 'ruff', 'mypy', 'eslint', 'prettier', 'biome') THEN 'tests or build'
          WHEN w.word IN ('python', 'python3') AND s.cmd ~ '\s-m\s+(pytest|unittest|mypy|ruff|pip)(\s|$)' THEN 'tests or build'
          WHEN w.word IN ('git', 'gh') THEN 'git'
          WHEN w.word IN ('python', 'python3', 'perl', 'ruby', 'patch', 'tee', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'chmod', 'ln', 'truncate', 'dd')
            THEN 'edit by script'
          ELSE 'other' END AS class
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.result->'content') = 'array' THEN c.result->'content' ELSE '[]' END) WITH ORDINALITY AS b(v, ord)
      CROSS JOIN LATERAL (SELECT regexp_replace(regexp_replace(
          CASE WHEN jsonb_typeof(b.v->'input') = 'object' THEN coalesce(b.v->'input'->>'command', '') ELSE '' END,
          '^[ \t({]*((cd|pushd)[ \t]+[^;&|\n]*(&&|;)[ \t({]*)*', ''), '^([A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+)*', '') AS cmd) s
      CROSS JOIN LATERAL (SELECT regexp_replace(substring(s.cmd FROM '^([^\s;&|()<>{}]+)'), '^.*/', '') AS word) w
      WHERE b.v->>'type' = 'tool_use') t),
    -- The call's report, if it made one: its kind and a review's verdict, known values only.
    'rk', (SELECT CASE WHEN b.v->'input'->>'kind' IN ('done', 'ask', 'review') THEN b.v->'input'->>'kind' ELSE '(other)' END
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.result->'content') = 'array' THEN c.result->'content' ELSE '[]' END) WITH ORDINALITY AS b(v, ord)
      WHERE b.v->>'type' = 'tool_use' AND b.v->>'name' = 'report' ORDER BY b.ord DESC LIMIT 1),
    'rv', (SELECT CASE WHEN b.v->'input'->>'verdict' IN ('APPROVE', 'REQUEST_CHANGES') THEN b.v->'input'->>'verdict' END
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.result->'content') = 'array' THEN c.result->'content' ELSE '[]' END) WITH ORDINALITY AS b(v, ord)
      WHERE b.v->>'type' = 'tool_use' AND b.v->>'name' = 'report' AND b.v->'input'->>'kind' = 'review' ORDER BY b.ord DESC LIMIT 1)) AS k
  FROM coding_model_calls c
  -- `|| '{}'` makes one in-memory copy of the request that every field above reads, at this
  -- query level so no copy is kept between levels; OFFSET 0 keeps the planner from computing
  -- it again for each use.
  CROSS JOIN LATERAL (SELECT c.input || '{}'::jsonb AS i OFFSET 0) x
  WHERE c.job_id = :'profile_job'::uuid)
-- No ORDER BY here: sorting would carry each request copy through the sort. Every section
-- orders the calls itself.
SELECT coalesce(jsonb_agg(k), '[]')::text AS profile_calls, coalesce(bool_or(NOT shaped), false) AS profile_shapeless FROM k \gset
\if :ERROR
\echo 'The model calls could not be read in time; every figure taken from them is missing below.'
\endif
\if :profile_shapeless
\echo 'This job was recorded by the old coding loop (planner, OpenAI-shaped calls or host checks); this script reads only the one-session loop. Use the journal 172 draft for it.'
ROLLBACK;
\quit
\endif

\echo
\echo 'Approximate (what the host does not record exactly): a run''s duration and cost (usage records carry no call id, so they are matched to runs by time);'
\echo 'write_1h (from stored responses, so a billed call that did not finish is missing); thinking share (only where Anthropic reported thinking tokens);'
\echo 'an inbox item''s first_seen, and so whether a rebase was clean or conflicting, read from the inbox ids in each request''s newest messages;'
\echo 'coder runs and review rounds, from the order of the calls (a run the host continued in a new box counts once); "no change" for an earlier attempt (from the worker''s summary).'
\echo 'Exact: tokens, cost, machine time, owner waits, and the end causes the host records (lifetime, eight hours, crash and retry, ask, PR).'
\echo
\echo '1. Summary: wall time to the end (or now), owner waits, machine time from boxes, loop counts'
\x on
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
calls AS MATERIALIZED (
  SELECT (e->>'i')::uuid AS id, e->>'a' AS attempt, e->>'r' AS role, e->>'p' AS purpose, e->>'s' AS state,
    (e->>'t')::timestamptz AS created_at, e->>'c' AS candidate, (e->>'x')::numeric AS context, (e->>'w')::numeric AS write_1h,
    e->'tools' AS tools, e->>'rk' AS report_kind, e->>'rv' AS verdict, e->'ib' AS inbox
  FROM jsonb_array_elements(:'profile_calls'::jsonb) AS e),
-- A box the host continued (lifetime or crash retry) carries on the same run.
cont AS (
  SELECT split_part(request_key, ':', 2) AS attempt FROM coding_revisions
  WHERE job_id = :'profile_job'::uuid AND (request_key LIKE 'continue-box:%' OR request_key LIKE 'auto-retry:%')),
s AS (
  SELECT x.*, sum(CASE WHEN x.role IS DISTINCT FROM x.prev_role
      OR (x.attempt IS DISTINCT FROM x.prev_attempt AND x.prev_attempt NOT IN (SELECT attempt FROM cont)) THEN 1 ELSE 0 END)
    OVER (ORDER BY x.created_at, x.id) AS seg
  FROM (SELECT calls.*, lag(role) OVER w AS prev_role, lag(attempt) OVER w AS prev_attempt
    FROM calls WINDOW w AS (ORDER BY created_at, id)) x),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(t)) AS n, min(t) AS started, max(t) AS last_activity FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at AS t FROM coding_events
      WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt, created_at FROM calls
    UNION ALL SELECT substr(request_key, 8), created_at FROM boxes
      WHERE subject = 'coding:' || :'profile_job' AND request_key ~ '^coding:[0-9a-f-]{36}$') a GROUP BY attempt),
starts AS (
  SELECT v.created_at FROM coding_revisions v, j WHERE v.job_id = j.id
    AND v.request_key IN (SELECT e.id::text FROM coding_events e WHERE e.job_id = j.id AND e.payload->>'decision' = 'approved')),
act AS (
  SELECT created_at FROM coding_events WHERE job_id = :'profile_job'::uuid
  UNION ALL SELECT created_at FROM calls),
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
-- A rebase item reaches the coder only when git left conflicts (journal 193); a clean rebase
-- goes straight to review.
seen AS (SELECT DISTINCT jsonb_array_elements_text(inbox) AS id FROM calls WHERE role = 'coder')
SELECT left(j.id::text, 8) AS job, j.state, j.stage, j.revision,
  CASE WHEN j.settings->>'model' ~ '^[A-Za-z0-9._/:-]{1,120}$' THEN j.settings->>'model' ELSE '(other)' END AS coder_model,
  CASE WHEN j.settings->>'reviewerModel' ~ '^[A-Za-z0-9._/:-]{1,120}$' THEN j.settings->>'reviewerModel' ELSE '(other)' END AS reviewer_model,
  CASE WHEN j.settings->>'effort' IN ('low', 'medium', 'high', 'xhigh', 'max') THEN j.settings->>'effort' ELSE '(other)' END AS effort,
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
  (SELECT count(*) FROM att) AS attempts,
  (SELECT count(DISTINCT seg) FROM s WHERE role = 'coder') AS coder_runs,
  (SELECT count(DISTINCT seg) FROM s WHERE role = 'reviewer') AS review_rounds,
  (SELECT count(*) FROM calls WHERE role = 'reviewer' AND purpose = 'agent' AND verdict = 'REQUEST_CHANGES') AS findings_reports,
  (SELECT count(*) FROM calls WHERE role = 'reviewer' AND purpose = 'agent' AND verdict = 'APPROVE') AS approvals,
  (SELECT count(*) FROM coding_revisions WHERE job_id = j.id AND request_key LIKE 'rebase:%') AS rebases,
  (SELECT count(*) FROM coding_events e JOIN seen ON seen.id = e.id::text
    WHERE e.job_id = j.id AND e.event_key LIKE 'inbox:rebase:%') AS conflicting_rebases,
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


\echo '1c. Attempts (one per box): when, machine time, model calls and why each ended (the cause the host records)'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
calls AS MATERIALIZED (
  SELECT (e->>'i')::uuid AS id, e->>'a' AS attempt, e->>'r' AS role, e->>'p' AS purpose, e->>'s' AS state,
    (e->>'t')::timestamptz AS created_at, e->>'c' AS candidate, (e->>'x')::numeric AS context, (e->>'w')::numeric AS write_1h,
    e->'tools' AS tools, e->>'rk' AS report_kind, e->>'rv' AS verdict, e->'ib' AS inbox
  FROM jsonb_array_elements(:'profile_calls'::jsonb) AS e),
box AS (
  SELECT substr(b.request_key, 8) AS attempt, b.state, b.created_at,
    b.running_ms + CASE WHEN b.running_since IS NULL THEN 0 ELSE GREATEST(0, (extract(epoch FROM now() - b.running_since) * 1000)::bigint) END AS ms
  FROM boxes b WHERE b.subject = 'coding:' || :'profile_job' AND b.request_key ~ '^coding:[0-9a-f-]{36}$'),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(t)) AS n, min(t) AS started, max(t) AS last_activity FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at AS t FROM coding_events
      WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt, created_at FROM calls
    UNION ALL SELECT substr(request_key, 8), created_at FROM boxes
      WHERE subject = 'coding:' || :'profile_job' AND request_key ~ '^coding:[0-9a-f-]{36}$') a GROUP BY attempt),
e AS (SELECT event_key, payload FROM coding_events WHERE job_id = :'profile_job'::uuid),
v AS (SELECT request_key FROM coding_revisions WHERE job_id = :'profile_job'::uuid),
n AS (SELECT attempt, count(*) FILTER (WHERE role = 'coder') AS coder, count(*) FILTER (WHERE role = 'reviewer') AS reviewer FROM calls GROUP BY attempt)
SELECT a.n || ' ' || left(a.attempt, 8) AS attempt, coalesce(box.state, '(no box row)') AS box,
  round(extract(epoch FROM a.started - j.created_at) / 60, 1) AS start_min,
  round(extract(epoch FROM a.last_activity - a.started) / 60, 1) AS wall_min,
  round(box.ms / 60000.0, 1) AS machine_min,
  coalesce(n.coder, 0) AS coder_calls, coalesce(n.reviewer, 0) AS reviewer_calls,
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
FROM att a CROSS JOIN j LEFT JOIN box USING (attempt) LEFT JOIN n USING (attempt) ORDER BY a.n;

\echo '2. Cost and tokens by role and purpose (from model_usage records; write_1h from the stored responses of completed calls)'
WITH calls AS MATERIALIZED (
  SELECT (e->>'i')::uuid AS id, e->>'a' AS attempt, e->>'r' AS role, e->>'p' AS purpose, e->>'s' AS state,
    (e->>'t')::timestamptz AS created_at, e->>'c' AS candidate, (e->>'x')::numeric AS context, (e->>'w')::numeric AS write_1h,
    e->'tools' AS tools, e->>'rk' AS report_kind, e->>'rv' AS verdict, e->'ib' AS inbox
  FROM jsonb_array_elements(:'profile_calls'::jsonb) AS e),
u AS (
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
  SELECT CASE WHEN role IN ('coder', 'reviewer') THEN role ELSE '(other)' END, purpose,
    0, 0, 0::numeric, 0::numeric, 0::numeric, coalesce(write_1h, 0), 0::numeric, NULL::numeric, 0::numeric, 0::numeric
  FROM calls WHERE state = 'complete'),
r AS (SELECT * FROM u UNION ALL SELECT * FROM w)
SELECT CASE WHEN GROUPING(role) = 1 THEN 'total' ELSE role END AS role,
  CASE WHEN GROUPING(purpose) = 1 THEN '' ELSE purpose END AS purpose,
  sum(calls) AS calls, sum(incomplete) AS incomplete,
  sum(prompt - cache_read - cache_write) AS input, sum(cache_read) AS cache_read, sum(cache_write) AS cache_write,
  sum(write_1h) AS write_1h, sum(output) AS output, sum(thinking) AS thinking,
  round(100 * sum(thinking) / nullif(sum(output) FILTER (WHERE thinking IS NOT NULL), 0), 1) AS thinking_pct,
  round(sum(cost), 4) AS cost_usd, sum(dropped) AS thinking_dropped
FROM r GROUP BY GROUPING SETS ((role, purpose), ()) ORDER BY GROUPING(role), role, purpose;

\echo '3. The loop: each coder run and review round in order (a run is consecutive calls of one role, across a box the host continued it in)'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
calls AS MATERIALIZED (
  SELECT (e->>'i')::uuid AS id, e->>'a' AS attempt, e->>'r' AS role, e->>'p' AS purpose, e->>'s' AS state,
    (e->>'t')::timestamptz AS created_at, e->>'c' AS candidate, (e->>'x')::numeric AS context, (e->>'w')::numeric AS write_1h,
    e->'tools' AS tools, e->>'rk' AS report_kind, e->>'rv' AS verdict, e->'ib' AS inbox
  FROM jsonb_array_elements(:'profile_calls'::jsonb) AS e),
-- A box the host continued (lifetime or crash retry) carries on the same run.
cont AS (
  SELECT split_part(request_key, ':', 2) AS attempt FROM coding_revisions
  WHERE job_id = :'profile_job'::uuid AND (request_key LIKE 'continue-box:%' OR request_key LIKE 'auto-retry:%')),
s AS (
  SELECT x.*, sum(CASE WHEN x.role IS DISTINCT FROM x.prev_role
      OR (x.attempt IS DISTINCT FROM x.prev_attempt AND x.prev_attempt NOT IN (SELECT attempt FROM cont)) THEN 1 ELSE 0 END)
    OVER (ORDER BY x.created_at, x.id) AS seg
  FROM (SELECT calls.*, lag(role) OVER w AS prev_role, lag(attempt) OVER w AS prev_attempt
    FROM calls WINDOW w AS (ORDER BY created_at, id)) x),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(t)) AS n, min(t) AS started, max(t) AS last_activity FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at AS t FROM coding_events
      WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt, created_at FROM calls
    UNION ALL SELECT substr(request_key, 8), created_at FROM boxes
      WHERE subject = 'coding:' || :'profile_job' AND request_key ~ '^coding:[0-9a-f-]{36}$') a GROUP BY attempt),
seg AS (
  SELECT seg, min(role) AS role, min(created_at) AS started, max(created_at) AS last_call,
    count(*) FILTER (WHERE purpose = 'agent') AS agent, count(*) FILTER (WHERE purpose = 'cache_warm') AS warm,
    count(*) FILTER (WHERE purpose = 'compaction') AS compaction, count(*) FILTER (WHERE state <> 'complete') AS unfinished,
    min(candidate) AS candidate, count(DISTINCT candidate) AS candidates,
    (array_agg(report_kind ORDER BY created_at DESC, id DESC) FILTER (WHERE purpose = 'agent' AND report_kind IS NOT NULL))[1] AS report_kind,
    (array_agg(verdict ORDER BY created_at DESC, id DESC) FILTER (WHERE purpose = 'agent' AND report_kind IS NOT NULL))[1] AS verdict,
    min(att.n) AS first_attempt, max(att.n) AS last_attempt
  FROM s JOIN att USING (attempt) GROUP BY seg),
-- A usage record is written when its call's stream ends: it belongs to the latest run of its
-- role that started before it (runs only grow in number over time, so that is the largest
-- run number among the role's earlier calls).
u AS (
  SELECT payload->>'role' AS role, created_at, NULL::bigint AS seg,
    CASE WHEN jsonb_typeof(payload->'usage'->'cost') = 'number' THEN (payload->'usage'->>'cost')::numeric ELSE 0 END AS cost
  FROM coding_events WHERE job_id = :'profile_job'::uuid AND payload->>'kind' = 'model_usage'),
ua AS (
  SELECT role, created_at, cost, max(seg) OVER (PARTITION BY role ORDER BY created_at, seg NULLS LAST ROWS UNBOUNDED PRECEDING) AS seg
  FROM (SELECT role, created_at, seg, 0::numeric AS cost FROM s UNION ALL SELECT role, created_at, seg, cost FROM u) x),
ucost AS (SELECT seg, sum(cost) AS cost, max(created_at) AS last_usage FROM ua WHERE cost <> 0 OR seg IS NOT NULL GROUP BY seg)
SELECT CASE seg.role WHEN 'coder' THEN 'coder run ' WHEN 'reviewer' THEN 'review round ' ELSE '(other) ' END
    || row_number() OVER (PARTITION BY seg.role ORDER BY seg.started) AS run,
  seg.first_attempt || CASE WHEN seg.last_attempt > seg.first_attempt THEN '-' || seg.last_attempt ELSE '' END AS attempt,
  round(extract(epoch FROM seg.started - j.created_at) / 60, 1) AS start_min,
  round(extract(epoch FROM GREATEST(seg.last_call, ucost.last_usage) - seg.started) / 60, 1) AS minutes,
  seg.agent AS agent_calls, seg.warm AS cache_warm, seg.compaction, seg.unfinished,
  round(coalesce(ucost.cost, 0), 4) AS cost_usd,
  CASE WHEN seg.report_kind = 'review' AND seg.verdict IN ('APPROVE', 'REQUEST_CHANGES') THEN seg.verdict
    WHEN seg.report_kind IN ('done', 'ask') THEN seg.report_kind WHEN seg.report_kind IS NOT NULL THEN '(other)' END AS report,
  left(seg.candidate, 12) || CASE WHEN seg.candidates > 1 THEN ' (+' || (seg.candidates - 1) || ')' ELSE '' END AS candidate
FROM seg CROSS JOIN j LEFT JOIN ucost USING (seg) ORDER BY seg.started;

\echo '3b. Milestones: Start, boxes continued or retried, rebases, publication, PR and its feedback rounds'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
calls AS MATERIALIZED (
  SELECT (e->>'i')::uuid AS id, e->>'a' AS attempt, e->>'r' AS role, e->>'p' AS purpose, e->>'s' AS state,
    (e->>'t')::timestamptz AS created_at, e->>'c' AS candidate, (e->>'x')::numeric AS context, (e->>'w')::numeric AS write_1h,
    e->'tools' AS tools, e->>'rk' AS report_kind, e->>'rv' AS verdict, e->'ib' AS inbox
  FROM jsonb_array_elements(:'profile_calls'::jsonb) AS e),
att AS (
  SELECT attempt, row_number() OVER (ORDER BY min(t)) AS n, min(t) AS started, max(t) AS last_activity FROM (
    SELECT split_part(event_key, ':', 1) AS attempt, created_at AS t FROM coding_events
      WHERE job_id = :'profile_job'::uuid AND event_key ~ '^[0-9a-f-]{36}:'
    UNION ALL SELECT attempt, created_at FROM calls
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
calls AS MATERIALIZED (
  SELECT (e->>'i')::uuid AS id, e->>'a' AS attempt, e->>'r' AS role, e->>'p' AS purpose, e->>'s' AS state,
    (e->>'t')::timestamptz AS created_at, e->>'c' AS candidate, (e->>'x')::numeric AS context, (e->>'w')::numeric AS write_1h,
    e->'tools' AS tools, e->>'rk' AS report_kind, e->>'rv' AS verdict, e->'ib' AS inbox
  FROM jsonb_array_elements(:'profile_calls'::jsonb) AS e),
i AS (
  SELECT e.id, e.created_at, e.payload ? 'heldBy' AS held,
    CASE WHEN jsonb_typeof(e.payload->'seq') = 'number' THEN (e.payload->>'seq')::numeric ELSE 0 END AS seq,
    CASE WHEN e.payload->>'source' IN ('owner', 'ask', 'ci', 'review', 'chief', 'rebase') THEN e.payload->>'source' ELSE '(other)' END AS source
  FROM coding_events e WHERE e.job_id = :'profile_job'::uuid AND e.event_key LIKE 'inbox:%'),
seen AS (
  SELECT DISTINCT ON (x.id) x.id, calls.created_at, calls.role
  FROM calls CROSS JOIN LATERAL jsonb_array_elements_text(calls.inbox) AS x(id)
  ORDER BY x.id, calls.created_at, calls.id)
SELECT i.source, round(extract(epoch FROM i.created_at - j.created_at) / 60, 1) AS at_min, i.held,
  coalesce(j.checkpoint->'piState'->'delivered', '[]'::jsonb) ? i.id::text AS delivered,
  round(extract(epoch FROM seen.created_at - j.created_at) / 60, 1) AS first_seen_min, seen.role AS seen_by
FROM i CROSS JOIN j LEFT JOIN seen ON seen.id = i.id::text
-- The host's own inbox order (CodingController.inbox).
ORDER BY i.created_at, i.seq, i.id;

\echo '3d. Rebases onto main: clean (straight to review) or conflicting (the coder resolved them), and the review round that followed'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
calls AS MATERIALIZED (
  SELECT (e->>'i')::uuid AS id, e->>'a' AS attempt, e->>'r' AS role, e->>'p' AS purpose, e->>'s' AS state,
    (e->>'t')::timestamptz AS created_at, e->>'c' AS candidate, (e->>'x')::numeric AS context, (e->>'w')::numeric AS write_1h,
    e->'tools' AS tools, e->>'rk' AS report_kind, e->>'rv' AS verdict, e->'ib' AS inbox
  FROM jsonb_array_elements(:'profile_calls'::jsonb) AS e),
-- A box the host continued (lifetime or crash retry) carries on the same run.
cont AS (
  SELECT split_part(request_key, ':', 2) AS attempt FROM coding_revisions
  WHERE job_id = :'profile_job'::uuid AND (request_key LIKE 'continue-box:%' OR request_key LIKE 'auto-retry:%')),
s AS (
  SELECT x.*, sum(CASE WHEN x.role IS DISTINCT FROM x.prev_role
      OR (x.attempt IS DISTINCT FROM x.prev_attempt AND x.prev_attempt NOT IN (SELECT attempt FROM cont)) THEN 1 ELSE 0 END)
    OVER (ORDER BY x.created_at, x.id) AS seg
  FROM (SELECT calls.*, lag(role) OVER w AS prev_role, lag(attempt) OVER w AS prev_attempt
    FROM calls WINDOW w AS (ORDER BY created_at, id)) x),
rounds AS (
  SELECT seg, min(created_at) AS started, row_number() OVER (ORDER BY min(created_at)) AS n,
    (array_agg(verdict ORDER BY created_at DESC, id DESC) FILTER (WHERE purpose = 'agent' AND report_kind = 'review'))[1] AS verdict
  FROM s WHERE role = 'reviewer' GROUP BY seg),
told AS (
  SELECT x.id, min(calls.created_at) AS at
  FROM calls CROSS JOIN LATERAL jsonb_array_elements_text(calls.inbox) AS x(id) WHERE calls.role = 'coder' GROUP BY x.id),
r AS (
  SELECT e.id, e.created_at, CASE WHEN e.payload->>'onto' ~ '^[0-9a-f]{40}$' THEN left(e.payload->>'onto', 12) END AS onto, told.at AS coder_saw
  FROM coding_events e LEFT JOIN told ON told.id = e.id::text
  WHERE e.job_id = :'profile_job'::uuid AND e.event_key LIKE 'inbox:rebase:%')
SELECT round(extract(epoch FROM r.created_at - j.created_at) / 60, 1) AS at_min, r.onto,
  CASE WHEN r.coder_saw IS NOT NULL THEN 'conflicting' WHEN f.n IS NOT NULL THEN 'clean' ELSE '(not yet rebased)' END AS kind,
  round(extract(epoch FROM r.coder_saw - j.created_at) / 60, 1) AS coder_told_min,
  f.n AS review_round, round(extract(epoch FROM f.started - j.created_at) / 60, 1) AS review_start_min, f.verdict
FROM r CROSS JOIN j
LEFT JOIN LATERAL (SELECT rounds.n, rounds.started, rounds.verdict FROM rounds WHERE rounds.started > coalesce(r.coder_saw, r.created_at)
  ORDER BY rounds.started LIMIT 1) f ON true
ORDER BY r.created_at, r.id;

\echo '4. Tool use per assistant turn (completed agent calls; Anthropic tool_use blocks)'
WITH calls AS MATERIALIZED (
  SELECT (e->>'i')::uuid AS id, e->>'a' AS attempt, e->>'r' AS role, e->>'p' AS purpose, e->>'s' AS state,
    (e->>'t')::timestamptz AS created_at, e->>'c' AS candidate, (e->>'x')::numeric AS context, (e->>'w')::numeric AS write_1h,
    e->'tools' AS tools, e->>'rk' AS report_kind, e->>'rv' AS verdict, e->'ib' AS inbox
  FROM jsonb_array_elements(:'profile_calls'::jsonb) AS e)
SELECT role, count(*) AS turns, count(*) FILTER (WHERE jsonb_array_length(tools) = 0) AS no_tool,
  count(*) FILTER (WHERE jsonb_array_length(tools) = 1) AS one, count(*) FILTER (WHERE jsonb_array_length(tools) = 2) AS two,
  count(*) FILTER (WHERE jsonb_array_length(tools) >= 3) AS three_or_more,
  sum(jsonb_array_length(tools)) AS tool_calls, max(jsonb_array_length(tools)) AS most_in_one_turn
FROM calls WHERE state = 'complete' AND purpose = 'agent' GROUP BY role ORDER BY role;

\echo '4b. Tool calls by name (a name that is not one of Pi''s tools or report is shown as (other))'
WITH calls AS MATERIALIZED (
  SELECT (e->>'i')::uuid AS id, e->>'a' AS attempt, e->>'r' AS role, e->>'p' AS purpose, e->>'s' AS state,
    (e->>'t')::timestamptz AS created_at, e->>'c' AS candidate, (e->>'x')::numeric AS context, (e->>'w')::numeric AS write_1h,
    e->'tools' AS tools, e->>'rk' AS report_kind, e->>'rv' AS verdict, e->'ib' AS inbox
  FROM jsonb_array_elements(:'profile_calls'::jsonb) AS e),
t AS (SELECT calls.role, x.v->>0 AS tool FROM calls CROSS JOIN LATERAL jsonb_array_elements(calls.tools) AS x(v)
  WHERE calls.state = 'complete' AND calls.purpose = 'agent')
SELECT role, tool, count(*) AS calls FROM t GROUP BY role, tool ORDER BY role, count(*) DESC, tool;

\echo '4c. bash commands by class, from the first program word against a fixed list (no command text is printed)'
WITH calls AS MATERIALIZED (
  SELECT (e->>'i')::uuid AS id, e->>'a' AS attempt, e->>'r' AS role, e->>'p' AS purpose, e->>'s' AS state,
    (e->>'t')::timestamptz AS created_at, e->>'c' AS candidate, (e->>'x')::numeric AS context, (e->>'w')::numeric AS write_1h,
    e->'tools' AS tools, e->>'rk' AS report_kind, e->>'rv' AS verdict, e->'ib' AS inbox
  FROM jsonb_array_elements(:'profile_calls'::jsonb) AS e),
t AS (SELECT calls.role, x.v->>1 AS class FROM calls CROSS JOIN LATERAL jsonb_array_elements(calls.tools) AS x(v)
  WHERE calls.state = 'complete' AND calls.purpose = 'agent' AND x.v->>0 = 'bash')
SELECT role, class, count(*) AS calls FROM t GROUP BY role, class ORDER BY role, count(*) DESC, class;

\echo '4d. The coder''s exploration: agent calls before its first edit or write, and the largest request context per role'
WITH j AS (SELECT * FROM coding_jobs WHERE id = :'profile_job'::uuid),
calls AS MATERIALIZED (
  SELECT (e->>'i')::uuid AS id, e->>'a' AS attempt, e->>'r' AS role, e->>'p' AS purpose, e->>'s' AS state,
    (e->>'t')::timestamptz AS created_at, e->>'c' AS candidate, (e->>'x')::numeric AS context, (e->>'w')::numeric AS write_1h,
    e->'tools' AS tools, e->>'rk' AS report_kind, e->>'rv' AS verdict, e->'ib' AS inbox
  FROM jsonb_array_elements(:'profile_calls'::jsonb) AS e),
c AS (
  SELECT role, created_at, context, row_number() OVER (PARTITION BY role ORDER BY created_at, id) AS n,
    tools @> '[["edit"]]' OR tools @> '[["write"]]' AS edits
  FROM calls WHERE purpose = 'agent'),
firsts AS (SELECT role, min(n) - 1 AS before_edit, min(created_at) AS at FROM c WHERE edits GROUP BY role),
largest AS (SELECT DISTINCT ON (role) role, created_at FROM c WHERE context IS NOT NULL ORDER BY role, context DESC, created_at)
SELECT c.role, count(*) AS agent_calls, min(firsts.before_edit) AS calls_before_first_edit,
  round(extract(epoch FROM min(firsts.at) - min(c.created_at)) / 60, 1) AS min_to_first_edit,
  max(c.context) AS largest_context,
  round(extract(epoch FROM min(largest.created_at) - min(j.created_at)) / 60, 1) AS largest_at_min
FROM c CROSS JOIN j LEFT JOIN firsts USING (role) LEFT JOIN largest USING (role) GROUP BY c.role ORDER BY c.role;

\echo '5. Context per agent call (input + cache read + cache write) by run, and Pi''s compactions'
WITH calls AS MATERIALIZED (
  SELECT (e->>'i')::uuid AS id, e->>'a' AS attempt, e->>'r' AS role, e->>'p' AS purpose, e->>'s' AS state,
    (e->>'t')::timestamptz AS created_at, e->>'c' AS candidate, (e->>'x')::numeric AS context, (e->>'w')::numeric AS write_1h,
    e->'tools' AS tools, e->>'rk' AS report_kind, e->>'rv' AS verdict, e->'ib' AS inbox
  FROM jsonb_array_elements(:'profile_calls'::jsonb) AS e),
-- A box the host continued (lifetime or crash retry) carries on the same run.
cont AS (
  SELECT split_part(request_key, ':', 2) AS attempt FROM coding_revisions
  WHERE job_id = :'profile_job'::uuid AND (request_key LIKE 'continue-box:%' OR request_key LIKE 'auto-retry:%')),
s AS (
  SELECT x.*, sum(CASE WHEN x.role IS DISTINCT FROM x.prev_role
      OR (x.attempt IS DISTINCT FROM x.prev_attempt AND x.prev_attempt NOT IN (SELECT attempt FROM cont)) THEN 1 ELSE 0 END)
    OVER (ORDER BY x.created_at, x.id) AS seg
  FROM (SELECT calls.*, lag(role) OVER w AS prev_role, lag(attempt) OVER w AS prev_attempt
    FROM calls WINDOW w AS (ORDER BY created_at, id)) x),
r AS (SELECT seg, role, dense_rank() OVER (PARTITION BY role ORDER BY seg) AS run FROM (SELECT DISTINCT seg, role FROM s) x),
x AS (SELECT s.role, r.run, s.created_at, s.purpose, s.context FROM s JOIN r USING (seg, role))
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
calls AS MATERIALIZED (
  SELECT (e->>'i')::uuid AS id, e->>'a' AS attempt, e->>'r' AS role, e->>'p' AS purpose, e->>'s' AS state,
    (e->>'t')::timestamptz AS created_at, e->>'c' AS candidate, (e->>'x')::numeric AS context, (e->>'w')::numeric AS write_1h,
    e->'tools' AS tools, e->>'rk' AS report_kind, e->>'rv' AS verdict, e->'ib' AS inbox
  FROM jsonb_array_elements(:'profile_calls'::jsonb) AS e)
SELECT k.role, round(extract(epoch FROM k.created_at - j.created_at) / 60, 1) AS at_min, k.state, k.context AS summarised_context,
  (SELECT n.context FROM calls n WHERE n.role = k.role AND n.purpose = 'agent' AND n.created_at > k.created_at ORDER BY n.created_at LIMIT 1) AS next_context
FROM calls k CROSS JOIN j WHERE k.purpose = 'compaction' ORDER BY k.created_at;

ROLLBACK;
