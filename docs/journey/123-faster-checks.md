# 123 — Why did every PR wait 26 minutes for checks?

Work date(s): 2026-10-27. Written/revised: 2026-10-27.
Status: tested. The test fixture, parallel test files and the split `checks` workflow are on `claude/build-speed-research`. Local timings are measured; the GitHub wall time of the new workflow is measured only once its first run completes.

## User-visible problem and preceding iteration

Every PR waited about 26 minutes for `checks`, including documentation-only PRs, and a release added another 5 to 6 minutes, so a merge took about 32 minutes to reach production. The suite has grown with each domain (64 test files use PGlite directly and 28 more through the coding fixture) while its setup and the workflow stayed as they were when both were small.

## Evidence

- **Reported (GitHub Actions, run 40197647552, PR 321, 25 October):** `checks` took 25 min 50 s. `npm run check` took 19 min 56 s. The Pi package and its two images took 2 min 56 s, and the browser image 1 min 8 s. PR 322 changed documentation only and took 25 min 47 s. Recent releases took 5 to 6 minutes.
- **Measured (4-core, 15 GB cloud container, Node 22.22, 27 October; each test file in its own `tsx --test` process, as the runner does):**
  - All 128 test files serially: 1,767 s, all passing. The 64 files that create PGlite themselves: 1,319 s (75 %).
  - One database as the tests built it (`new PGlite()` and all 30 migrations): about 1,750 ms; the WASM compile and initdb cost more than the migrations (about 470 ms). Restoring a migrated `dumpDataDir` snapshot with a shared compiled module: about 660 ms. These benchmarks ran beside other jobs and are noisy.
  - `tests/boxes.test.ts` on `main`: peak RSS 10.4 GB, growing about 250 MB per test, and 88 s.
  - `--test-concurrency=4` on the unchanged fixtures: the kernel killed `boxes.test.ts` (memory cgroup OOM); every subtest that had run passed.
  - `tsc --noEmit` on `src`: about 20 s per pass. Replacing `@aws-sdk/client-ec2`'s types (1,042 of 3,374 files) with a shim left the time unchanged, so the AWS SDK is not the cost.
- **Measured after the change:** see Verification.

## Diagnosis and alternatives

- **Database setup dominates.** Every test boots PGlite, so most of a test's time is compiling WASM and running initdb before it does anything.
- **The memory growth is a retained reference, not a PGlite leak.** `node:test` keeps finished tests and their hooks for its report, so `t.after(() => pg.close())` keeps each closed database's WASM heap reachable. A test that creates and closes 12 databases without such a hook stays flat (about 800 MB); one that keeps references grows about 200 MB per database. The growth made parallel files unsafe, which is a plausible reason for `--test-concurrency=1`; the squashed history does not record one.
- **The workflow is one serial job.** Type checking, five image builds and the tests run one after another, and `src` is type-checked three times.

Alternatives considered:

- **One database per file, reset with `TRUNCATE ... RESTART IDENTITY CASCADE`:** about 190 ms against about 700 ms for a restore, but ten migrations seed rows, so every reset would need re-seeding and a missed table would leak state between tests. Deferred.
- **Transaction rollback per test:** the code under test opens its own transactions.
- **`clone()`:** measured 2.1 s, no faster than a fresh boot.
- **TypeScript 7 (native `tsc`):** 22 s to 10 s per pass here, with no errors. Deferred to its own PR, because its emit and changed defaults need their own review.
- **Skipping heavy jobs for documentation-only PRs:** deferred; it needs a decision about which paths count as documentation.

## Implementation and review

- `tests/helpers/pglite.ts`:
  - `migratedPGlite(migrations?)` compiles the WASM module and filesystem bundle once per test process, applies a migration list once (by default every migration, with the same filter as `src/migrate.ts`), and restores each database from that snapshot. Explicit lists keep the partial schemas some tests use; each list has its own snapshot.
  - `closeAfter(t, db)` registers a close hook that drops its reference first.
- 59 test files and `tests/helpers/coding-fixture.ts` (used by 28 more) use them. `history.test.ts` (legacy migration replay), `library-migrations.test.ts`, `media-outbox.test.ts`, `core.test.ts` and one `telegram.test.ts` case keep their own setup because they test or build schemas differently.
- `package.json`: `npm test` runs `test:ts` (`--test-concurrency=4`, with an optional `TEST_SHARD`) and `test:other`. `npm run check` still runs everything.
- `.github/workflows/ci.yml`: parallel jobs for format and types, three test shards, scripts/evals/Python runtime, the Pi package and its images, and the other images. A final `test` job passes only when all of them passed, so the check name that branch protection and the release workflow see is unchanged.
- Independent review: pending.

## Verification and outcome

- **Measured, five slowest PGlite files, serial:** 388 s before, 207 s after; all 203 tests pass.
- **Measured, `boxes.test.ts` with `closeAfter`:** peak 1.5 GB, 39 s.
- **Measured, all test files at concurrency 4 with the fixture in 30 files:** 520 s, peak 7.7 GB used; 1,286 pass, 0 fail, 1 skipped (the Docker box test, which needs an image).
- **Measured, full `npm run format:check && npm run check && npm run build` after the change:** pending in this revision.
- **Not measured:** the GitHub wall time of the new workflow.

## Follow-up and next iteration

- Record the first `checks` run's wall time and job times.
- TypeScript 7, a cross-process snapshot cache, skipping heavy jobs for documentation-only PRs, and building the release image in CI are separate changes.
