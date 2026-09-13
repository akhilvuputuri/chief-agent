BEGIN;
ALTER TABLE conversation_inputs ADD COLUMN IF NOT EXISTS preparation text NOT NULL DEFAULT 'ready'
 CHECK(preparation IN ('pending','ready','failed'));
ALTER TABLE conversation_inputs ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
ALTER TABLE conversation_inputs ADD COLUMN IF NOT EXISTS message_index integer;
CREATE INDEX IF NOT EXISTS conversation_inputs_pending ON conversation_inputs(user_id,ordinal) WHERE state='queued';
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS delivery_state text NOT NULL DEFAULT 'recorded' CHECK(delivery_state IN ('recorded','pending','sent'));
INSERT INTO runtime_migrations(version) VALUES(14) ON CONFLICT DO NOTHING;
COMMIT;
