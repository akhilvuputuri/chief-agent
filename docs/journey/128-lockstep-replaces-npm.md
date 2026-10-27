# 128 — Replacing npm with an owned, npm-identical toolchain

Work dates: 2026-10-27 to 2026-10-28. Written: 2026-10-28.
Status: tested; cut-over PR open. The worker image digests and the production release are pending (see Follow-up).

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
- the repository is public: [akhilvuputuri/lockstep](https://github.com/akhilvuputuri/lockstep).

## Evidence

- **Tested: install parity.** `harness/parity.sh` in lockstep runs `npm ci` and `lockstep ci` on the same lockfile. It diffs every path, file type, mode, symlink target and content hash, including `node_modules/.package-lock.json`.
  - Chief's root and Pi lockfiles were checked with and without scripts and `--omit=dev`, on Linux x64, Linux arm64 and macOS arm64.
  - The reference was npm 10.9.9 from Node 22.23.4.
  - Result: zero differences. Example sizes are 27,856 entries for the root and 16,769 for Pi.
  - The same check passed on npm-generated lockfiles for 12 real-world stacks.
  - The Angular stack is the 13th. npm refuses its own fresh lockfile in `npm ci`, and lockstep refuses it with the same five problems.
- **Tested: resolution parity.** `harness/resolve-parity.sh` runs `npm ... --package-lock-only` and lockstep, then diffs `package-lock.json` and `package.json`. Results were byte-identical for:
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
  | lockstep 0.1.0                 | 2.80 s | 0.42 s |
  | pnpm 12 (imported lockfile)    | 6.66 s | 0.55 s |
  | Bun 1.4.4 (converted lockfile) | 2.74 s | 0.44 s |

  Cold installs are network-bound, and repeated runs varied by about ±1 s.

- **Measured: the [v0.1.0 release](https://github.com/akhilvuputuri/lockstep/releases/tag/v0.1.0) benchmark job.**
  - Setup: the same lockfile, median of 3, scripts off, on GitHub-hosted runners, 28 October 2026.
  - Linux x64 (4 CPUs):

    | tool     |   cold |   warm |
    | -------- | -----: | -----: |
    | npm      |  9.0 s |  7.4 s |
    | lockstep | 1.66 s | 0.29 s |
    | pnpm     |  3.2 s |  1.6 s |
    | Bun      | 1.07 s | 0.40 s |

  - Linux arm64: lockstep 1.12 s cold and 0.20 s warm; Bun 0.61 s and 0.20 s; npm 7.1 s and 5.3 s.
  - On a fast network Bun's cold install is still faster than lockstep's; that is the next performance target. Warm installs, which CI caches and coding boxes with a baked store hit, are at least as fast as Bun's.

## Diagnosis and alternatives

- **Bun and pnpm** convert `package-lock.json` to their own lockfile and build a different `node_modules`. The issue measured Bun at 347 packages against npm's 339 for the same lockfile. Exact npm parity was a hard requirement, so neither could be used directly.
- **A lockfile-only installer** would have frozen dependencies until a resolver existed. The owner chose a resolver in v1.

lockstep ports npm's own behaviour from source:

- arborist's ideal tree: the queue order, PlaceDep/CanPlaceDep with peer sets, and calcDepFlags;
- pacote's file modes;
- bin-links;
- the lifecycle script phases;
- npm ci's lockfile validation;
- npm's configuration precedence.

Out-of-scope features fail with a clear error and never fall back: workspaces, overrides, bundled dependencies, non-default registries, and `.npmrc` settings that change results.

## Implementation and review

lockstep:

- [PR 1](https://github.com/akhilvuputuri/lockstep/pull/1) was reviewed independently by Opus 5.5 in three rounds:
  1. `c0dd5eb`, REQUEST CHANGES:
     - npm config and `NODE_ENV` were ignored;
     - hard-linked store entries were not re-verified.
  2. `e8a358a`, REQUEST CHANGES:
     - store entries from the earlier layout were trusted without verification;
     - npm's omit precedence was wrong.
  3. `7c2b2e6`, **APPROVE**. Low follow-ups R1–R6 remain.

Chief (this PR):

- **Pin and installer:** `tools/lockstep.json` pins the release and a SHA-256 per platform. `tools/install-lockstep.mjs` needs only Node and refuses a checksum mismatch.
- **CI:** `.github/actions/setup-lockstep` installs the pinned binary, caches its store per lockfile and removes npm and npx from the runner's PATH, so nothing can fall back to them.
- **Images:** every Dockerfile installs lockstep and deletes npm and corepack. `npm prune --omit=dev` becomes `lockstep ci --omit=dev`. The standalone Pi image reads the pin through a named build context (`--build-context lockstep=tools`).
- **Coding runtimes:**
  - the TypeScript worker, Pi worker and Python runtime run `lockstep ci` and `lockstep run <script>`;
  - the merge gate (`merge-policy.ts`), `controller.ts` and `squad-state.ts` require the exact `lockstep run check|build|format:check` identities;
  - workspaces set `LOCKSTEP_STORE` inside the tool home, outside the checkout.
- **Tests:**
  - tests that asserted npm command strings now assert lockstep's;
  - the workspace-install test uses a local `file:` package and checks that no store or cache enters the checkout;
  - Python fixtures lock with `lockstep install --lockfile-only`.
- **Docs:** current docs and AGENTS.md now name lockstep. Historical journal entries and recorded Pi acceptance results are unchanged.

## Verification and outcome

[lockstep v0.1.0](https://github.com/akhilvuputuri/lockstep/releases/tag/v0.1.0) was published from `1911afd`, on main with green CI. The release workflow built each binary twice, required both builds to be byte-identical, re-ran npm parity on the exact binaries (Chief root and Pi, with and without `--omit=dev`, plus a fresh resolve), and published SHA-256 checksums. `tools/lockstep.json` pins those checksums, and the installer refuses a mismatched binary (tested).

Local verification on macOS with lockstep 0.1.0:

- `lockstep ci` passed in 1.6 s, with install scripts;
- `lockstep run format:check` and `lockstep run typecheck` passed;
- `lockstep run build` passed;
- the 9 changed coding test files passed (97 tests);
- the Python runtime and squad tests passed (40 tests, including real `lockstep ci` and `lockstep run` checks in the worker).

The full CI result for the cut-over PR is recorded on the PR.

Not yet done: Docker image builds with the published release binary, rebuilt worker images, and a production release.

### Release closure — pending

Pending steps:

1. Merge the cut-over PR.
2. Run `coding-image.yml` and `pi-coding-image.yml` on main.
3. Update the digests in `config/boxes.json`, `config/coding.json` and `config/coding-pi.json`. These are protected paths, so the owner reviews the change.
4. Release Chief.
5. Record the release and the CI, host-build and coding-job timings against the baseline in issue #330.

Coding jobs on the old worker images report `npm run …` and will be refused by the exact merge gate until the digests are updated.

## Follow-up and next iteration

- lockstep R1–R6 (Low; listed on lockstep PR 1).
- Measure:
  - CI install time;
  - the production image build on the Lightsail host;
  - the install time in a real coding job.

  Compare each against the issue's baseline.

- Consider baking a verified lockstep store into the worker images, so fresh boxes start warm.
- Later lockstep milestones: workspaces and overrides if Chief needs them, and TypeScript build and test orchestration (issue #330, phase 5).
