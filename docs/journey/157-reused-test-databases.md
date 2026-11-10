# 157 — Where does test time go, and can a test get a database for less?

Work date: 10 November 2026. Written: 10 November 2026.
Status: tested locally. CI timings and release are pending.

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

- **Close:** `close()` resets the database and keeps it for the next caller with the same migration list. The old handle then refuses every call with `PGlite is closed`, so late work from a finished test cannot reach the next one.
- **Reset:** roll back any open transaction, delete from the tables that hold rows (with triggers and foreign keys off), put back the rows the migrations inserted, restart used sequences, then `DISCARD ALL`.
- **Never reused:** a database whose schema changed. An event trigger records every schema change, and a rolled-back change is rolled back in the record too. Event triggers do not see roles or databases being created; no test does that.
- **Off switch:** `TEST_DB_REUSE=0` restores the snapshot for every call, as before.

Deleted rows are never vacuumed, so a long-lived process grows its tables. A test file's process is short, so this has not been bounded.

## Verification and outcome

**Tested, same Mac:**

- The 31-file sample: 81.9 s to 54.2 s serially, and 35.9 s to 25.1 s four files at a time. All 348 tests passed both ways.
- In that sample, 185 of 250 databases were reused and 3 discarded for schema changes. Four files never close their databases and so reuse none; `portfolio.test.ts` alone created 25.
- The whole suite, four files at a time, passed three times with reuse and no failures. The runs took 146.6 s, 167.1 s and 216.8 s against one run of 241.8 s without. The Mac was busy and the spread is too wide to quote a saving.

**Not measured:** CI. The comparison that counts is the `test:ts` step against its 100 s median on main.

## Follow-up and next iteration

- Record CI's `test:ts` times before and after.
- Close databases in the four files that leak them.
- Decide on a shared-process runner from the 816 ms first-database cost per file.
