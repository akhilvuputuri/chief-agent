# Parcel migration 019: operator procedure

This is a procedure for review, not evidence of execution. The automatic release command must continue refusing DB/Compose changes. Do not reuse `deploy-routines.py`: its exact baseline and migration 017 allowlist are intentionally incompatible with this change.

## Prepare and reconcile

1. Obtain independent approval of the exact PR head, including this procedure, migration 019, the Compose addition and startup check. Require passing `npm run check`, `npm run build`, `npm run format:check`. Merge only that reviewed revision with required checks passing.
2. Through the existing authorized operations connection, record the actual live `RELEASE` SHA, current healthy image ID, Compose bytes, migration markers and a bounded count of existing owner/domain records. Never assume a baseline from an old handover. Archive the live source and configuration privately for rollback; do not export `.env`, database dumps or traces to the development checkout.
3. Compare the exact reviewed candidate with the live source. Accept only the reviewed application changes, additive `019_parcels.sql` and the two Compose command-array entries applying it. All historical migrations and the trusted installed release command must be byte-identical. If another release (including watchlist 018) changed Compose or schema since review, reconcile the candidate and obtain updated review before proceeding. Do not renumber/replace an installed migration.
4. Transfer a `git archive` of the full reviewed merged SHA over the existing operations channel into a private staging directory outside the live source. Verify its commit metadata, paths and digest; reject symlinks, traversal, unexpected files or secrets. Use the existing reviewed rollout scripts' archive-validation and source-backup patterns when automating this procedure, with separate review of the new script.
5. Acquire the existing nonblocking `/var/lock/companion-release.lock` for the entire install and possible rollback. Build the candidate image tagged with its exact SHA before downtime. Record/preserve the prior image. Require baseline health; refuse running runtime work or queued/running conversation inputs. Wait until idle without cancelling, resetting or resuming owner work.

## Apply while stopped

1. Stop only the gateway. Keep PostgreSQL and its persistent volume running. Recheck that no writer/container is active and no in-flight work needs preservation before changing schema.
2. Apply only the reviewed migration using `psql -X -v ON_ERROR_STOP=1`, authenticated as the existing database operator. The file has its own transaction; do not run historical migrations as a substitute for this step.

   From a verified operator staging directory on the host:

   ```sh
   docker exec -i hermes-companion-postgres-1 \
     psql -X -U companion -d companion -v ON_ERROR_STOP=1 \
     < db/019_parcels.sql
   ```

3. Verify marker 19, all five tables, indexes and composite foreign keys. Verify migration 012's `runtime_runs_owner_id` unique index and migration 017 are already present; missing prerequisites require operator investigation. Repeat the bounded pre-install record-count checks. The migration must not remove or rewrite existing rows.
4. Publish the candidate Compose bytes, tag the candidate as the gateway image and start only the gateway with `--no-deps --no-build`. Do not launch unrelated services, reminders, mailbox searches or routines. Verify startup `/healthz` and Docker health; the startup migration check must succeed.
5. Once healthy, atomically publish the reviewed application source and update `RELEASE` to the exact deployed SHA, preserving the private environment and persistent storage. Record the installed SHA, migration marker, health and data-preservation result. Release the lock only after completion or healthy rollback.

## Rollback

On migration failure, PostgreSQL rolls back that file's transaction. Keep the gateway stopped while inspecting; do not mask failure by inserting a version marker. On later application/health failure, stop the candidate, restore the recorded prior image, Compose bytes and source, restart only the previous gateway and verify health. Restore the previous `RELEASE` value only when the previous application is healthy.

Retain any committed additive parcel tables, evidence, request keys and events. The previous application ignores them. Do not delete tracked parcels, drop tables, reverse historical migrations, reset data or replay uncertain work. A failed rollback requires explicit operator investigation.

## Close the release

After success, verify the deployed SHA and health through existing bounded diagnostics and confirm a subsequent ordinary release can use the now-matching schema/Compose baseline. Record exact-head independent review and operator evidence in the PR and [journal](journey/25-delivery-tracker.md); publish only a new patch version/tag after verified shipment.

Phone acceptance is separate: manually save a parcel, find selected delivery mail, distinguish reported/confirmed receipt, correct a field, query saved state after restart, and verify a failed refresh preserves it. No paid evaluation or real mailbox scan is part of the migration procedure.

## Interrupted proposal reports

`parcel_report` persists evidence and proposal events before acknowledging completion. A restart in that window leaves the call `uncertain`; the existing owner-wide uncertain-write gate blocks further writes pending inspection, even though proposals do not change saved parcels. Inspect the owner/run-scoped call and proposal records through the authorized operations path before resolving uncertainty. Do not automatically replay reports or clear the guard to continue. Source fingerprints prevent duplicate parcel application but do not prove report completion.
