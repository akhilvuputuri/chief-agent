BEGIN;
-- Identical list in db/003_skills.sql:3 and db/009_calendar_approval.sql:3 (Compose re-runs both before this file).
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_operation_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_operation_check CHECK(operation IN ('job_delete','skill_activate','calendar_create','library_borrow','library_hold','library_hold_cancel','library_link','library_revoke'));
CREATE INDEX IF NOT EXISTS approvals_pending_user ON approvals(user_id,created_at) WHERE status='pending';
-- One pending card per title; one executing/uncertain library action per owner (revoke exempt, so the kill switch is never blocked). DDL, not a SELECT-then-INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS approvals_library_pending_title ON approvals(user_id,(payload->'draft'->>'titleId')) WHERE status='pending' AND operation LIKE 'library\_%' AND payload->'draft'->>'titleId' IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS approvals_library_one_executing ON approvals(user_id) WHERE operation LIKE 'library\_%' AND operation <> 'library_revoke' AND payload->>'execution' IN ('executing','uncertain');

CREATE TABLE IF NOT EXISTS library_identities (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 state text NOT NULL CHECK(state IN ('anonymous','linking','linked','expired','revoked')),
 token_box bytea, key_version smallint NOT NULL DEFAULT 1,
 token_expires_at timestamptz, minted_at timestamptz,
 card_id text, card_count integer NOT NULL DEFAULT 0, library_key text NOT NULL DEFAULT 'nlb',
 linked_at timestamptz, revoked_at timestamptz, remote_revoked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(state<>'linked' OR (token_box IS NOT NULL AND card_id IS NOT NULL)),
 CHECK(state<>'revoked' OR token_box IS NULL)
);
CREATE TABLE IF NOT EXISTS library_link_attempts (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 approval_id uuid NOT NULL, direction text NOT NULL CHECK(direction IN ('display','enter')),
 state text NOT NULL CHECK(state IN ('displaying','fulfilled','completing','done','expired','aborted','failed')),
 deadline_at timestamptz NOT NULL, telegram_message_id bigint,
 polls integer NOT NULL DEFAULT 0, rotations integer NOT NULL DEFAULT 0, last_result text, abort_requested boolean NOT NULL DEFAULT false,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS library_link_attempts_live ON library_link_attempts(user_id) WHERE state IN ('displaying','fulfilled','completing');
CREATE TABLE IF NOT EXISTS library_shelf (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 synced_at timestamptz NOT NULL, loans jsonb NOT NULL DEFAULT '[]', holds jsonb NOT NULL DEFAULT '[]', capacity jsonb NOT NULL DEFAULT '{}',
 CHECK(jsonb_typeof(loans)='array' AND jsonb_typeof(holds)='array' AND octet_length(loans::text)+octet_length(holds::text)<=262144)
);
CREATE TABLE IF NOT EXISTS library_call_days (
 day date PRIMARY KEY, calls integer NOT NULL DEFAULT 0, writes integer NOT NULL DEFAULT 0, link_polls integer NOT NULL DEFAULT 0, refused integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS library_calls (
 id bigserial PRIMARY KEY, host text NOT NULL, method text NOT NULL, route text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('read','write','link','identity')),
 outcome text NOT NULL CHECK(outcome IN ('ok','rejected','throttled','unauthenticated','transient','timeout','refused')),
 status integer, duration_ms integer, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_calls_recent ON library_calls(created_at DESC);
CREATE TABLE IF NOT EXISTS library_pacing (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 last_call_at timestamptz, last_write_at timestamptz, breaker_open_until timestamptz, breaker_reason text,
 consecutive_failures integer NOT NULL DEFAULT 0, notified_breaker_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO library_pacing(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS library_watch (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','processing','paused')),
 next_run timestamptz NOT NULL DEFAULT now(), lease uuid, started_at timestamptz, last_run_at timestamptz, last_error text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_watch_due ON library_watch(next_run) WHERE status='scheduled';
-- Exactly-once owner notices; key = titleId for hold notices. Re-armed only by deleting the row.
CREATE TABLE IF NOT EXISTS library_notices (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('capacity','offer_denied','identity_expired','breaker','link_interrupted')),
 key text NOT NULL DEFAULT '', sent_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,kind,key)
);
INSERT INTO runtime_migrations(version) VALUES(16) ON CONFLICT DO NOTHING;
COMMIT;
