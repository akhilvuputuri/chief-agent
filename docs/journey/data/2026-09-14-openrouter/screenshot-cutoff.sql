WITH charges AS (
 SELECT CASE WHEN created_at<='2026-09-12T17:32:30Z' THEN 'at_or_before_screenshot' ELSE 'after_screenshot' END AS period,
 CASE provider WHEN 'openrouter-main' THEN 'main' WHEN 'openrouter-search-exa' THEN 'search' ELSE 'other' END AS channel,
 actual_usd,usage
 FROM public.provider_charges WHERE created_at>='2026-09-12T00:00:00Z' AND created_at<'2026-09-13T00:00:00Z'
), events AS (
 SELECT CASE WHEN created_at<='2026-09-12T17:32:30Z' THEN 'at_or_before_screenshot' ELSE 'after_screenshot' END AS period,data->'usage' AS usage
 FROM public.events WHERE type='model.completed' AND created_at>='2026-09-12T00:00:00Z' AND created_at<'2026-09-13T00:00:00Z'
)
SELECT json_build_object(
 'captured_at_utc',now(),
 'screenshot_filename_inferred_cutoff_utc','2026-09-12T17:32:30Z',
 'cutoff_provenance','Cutoff inferred from the owner-supplied screenshot filename; query verifies numeric production usage around this cutoff, not screenshot creation metadata.',
 'charge_day_utc','2026-09-12',
 'ledger',(SELECT json_agg(x ORDER BY period,channel) FROM (
  SELECT period,channel,count(*) AS reservations,count(actual_usd) AS known_cost_records,sum(actual_usd) AS reported_usd,
   sum(CASE WHEN jsonb_typeof(usage->'prompt_tokens')='number' THEN (usage->>'prompt_tokens')::bigint END) AS prompt_tokens,
   sum(CASE WHEN jsonb_typeof(usage->'completion_tokens')='number' THEN (usage->>'completion_tokens')::bigint END) AS completion_tokens
  FROM charges GROUP BY period,channel
 ) x),
 'model_completed_events_overlap_ledger',(SELECT json_agg(x ORDER BY period) FROM (
  SELECT period,count(*) AS completed_calls,sum(CASE WHEN jsonb_typeof(usage->'cost')='number' THEN (usage->>'cost')::numeric END) AS reported_usd
  FROM events GROUP BY period
 ) x)
)
