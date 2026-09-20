# Library migration 016 and operator rollout

Migration `016_library.sql` adds the library account tables (`library_identities`, `library_link_attempts`, `library_shelf`, `library_call_days`, `library_calls`, `library_pacing`, `library_watch`, `library_notices`), two partial unique indexes on `approvals` and the widened `approvals_operation_check`. Because `db/003_skills.sql` and `db/009_calendar_approval.sql` re-assert that constraint on every Compose start and `ADD CONSTRAINT` validates existing rows, both files carry the same widened line, exactly as the Calendar release edited 003. The migration deletes nothing and records version 16. Validated under PGlite by `tests/library-migrations.test.ts` (full sorted directory, rows per library operation, re-run, constraint definition).

The ordinary GitHub release refuses database and Compose changes. The reviewed [deploy-library.py](../scripts/deploy-library.py) is a one-time operator procedure through the existing authorized operations connection; it does not add a cloud SSH capability or install a changed trusted release command. This is the only phase of the library work that needs that connection, a known cloud/local parity gap.

## Review and prepare

1. Review the application, migration, the two historical edits, the Compose additions (the `016` command pair after `015` and the two gateway environment lines after `MINIAPP_ORIGIN`) and the rollout script together. Require the independent review loop, passing checks and a merged main commit. Confirm nothing under the `migrate` service changes.
2. Run `python3 -B scripts/test-deploy-library.py`. The offline tests stub Docker, database calls and health; they exercise refusal ordering, the whitelisted historical edit, the environment-key pre-flight and rollback, not real PostgreSQL semantics.
3. On the server, generate the identity key once, directly into the private environment file: a line `LIBRARY_IDENTITY_KEY=` followed by the output of `openssl rand -hex 32`. Never print it, paste it in chat or copy it to a development checkout. `LIBRARY_HOLD_EMAIL=` may stay empty. Losing the key means re-linking from the phone.
4. Prepare `git archive --format=tar --output=... <full merged main SHA>` from the exact reviewed commit and upload it with the reviewed script outside the live source directory.

## Run from the exact baseline

Completed on 20 September 2026: deployed `71de810f370d109f859a845de262ae694d3e552f`, healthy, migration 16. The baseline-specific procedure below is retained as the record; do not rerun it against a newer release.

Server `RELEASE` had to equal `794da5fda26482877d12d21661cb9f38adda4378` (the v0.3.11 docs record deployed on 20 September 2026). If a newer release has deployed, reconcile and obtain a revised review; do not rewrite `RELEASE`.

Invoke `python3 /path/to/deploy-library.py /path/to/reviewed-source.tar <full merged main SHA>`. It takes the nonblocking release lock and:

- Rejects unsafe archive entries, changed or removed historical migrations other than the exact constraint widening in 003 and 009 (both or neither), any new migration other than 016, a 016 that does not repeat the widened constraint, any Compose change beyond the two reviewed insertions, the key appearing under `migrate:`, and a server `.env` without a 64-hex `LIBRARY_IDENTITY_KEY` line.
- Builds the candidate before downtime, confirms baseline health, refuses running runtime work and queued or running conversation input.
- Stops only the gateway, applies only `016_library.sql`, checks the version marker and that the live constraint now names `library_borrow`, writes the new Compose file, starts the candidate and verifies health.
- On success publishes the reviewed source (so the live 003 and 009 are the widened copies and later ordinary releases hash-match) and writes `RELEASE`.

## Rollback

If anything fails after the gateway stops, the script first removes every library approval row and link attempt (only the failed candidate could have created them; the restored narrow 003 and 009 would otherwise fail validation at the next Compose start), then restores the previous image, Compose and source and verifies health. The widened constraint and the empty library tables stay; they are a superset the previous application ignores. There is no table drop and no data replay.

## After success

Verify the exact server SHA, health, migration 16 and that ordinary GitHub deployment resumes (one normal release). From the phone: `/library` reports not linked; `/library link`, approve, complete the handshake in Libby; "how many days left on my loans" answers from the shelf. Record which linking direction worked and the observed poll results in [journey 22](journey/22-library-assistant.md), then publish the patch release.
