# Versioned skills

Hermes can author reusable text procedures using the companion tool boundary. Versions live in Postgres, not the native writable filesystem skill store. This deliberately keeps skill content separate from executable application code and credentials. No new server or shell access is needed.

## Conversation flow

Ask: “Create a preparation skill that distinguishes unknowns from confirmed gaps. Try it on a saved role and show me the results.” Hermes lists and reads relevant active skills, creates an immutable draft with a reason, records an evaluation, and requests approval. Only the owner typing the exact `/approve UUID` activates that version. `/deny UUID` leaves the current version in place. Approvals expire after 15 minutes and are bound to the specific version and expected previous version.

Ask “Show the history of my preparation skill” or “Restore the previous preparation skill.” Restoration points to a retained, evaluated version after another explicit approval. There is no skill delete tool. Drafts do not automatically influence normal tasks; the bridge instructs Hermes to reload the current active version rather than trust stale conversation context.

## Protocol and storage

- `skill_list()` lists up to 100 active keys.
- `skill_read(key,id?)` reads active or specified content plus latest evaluation reports.
- `skill_history(key)` lists the latest 100 immutable revisions.
- `skill_draft(key,content,reason)` appends a text revision (12,000 characters maximum).
- `skill_evaluate(id,report)` appends observed results for that exact revision.
- `skill_activate(id)` creates a version-bound owner approval, including for rollback.

Migration `003_skills.sql` creates revisions, active pointers and append-only evaluation records. Existing approval and event records retain activation history. Application operations never edit or delete revisions; this is not protection against a database administrator modifying data. Gmail remains read-only; skills cannot grant permissions, run scripts or change the service configuration.

## Evaluation limits and next work

An evaluation report is agent-authored evidence, not an independently verified test pass. The gateway requires a report and a human approval; it cannot prove the report's semantic correctness. The user sees the report with the activation request. Representative trials should describe the task, observed outcome, comparison and limitations. Do not save experimental role/Sheet changes unless requested.

Version 1 uses the existing daily model. Frontier review/model switching and automatic scheduled reviews are not implemented. Review skills conversationally for now. Add periodic review only after usage provides useful evidence; propose consolidation rather than deleting history. No extra DigitalOcean VM is planned.

## Verification

Integration tests cover migration reruns, drafts staying inactive, evaluation prerequisites, owner isolation, one-use and expiring approvals, stale-head rejection, denied activation, immutable rollback and forbidden payload fields. Existing role deletion regression tests remain required.
