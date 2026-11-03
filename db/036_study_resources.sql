BEGIN;
-- The study list (docs/link-study-routing.md). A shared link is classified before it is
-- saved; study material lands here instead of Reader, and Reader keeps offline reading.
-- Every row keeps the classification that put it here, so a correction is explainable.
CREATE TABLE IF NOT EXISTS study_resources (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 url text NOT NULL,
 url_key text NOT NULL,
 title text NOT NULL,
 source text,
 topic text,
 tags text[] NOT NULL DEFAULT '{}',
 notes text,
 status text NOT NULL DEFAULT 'to_study' CHECK(status IN ('to_study','in_progress','done')),
 classification jsonb NOT NULL,
 added_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,url_key)
);
CREATE INDEX IF NOT EXISTS study_resources_owner_status ON study_resources(user_id,status,added_at DESC);
CREATE INDEX IF NOT EXISTS study_resources_owner_topic ON study_resources(user_id,lower(topic));
CREATE INDEX IF NOT EXISTS study_resources_owner_tags ON study_resources USING gin(tags);
-- An unsure classification asks the owner with buttons. The row is the durable question:
-- one answer each, expiring on its own so a stale keyboard never blocks anything.
CREATE TABLE IF NOT EXISTS study_link_prompts (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 url text NOT NULL,
 url_key text NOT NULL,
 title text NOT NULL,
 source text,
 topic text,
 tags text[] NOT NULL DEFAULT '{}',
 classification jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 notified_at timestamptz,
 resolved_at timestamptz,
 resolution text CHECK(resolution IN ('study','reader','both'))
);
CREATE INDEX IF NOT EXISTS study_link_prompts_owner ON study_link_prompts(user_id,resolved_at,expires_at);
INSERT INTO runtime_migrations(version) VALUES(36) ON CONFLICT DO NOTHING;
COMMIT;
