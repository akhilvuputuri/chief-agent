BEGIN;
CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversations (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 history jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL, company text NOT NULL, url text, description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'saved' CHECK (status IN ('saved','interested','applied','interviewing','offer','rejected','archived')),
 notes text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_user_status ON jobs(user_id,status);
CREATE TABLE IF NOT EXISTS memories (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, key text NOT NULL,
 value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,key)
);
CREATE TABLE IF NOT EXISTS approvals (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 run_id uuid NOT NULL,
 operation text NOT NULL CHECK (operation = 'job_delete'), payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
 expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
 id bigserial PRIMARY KEY, run_id uuid NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 type text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id,id);
CREATE TABLE IF NOT EXISTS inbound_updates (
 update_id bigint PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','completed','failed')),
 created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
