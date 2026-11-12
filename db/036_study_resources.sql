BEGIN;
-- Study list and pending link choices (docs/links.md). Additive tables only; owner-scoped.
-- A link the owner shares is classified (Jev) as study material or offline reading. Study
-- material lives here, not in Reader. One row per canonical URL per owner.
CREATE TABLE IF NOT EXISTS study_resources (
 id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),url text NOT NULL,
 title text,site text,topic text,tags text[] NOT NULL DEFAULT '{}',notes text,
 status text NOT NULL DEFAULT 'to_study' CHECK(status IN ('to_study','in_progress','done')),
 added_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 classification_reason text,
 classification_confidence real CHECK(classification_confidence BETWEEN 0 AND 1),
 classified_by text CHECK(classified_by IN ('jev','owner')),
 UNIQUE(user_id,url)
);
CREATE INDEX IF NOT EXISTS study_resources_owner ON study_resources(user_id,status,added_at DESC);
-- A link Chief was unsure about waits here for the owner's tap (Study list / Reader / Both).
-- The tap claims the row with a lease, and records each write before and after it happens.
CREATE TABLE IF NOT EXISTS link_choices (
 id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),url text NOT NULL,
 page jsonb NOT NULL,classification jsonb NOT NULL,run_id uuid,
 chat_message_id bigint,thread_id bigint,
 delivery text NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending','sending','sent','uncertain')),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','applying','done')),
 choice text CHECK(choice IN ('study','reader','both')),claimed_at timestamptz,
 study_written boolean NOT NULL DEFAULT false,reader_key uuid,reader_state text,outcome text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS link_choices_owner ON link_choices(user_id,delivery,created_at);
-- Every canonical form of a link (as shared, and after redirects) that a Reader save was sent
-- for, mapped to its request key. A later save of the link as first shared then finds and
-- retries that same request even though the payload carries the redirected URL.
CREATE TABLE IF NOT EXISTS link_reader_keys (
 user_id text NOT NULL REFERENCES users(id),url text NOT NULL,request_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,url,request_key)
);
INSERT INTO runtime_migrations(version) VALUES(36) ON CONFLICT DO NOTHING;
COMMIT;
