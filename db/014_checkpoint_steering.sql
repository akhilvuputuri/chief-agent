BEGIN;
ALTER TABLE conversation_inputs ADD COLUMN IF NOT EXISTS preparation text NOT NULL DEFAULT 'ready'
 CHECK(preparation IN ('pending','ready','failed'));
ALTER TABLE conversation_inputs ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
ALTER TABLE conversation_inputs ADD COLUMN IF NOT EXISTS message_index integer;
CREATE INDEX IF NOT EXISTS conversation_inputs_pending ON conversation_inputs(user_id,ordinal) WHERE state='queued';
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS delivery_state text NOT NULL DEFAULT 'recorded' CHECK(delivery_state IN ('recorded','pending','sent'));
-- Projection metadata only: immutable run messages remain available for inspection.
CREATE TABLE IF NOT EXISTS run_message_context_exclusions (
 user_id text NOT NULL,
 run_id uuid NOT NULL,
 message_index integer NOT NULL CHECK(message_index>=0),
 reason text NOT NULL CHECK(reason IN ('superseded','pending_delivery')),
 created_at timestamptz NOT NULL DEFAULT now(),
 released_at timestamptz,
 PRIMARY KEY(user_id,run_id,message_index),
 FOREIGN KEY(user_id,run_id,message_index) REFERENCES run_messages(user_id,run_id,ordinal),
 CHECK(reason<>'superseded' OR released_at IS NULL)
);
INSERT INTO runtime_migrations(version) VALUES(14) ON CONFLICT DO NOTHING;
COMMIT;
