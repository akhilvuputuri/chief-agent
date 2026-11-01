-- Meaning search over the owner's conversations and memories (docs/recall.md). Vectors are only
-- an index: the source rows stay the truth, and search joins back to them, so a retired memory
-- or an excluded message is never returned. Exact search is fast at this size, so no HNSW yet.
BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS embeddings (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('message','memory')),
  source_id uuid NOT NULL,
  chunk integer NOT NULL CHECK (chunk >= 0),
  model text NOT NULL,
  embedding vector(512) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,source_type,source_id,chunk)
);
INSERT INTO runtime_migrations(version) VALUES(34) ON CONFLICT DO NOTHING;
COMMIT;
