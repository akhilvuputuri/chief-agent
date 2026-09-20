BEGIN;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_operation_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_operation_check CHECK(operation IN ('job_delete','skill_activate','calendar_create','library_borrow','library_hold','library_hold_cancel','library_link','library_revoke'));
CREATE TABLE IF NOT EXISTS skill_versions (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 key text NOT NULL, content text NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,key,id)
);
CREATE TABLE IF NOT EXISTS skill_heads (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, key text NOT NULL,
 version_id uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,key), FOREIGN KEY(user_id,key,version_id) REFERENCES skill_versions(user_id,key,id)
);
CREATE TABLE IF NOT EXISTS skill_evaluations (
 id uuid PRIMARY KEY, user_id text NOT NULL, key text NOT NULL, version_id uuid NOT NULL,
 report text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(user_id,key,version_id) REFERENCES skill_versions(user_id,key,id)
);
CREATE INDEX IF NOT EXISTS skill_versions_owner ON skill_versions(user_id,key,created_at);
COMMIT;
