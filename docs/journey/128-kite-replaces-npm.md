# 128 — Replacing npm with an owned, npm-identical toolchain

Work dates: 2026-10-27 to 2026-10-28. Written: 2026-10-28.
Status: tested; cut-over PR open. The worker image digests and the production release are pending (see Follow-up).

Naming: the tool was published as **lockstep** (v0.1.0) and renamed **Kite** on 28 October 2026, before this cut-over merged. The repository is `akhilvuputuri/kite` (old links redirect), the command is `kite`, and the crate and planned npm/Homebrew package are `kite-pm`. Chief pins Kite 0.1.2. It is the second release under the new name, after 0.1.1, and adds incremental installs: `kite install`, `uninstall` and `update` change only the packages that differ from the installed tree, matching `npm install`. Kite's release notes give about 40 ms for a repeated install on a 300-package project, against about 430 ms for npm.

## User-visible problem and preceding iteration

Issue #330. npm installs were a fixed cost in every CI job, every image build on the Lightsail host and every coding box:

- `npm ci` re-extracts all tarballs on each run;
- a fresh box took about 1 minute to install ([journal 91](91-boxed-subagents.md));
- a release spends 5–6 minutes building the production image on the host.

Journal 123 had already cut CI time by restoring test databases from a snapshot. Installing dependencies was the next fixed cost.

