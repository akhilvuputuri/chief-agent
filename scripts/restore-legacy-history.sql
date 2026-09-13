-- Operator-only rollback: stop the gateway first. Preserve all normalized data and identifiers.
-- Before returning to v0.3.7+, reapply migration 012 to reconcile any legacy writes.
BEGIN;
UPDATE runtime_runs r SET messages=coalesce((SELECT jsonb_agg(c.payload ORDER BY e.ordinal)
 FROM run_messages e JOIN message_contents c USING(user_id,hash) WHERE e.user_id=r.user_id AND e.run_id=r.id),'[]'::jsonb);
UPDATE conversations r SET history=coalesce((SELECT jsonb_agg(c.payload ORDER BY e.ordinal)
 FROM conversation_messages e JOIN message_contents c USING(user_id,hash) WHERE e.user_id=r.user_id),'[]'::jsonb);
COMMIT;
