BEGIN;
-- Study resources (docs/study-resources.md): the owner's learning material, in Postgres,
-- separate from Reader (offline reading) and from canvases. Additive only.
CREATE TABLE IF NOT EXISTS study_resources (
 id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),
 canonical_url text NOT NULL,url text NOT NULL,title text NOT NULL,site text NOT NULL,
 topic text NOT NULL CHECK(topic IN ('applied-ai-engineering','agent-platforms','developer-tools','voice-conversational-ai','other')),
 tags text[] NOT NULL DEFAULT '{}',notes text,
 status text NOT NULL DEFAULT 'to_study' CHECK(status IN ('to_study','in_progress','done')),
 reason text NOT NULL,confidence numeric(4,3),
 added_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,canonical_url)
);
CREATE INDEX IF NOT EXISTS study_resources_status ON study_resources(user_id,status,added_at DESC);
CREATE INDEX IF NOT EXISTS study_resources_topic ON study_resources(user_id,topic,added_at DESC);
CREATE INDEX IF NOT EXISTS study_resources_tags ON study_resources USING gin(tags);
-- Every saved link's route, so a confident Reader save can be corrected to the study list.
-- The unsure prompt is bound to its owner and Telegram message before a tap can write.
CREATE TABLE IF NOT EXISTS link_saves (
 id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),
 canonical_url text NOT NULL,page_url text NOT NULL,title text NOT NULL,site text NOT NULL,
 topic text NOT NULL CHECK(topic IN ('applied-ai-engineering','agent-platforms','developer-tools','voice-conversational-ai','other')),
 route text NOT NULL CHECK(route IN ('study','reader','both','unsure')),
 reason text NOT NULL,confidence numeric(4,3),
 study_id uuid REFERENCES study_resources(id) ON DELETE SET NULL,reader_request_key uuid,reader_state text,
 run_id uuid,telegram_message_id bigint,claimed_at timestamptz,delivering_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS link_saves_owner ON link_saves(user_id,canonical_url,created_at DESC);
CREATE INDEX IF NOT EXISTS link_saves_prompt ON link_saves(user_id,run_id) WHERE route='unsure' AND telegram_message_id IS NULL;
INSERT INTO runtime_migrations(version) VALUES(36) ON CONFLICT DO NOTHING;
COMMIT;
