BEGIN;
-- gmail_recall searches with pgvector (docs/mail-recall.md). The gateway fills this column from
-- the bytea vectors on start, without re-embedding. The bytea column stays, and is still written,
-- so the previous gateway keeps working after a rollback. A later migration drops it.
ALTER TABLE mail_index_chunks ADD COLUMN IF NOT EXISTS embedding vector(512);
INSERT INTO runtime_migrations(version) VALUES(35) ON CONFLICT DO NOTHING;
COMMIT;
