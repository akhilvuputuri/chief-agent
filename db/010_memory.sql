BEGIN;
CREATE TABLE IF NOT EXISTS memory_sources (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), run_id uuid,
 role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL,
 origin text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 search tsvector GENERATED ALWAYS AS (to_tsvector('english',content)) STORED
);
CREATE INDEX IF NOT EXISTS memory_sources_search ON memory_sources USING gin(search);
CREATE INDEX IF NOT EXISTS memory_sources_owner ON memory_sources(user_id,created_at);
CREATE TABLE IF NOT EXISTS memory_revisions (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), key text NOT NULL,
 revision integer NOT NULL, value text NOT NULL, source_id uuid REFERENCES memory_sources(id),
 source_quote text, reason text NOT NULL, source_kind text NOT NULL, core boolean NOT NULL DEFAULT false,
 run_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 search tsvector GENERATED ALWAYS AS (to_tsvector('english',key || ' ' || value)) STORED,
 UNIQUE(user_id,key,revision), UNIQUE(user_id,id)
);
CREATE INDEX IF NOT EXISTS memory_revisions_search ON memory_revisions USING gin(search);
CREATE TABLE IF NOT EXISTS memory_heads (
 user_id text NOT NULL REFERENCES users(id), key text NOT NULL, revision_id uuid NOT NULL,
 PRIMARY KEY(user_id,key), FOREIGN KEY(user_id,revision_id) REFERENCES memory_revisions(user_id,id)
);
CREATE TABLE IF NOT EXISTS memory_events (
 id bigserial PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), run_id uuid,
 type text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_events_owner_run ON memory_events(user_id,run_id,id);
CREATE TABLE IF NOT EXISTS model_invocations (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runtime_runs(id), user_id text NOT NULL REFERENCES users(id),
 attempt integer NOT NULL, model text, request jsonb NOT NULL, response jsonb,
 state text NOT NULL DEFAULT 'started', latency_ms integer, usage jsonb, provider text,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
ALTER TABLE runtime_calls ADD COLUMN IF NOT EXISTS invocation_id uuid REFERENCES model_invocations(id);
CREATE TABLE IF NOT EXISTS trace_blobs (
 user_id text NOT NULL REFERENCES users(id), hash text NOT NULL, content jsonb NOT NULL, PRIMARY KEY(user_id,hash)
);
CREATE TABLE IF NOT EXISTS invocation_memories (
 invocation_id uuid NOT NULL REFERENCES model_invocations(id), user_id text NOT NULL,
 revision_id uuid NOT NULL, via text NOT NULL,
 PRIMARY KEY(invocation_id,revision_id), FOREIGN KEY(user_id,revision_id) REFERENCES memory_revisions(user_id,id)
);
-- One-time import: no invented source attribution or dates for historical messages.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM runtime_migrations WHERE version=10) THEN
  INSERT INTO memory_sources(id,user_id,role,content,origin)
  SELECT md5(c.user_id || ':history:' || n)::uuid,c.user_id,m->>'role',m->>'content','legacy_snapshot'
  FROM conversations c,jsonb_array_elements(c.history) WITH ORDINALITY a(m,n)
  WHERE m->>'role' IN ('user','assistant') AND jsonb_typeof(m->'content')='string'
  ON CONFLICT DO NOTHING;
  INSERT INTO memory_revisions(id,user_id,key,revision,value,reason,source_kind,core)
  SELECT md5(user_id || ':memory:' || key)::uuid,user_id,key,1,value,'Imported existing memory; original source unknown','legacy_unsourced',true FROM memories ON CONFLICT DO NOTHING;
  INSERT INTO memory_heads(user_id,key,revision_id) SELECT user_id,key,id FROM memory_revisions WHERE revision=1 ON CONFLICT DO NOTHING;
  INSERT INTO runtime_migrations(version) VALUES(10);
 END IF;
END $$;
COMMIT;
