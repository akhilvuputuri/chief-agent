-- Proactive link classification (docs/study-links.md). Study material lives in its own
-- owner-scoped collection instead of Reader; link_decisions is the durable resume record for a
-- save that needed the owner's choice or failed part-way, so a tap is never one-shot.
BEGIN;
CREATE TABLE IF NOT EXISTS study_resources (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 url text NOT NULL,
 canonical_url text NOT NULL,
 title text NOT NULL,
 source text,
 topic text,
 tags text[] NOT NULL DEFAULT '{}',
 notes text,
 status text NOT NULL DEFAULT 'to_study' CHECK(status IN ('to_study','in_progress','done')),
 classification_route text NOT NULL,
 classification_reason text NOT NULL,
 classification_confidence double precision NOT NULL,
 classification_model text,
 reader_saved boolean NOT NULL DEFAULT false,
 added_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- The duplicate detector: one entry per owner and canonical link.
CREATE UNIQUE INDEX IF NOT EXISTS study_resources_link ON study_resources(user_id,canonical_url);
CREATE INDEX IF NOT EXISTS study_resources_status ON study_resources(user_id,status);
CREATE INDEX IF NOT EXISTS study_resources_tags ON study_resources USING gin(tags);
CREATE TABLE IF NOT EXISTS link_decisions (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 shared_url text NOT NULL,
 canonical_url text NOT NULL,
 title text,
 source text,
 topic text,
 route text NOT NULL CHECK(route IN ('study','reader','both','unsure')),
 reason text NOT NULL,
 confidence double precision NOT NULL,
 model text,
 telegram_chat_id text,
 telegram_message_id bigint,
 -- The thread the buttons were really sent to, so a re-render can reply where they are.
 telegram_thread_id bigint,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','confirmed')),
 choice text CHECK(choice IN ('study','reader','both')),
 study_state text NOT NULL DEFAULT 'none' CHECK(study_state IN ('none','done')),
 study_id uuid,
 reader_state text NOT NULL DEFAULT 'none' CHECK(reader_state IN ('none','pending','accepted','rejected','uncertain')),
 reader_request_key uuid,
 reader_attempts int NOT NULL DEFAULT 0,
 reader_status_detail text,
 claim_token uuid,
 claimed_at timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '2 days'
);
CREATE INDEX IF NOT EXISTS link_decisions_open ON link_decisions(user_id,created_at DESC);
INSERT INTO runtime_migrations(version) VALUES(36) ON CONFLICT DO NOTHING;
COMMIT;
