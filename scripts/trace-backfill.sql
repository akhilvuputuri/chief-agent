-- Trace backfill rows (docs/tracing.md#backfilling-history): one JSON object per runtime run
-- started in [since, until), for src/trace-backfill.ts. Read-only: one SELECT, no writes, no
-- temporary tables. Set the window with psql variables at the top of the input, e.g.
--   \set since '2026-09-06T00:00:00Z'
--   \set until '2026-10-29T15:00:00Z'
-- The output holds the owner's messages, replies and tool payloads: keep it private.
WITH runs AS (
  SELECT r.id, r.user_id, r.task_id, r.state, r.stop_reason, r.started_at, r.updated_at
  FROM runtime_runs r
  WHERE r.started_at >= :'since'::timestamptz AND r.started_at < :'until'::timestamptz
),
-- The owner's input messages consumed by each run, in arrival order.
inputs AS (
  SELECT i.run_id,
    json_agg(json_build_object(
      'message', i.message,
      'thread_id', i.metadata->'threadId',
      'received_at', i.received_at,
      'ordinal', i.ordinal
    ) ORDER BY i.ordinal) AS list
  FROM conversation_inputs i
  JOIN runs r ON r.id = i.run_id AND r.user_id = i.user_id
  GROUP BY i.run_id
),
-- The last delivered reply of each run: an assistant message without tool calls.
replies AS (
  SELECT DISTINCT ON (m.run_id) m.run_id, left(c.payload->>'content', 40000) AS reply
  FROM conversation_messages m
  JOIN runs r ON r.id = m.run_id AND r.user_id = m.user_id
  JOIN message_contents c ON c.user_id = m.user_id AND c.hash = m.hash
  WHERE m.delivery_state IN ('sent', 'recorded')
    AND c.payload->>'role' = 'assistant'
    AND NOT (c.payload ? 'tool_calls')
  ORDER BY m.run_id, m.ordinal DESC
)
SELECT json_build_object(
  'run_id', r.id,
  'user_id', r.user_id,
  'task_id', r.task_id,
  'state', r.state,
  'stop_reason', r.stop_reason,
  'started_at', r.started_at,
  'updated_at', r.updated_at,
  'stopped_at', ev.stopped_at,
  'stop_event_reason', ev.stop_event_reason,
  'failed_at', ev.failed_at,
  'child_event', ev.child_event,
  'parent_run_id', ev.parent_run_id,
  'child_type', ev.child_type,
  'model_events', coalesce(ev.model_events, '[]'::json),
  'calls', coalesce(calls.list, '[]'::json),
  'inputs', coalesce(inputs.list, '[]'::json),
  'reply', replies.reply
)::text AS j
FROM runs r
-- One pass over the run's events (index events_run).
LEFT JOIN LATERAL (
  SELECT
    (array_agg(e.created_at ORDER BY e.id) FILTER (WHERE e.type = 'runtime.stopped'))[1] AS stopped_at,
    (array_agg(e.data->>'stopReason' ORDER BY e.id) FILTER (WHERE e.type = 'runtime.stopped'))[1] AS stop_event_reason,
    (array_agg(e.created_at ORDER BY e.id) FILTER (WHERE e.type = 'turn.failed'))[1] AS failed_at,
    (array_agg(e.type ORDER BY e.id) FILTER (WHERE e.type IN ('agent.child_started', 'research.child_started')))[1] AS child_event,
    (array_agg(e.data->>'parentRunId' ORDER BY e.id) FILTER (WHERE e.type IN ('agent.child_started', 'research.child_started')))[1] AS parent_run_id,
    (array_agg(e.data->>'type' ORDER BY e.id) FILTER (WHERE e.type = 'agent.child_started'))[1] AS child_type,
    json_agg(json_build_object('type', e.type, 'created_at', e.created_at, 'data', e.data) ORDER BY e.id)
      FILTER (WHERE e.type IN ('model.started', 'model.completed', 'model.failed')) AS model_events
  FROM events e
  WHERE e.run_id = r.id AND e.user_id = r.user_id
    AND e.type IN ('runtime.stopped', 'turn.failed', 'agent.child_started', 'research.child_started',
                   'model.started', 'model.completed', 'model.failed')
) ev ON true
-- Tool calls (index on runtime_calls(run_id, call_id)); payloads capped.
LEFT JOIN LATERAL (
  SELECT json_agg(json_build_object(
    'id', c.id,
    'call_id', c.call_id,
    'operation', c.operation,
    'is_write', c.is_write,
    'state', c.state,
    'arguments', left(c.arguments::text, 40000),
    'result', left(c.result::text, 40000),
    -- As Execution.endCall reads it: a string error code only.
    'error_code', CASE WHEN jsonb_typeof(c.result->'error'->'code') = 'string'
                       THEN c.result->'error'->>'code' END,
    'started_at', c.started_at,
    'finished_at', c.finished_at
  ) ORDER BY c.started_at, c.id) AS list
  FROM runtime_calls c
  WHERE c.run_id = r.id
) calls ON true
LEFT JOIN inputs ON inputs.run_id = r.id
LEFT JOIN replies ON replies.run_id = r.id
ORDER BY r.started_at, r.id;
