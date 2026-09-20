-- Counts-only diagnostics for the NLB library assistant. No tokens, ids, titles or bodies.
SELECT 'identity' AS what, state AS value, count(*)::text AS n FROM library_identities GROUP BY state
UNION ALL SELECT 'approvals', operation || ':' || status || ':' || COALESCE(payload->>'execution',''), count(*)::text FROM approvals WHERE operation LIKE 'library\_%' GROUP BY 2
UNION ALL SELECT 'attempts', state, count(*)::text FROM library_link_attempts GROUP BY state
UNION ALL SELECT 'calls_today', kind || ':' || outcome, count(*)::text FROM library_calls WHERE created_at > now() - interval '1 day' GROUP BY 2
UNION ALL SELECT 'call_days', day::text, calls::text || ' calls, ' || link_polls::text || ' polls, ' || refused::text || ' refused' FROM library_call_days WHERE day > current_date - 7
UNION ALL SELECT 'breaker', COALESCE(breaker_reason,'closed'), COALESCE(breaker_open_until::text,'') FROM library_pacing
UNION ALL SELECT 'watch', status, count(*)::text FROM library_watch GROUP BY status
ORDER BY 1,2;
