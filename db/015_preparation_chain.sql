BEGIN;
-- Retain older tasks explicitly unlinked; never infer evidence during migration.
ALTER TABLE preparation_tasks ADD COLUMN IF NOT EXISTS evidence_chain jsonb NOT NULL DEFAULT '[]'::jsonb
 CHECK(jsonb_typeof(evidence_chain)='array' AND jsonb_array_length(evidence_chain)<=32 AND octet_length(evidence_chain::text)<=262144);
INSERT INTO runtime_migrations(version) VALUES(15) ON CONFLICT DO NOTHING;
COMMIT;
