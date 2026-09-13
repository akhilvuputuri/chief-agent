BEGIN;
-- Payload identity is owner-scoped; repeated occurrences retain separate ordered references.
CREATE TABLE IF NOT EXISTS message_contents (
 user_id text NOT NULL REFERENCES users(id), hash text NOT NULL,
 payload jsonb NOT NULL, characters integer NOT NULL,
 search tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(payload->>'content',''))) STORED,
 PRIMARY KEY(user_id,hash)
);
CREATE INDEX IF NOT EXISTS message_contents_search ON message_contents USING gin(search);
ALTER TABLE runtime_runs ADD COLUMN IF NOT EXISTS message_count integer NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS message_count integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS runtime_runs_owner_id ON runtime_runs(user_id,id);
CREATE TABLE IF NOT EXISTS run_messages (
 user_id text NOT NULL, run_id uuid NOT NULL, ordinal integer NOT NULL,
 hash text NOT NULL, PRIMARY KEY(user_id,run_id,ordinal),
 FOREIGN KEY(user_id,run_id) REFERENCES runtime_runs(user_id,id),
 FOREIGN KEY(user_id,hash) REFERENCES message_contents(user_id,hash)
);
CREATE TABLE IF NOT EXISTS conversation_messages (
 user_id text NOT NULL REFERENCES conversations(user_id) ON DELETE CASCADE,
 id uuid NOT NULL DEFAULT gen_random_uuid(), UNIQUE(user_id,id),
 ordinal integer NOT NULL, hash text NOT NULL, run_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,ordinal),
 FOREIGN KEY(user_id,hash) REFERENCES message_contents(user_id,hash),
 FOREIGN KEY(user_id,run_id) REFERENCES runtime_runs(user_id,id)
);
-- Run with gateway stopped. Also reconciles legacy writes after an operator rollback.
-- Verify exact reconstruction before clearing any legacy array.
DO $$ BEGIN
  INSERT INTO message_contents(user_id,hash,payload,characters)
   SELECT DISTINCT user_id,encode(sha256(convert_to(m::text,'UTF8')),'hex'),m,length(m::text)
   FROM (SELECT user_id,messages AS history FROM runtime_runs UNION ALL SELECT user_id,history FROM conversations) h
   CROSS JOIN LATERAL jsonb_array_elements(history) a(m) ON CONFLICT DO NOTHING;
  INSERT INTO run_messages(user_id,run_id,ordinal,hash)
   SELECT user_id,id,n::int-1,encode(sha256(convert_to(m::text,'UTF8')),'hex')
   FROM runtime_runs CROSS JOIN LATERAL jsonb_array_elements(messages) WITH ORDINALITY a(m,n) ON CONFLICT DO NOTHING;
  INSERT INTO conversation_messages(user_id,ordinal,hash,created_at)
   SELECT user_id,n::int-1,encode(sha256(convert_to(m::text,'UTF8')),'hex'),updated_at
   FROM conversations CROSS JOIN LATERAL jsonb_array_elements(history) WITH ORDINALITY a(m,n) ON CONFLICT DO NOTHING;
  IF EXISTS(SELECT 1 FROM runtime_runs r WHERE r.messages<>'[]' AND r.messages IS DISTINCT FROM
    coalesce((SELECT jsonb_agg(c.payload ORDER BY e.ordinal) FROM run_messages e JOIN message_contents c USING(user_id,hash) WHERE e.user_id=r.user_id AND e.run_id=r.id),'[]'::jsonb))
   OR EXISTS(SELECT 1 FROM conversations r WHERE r.history<>'[]' AND r.history IS DISTINCT FROM
    coalesce((SELECT jsonb_agg(c.payload ORDER BY e.ordinal) FROM conversation_messages e JOIN message_contents c USING(user_id,hash) WHERE e.user_id=r.user_id),'[]'::jsonb))
   THEN RAISE EXCEPTION 'Message normalization verification failed'; END IF;
  UPDATE runtime_runs SET message_count=jsonb_array_length(messages),messages='[]' WHERE messages<>'[]';
  UPDATE conversations SET message_count=jsonb_array_length(history),history='[]' WHERE history<>'[]';
  INSERT INTO runtime_migrations(version) VALUES(12) ON CONFLICT DO NOTHING;
END $$;
COMMIT;
