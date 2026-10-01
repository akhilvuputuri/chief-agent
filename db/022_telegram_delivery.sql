BEGIN;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS delivery_context jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS work_deliveries (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
 task_id uuid NOT NULL REFERENCES work_tasks(id), run_id uuid NOT NULL UNIQUE REFERENCES runtime_runs(id),
 payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','uncertain')),
 created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS work_deliveries_pending ON work_deliveries(created_at) WHERE state='pending';
CREATE INDEX IF NOT EXISTS telegram_message_reference ON events(user_id,(data->>'messageId'),id DESC)
 WHERE type IN ('telegram.message_sent','telegram.view_opened','telegram.feed_sent');
CREATE UNIQUE INDEX IF NOT EXISTS telegram_slow_pointer_once ON events(user_id,run_id) WHERE type='telegram.slow_pointer_claimed';
INSERT INTO runtime_migrations(version) VALUES(22) ON CONFLICT DO NOTHING;
COMMIT;
