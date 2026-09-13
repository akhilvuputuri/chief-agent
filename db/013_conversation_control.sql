BEGIN;
-- Chat and independently addressed jobs have separate lifecycles. No existing work is resumed.
DROP INDEX IF EXISTS work_one_active;
-- Retain the historical name as a non-unique index: rerunning005 must not recreate uniqueness.
CREATE INDEX work_one_active ON work_tasks(user_id) WHERE status IN ('active','queued','running','paused');
CREATE INDEX IF NOT EXISTS work_owner_status ON work_tasks(user_id,status,created_at DESC);
CREATE TABLE IF NOT EXISTS conversation_inputs (
 id uuid PRIMARY KEY,ordinal bigserial UNIQUE,user_id text NOT NULL REFERENCES users(id),run_id uuid,
 message text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','interrupted','failed')),
 received_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,
 FOREIGN KEY(user_id,run_id) REFERENCES runtime_runs(user_id,id)
);
CREATE INDEX IF NOT EXISTS conversation_inputs_owner ON conversation_inputs(user_id,received_at DESC);
-- Versioned projections; immutable messages and tool journals remain authoritative.
CREATE TABLE IF NOT EXISTS conversation_contexts (
 id bigserial PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),run_id uuid NOT NULL,
 summary text NOT NULL DEFAULT '',pending_reply jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,run_id),FOREIGN KEY(user_id,run_id) REFERENCES runtime_runs(user_id,id)
);
CREATE INDEX IF NOT EXISTS conversation_contexts_owner ON conversation_contexts(user_id,id DESC);
INSERT INTO runtime_migrations(version) VALUES(13) ON CONFLICT DO NOTHING;
COMMIT;
