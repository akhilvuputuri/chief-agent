BEGIN;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_operation_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_operation_check CHECK(operation IN ('job_delete','skill_activate','calendar_create','library_borrow','library_hold','library_hold_cancel','library_link','library_revoke'));
COMMIT;
