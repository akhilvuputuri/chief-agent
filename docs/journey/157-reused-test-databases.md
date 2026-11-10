# 157 — Where does test time go, and can a test get a database for less?

Work date: 10 November 2026. Written: 10 November 2026.
Status: tested locally and in one CI run. Release is pending.

## User-visible problem and preceding iteration

Tests are the largest part of a CI run and of every coding job's checks. [Journal 141](141-parallel-test-files.md) ran four test files at a time; nothing since has measured what a test spends its time on. The owner asked where the JavaScript toolchain could take over more work to make things faster.

## Evidence

**Measured, 10 November, a Mac on Node 22.23.4, a sample of 31 of the 153 test files (every fifth), run serially unless stated:**

| Run                                     |   Time |
| --------------------------------------- | -----: |
| `tsx --test`, one process per file      | 87.5 s |
| The same files transpiled ahead of time | 75.2 s |
| Transpiled, one shared process          | 60.6 s |

- **CPU profile of the shared-process run (65 s):** PGlite's JavaScript 42%, its WASM 21%, idle 20%, garbage collection 6.5%, Chief's own source 0.6%.
- **Database creation:** 255 calls to `PGlite.create` took 48.9 s of that run. 18,261 queries took 7.4 s. The counting wrapper adds some overhead of its own.
- **One database:** the first in a process costs 816 ms (compile, initdb, migrations). Each later one costs 156 ms to restore from the snapshot.
- **Alternatives measured:** truncating all 110 tables takes 41–46 ms, because nearly every table references `users`. Probing for tables with rows and deleting from those takes about 12 ms. Native Postgres 17 in Docker on the same Mac took 300–990 ms to clone a template database. Node's compile cache made no measurable difference.

**Hypothesis:** a test runner that shares the compiled engine and snapshot between files would save most of the 816 ms per file. Not built or measured.

## Diagnosis and alternatives

Most of a test's time goes to restoring a database snapshot into PGlite's in-memory filesystem, not to queries or to Chief's code. The helper already compiled once and restored from a snapshot per process ([journal 138](138-faster-ci-checks.md)).

- **Reuse a closed database (chosen):** empty it and hand it to the next caller.
- **Truncate instead of delete:** simplest to reason about, but four times slower.
- **Native Postgres:** slower per database here, and a new service for every test run.
- **One transaction per test, rolled back:** Chief's code opens its own transactions.

## Implementation and review

`migratedPGlite` in `tests/helpers/pglite.ts` now returns a handle over a pooled database. No test changed.

- **Close:** `close()` resets the database and keeps it for the next caller with the same migration list. The old handle then refuses every method call with `PGlite is closed`, and its listeners are removed, so late work from a finished test does not reach the next one through it.
- **Reset:** roll back any open transaction, delete from the tables that hold rows (with triggers and foreign keys off), vacuum them, put back the rows the migrations inserted, restart every sequence, then `DISCARD ALL`.
- **Never reused:** a database whose schema changed, or that gained a role or a large object. Event triggers record every schema change in a table, so a rolled-back change is rolled back in the record too, and they keep firing in replica mode. A table that vacuum did not return to zero size is not reused either.
- **Off switch:** `TEST_DB_REUSE=0` restores the snapshot for every call, as before.

**Known limits:** a test that deliberately drops or disables the `test_pool` triggers defeats the check. A value on the handle that is not a method, such as an extension's namespace, is not refused after close. `ALTER DATABASE ... SET` is not undone. No test does any of these.

**Review (Claude Opus 5.5), `7ee516c`: changes requested.** All findings were reproduced by experiment:

- **Row order.** The first version deleted rows without vacuuming and claimed later rows would still land in insertion order. They did not: an unordered `SELECT` came back in a different order in 37 of 400 reuses, from the sixteenth on. Deleting and then vacuuming gave 0 of 400, at about the same cost (7.1 ms against 6.8 ms in one loaded run), and tables no longer grow.
- **Listeners.** PGlite keeps listener callbacks on the instance, so a closed test's callback fired in the next test. The handle now removes them on close.
- **Missed changes.** `RESET ALL` cleared the first version's change marker, schema changes made in replica mode were not recorded, a sequence moved with `setval(..., false)` was not restarted, and large objects and roles survived. Each now has a regression test.

## Verification and outcome

**Tested, same Mac:**

- The 31-file sample: 81.9 s to 54.2 s serially, and 35.9 s to 25.1 s four files at a time. All 348 tests passed both ways.
- In that sample, 185 of 250 databases were reused and 3 discarded for schema changes. Four files never close their databases and so reuse none; `portfolio.test.ts` alone created 25.
- The whole suite, four files at a time, passed three times with reuse and no failures. The runs took 146.6 s, 167.1 s and 216.8 s against one run of 241.8 s without. The Mac was busy and the spread is too wide to quote a saving.

**Measured, CI, the first version (`7ee516c`, run 42826457304):** the six `test:ts` steps took 74, 55, 41, 59, 88 and 65 s, 382 s in all. Their medians over six runs on main sum to 617 s, so this one run is 38% lower. The shards are now uneven because their weights were recorded before the change.

**Not measured:** the reviewed version in CI, and more than one run.

## Follow-up and next iteration

- Re-record the shard weights, which the change has made stale.
- Close databases in the four files that leak them.
- Decide on a shared-process runner from the 816 ms first-database cost per file.
