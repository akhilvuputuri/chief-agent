# 206 — Why did a reused test database return rows in index order?

Work date: 22 November 2026. Written: 22 November 2026.
Status: tested locally; not yet released. Tests only.

## User-visible problem and preceding iteration

[Journal 158](158-reused-test-databases.md) made a closed test database reusable: its reset deletes the rows, vacuums the emptied tables and hands the database to the next caller. `tests/test-db-pool.test.ts` holds it to behaving as a fresh database does, including the order an unordered `SELECT` returns.

**Reported, 22 November:** one full local run (`kite run test:ts`) at `6e243ede` failed "rows come back in insertion order after many reuses, as in a fresh database" with the message `reuse 6`: the row `10-6-…` came back before `2-6-…`. The file passed 3 of 3 times alone and hosted CI passed on that commit. The Mac was running other test processes, so load was suspected.

## Evidence

**Measured, 22 November, a Mac on Node 22.23.4, PGlite 0.3.16 (PostgreSQL 17.5), main at `b098385`:**

- **It is not load.** The runner's default four workers deal the 160 test files into eight groups, and the pool file is the nineteenth of twenty in the last. That group, run in one shared process, failed the test in 2 of 2 runs, each time at `reuse 6`. The file list at `6e243ede` is the same, so the groups were too.
- **One file sets it up.** Each of the 18 files before it in the group was run with the pool file as a pair in one process. Only the pair with `tests/coding-confirmation-telegram.test.ts` failed.
- **The heap was in order.** At the failure the eleven rows sat at `ctid` (0,1) to (0,11) in insertion order. The plan was `Index Only Scan using users_pkey`, estimated at 120 rows. In the file alone the plan was `Bitmap Heap Scan`, estimated at 1,200 rows, in all 60 cycles.
- **PGlite forbids sequential scans.** `enable_seqscan` is `off`, from PGlite's own command line. A read of a whole table is therefore planned through an index where one can serve it: a bitmap scan returns heap order, an index scan returns index order.
- **A vacuumed table is planned at its real size.** `pg_class.reltuples` is -1 for a table never vacuumed, and Postgres plans such a table as ten pages. The reset's `VACUUM` sets it to 0, and the table is then planned at the one page it has, which makes the index-only scan the cheaper plan.
- **PGlite does not notice at once.** On a bare PGlite, a table was filled, emptied, vacuumed and refilled. `pg_class` showed `reltuples` 0, and the plan stayed the 1,200-row bitmap scan through 3,000 further rounds. Of 15 kinds of statement tried after the vacuum (transactions, errors, rollbacks, locks, `DISCARD ALL`, a second vacuum), only a rolled-back `ALTER TABLE` on the table changed the plan to the index-only scan, with the rows then returned as 0, 1, 10, 2, ….
- **Why reuse 6.** The plan was the index-only scan from the first cycle. Cycle 6 is the first to insert eleven rows, the first where text order (`10` before `2`) differs from insertion order.

**How the two files meet.** The first test of the confirmation file opens four databases, adds a user to each and closes them together, so four vacuumed databases wait in the pool. The pool file's second test takes three: two are discarded for schema changes, and on the third it runs `BEGIN; ALTER TABLE users ADD COLUMN extra int; ROLLBACK`, which the pool keeps. The ordering test gets that database. Run alone, that third database is new and its `users` table has never been vacuumed.

**A full run hides it.** One default full run on unchanged main, in a separate checkout on the same busy Mac: the test failed in the shared process and passed in the rerun the runner gives a failed file ([journal 159](159-shared-process-test-runs.md)). The runner then ran the group's other 19 files again one process each, and the run ended with every group passed. So a default local run has been failing this test and passing overall since the two files shared a group; when that began was not looked up. CI runs a process per file and so never saw it.

## Diagnosis and alternatives

Reuse changed behaviour: the reset left planner statistics that a fresh database does not have. The test's assumption, that an unordered read of `users` returns insertion order in a fresh database, holds; it is what journal 158 set out to preserve for every other test.

- **Put the statistics back (chosen).** Record `relpages`, `reltuples` and `relallvisible` of everything the migrations created when a database enters the pool, and restore them on every reset.
- **Add `ORDER BY` to the test.** That would hide the difference in the one test written to detect it, and leave every other test's unordered reads exposed to it.
- **Truncate instead of delete and vacuum.** `TRUNCATE` leaves a table as never vacuumed, but took four times as long in journal 158, because nearly every table references `users`.
- **Vacuum the snapshot, so a fresh database is planned at real size too.** Consistent, but it would change the plans of every test in every database at once, with index order becoming the usual result of an unordered read.

## Implementation and review

`tests/helpers/pglite.ts`:

- **Statistics restored.** A database entering the pool copies those three columns of `pg_class`, for object ids from 16384 up, into `test_pool.sizes`. Every reset updates the rows that differ, after the vacuum.
- **In its own transaction.** Sent as one statement through `exec`, the update left the next `ALTER TABLE` failing with `tuple concurrently updated`: PGlite did not apply the catalog change to its own cache. Wrapped in `BEGIN … COMMIT` it does. Measured on a bare PGlite: a lone `exec` fails; `query`, a following statement, an explicit transaction and `db.transaction` all work.
- **ANALYZE discards.** Column statistics in `pg_statistic` survive a reset in the same way, and `ANALYZE` is not a schema change, so the event triggers do not see it. A database whose `pg_statistic` row count changed is not reused. No test runs `ANALYZE` today.

`tests/test-db-pool.test.ts`:

- **New test.** A database is filled and closed, and its reuse is compared with a fresh one after a rolled-back `ALTER TABLE users`: the same `pg_class` sizes for every relation in `public`, the same plan shape for `SELECT id FROM users`, and eleven rows in insertion order.
- **New case.** `ANALYZE users` joins the states that are never reused.

**Known limits:**

- **Index pages.** An index keeps the pages it grew to, since vacuum does not return them, so a reused database's index can be larger than a fresh one's and its plans cost more. The new test compares plans without costs for that reason. Measured with the change: with an index of 4 to 21 pages left by an earlier lease of 100 to 1,000 users, the plan for the unordered read was still the bitmap scan, at a higher cost.
- **Stale numbers within one test.** A test that vacuums a table itself goes on being planned from the old numbers until the table is reopened. That is PGlite's behaviour in a fresh database too.
- **Why PGlite misses its own catalog changes** was observed, not traced into PGlite.

## Verification and outcome

**Tested, same Mac, 22 November:**

- Against the pool as it was, the new test and the new `ANALYZE` case fail and the other eight pass. With the change all ten pass.
- The 20-file group in one shared process: failed 2 of 2 before, passed 3 of 3 after (198 of 199 tests pass, one skipped, each time).

**Measured, same Mac:** one lease, two inserts and a close took a median of 9.5 ms before and 10.3 ms after, over ten samples of 200 each way, so the restore adds about 1 ms a reuse against about 156 ms to restore a snapshot. `pg_class` stayed at 28 pages over 3,000 reuses.

**Not measured:** a full run's time, a coding box, and more than one Mac.

## Follow-up and next iteration

- If a plan is ever traced to index size, rebuild the indexes of a table that grew, or discard the database.
- The stale statistics after a vacuum are worth a report to PGlite once reduced to a script.