The owner decided (issue #330, 27 October 2026):

- npm is removed from CI, Dockerfiles, coding runtimes, scripts and docs, with no fallback;
- the replacement is a separate repository with pinned, checksum-verified releases;
- it includes a resolver in v1, so dependencies can still be added and upgraded;
- it is written in Rust;
- the repository is public: [akhilvuputuri/kite](https://github.com/akhilvuputuri/kite).

## Evidence

- **Tested: install parity.** `harness/parity.sh` in kite runs `npm ci` and `kite ci` on the same lockfile. It diffs every path, file type, mode, symlink target and content hash, including `node_modules/.package-lock.json`.
  - Chief's root and Pi lockfiles were checked with and without scripts and `--omit=dev`, on Linux x64, Linux arm64 and macOS arm64.
  - The reference was npm 10.9.9 from Node 22.23.4.
  - Result: zero differences. Example sizes are 27,856 entries for the root and 16,769 for Pi.
  - The same check passed on npm-generated lockfiles for 12 real-world stacks.
  - The Angular stack is the 13th. npm refuses its own fresh lockfile in `npm ci`, and kite refuses it with the same five problems.
- **Tested: resolution parity.** `harness/resolve-parity.sh` runs `npm ... --package-lock-only` and kite, then diffs `package-lock.json` and `package.json`. Results were byte-identical for:
  - Chief: no-op install, fresh resolution, and adds (prod, dev, exact, tag, range, existing, peer-heavy);
  - uninstall, and both named and full update;
  - fresh resolution of 13 fixtures.

  An ESLint-plugin peer conflict gives the same ERESOLVE refusal in both tools.

- **Tested: semantics.** Over 40,000 random cases, semver satisfaction and range validity matched node-semver. Over 10,000 strings, key ordering matched Node's ICU collator. Both had zero mismatches.
- **Measured: install speed.**
  - Setup: clean install of Chief's root lockfile with scripts off, median of 5 runs, macOS arm64 with 10 cores, 28 October 2026.
  - The machine was also running other work, with a load average of about 7.

  | tool                           |   cold |   warm |
  | ------------------------------ | -----: | -----: |
  | npm 10.9.9                     | 4.53 s | 2.98 s |
  | Kite 0.1.0 (as lockstep)       | 2.80 s | 0.42 s |
  | pnpm 12 (imported lockfile)    | 6.66 s | 0.55 s |
  | Bun 1.4.4 (converted lockfile) | 2.74 s | 0.44 s |

  Cold installs are network-bound, and repeated runs varied by about ±1 s.

- **Measured: the [v0.1.0 release](https://github.com/akhilvuputuri/kite/releases/tag/v0.1.0) benchmark job.**
  - Setup: the same lockfile, median of 3, scripts off, on GitHub-hosted runners, 28 October 2026.
  - Linux x64 (4 CPUs):

    | tool |   cold |   warm |
    | ---- | -----: | -----: |
    | npm  |  9.0 s |  7.4 s |
    | kite | 1.66 s | 0.29 s |
    | pnpm |  3.2 s |  1.6 s |
    | Bun  | 1.07 s | 0.40 s |

  - Linux arm64: kite 1.12 s cold and 0.20 s warm; Bun 0.61 s and 0.20 s; npm 7.1 s and 5.3 s.
  - On a fast network Bun's cold install is still faster than kite's; that is the next performance target. Warm installs, which CI caches and coding boxes with a baked store hit, are at least as fast as Bun's.

## Diagnosis and alternatives

- **Bun and pnpm** convert `package-lock.json` to their own lockfile and build a different `node_modules`. The issue measured Bun at 347 packages against npm's 339 for the same lockfile. Exact npm parity was a hard requirement, so neither could be used directly.
- **A lockfile-only installer** would have frozen dependencies until a resolver existed. The owner chose a resolver in v1.

kite ports npm's own behaviour from source:

- arborist's ideal tree: the queue order, PlaceDep/CanPlaceDep with peer sets, and calcDepFlags;
- pacote's file modes;
- bin-links;
- the lifecycle script phases;
- npm ci's lockfile validation;
- npm's configuration precedence.

Out-of-scope features fail with a clear error and never fall back: workspaces, overrides, bundled dependencies, non-default registries, and `.npmrc` settings that change results.

## Implementation and review

kite:

- [PR 1](https://github.com/akhilvuputuri/kite/pull/1) was reviewed independently by Opus 5.5 in three rounds:
  1. `c0dd5eb`, REQUEST CHANGES:
     - npm config and `NODE_ENV` were ignored;
     - hard-linked store entries were not re-verified.
  2. `e8a358a`, REQUEST CHANGES:
     - store entries from the earlier layout were trusted without verification;
     - npm's omit precedence was wrong.
  3. `7c2b2e6`, **APPROVE**. Low follow-ups R1–R6 remain.

Chief (this PR):

- **Pin and installer:** `tools/kite.json` pins the release and a SHA-256 per platform. `tools/install-kite.mjs` needs only Node and refuses a checksum mismatch.
- **CI:** `.github/actions/setup-kite` installs the pinned binary, caches its store per lockfile and removes npm and npx from the runner's PATH, so nothing can fall back to them.
- **Images:** every Dockerfile installs kite and deletes npm and corepack. `npm prune --omit=dev` becomes `kite ci --omit=dev`. The standalone Pi image reads the pin through a named build context (`--build-context kite=tools`).
- **Coding runtimes:**
  - the TypeScript worker, Pi worker and Python runtime run `kite ci` and `kite run <script>`;
  - the merge gate (`merge-policy.ts`), `controller.ts` and `squad-state.ts` require the exact `kite run check|build|format:check` identities;
  - workspaces set `KITE_STORE` inside the tool home, outside the checkout.
- **Tests:**
  - tests that asserted npm command strings now assert kite's;
  - the workspace-install test uses a local `file:` package and checks that no store or cache enters the checkout;
  - Python fixtures lock with `kite install --lockfile-only`.
- **Docs:** current docs and AGENTS.md now name kite. Historical journal entries and recorded Pi acceptance results are unchanged.

## Verification and outcome

v0.1.0 (released as lockstep, [notes](https://github.com/akhilvuputuri/kite/releases/tag/v0.1.0)) was published from `1911afd`, on main with green CI. The release workflow built each binary twice, required both builds to be byte-identical, re-ran npm parity on the exact binaries (Chief root and Pi, with and without `--omit=dev`, plus a fresh resolve), and published SHA-256 checksums. Kite 0.1.1 (the rename) and 0.1.2 ([notes](https://github.com/akhilvuputuri/kite/releases/tag/v0.1.2), from `8c39dc0`) were released through the same workflow. 0.1.2 adds incremental-install parity scenarios to Kite's CI: no-op, add, uninstall, update, deleted packages, tool caches and link changes, all byte-identical to npm. `tools/kite.json` pins the 0.1.2 checksums, and the installer refuses a mismatched binary (tested).

Local verification on macOS with the 0.1.0 binary, before the rename (the commands were then `lockstep ci` and `lockstep run`):

- `lockstep ci` passed in 1.6 s, with install scripts;
- `lockstep run format:check` and `lockstep run typecheck` passed;
- `lockstep run build` passed;
- the 9 changed coding test files passed (97 tests);
- the Python runtime and squad tests passed (40 tests, including real `lockstep ci` and `lockstep run` checks in the worker).

Local verification on macOS with the pinned 0.1.2 binary, after the rename:

- `tools/install-kite.mjs` fetched the binary and verified its checksum, and the installer tests passed (3);
- `kite ci` took 0.94 s with a warm store and install scripts, and a repeated `kite install` took 0.02 s (306 packages);
- `kite run format:check`, `kite run typecheck` and `kite run build` passed;
- `kite run check:coding` passed: ruff, mypy and 62 Python runtime tests, including real `kite ci` and `kite run` checks in the worker.

The full CI result for the cut-over PR is recorded on the PR.

The PR's CI built every Dockerfile with the published v0.1.0 binary: the gateway, browser, coding and Pi worker images and the standalone Pi image. It passed their smoke checks, with all 11 checks green on `7babddd`. Not yet done: published worker images, their digests, and a production release.

### Release closure — pending

Pending steps:

1. Merge the cut-over PR.
2. Run `coding-image.yml` and `pi-coding-image.yml` on main.
3. Update the digests in `config/boxes.json`, `config/coding.json` and `config/coding-pi.json`. These are protected paths, so the owner reviews the change.
4. Release Chief.
5. Record the release and the CI, host-build and coding-job timings against the baseline in issue #330.

Transition, traced by the independent review. The gate fails closed throughout, so nothing merges with checks that did not run:

- **Between this merge and the digest release, old images:**
  - They report `npm run …`, which the exact gate refuses.
  - Against the new main they also fail outright: Chief's `check` script now calls `kite`, which those images lack.
  - Accepting both command names (option b) would only help jobs on a pre-merge base, so it is not worth it.
- **After the digest release:** jobs still pinned to a pre-merge base fail on the new images, because their scripts call npm.
- **Candidates that already finished:** any with stored `npm run` checks that are waiting for a Merge card are refused, with a reviewer-proof message.
- **Plan:** before merging, finish or cancel the open coding jobs. Merge, publish the images, update the digests, then restart any job that is still needed.

## Follow-up and next iteration

- kite R1–R6 (Low; listed on kite PR 1).
- Measure:
  - CI install time;
  - the production image build on the Lightsail host;
  - the install time in a real coding job.

  Compare each against the issue's baseline.

- Consider baking a verified kite store into the worker images, so fresh boxes start warm.
- Later kite milestones: workspaces and overrides if Chief needs them, and TypeScript build and test orchestration (issue #330, phase 5).
