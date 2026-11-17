BEGIN;
-- GitHub issue drafts (docs/github-issues.md). Reuses the approvals table like Calendar drafts:
-- only the operation list grows. Additive; every earlier row stays valid, and the previous
-- application ignores the new operation.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_operation_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_operation_check CHECK(operation IN ('job_delete','skill_activate','calendar_create','library_borrow','library_hold','library_hold_cancel','library_link','library_revoke','responsibility_confirm','portfolio_connect','portfolio_disconnect','github_issue_create'));
INSERT INTO runtime_migrations(version) VALUES(37) ON CONFLICT DO NOTHING;
COMMIT;
