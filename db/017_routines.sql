BEGIN;
CREATE TABLE IF NOT EXISTS agent_routines (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), name text NOT NULL,
 instruction text NOT NULL, schedule text NOT NULL, parsed jsonb NOT NULL,
 status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','paused','cancelled','completed')),
 missed_policy text NOT NULL DEFAULT 'latest' CHECK(missed_policy IN ('latest','skip')),
 next_run timestamptz, revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_routines_due ON agent_routines(next_run) WHERE status='scheduled';
CREATE TABLE IF NOT EXISTS routine_occurrences (
 id uuid PRIMARY KEY, routine_id uuid NOT NULL REFERENCES agent_routines(id),
 user_id text NOT NULL REFERENCES users(id), revision integer NOT NULL,
 scheduled_at timestamptz NOT NULL, instruction text NOT NULL,
 disposition text NOT NULL CHECK(disposition IN ('launched','missed','overlap')),
 task_id uuid UNIQUE REFERENCES work_tasks(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(routine_id,revision,scheduled_at)
);
CREATE TABLE IF NOT EXISTS routine_deliveries (
 id uuid PRIMARY KEY, occurrence_id uuid NOT NULL REFERENCES routine_occurrences(id),
 user_id text NOT NULL REFERENCES users(id), run_id uuid UNIQUE REFERENCES runtime_runs(id),
 payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','uncertain')),
 created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
INSERT INTO runtime_migrations(version) VALUES(17) ON CONFLICT DO NOTHING;
COMMIT;
