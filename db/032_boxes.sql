BEGIN;
-- Boxed sub-agents (docs/boxes.md). Independent of coding_* tables.
CREATE TABLE IF NOT EXISTS boxes (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), request_key text NOT NULL,
 profile text NOT NULL, provider text NOT NULL, environment text NOT NULL,
 -- What the box is bound to (one job, owner and repository); never reused for another subject.
 subject text NOT NULL, image text NOT NULL,
 state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','launching','booting','ready','busy','stopping','stopped','starting','terminating','terminated','held')),
 reason text NOT NULL DEFAULT '', provider_id text, launch_started_at timestamptz,
 -- Credentials: only hashes are stored. Epoch 0 is the single-use bootstrap secret.
 epoch integer NOT NULL DEFAULT 0, credential_hash text NOT NULL, previous_hash text,
 -- The consumed bootstrap secret stays recognisable for the box's whole life.
 bootstrap_hash text,
 retired_hashes text[] NOT NULL DEFAULT '{}', message_seq bigint NOT NULL DEFAULT 0,
 seen_at timestamptz, idle_since timestamptz, running_since timestamptz,
 running_ms bigint NOT NULL DEFAULT 0, stopped_at timestamptz, absolute_deadline timestamptz NOT NULL,
 lease uuid, lease_until timestamptz, reconciled_at timestamptz,
 -- Arrival order, independent of clock resolution: new boxes are admitted first-come.
 arrival bigserial,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,request_key)
);
CREATE INDEX IF NOT EXISTS boxes_live ON boxes(reconciled_at) WHERE state NOT IN ('terminated','held');
CREATE TABLE IF NOT EXISTS box_tasks (
 id uuid PRIMARY KEY, box_id uuid NOT NULL REFERENCES boxes(id), request_key text NOT NULL,
 kind text NOT NULL, payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','failed','cancelled')),
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(box_id,request_key)
);
-- Host to box, ordered per box and acknowledged by the next poll.
CREATE TABLE IF NOT EXISTS box_messages (
 box_id uuid NOT NULL REFERENCES boxes(id), seq bigint NOT NULL, request_key text NOT NULL,
 kind text NOT NULL, payload jsonb NOT NULL, acked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(box_id,seq), UNIQUE(box_id,request_key)
);
-- Box to host, ordered per epoch and deduplicated.
CREATE TABLE IF NOT EXISTS box_events (
 box_id uuid NOT NULL REFERENCES boxes(id), epoch integer NOT NULL, seq bigint NOT NULL,
 kind text NOT NULL, task_id uuid, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(box_id,epoch,seq)
);
-- Host notices for the owner (alerts, holds, compromise); delivered by the host outbox.
CREATE TABLE IF NOT EXISTS box_notices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), box_id uuid NOT NULL REFERENCES boxes(id),
 notice_key text NOT NULL, payload jsonb NOT NULL,
 delivery text NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending','sending','sent','uncertain','suppressed')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(box_id,notice_key)
);
INSERT INTO runtime_migrations(version) VALUES(32) ON CONFLICT DO NOTHING;
COMMIT;
