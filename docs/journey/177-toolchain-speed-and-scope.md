# 177 — What did three days of toolchain work buy in speed and scope?

Work dates: 10–12 November 2026. Written: 12 November 2026.
Status: a summary of released work. It adds no measurement of its own; every figure is copied from the entry named beside it, which holds the method and the run numbers.

## User-visible problem and preceding iteration

On 10 November the owner asked for two things from the JavaScript toolchain: make it faster and more efficient within what it already does, and widen what it does, so that more of the toolchain is Chief's own. [Kite](https://github.com/akhilvuputuri/kite) had replaced npm on 28 October ([journal 128](128-kite-replaces-npm.md)) and did nothing else at the time: it installed packages, resolved dependencies and ran scripts.

The work is spread over four entries. This one puts their results side by side, so a later reader can see what was gained, what was tried and dropped, and what still sets the time.

## Evidence

### Speed (measured)

| Change                                       | Before               | After                | Entry                                  |
| -------------------------------------------- | -------------------- | -------------------- | -------------------------------------- |
| Test databases are reused within a process   | 617 s                | 324–397 s            | [158](158-reused-test-databases.md)    |
| A serial test run shares one process         | 285.6 s              | 170.7–175.6 s        | [159](159-shared-process-test-runs.md) |
| CI runs four test shards, not six            | 13 jobs a run        | 11 jobs a run        | [165](165-four-test-shards.md)         |
| `kite run build` step in two CI jobs         | 13–22 s, median 17 s | under 1 s            | [168](168-kite-builds-typescript.md)   |
| Building Chief's main project, without types | 1,656 ms (`tsc`)     | 27 ms (`kite build`) | [168](168-kite-builds-typescript.md)   |

- **Row 1** is the sum of CI's six `test:ts` steps: the medians of six runs on main before, and five single runs after. One of the five (382 s) is the version from before its review.
- **Row 2** is `kite run test:ts` on a Mac, with a process per file before and three shared-process runs after, all on the first version. The released version took 169.0 s in one run. CI still runs a process per file, by design.
- **Row 3** was aimed at queueing, not at the length of a run. Twenty jobs were running across the account's repositories at once, and jobs had waited up to 9 minutes to start. The four test steps then took 66–112 s each over four runs.
- **Row 4** compares seven runs on main before the switch with two runs after it.
- **Row 5** is a median of 5 and 11 runs on an Apple M4 laptop, with the Kite 0.2.0 candidate. Building both projects from empty output folders took 40 ms, in a single run.

**A CI run did not get shorter, in the one run measured.** The image job takes 152–171 s and sets the length of a run. The first four-shard run took 172 s, which journal 165 calls about as long as the six-shard runs before it. No run was timed as a whole after the switch to `kite build`.

### Scope

- **Before:** Kite installed packages and ran scripts. `tsc` compiled TypeScript in CI and in coding boxes. The image builds transpiled with esbuild, through a script of Chief's own whose output had never been compared with `tsc`'s beyond the list of files written.
- **Now:** Kite also compiles TypeScript. `kite build` (Kite 0.2.0) reads `tsconfig.json`, compiles each file on its own and refuses anything `tsc` would turn into different JavaScript, such as enums, namespaces and decorators. All 250 of Chief's output files have the same syntax tree as `tsc` 5.9.3's, by a comparison that ignores layout, comments, parentheses and three equivalent spellings. CI, the gateway, browser and worker images, and a laptop all build with it (journal 168).
- **Removed from Chief:** `scripts/build-image.mjs`, its test and the direct `esbuild` dependency. esbuild is still installed, because tsx and `@earendil-works/chord` depend on it.
- **Still third-party:** type checking and declaration files (`tsc`, about 24 s in its own CI job), the test runner and TypeScript loader (Node's test runner with tsx), formatting (prettier), and Node itself.

### Tried and dropped

- **A TypeScript transpiler in Kite for tests (dropped on a measurement):** in a shared process the loader is not a cost. tsx used 50 s of CPU there and files transpiled ahead of time used 61 s (journal 159).
- **Node's built-in type transform (dropped on a measurement):** slower than tsx, 124.9 s against 75.4 s of wall time on a loaded machine (journal 159).
- **A test runner in Kite (not built, and not ruled out by a measurement):** the owner asked for one. Node's own runner already shares a process between files, with `--experimental-test-isolation=none`, so Chief's test script uses that instead (journal 159). Measured in journal 158: Chief's own source was 0.6% of the CPU in a shared-process run and the database engine 63%. What a runner in Kite would add to Node's was not measured.
- **Native Postgres for test databases (dropped on a measurement):** cloning a template database took 300–990 ms, against 156 ms to restore a snapshot in the in-process engine (journal 158).

### Not measured

- **Coding boxes:** neither test time nor `kite build` has been timed or tested inside a box.
- **Box boot on the baked image:** the configuration is live, and no launch from it had been observed when [journal 144](144-baked-box-image.md) was last updated.

## Diagnosis and alternatives

The owner asked for Kite to do more, for speed. The measurements put the time elsewhere: it was database set-up and per-file process start-up, and both were fixed in Chief's own test code. Kite's new command removed a 17 s step from two jobs and one tool from the build, which is a gain in scope more than in time.

## Implementation and review

**Review (Claude Opus 5.5), `c6d0f54`: changes requested.** The reviewer checked each figure against its source entry and found them copied correctly. Two statements went further than the sources:

- The entry said `kite build` refuses "anything it cannot show matches", and gave the 250-file match without the comparison's conditions. It now uses journal 168's wording.
- The entry listed a test runner in Kite under "measured" and said it was dropped on numbers. Journals 158 and 159 show it was replaced by Node's own shared-process runner, and no measurement ruled it out. The entry now says so.

Smaller corrections from the same review: which version each timing is from, that the claim about a CI run rests on one run, and that a coding box is untested rather than known to be unused.

## Verification and outcome

All four changes are released, with their release closures in their own entries. This entry changes documents only.

## Follow-up and next iteration

- **The image job** is the next place to look for a shorter CI run, since it sets the length of every run.
- **Type checking** is the largest toolchain step that is still third-party.
- **The first coding job on the new worker image** will show whether `kite build` behaves the same in a box.
- Before proposing a loader in Kite again, measure again: it was dropped on numbers. A test runner in Kite would need its own measurement against Node's shared-process runner, which has not been made.
