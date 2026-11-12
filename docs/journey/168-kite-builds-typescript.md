# 168 — Can Kite build Chief's TypeScript, and is its output the same as tsc's?

Work dates: 11–12 November 2026. Written: 12 November 2026.
Status: Kite 0.2.0 is released and pinned by this change. Chief's build still runs `tsc` and esbuild; switching it is the next change, after the coding worker image carries the new Kite.

> **Update, 12 November 2026:** the pin is live, the coding worker image is rebuilt with Kite 0.2.0 and pinned, and `kite run build` and the image builds now use `kite build`. See [Build switch](#build-switch-12-november-2026) below, which also corrects three statements in this entry.

## User-visible problem and preceding iteration

The owner asked for Kite to take over more of the toolchain where that buys speed. [Journal 159](159-shared-process-test-runs.md) showed that a transpiler would not speed up tests. Builds are different: `kite run build` runs `tsc`, which type-checks and emits, in two CI jobs and in every coding job's checks, although the type check already runs on its own.

## Evidence

**Measured, CI, six runs on main (10 November):** `kite run build` took a median of 21 s in the Pi worker job and 19 s in the scripts job. `kite run typecheck` took 24 s in its own job.

**Measured, an Apple M4 laptop, 11 November, Chief's main project (232 files, about 124,000 lines), with the Kite 0.2.0 candidate:**

| Build                           | Median   |
| ------------------------------- | -------- |
| `tsc --noCheck` (emit only)     | 1,656 ms |
| `kite build`                    | 27 ms    |
| `kite run build`, both projects | 40 ms    |

The two timed builds are medians of 5 and 11 runs in one session; `kite run build`, with the scripts switched locally, is a single run.

**Measured, same day, main at `a7c1993`:** all 250 output files of the two projects have the same syntax tree as `tsc` 5.9.3's, compared with Kite's `harness/ast-diff.mjs`. Three spellings count as equal: `import {} from "x"` and `import "x"`, `{ a: a }` and `{ a }`, and a single statement with or without braces.

**Tested, same laptop and candidate, scripts switched locally:** `kite run typecheck` passed, and `kite run test` (build, 1,665 TypeScript tests in the shared process, 77 script tests) passed in 347.5 s.

## Diagnosis and alternatives

- **esbuild (to be replaced):** the image build transpiles with esbuild ([journal 132](132-ci-built-gateway-image.md)), through a script of Chief's own. It was never compared with `tsc` beyond the list of files written.
- **`kite build` (chosen):** new in Kite 0.2.0. It reads `tsconfig.json`, compiles each file on its own and refuses anything `tsc` would turn into different JavaScript, such as enums, namespaces and decorators. Chief uses none of those.
- **TypeScript 7 for the build:** would also be fast, but three scripts still use the compiler API it does not yet ship.

A transpile cannot fail on a type error. That is already true of the image build; `typecheck` is what gates a release.

## Implementation and review

**Kite ([PR 13](https://github.com/akhilvuputuri/kite/pull/13), merged as `95fd004`, released as v0.2.0):** the `kite build` command, 56 unit tests, and a CI job that compiles fixture projects with `tsc` and with `kite build` and compares them by syntax tree.

An independent reviewer (Claude Opus 5.5) requested changes three times before approving, each time by compiling small projects with both tools:

- **First version:** files reached only through imports were not built; a script got no `"use strict"` and a module no `export {}` where `tsc` adds them; two empty import and re-export forms were kept or dropped wrongly; a refused file left a half-written build; the comparison tool missed three kinds of difference.
- **Second:** a dynamic import written as a template string was not followed; `paths` patterns were tried in the wrong order; imports in declaration files were not followed; a `composite` project was laid out wrongly.
- **Third:** `module: "Preserve"` is now refused, and a matched `paths` pattern no longer falls back to `baseUrl`.

None of those cases occurs in Chief's code. The comparison on Chief's 250 files was repeated on each corrected version.

**This change:** `tools/kite.json` pins Kite 0.2.0 and its three checksums. Nothing calls `kite build` yet, and 0.2.0's install, run and exec code is what 0.1.3 had.

## Verification and outcome

**Tested, with the pinned 0.2.0 installed by `tools/install-kite.mjs`:** the checksum verified; `kite ci` for both lockfiles, `format:check`, `typecheck` and `build:image` passed.

**Measured, Kite's release run 43146342528:** each of the three binaries was built twice and compared, then checked against `npm` 10.9 and `tsc` 5.9.3 on the parity fixtures before publishing.

**Not tested:** `kite build` in CI, in the image builds or on a coding box.

## Follow-up and next iteration

- Rebuild and pin the coding worker image, so coding boxes have Kite 0.2.0.
- Then switch `kite run build` and the image builds to `kite build`, and remove the esbuild script. A machine with an older Kite will fail that build with an unknown-command error; `node tools/install-kite.mjs` installs the pinned one.
- Record the two CI jobs' build steps after that release.

## Build switch (12 November 2026)

**Pin release.** The pin merged as `d2d7d3b` (PR 457). Checks run 43148277915 passed and release run 43148594589 succeeded; the host ran the gateway at `d2d7d3b`, healthy.

**Corrections to the text above,** from the reviewer of PR 457:

- Kite's PR 13 added 25 unit tests, which makes 56 in all; it did not add 56.
- The checks listed under "Tested, with the pinned 0.2.0" ran on the same Apple M4 laptop.
- Kite's release run is a test, not a measurement: it reports pass or fail, and it passed.

**Worker image.** Run 43148537031 built `sha256:8da97981…` from `d2d7d3b`. Its Dockerfile installs Kite from `tools/kite.json` and stops on a checksum mismatch, so the image carries 0.2.0. `config/boxes.json` and `config/coding-pi.json` pin it, and `sha256:33639fbe…` moves to `previousImages`.

The list of earlier images holds at most ten, and this pin made eleven; the first local test run failed on that. The oldest, `sha256:ba99d955…`, which was current on 20–21 October, is dropped. **Measured on the host, 12 November:** the two coding jobs recorded on it are finished (one with its pull request ready, one cancelled), so nothing can ask for a box on it.

**The switch.**

- **`build`:** `kite build --project coding_runtime_pi --skip-declarations && kite build`. `build:image` is gone; CI and both gateway Dockerfiles call `build`.
- **Removed:** `scripts/build-image.mjs`, its test, and the direct `esbuild` dependency. tsx still brings its own esbuild.
- **Unchanged:** `typecheck`, and `build:pi`, which runs `tsc` in the Pi package and writes the declaration files the type check needs. The Pi package's own `build` and `check` still run `tsc`.

The pin and the switch are one change, so a new coding job never meets `kite build` on an image without it.

**Measured, same laptop, 12 November, this branch on main at `d2d7d3b`, pinned Kite 0.2.0:**

- **Parity:** all 250 output files (232 and 18) have the same syntax tree as `tsc` 5.9.3's, by the same comparison as above.
- **Time:** `kite run build` from empty output folders took 40 ms, in a single run.

**Tested, same laptop and branch:** `kite run typecheck` passed. `kite run test` from empty output folders (build, 1,674 TypeScript tests in the shared process with none failing and one skipped, 77 script tests, the Python suites) passed in 239 s. An earlier run failed two tests on the eleven earlier images, described above.

**Not tested:** `kite --version` inside the new worker image, and a coding job on it.

**What changes for people and agents:**

- **Declarations:** `kite run build` no longer writes the Pi package's declaration files. An editor that wants them needs `kite run typecheck` or `kite run build:pi` once.
- **Type errors:** `kite run build` no longer fails on one. `kite run check` and CI's `format and types` job still do.
- **Older Kite:** a machine with Kite 0.1.3 fails `kite run build` with an unknown-command error; `node tools/install-kite.mjs` installs the pinned one. A coding job paused on an earlier worker image keeps its own branch and its old scripts, so it is affected only if it takes this change from main.

**Next:** record the build steps of the two CI jobs after release.
