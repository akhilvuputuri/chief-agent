BEGIN;
ALTER TABLE coding_model_calls DROP CONSTRAINT IF EXISTS coding_model_calls_role_check;
ALTER TABLE coding_model_calls ADD CONSTRAINT coding_model_calls_role_check CHECK(role IN ('leader','coder','reviewer'));
INSERT INTO runtime_migrations(version) VALUES(27) ON CONFLICT DO NOTHING;
COMMIT;
