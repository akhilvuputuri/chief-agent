BEGIN;
CREATE TABLE IF NOT EXISTS link_resolutions (
 id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),original_url text NOT NULL,
 target text NOT NULL CHECK(target IN ('article','discussion')),result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS link_resolution_owner ON link_resolutions(user_id,original_url,target,created_at DESC);
ALTER TABLE mcp_operations ADD COLUMN IF NOT EXISTS source_payload jsonb;
ALTER TABLE mcp_operations ADD COLUMN IF NOT EXISTS reader_target text;
ALTER TABLE mcp_operations ADD COLUMN IF NOT EXISTS link_resolution jsonb;
INSERT INTO runtime_migrations(version) VALUES(31) ON CONFLICT DO NOTHING;
COMMIT;
