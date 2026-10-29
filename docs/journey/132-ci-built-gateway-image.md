# 132 — Can a release stop building on the production host?

Work dates: 28–29 October 2026. Written: 29 October 2026.
Status: released. Since `b431444` (29 October 2026), releases pull the CI-built gateway image by digest. The first pull release step took 51 s, against 370–400 s for host builds.

## User-visible problem and preceding iteration

A release took about 6 minutes from the start of the host step to a healthy gateway. Most of that went to `docker build` on the 2-vCPU, 2 GB Lightsail host, running beside production. [Journal 128](128-kite-replaces-npm.md) moved installs to Kite and removed the full reinstall in the image build (PR 346), but the release step barely moved: 370 s, against 377 s and 400 s for the previous two Kite releases.

## Evidence

**Measured, release step durations** (from the release workflow):

| Release              | Installer                       | Seconds  |
| -------------------- | ------------------------------- | -------- |
| `1ff88d2`, `45bd6ed` | npm                             | 279, 353 |
| `0a78485`, `d77a23a` | Kite                            | 377, 400 |
| `f74ff74`            | Kite, with the PR 346 prune fix | 370      |

**Measured on the host, read-only, for `f74ff74`** (journal and `docker history`):

- The release's SSH step started at 18:06:06, and stage 2's first layer was created at 18:09:25. Upload, staging and the whole build stage therefore took 3 min 19 s.
- Stage 2 then took 2 min 22 s, mostly for small steps:
  - `COPY node_modules` (333 MB): 41 s;
  - `COPY dist` (2.8 MB): 25 s;
  - eight small `COPY`s: about 3 s each;
  - `ARG`: 19 s; `ENV`: 12 s; `USER`: 11 s; `CMD`: 6 s, although all four write nothing.
- The host uses Docker's legacy builder (no buildx) with the containerd image store, which commits a snapshot per instruction. The same metadata steps took about 2 s each on a GitHub runner.

**Measured locally:** `tsc` for the root build took 7.2 s, of which 4.6 s was type checking, with a 1 GB peak. esbuild transpiled the same 215 files in 0.10 s.

## Diagnosis and alternatives

- **Cause.** Per-instruction overhead and build CPU on a small host that is also serving production, not package installs.
- **Kite's share.** Kite's Dockerfile has 27 instructions against npm's 24, which is about 30–45 s at this overhead.

Alternatives, largest first:

1. **Build in CI and pull by digest.** Removes the host build entirely, and deploys the exact image CI built from the commit that passed CI.
2. **BuildKit on the host.** Removes the per-instruction overhead. After option 1, it only serves as the fallback.
3. **Fewer Dockerfile instructions.**
4. **Transpile instead of type-checking in the image build.** CI's `typecheck` already gates releases.

Running TypeScript directly with Node's type stripping was rejected for now. It needs `.ts` import specifiers, and Chief has 769 `.js` ones, plus 374 non-erasable constructs, mostly constructor parameter properties.

## Implementation and review

- **`checks`, main only:** a new `publish gateway image` job runs alongside the tests.
  - It builds with BuildKit and the GitHub Actions layer cache, then pushes `ghcr.io/akhilvuputuri/chief-agent-gateway:<sha>` (linux/amd64).
  - The image carries the label `org.opencontainers.image.revision=<sha>` and the build argument `RELEASE_SHA=<sha>`.
  - The job pushes a build-provenance attestation.
  - The release runs only if the whole workflow succeeds, so a failed publish blocks the release.
- **`release`:** finds the image digest for the commit and verifies the attestation (signer `ci.yml`, ref `refs/heads/main`, source digest = the commit). This step is advisory in this change. The switch-over makes it required and sends the digest.
- **`scripts/cloud-release.py`:**
  - It accepts `deploy <sha> sha256:<digest>`.
  - It pulls `chief-agent-gateway@<digest>` and refuses the image unless its revision label and `RELEASE_SHA` equal `<sha>`. It then tags only the candidate; `:latest` moves after the existing guards.
  - It removes the digest-named image record once tagged. On the containerd image store that record is expected to stay separate, and `docker image prune` is not expected to free it (reading of moby's source, not yet checked on the host). Check after the first pull: `docker images --digests` should show no leftover `chief-agent-gateway@sha256:` record.
  - `deploy <sha>` still builds on the host, as the fallback.
  - The Compose and database refusal, the active-work and pending-input guards, rollback, health check, source copy and prune are unchanged.
- **`deploy/lightsail/install-release-handler.sh`:** the reviewed operator step.
  - It checks the handler's SHA-256 and installs it atomically.
  - It installs `docker-buildx` only if that leaves `docker.io`, `containerd` and `runc` unchanged.
- **Tests:**
  - Seven new offline handler tests: a digest release pulls, does not build and drops the digest record after tagging; the work guards still hold; an image from another commit is refused by its revision label or by `RELEASE_SHA`; a failed pull reports its reason; a failed or malformed `inspect` is refused; malformed commands are refused.
  - CI now runs all 16 `scripts/test-*.py` files (235 tests). Until now none of them ran in CI.

## Verification and outcome

**Measured:**

- **First main publish** (`e2ffacb`, checks run 40808840306): `publish gateway image` succeeded in 94 s, running alongside the tests.
- **The package is public:** an anonymous GHCR token fetched its manifest (HTTP 200), so the host can pull it without credentials.
- **First release with the advisory step** (`b6e1071`, release run 40809473729): it found the digest and verified the attestation in 6 s. The host still built the image, and the whole release step (upload, guards, build, gateway recreate and health check) took 390 s.
- **Two earlier attempts** for `260c94c` and `e2ffacb` were refused by the existing guard because main had moved on. That is expected.
- **Transpiled build (#352):** CI's image job built the gateway image with `build:image` and passed its smoke checks.

**Operator install** (29 October, through CloudShell):

- `install-release-handler.sh` exited 0 with the handler at SHA-256 `76fb4833…98a9f`.
- docker-buildx 0.30.1 was the only package installed.
- needrestart deferred every restart, docker.service included, and reported no containers needing a restart.

### Release closure — 29 October 2026

- **What merged:** #353 (`aca8cec`) switched `release` to deploy by digest.
- **Blocked first:** the first attempt was refused because #360 had changed `compose.yaml`. It went through after that change's operator rollout (`6e90db7`).
- **First pull release:** `b431444` (release run 40897824539):
  - The attestation check took 6 s.
  - `deploy b431444 sha256:de3dc421…` succeeded.
  - The whole release step took **51 s**, against 370, 377 and 400 s for the last three host builds.
- **Host, read-only over SSH:**
  - The gateway runs the pulled image, with revision label and `RELEASE_SHA` both `b431444`.
  - `:latest` and `:b431444…` are digest `de3dc421…`, and `:rollback` is kept.
  - **No `chief-agent-gateway@sha256` records are left**, so the expected containerd prune behaviour is confirmed and the handler's `docker rmi` of the digest record works.
  - agentwatch and the other services are untouched, and disk is at 46%.
- **Not measured:** how long the publish job takes when only the source layer changes. The first publish took 94 s cold; a later one took 34 s.

## Follow-up and next iteration

- Consider whether the host should verify the attestation itself, in addition to the release workflow.
