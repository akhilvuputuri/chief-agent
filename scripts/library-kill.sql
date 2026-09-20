-- Operator kill switch for the NLB library assistant. Run with psql -v ON_ERROR_STOP=1.
-- Forgets every identity locally (the remote token then lapses by itself within a week),
-- denies pending library cards, pauses the watcher and opens the breaker for a very long time.
BEGIN;
UPDATE library_identities SET state='revoked', token_box=NULL, card_id=NULL, revoked_at=now(), updated_at=now() WHERE state<>'revoked';
UPDATE approvals SET status='denied' WHERE operation LIKE 'library\_%' AND status='pending';
UPDATE library_link_attempts SET state='aborted', finished_at=now() WHERE state IN ('displaying','fulfilled','completing');
UPDATE library_watch SET status='paused';
UPDATE library_pacing SET breaker_open_until=now()+interval '100 years', breaker_reason='operator', updated_at=now();
COMMIT;
-- To force one stuck uncertain approval to a terminal failed state after inspection, substitute its id:
-- UPDATE approvals SET payload=payload || '{"execution":"failed","failure":{"code":"operator_cleared"}}'::jsonb WHERE id='<uuid>' AND operation LIKE 'library\_%' AND payload->>'execution'='uncertain';
