BEGIN;
CREATE TABLE IF NOT EXISTS daily_items (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('task','note')), title text NOT NULL, content text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','archived')),
 due_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS daily_schedules (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('reminder','briefing')), content text NOT NULL,
 schedule text NOT NULL, parsed jsonb NOT NULL, next_run timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','processing','completed','paused','failed','cancelled')),
 include_email boolean NOT NULL DEFAULT false, include_calendar boolean NOT NULL DEFAULT false,
 lease uuid, started_at timestamptz, last_delivered timestamptz, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS daily_due ON daily_schedules(next_run) WHERE status='scheduled';
COMMIT;
