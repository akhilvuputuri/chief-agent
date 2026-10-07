BEGIN;
CREATE TABLE IF NOT EXISTS mcp_operations (
 user_id text NOT NULL REFERENCES users(id),connection text NOT NULL,request_key uuid NOT NULL,
 tool text NOT NULL,binding text NOT NULL,schema_hash text NOT NULL,payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','rejected')),
 result jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,connection,request_key)
);
CREATE INDEX IF NOT EXISTS mcp_pending ON mcp_operations(user_id,updated_at) WHERE state='pending';
CREATE TABLE IF NOT EXISTS mcp_connection_state (
 user_id text NOT NULL REFERENCES users(id),connection text NOT NULL,binding text NOT NULL,
 category text NOT NULL CHECK(category IN ('auth','capacity')),retry_at timestamptz,
 PRIMARY KEY(user_id,connection)
);
INSERT INTO runtime_migrations(version) VALUES(30) ON CONFLICT DO NOTHING;
COMMIT;
