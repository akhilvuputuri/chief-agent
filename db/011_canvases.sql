BEGIN;
CREATE TABLE IF NOT EXISTS canvases (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL,
 latest_revision integer NOT NULL CHECK(latest_revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id)
);
CREATE INDEX IF NOT EXISTS canvases_owner_updated ON canvases(user_id,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS canvas_revisions (
 canvas_id uuid NOT NULL,
 user_id text NOT NULL,
 revision integer NOT NULL CHECK(revision > 0),
 document jsonb NOT NULL,
 run_id uuid NOT NULL,
 request_key uuid NOT NULL,
 request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(canvas_id,revision),
 UNIQUE(user_id,request_key),
 FOREIGN KEY(canvas_id,user_id) REFERENCES canvases(id,user_id) ON DELETE CASCADE,
 CHECK(document->>'schemaVersion'='1'),
 CHECK(octet_length(document::text) <= 120000)
);
-- API/agent code only INSERTs revisions. No destructive migration or history reset.
COMMIT;
