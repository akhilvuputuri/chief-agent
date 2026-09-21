# Preparation evidence migration and operator rollout

Migration `015_preparation_chain.sql` adds bounded `evidence_chain` JSONB to `preparation_tasks`, defaulting to an empty array, and records migration 15. Existing tasks remain saved and explicitly unlinked. It performs no deletion, evidence inference or backfill. New evidence can be saved only through the reviewed application behavior.

Status on 14 September 2026: [PR #44](https://github.com/akhilvuputuri/chief-agent/pull/44) merged at `672021f2afcea620224fd9f7ce7ccfdc53b9ba89`, with the same tree as [Astra-approved `b01a9226c37ea73fa0cb3140fdfb43e11fc08772`](https://github.com/akhilvuputuri/chief-agent/pull/44#issuecomment-5655091129). Required checks passed, including 12 offline rollout tests; the reviewer also ran those 12 tests independently. The operator rollout succeeded from the baseline below, reporting that exact deployed SHA, healthy startup and migration 15. A separate read-only server check confirmed the release marker, `healthz` status `ok` for runtime `personal-agent`, all three existing preparation tasks retained with empty evidence arrays, and no active runs. [Main CI](https://github.com/akhilvuputuri/chief-agent/actions/runs/34773706544) passed; the [standard release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/34773911229) passed and the published [v0.3.10](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.10) tag resolves to that exact deployed SHA. New linked-task acceptance remains separate from startup and preserved-data checks.

The ordinary GitHub release refuses database/Compose changes. The reviewed [deploy-preparation.py](../scripts/deploy-preparation.py) is a one-time operator procedure through the existing authorized operations connection. It does not add a new cloud SSH capability or install a changed trusted release command.

The baseline-specific procedure below is retained as the record of the completed migration rollout. Do not rerun it against the newer server release or rewrite `RELEASE` to satisfy its old baseline. Ordinary later application releases use the installed migration.

## Review and prepare

1. Review the exact application, migration, Compose addition and rollout script together. Require the independent review/fix/re-review loop, passing required checks and a merged main commit. Preserve all historical migration files. Confirm the only Compose change is the pair of command arguments adding `/migrations/015_preparation_chain.sql` after migration 014.
2. Run `python3 -B scripts/test-deploy-preparation.py` for the offline rollout checks. These stub Docker, database calls and health responses; they exercise refusal and rollback ordering, not real PostgreSQL migration semantics or live service health. The application's database regression checks cover migration/data behavior separately. No paid model test is a rollout prerequisite.
3. Prepare a `git archive --format=tar --output=... <full-merged-main-SHA>` from that exact reviewed commit. Upload it and the matching reviewed script outside the live source directory. Do not include an environment file or copy production credentials into a development environment.

## Run from the exact baseline

Server `RELEASE` must equal `16cb37f28625823df1c35d41bc7f8844db4b09b2`. If a newer release has deployed, reconcile its source/migrations and obtain a revised review; do not bypass the check or rewrite `RELEASE` to make it pass. The archive's Git commit comment must match the supplied 40-character SHA. That check detects a mismatch; review and a trusted archive transfer still establish which source is authorized.

Invoke the reviewed script on the server with `python3 /path/to/deploy-preparation.py /path/to/reviewed-source.tar <full-merged-main-SHA>`. It takes the same nonblocking release lock as ordinary deployment and:

- Rejects unsafe/duplicate archive paths, links, environment files, unexpected release-marker entries, oversized/incomplete archives, changed/removed historical DB files and any new DB file other than migration 015.
- Requires Compose to equal the installed baseline byte-for-byte plus exactly the migration 015 command entry. Other environment, service, port or command changes fail before downtime. The repository copy of `scripts/cloud-release.py` must remain unchanged; the trusted `/usr/local/sbin/companion-cloud-release` is not overwritten.
- Saves a temporary rollback copy of source, builds the candidate before downtime and confirms baseline health. It refuses running runtime work and queued/running input, including file/voice preparation. Wait until the owner’s work finishes; do not cancel it to deploy.
- Records the previous image, stops only the gateway, applies only transactional migration 015, checks its migration marker and starts the candidate without recreating Postgres or running the full migration service.
- Verifies startup health, publishes reviewed source and atomically writes the new `RELEASE`. Success prints only the deployed SHA, health result and migration number.

The existing small check-to-stop input race remains: coordinate an idle window and avoid starting work during rollout. This script does not introduce intake draining, task cancellation or automatic replay. SQL/build/Compose failure output is not dumped into logs; do not troubleshoot by printing expanded Compose configuration or credentials.

## Rollback and verification

If migration, startup, health or source publication fails after stopping the gateway, the script attempts to restore the previous image, Compose and any partially published source, then verifies rollback health. A committed migration 015 stays in Postgres, including evidence written before failure; there is no column drop, task deletion or automatic replay. The previous application ignores the new column. If it edits an existing task during prolonged rollback, its older write path cannot maintain the new evidence relationship; inspect/reassess affected tasks before relying on their evidence. A migration transaction that failed before commit does not have to be reversed. The baseline `RELEASE` remains unchanged on a failed rollout; inspect any reported rollback failure before retrying.

After success, separately verify the exact server SHA, HTTP/container health, migration 15 and preserved preparation/task counts. Check a bounded owner-authorized linked preparation task and its later retrieval when appropriate. Historical tasks should still have empty evidence arrays until explicitly updated; do not invent links during acceptance. Health proves startup, not the correctness of generated preparation. Confirm that ordinary GitHub deployment now sees matching installed DB/Compose files, then record exact release evidence and publish the immutable patch release through the existing process.
