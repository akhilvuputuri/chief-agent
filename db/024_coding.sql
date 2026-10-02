BEGIN;
CREATE TABLE IF NOT EXISTS coding_jobs (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), request_key text NOT NULL,
 request_hash text NOT NULL, origin_run uuid NOT NULL, thread_id bigint,
 objective text NOT NULL, context text NOT NULL, mode text NOT NULL CHECK(mode IN ('plan','implement')),
 revision integer NOT NULL DEFAULT 1, base_sha text NOT NULL, settings jsonb NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','provisioning','running','plan_ready','awaiting_input','publishing','pr_ready','paused','failed','cancelled')),
 stage text NOT NULL DEFAULT 'queued', summary text NOT NULL DEFAULT '', question text NOT NULL DEFAULT '',
 checkpoint jsonb NOT NULL DEFAULT '{"plan":"","patch":"","summary":""}', result jsonb,
 attempt_id uuid, sandbox_id text, heartbeat_at timestamptz, attempt_deadline timestamptz,
 cleanup text NOT NULL DEFAULT 'none' CHECK(cleanup IN ('none','pending','complete')),
 lease uuid, lease_until timestamptz, pr_url text, head_sha text,
 used_models integer NOT NULL DEFAULT 0, model_busy boolean NOT NULL DEFAULT false,
 publication_started boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,request_key)
);
CREATE TABLE IF NOT EXISTS coding_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES coding_jobs(id),
 event_key text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 delivery text NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending','sending','sent','uncertain','suppressed')),
 UNIQUE(job_id,event_key)
);
CREATE TABLE IF NOT EXISTS coding_revisions (
 job_id uuid NOT NULL REFERENCES coding_jobs(id), revision integer NOT NULL, request_key text NOT NULL,
 message text NOT NULL, mode text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(job_id,revision), UNIQUE(job_id,request_key)
);
CREATE TABLE IF NOT EXISTS coding_model_calls (
 id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES coding_jobs(id), attempt_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('coder','reviewer')), request_hash text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','uncertain')),
 input jsonb NOT NULL, result jsonb, result_box bytea, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS coding_one_active_worker ON coding_jobs((true)) WHERE state IN ('provisioning','running','publishing') OR cleanup='pending';
CREATE INDEX IF NOT EXISTS coding_pending ON coding_jobs(created_at) WHERE state='queued';
INSERT INTO runtime_migrations(version) VALUES(24) ON CONFLICT DO NOTHING;
COMMIT;
