WITH
all_runs AS (
 SELECT 'public'::text AS source_scope,id,started_at,updated_at,model,state,stop_reason,used_models,used_tools,used_ms FROM public.runtime_runs
 UNION ALL
 SELECT 'reset_archive_20260907',id,started_at,updated_at,model,state,stop_reason,used_models,used_tools,used_ms FROM reset_archive_20260907.runtime_runs
),
runs AS (
 SELECT *,row_number() OVER (ORDER BY started_at,source_scope,id) AS run_ordinal FROM all_runs
),
all_events AS (
 SELECT 'public'::text AS source_scope,id,run_id,type,created_at,data FROM public.events
 WHERE type IN ('model.completed','model.started','model.failed','research.child_started','conversation.routed')
 UNION ALL
 SELECT 'reset_archive_20260907',id,run_id,type,created_at,data FROM reset_archive_20260907.events
 WHERE type IN ('model.completed','model.started','model.failed','research.child_started','conversation.routed')
),
model_events AS (
 SELECT e.*,e.data->'usage' AS usage,r.run_ordinal,
 row_number() OVER (ORDER BY e.created_at,e.source_scope,e.id) AS event_ordinal
 FROM all_events e LEFT JOIN runs r ON r.source_scope=e.source_scope AND r.id=e.run_id
 WHERE e.type='model.completed' AND e.created_at>='2026-09-04T16:00:00Z' AND e.created_at<'2026-09-15T00:00:00Z'
),
charges AS (
 SELECT c.*,r.run_ordinal,r.model AS run_last_recorded_model,
 row_number() OVER (ORDER BY c.created_at,c.id) AS charge_ordinal
 FROM public.provider_charges c JOIN runs r ON r.source_scope='public' AND r.id=c.run_id
 WHERE c.created_at>='2026-09-04T16:00:00Z' AND c.created_at<'2026-09-15T00:00:00Z'
),
charge_rows AS (
 SELECT charge_ordinal,run_ordinal,
 CASE provider WHEN 'openrouter-main' THEN 'main' WHEN 'openrouter-search-exa' THEN 'search' WHEN 'tavily' THEN 'tavily' ELSE 'other' END AS channel,
 CASE WHEN provider='openrouter-main' THEN run_last_recorded_model ELSE NULL END AS run_last_recorded_main_model,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day_utc,
 to_char(created_at AT TIME ZONE 'Asia/Singapore','YYYY-MM-DD') AS day_sgt,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:00') AS hour_utc,
 to_char(created_at AT TIME ZONE 'Asia/Singapore','YYYY-MM-DD HH24:00') AS hour_sgt,
 estimated_usd,actual_usd,jsonb_typeof(usage) AS usage_json_type,
 CASE WHEN jsonb_typeof(usage->'cost')='number' THEN (usage->>'cost')::numeric END AS usage_cost_usd,
 CASE WHEN jsonb_typeof(usage->'prompt_tokens')='number' THEN (usage->>'prompt_tokens')::bigint END AS prompt_tokens,
 CASE WHEN jsonb_typeof(usage->'completion_tokens')='number' THEN (usage->>'completion_tokens')::bigint END AS completion_tokens,
 CASE WHEN jsonb_typeof(usage->'total_tokens')='number' THEN (usage->>'total_tokens')::bigint END AS total_tokens,
 CASE WHEN jsonb_typeof(usage->'prompt_tokens_details'->'cached_tokens')='number' THEN (usage->'prompt_tokens_details'->>'cached_tokens')::bigint END AS cached_prompt_tokens,
 CASE WHEN jsonb_typeof(usage->'prompt_tokens_details'->'cache_write_tokens')='number' THEN (usage->'prompt_tokens_details'->>'cache_write_tokens')::bigint END AS cache_write_tokens,
 CASE WHEN jsonb_typeof(usage->'completion_tokens_details'->'reasoning_tokens')='number' THEN (usage->'completion_tokens_details'->>'reasoning_tokens')::bigint END AS reasoning_tokens
 FROM charges
),
event_rows AS (
 SELECT source_scope,event_ordinal,run_ordinal,data->>'model' AS recorded_model,data->>'provider' AS recorded_provider,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day_utc,
 to_char(created_at AT TIME ZONE 'Asia/Singapore','YYYY-MM-DD') AS day_sgt,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:00') AS hour_utc,
 to_char(created_at AT TIME ZONE 'Asia/Singapore','YYYY-MM-DD HH24:00') AS hour_sgt,
 created_at < (SELECT min(created_at) FROM public.provider_charges) AS before_first_ledger_record,
 EXISTS(SELECT 1 FROM public.provider_charges c WHERE c.run_id=model_events.run_id AND c.provider='openrouter-main') AS run_has_main_ledger_rows,
 CASE WHEN jsonb_typeof(data->'latencyMs')='number' THEN (data->>'latencyMs')::bigint END AS model_event_latency_ms,
 jsonb_typeof(usage) AS usage_json_type,
 CASE WHEN jsonb_typeof(usage->'cost')='number' THEN (usage->>'cost')::numeric END AS usage_cost_usd,
 CASE WHEN jsonb_typeof(usage->'prompt_tokens')='number' THEN (usage->>'prompt_tokens')::bigint END AS prompt_tokens,
 CASE WHEN jsonb_typeof(usage->'completion_tokens')='number' THEN (usage->>'completion_tokens')::bigint END AS completion_tokens,
 CASE WHEN jsonb_typeof(usage->'total_tokens')='number' THEN (usage->>'total_tokens')::bigint END AS total_tokens,
 CASE WHEN jsonb_typeof(usage->'prompt_tokens_details'->'cached_tokens')='number' THEN (usage->'prompt_tokens_details'->>'cached_tokens')::bigint END AS cached_prompt_tokens,
 CASE WHEN jsonb_typeof(usage->'prompt_tokens_details'->'cache_write_tokens')='number' THEN (usage->'prompt_tokens_details'->>'cache_write_tokens')::bigint END AS cache_write_tokens,
 CASE WHEN jsonb_typeof(usage->'completion_tokens_details'->'reasoning_tokens')='number' THEN (usage->'completion_tokens_details'->>'reasoning_tokens')::bigint END AS reasoning_tokens
 FROM model_events
),
run_rows AS (
 SELECT r.source_scope,r.run_ordinal,r.model AS last_recorded_model,
 to_char(r.started_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:00') AS started_hour_utc,
 to_char(r.started_at AT TIME ZONE 'Asia/Singapore','YYYY-MM-DD HH24:00') AS started_hour_sgt,
 CASE WHEN r.state IN ('running','stopped','failed','completed') THEN r.state ELSE 'other' END AS state,
 CASE WHEN r.stop_reason IN ('answer','awaiting_user','awaiting_approval','budget','cancelled','yield','error','interrupted','restart','runtime_cutover','context_limit','task_handoff') THEN r.stop_reason WHEN r.stop_reason IS NULL THEN NULL ELSE 'other' END AS stop_reason,
 r.used_models,r.used_tools,r.used_ms AS accounted_runtime_ms,
 round(EXTRACT(EPOCH FROM r.updated_at-r.started_at)*1000) AS row_lifetime_ms,
 CASE WHEN EXISTS(SELECT 1 FROM all_events e WHERE e.source_scope=r.source_scope AND e.run_id=r.id AND e.type='research.child_started') THEN 'delegated'
 WHEN EXISTS(SELECT 1 FROM all_events e WHERE e.source_scope=r.source_scope AND e.run_id=r.id AND e.type='conversation.routed' AND e.data->>'lane'='job') THEN 'job'
 WHEN EXISTS(SELECT 1 FROM all_events e WHERE e.source_scope=r.source_scope AND e.run_id=r.id AND e.type='conversation.routed' AND e.data->>'lane'='foreground') THEN 'foreground' ELSE 'unclassified' END AS recorded_lane,
 (SELECT count(*) FROM model_events e WHERE e.source_scope=r.source_scope AND e.run_id=r.id) AS completed_model_events,
 (SELECT count(*) FROM all_events e WHERE e.source_scope=r.source_scope AND e.run_id=r.id AND e.type='model.started') AS started_model_events,
 (SELECT count(*) FROM all_events e WHERE e.source_scope=r.source_scope AND e.run_id=r.id AND e.type='model.failed') AS failed_model_events,
 (SELECT count(*) FROM charges c WHERE c.run_id=r.id AND r.source_scope='public') AS ledger_rows
 FROM runs r WHERE r.started_at>='2026-09-04T16:00:00Z' AND r.started_at<'2026-09-15T00:00:00Z'
)
SELECT json_build_object(
 'captured_at_utc',now(),
 'window_start_utc','2026-09-04T16:00:00Z',
 'window_end_exclusive_utc','2026-09-15T00:00:00Z',
 'method','Numeric projections in a read-only transaction; both UTC and Asia/Singapore buckets. Charge times are request-begin times; model-event times are completion-record times. Run and row ordinals replace identifiers. Main ledger and overlapping model events must not be added.',
 'charge_rows',(SELECT json_agg(x ORDER BY charge_ordinal) FROM charge_rows x),
 'model_event_rows',(SELECT json_agg(x ORDER BY event_ordinal) FROM event_rows x),
 'run_rows',(SELECT json_agg(x ORDER BY run_ordinal) FROM run_rows x),
 'source_coverage',(SELECT json_agg(x ORDER BY source_scope,event_type) FROM (
   SELECT source_scope,type AS event_type,count(*) AS event_count,min(created_at) AS earliest_utc,max(created_at) AS latest_utc FROM all_events WHERE type IN ('model.completed','model.started','model.failed') GROUP BY source_scope,type
 ) x),
 'archive_overlap',json_build_object(
   'same_model_event_id_in_public_and_archive',(SELECT count(*) FROM public.events p JOIN reset_archive_20260907.events a ON a.id=p.id WHERE p.type='model.completed' AND a.type='model.completed'),
   'same_run_id_in_public_and_archive',(SELECT count(*) FROM public.runtime_runs p JOIN reset_archive_20260907.runtime_runs a ON a.id=p.id)
 ),
 'search_call_coverage',(SELECT json_agg(x ORDER BY source_scope) FROM (
   SELECT 'public' AS source_scope,count(*) AS calls,count(*) FILTER(WHERE state='success') AS succeeded,
     count(*) FILTER(WHERE result->'result'->>'cacheHit'='true') AS cache_hits,min(started_at) AS earliest_utc,max(started_at) AS latest_utc,
     count(*) FILTER(WHERE jsonb_typeof(result->'result'->'usage')='object') AS result_usage_objects
   FROM public.runtime_calls WHERE operation='web_search'
   UNION ALL
   SELECT 'reset_archive_20260907',count(*),count(*) FILTER(WHERE state='success'),count(*) FILTER(WHERE result->'result'->>'cacheHit'='true'),min(started_at),max(started_at),count(*) FILTER(WHERE jsonb_typeof(result->'result'->'usage')='object')
   FROM reset_archive_20260907.runtime_calls WHERE operation='web_search'
 ) x)
)
