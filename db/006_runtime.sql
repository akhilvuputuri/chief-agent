BEGIN;
CREATE TABLE IF NOT EXISTS runtime_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS budget_ms bigint NOT NULL DEFAULT 900000;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS budget_models integer NOT NULL DEFAULT 40;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS budget_tools integer NOT NULL DEFAULT 100;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS used_ms bigint NOT NULL DEFAULT 0;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS used_models integer NOT NULL DEFAULT 0;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS used_tools integer NOT NULL DEFAULT 0;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS budget_initialized boolean NOT NULL DEFAULT false;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS pause_reason text;
CREATE TABLE IF NOT EXISTS runtime_runs (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), task_id uuid REFERENCES work_tasks(id),
 version integer NOT NULL DEFAULT 1, messages jsonb NOT NULL DEFAULT '[]',
 state text NOT NULL DEFAULT 'running', stop_reason text, model text,
 used_ms bigint NOT NULL DEFAULT 0, used_models integer NOT NULL DEFAULT 0, used_tools integer NOT NULL DEFAULT 0,
 started_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runtime_runs_task ON runtime_runs(task_id,started_at DESC);
CREATE TABLE IF NOT EXISTS runtime_calls (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runtime_runs(id), call_id text NOT NULL,
 operation text NOT NULL, arguments jsonb NOT NULL, is_write boolean NOT NULL,
 state text NOT NULL DEFAULT 'started', result jsonb, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(run_id,call_id)
);
CREATE TABLE IF NOT EXISTS conversation_archives (
 user_id text PRIMARY KEY REFERENCES users(id), history jsonb NOT NULL, archived_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS runtime_version integer NOT NULL DEFAULT 0;
-- Apply cutover only once. Preserve original framework payloads byte-for-byte as JSON values.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM runtime_migrations WHERE version=6) THEN
  INSERT INTO conversation_archives(user_id,history) SELECT user_id,history FROM conversations ON CONFLICT DO NOTHING;
  UPDATE conversations c SET history=COALESCE((SELECT jsonb_agg(jsonb_build_object('role',m->>'role','content',m->>'content') ORDER BY n) FROM jsonb_array_elements(c.history) WITH ORDINALITY a(m,n) WHERE m->>'role' IN ('user','assistant') AND jsonb_typeof(m->'content')='string' AND NOT (m ? 'tool_calls') AND m->>'content' NOT LIKE 'Continue the existing task%' AND m->>'content' NOT LIKE '%[SYSTEM%'), '[]'::jsonb),runtime_version=1;
  UPDATE work_tasks SET status='paused',lease=NULL,pause_reason='runtime_cutover',updated_at=now() WHERE status IN ('active','queued','running','paused');
  INSERT INTO runtime_migrations(version) VALUES(6);
 END IF;
END $$;
COMMIT;
