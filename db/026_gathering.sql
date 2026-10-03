BEGIN;
CREATE TABLE IF NOT EXISTS file_artifacts (
 id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),name text NOT NULL CHECK(length(name)<=120),
 mime_type text NOT NULL CHECK(mime_type='application/pdf'),bytes integer NOT NULL CHECK(bytes>0 AND bytes<=20971520),
 encrypted bytea NOT NULL,facts jsonb NOT NULL CHECK(jsonb_typeof(facts)='object'),
 input_id uuid,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id),UNIQUE(user_id,sha256)
);
CREATE TABLE IF NOT EXISTS gather_collections (
 id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 task_id uuid NOT NULL UNIQUE REFERENCES work_tasks(id),task_revision integer NOT NULL,
 request_key text NOT NULL,request_hash text NOT NULL,scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object'),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','complete')),
 evidence_revision integer NOT NULL DEFAULT 0,stored_bytes integer NOT NULL DEFAULT 0 CHECK(stored_bytes>=0),stored_files integer NOT NULL DEFAULT 0 CHECK(stored_files>=0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,request_key),UNIQUE(id,user_id)
);
CREATE TABLE IF NOT EXISTS gather_scope_history (
 collection_id uuid NOT NULL,user_id text NOT NULL,revision integer NOT NULL,scope jsonb NOT NULL,run_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(collection_id,revision),
 FOREIGN KEY(collection_id,user_id) REFERENCES gather_collections(id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS gather_targets (
 collection_id uuid NOT NULL,user_id text NOT NULL,key text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','covered','blocked')),active boolean NOT NULL DEFAULT true,coverage_checked boolean NOT NULL DEFAULT false,coverage_source text,coverage_note text,
 reason text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(collection_id,key),
 FOREIGN KEY(collection_id,user_id) REFERENCES gather_collections(id,user_id) ON DELETE CASCADE,
 UNIQUE(collection_id,key,user_id)
);
CREATE TABLE IF NOT EXISTS gather_attempts (
 id uuid PRIMARY KEY,user_id text NOT NULL,collection_id uuid NOT NULL,target_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('search','email','provided','browser')),state text NOT NULL CHECK(state IN ('success','failed','login_needed')),
 metadata jsonb NOT NULL DEFAULT '{}',scope_revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(collection_id,target_key,user_id) REFERENCES gather_targets(collection_id,key,user_id) ON DELETE CASCADE,
 UNIQUE(id,user_id)
);
CREATE TABLE IF NOT EXISTS gather_assets (
 collection_id uuid NOT NULL,user_id text NOT NULL,artifact_id uuid NOT NULL,
 PRIMARY KEY(collection_id,artifact_id),
 FOREIGN KEY(collection_id,user_id) REFERENCES gather_collections(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(artifact_id,user_id) REFERENCES file_artifacts(id,user_id)
);
CREATE OR REPLACE FUNCTION gather_asset_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE gather_collections SET stored_bytes=stored_bytes+(SELECT bytes FROM file_artifacts WHERE id=NEW.artifact_id AND user_id=NEW.user_id),stored_files=stored_files+1
 WHERE id=NEW.collection_id AND user_id=NEW.user_id AND stored_files<100
 AND stored_bytes+(SELECT bytes FROM file_artifacts WHERE id=NEW.artifact_id AND user_id=NEW.user_id)<=209715200;
 IF NOT FOUND THEN RAISE EXCEPTION 'Collection file capacity reached' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS gather_asset_capacity_trigger ON gather_assets;
CREATE TRIGGER gather_asset_capacity_trigger AFTER INSERT ON gather_assets FOR EACH ROW EXECUTE FUNCTION gather_asset_capacity();
CREATE TABLE IF NOT EXISTS gather_candidates (
 collection_id uuid NOT NULL,target_key text NOT NULL,user_id text NOT NULL,artifact_id uuid NOT NULL,
 attempt_id uuid NOT NULL,facts jsonb NOT NULL,PRIMARY KEY(collection_id,target_key,artifact_id),
 FOREIGN KEY(collection_id,target_key,user_id) REFERENCES gather_targets(collection_id,key,user_id) ON DELETE CASCADE,
 FOREIGN KEY(artifact_id,user_id) REFERENCES file_artifacts(id,user_id),
 FOREIGN KEY(attempt_id,user_id) REFERENCES gather_attempts(id,user_id)
);
CREATE TABLE IF NOT EXISTS gather_items (
 collection_id uuid NOT NULL,target_key text NOT NULL,user_id text NOT NULL,artifact_id uuid NOT NULL,
 scope_revision integer NOT NULL DEFAULT 1,match_date text NOT NULL CHECK(match_date~'^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$'),date_basis text NOT NULL CHECK(date_basis IN ('invoice_date','service_period')),
 receipt_id uuid NOT NULL REFERENCES tool_receipts(id),PRIMARY KEY(collection_id,target_key,artifact_id),
 FOREIGN KEY(collection_id,target_key,user_id) REFERENCES gather_targets(collection_id,key,user_id) ON DELETE CASCADE,
 FOREIGN KEY(artifact_id,user_id) REFERENCES file_artifacts(id,user_id)
);
CREATE TABLE IF NOT EXISTS gather_mutations (
 collection_id uuid NOT NULL,user_id text NOT NULL,request_key text NOT NULL,request_hash text NOT NULL,
 result jsonb NOT NULL,PRIMARY KEY(collection_id,request_key),
 FOREIGN KEY(collection_id,user_id) REFERENCES gather_collections(id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS gather_browser_sessions (
 id uuid PRIMARY KEY,user_id text NOT NULL,collection_id uuid NOT NULL,target_key text NOT NULL,
 origin text NOT NULL,encrypted_state bytea,state text NOT NULL DEFAULT 'readonly' CHECK(state IN ('readonly','owner','closed')),
 generation integer NOT NULL DEFAULT 1,allowed_origins jsonb NOT NULL DEFAULT '[]',expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 FOREIGN KEY(collection_id,target_key,user_id) REFERENCES gather_targets(collection_id,key,user_id) ON DELETE CASCADE,
 UNIQUE(id,user_id)
);
CREATE TABLE IF NOT EXISTS gather_browser_profiles (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,origin text NOT NULL,account_label text NOT NULL,
 encrypted_state bytea NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,origin,account_label)
);
CREATE OR REPLACE FUNCTION gather_observation_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE gather_collections SET evidence_revision=evidence_revision+1 WHERE id=NEW.collection_id AND user_id=NEW.user_id;
 IF TG_TABLE_NAME='gather_attempts' AND EXISTS(SELECT 1 FROM gather_collections WHERE id=NEW.collection_id AND task_revision=NEW.scope_revision) THEN
   UPDATE gather_targets SET coverage_checked=false,coverage_source=NULL,coverage_note=NULL,state=CASE WHEN state='covered' THEN 'pending' ELSE state END WHERE collection_id=NEW.collection_id AND key=NEW.target_key AND user_id=NEW.user_id;
   UPDATE work_steps SET status='pending' WHERE task_id=(SELECT task_id FROM gather_collections WHERE id=NEW.collection_id) AND key=NEW.target_key AND status='done';
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS gather_attempt_changed ON gather_attempts;
CREATE TRIGGER gather_attempt_changed AFTER INSERT ON gather_attempts FOR EACH ROW EXECUTE FUNCTION gather_observation_changed();
DROP TRIGGER IF EXISTS gather_item_changed ON gather_items;
CREATE TRIGGER gather_item_changed AFTER INSERT OR UPDATE ON gather_items FOR EACH ROW EXECUTE FUNCTION gather_observation_changed();
INSERT INTO runtime_migrations(version) VALUES(26) ON CONFLICT DO NOTHING;
COMMIT;
