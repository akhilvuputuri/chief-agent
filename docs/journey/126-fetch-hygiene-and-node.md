# 126 — Can a corrupt response hang a fetch, and what do fetch failures leave behind?

Work date: 2026-10-27. Written: 2026-10-27.
Status: released in `9ab96c2` ([#329](https://github.com/akhilvuputuri/chief-agent/issues/329) items 3–5). The gateway now runs Node v22.23.4. The Pi image still runs its old Node until it is republished.

## User-visible problem and preceding iteration

No incident is recorded. Follows [journal 125](125-db-drops-and-shutdown.md), which handled #329 items 1–2. The same dependency research found that reading a response with a corrupt gzip body could hang forever on Node 22. It also found that fetch failures and failed responses lost or held information.

## Evidence

- **Corrupt gzip hang (tested, 27 October).** A local server answers `content-encoding: gzip` with 16 zero bytes. The client reads with `arrayBuffer()`, `text()` or a `getReader()` loop under `AbortSignal.timeout(1000)`:

  | Node (bundled undici)                 | Result                                                                                |
  | ------------------------------------- | ------------------------------------------------------------------------------------- |
  | 22.22.0 (6.23.0)                      | Hangs past the 4 s test window in all three read modes; the abort signal doesn't help |
  | 22.23.4 (6.29.1), released 20 October | Rejects with `TypeError` / `Z_DATA_ERROR` in about 140 ms in all three                |

  CI, the release workflow, `.nvmrc` and both Pi images pinned 22.19.0, which is older than both. The gateway and gathering-browser images used the floating `node:22-bookworm-slim` tag. They are built on the Lightsail host (`scripts/cloud-release.py` runs `docker build` without `--pull`; Compose builds the browser images), so they reuse whichever `node:22-bookworm-slim` the host last pulled. The host was set up on 26 September, so the running gateway's Node is unknown and probably predates the fix (inferred from the code; not checked on the host). The Python-squad image is built on fresh GitHub runners by `coding-image.yml`, so its floating tag does resolve to the current Node 22.

- **Fetch failures were logged without their cause (tested).** `errorFields()` read only `error.code`. `fetch()` reports network failures as `TypeError("fetch failed")` with the real code (`UND_ERR_SOCKET`, `ECONNRESET`, …) on `error.cause`, so logs showed only `TypeError`.
- **Unread bodies (by reading the code).** `boundedBytes()` and the Singapore client threw on non-OK statuses and declared-oversize responses without cancelling the body, so the connection was held until garbage collection.
- **Singapore decoded size (tested).** The Singapore client checked `content-length`, which is the _compressed_ size. It then read the whole decoded body with `arrayBuffer()` before comparing it with the limit. A gzip response that expands past the limit was rejected only after the full decoded body was in memory, and an endless decoded stream was never rejected. The new test serves endless gzip-encoded zeros: on the old code it never returns (killed at the 30 s test timeout); on the new code it is rejected after about 4 MB. The error-status test (404, 429, 500) also fails on the old code, which never cancelled those bodies.

## Diagnosis and alternatives

- Pin Node 22.23.4 everywhere it is built, including the host-built gateway and browser images (`Dockerfile`, `Dockerfile.browser`): a new exact tag forces the host to pull it on the next build. This is preferred to adding an outer deadline around every body read. The fix belongs in undici, and an outer race would leave the hung read running.
- Log the cause's code when the error has none of its own, plus the cause's name (`causeCategory`). The error's own code still wins.
- Cancel unread bodies on every early throw. The Singapore client now reads through `boundedBytes()`, which stops and cancels at the limit on the decoded stream. It keeps its provider-specific messages.
- Not done:
  - **Consolidating the other bounded readers** (`library-client`, `calendar` reuse, `gmail`, `ibkr/mcp`, `gathering/browser-client`, `mcp-client`). This would widen the PR without a failure behind it.
  - **The `@fastify/websocket` 11.3.4 bump.** It contains only type fixes.

## Implementation and review

- `.nvmrc`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `Dockerfile`, `Dockerfile.browser`, `Dockerfile.coding-pi`, `coding_runtime_pi/Dockerfile` and `coding_runtime_pi/README.md`: Node 22.23.4. `Dockerfile.coding` stays on the floating tag, because it is built on fresh runners.
- `src/main.ts`: `gateway.started` logs `nodeVersion`, so CloudWatch shows which Node the running gateway uses.
- `src/ops-log.ts`: `errorFields()` falls back to `error.cause.code` and adds `causeCategory` (allow-listed).
- `src/providers.ts`: `discardBody()`; `boundedBytes()` cancels the body before throwing on a non-OK status or a declared oversize.
- `src/singapore/http.ts`: the body is cancelled on 429, 5xx, 401 and other non-OK responses. The body is read through `boundedBytes()`, and `"Response too large"` is mapped back to `"<provider> response is too large"`. An empty body still returns an empty buffer.
- `src/gateway-stop.ts`: the `intakeStopped` comment no longer overstates the risk (journal 125 review note).
- `tests/fetch-hygiene.test.ts`: the cause code, cancelled bodies, an endless decoded Singapore stream, and Singapore error bodies (404, 429, 500) being cancelled.
- Records: journal 35's proxy note is corrected; journal 125's test count and final review are recorded; operational logs gain `causeCategory` (in the safety contract) and `nodeVersion`.
- Independent review (Opus 5.5) of `d0e139c`: **REQUEST CHANGES**. Its findings, all addressed in the next commit:
  - the record claimed the floating-tag gateway image would pick up the fix on rebuild, but host builds reuse the cached base image;
  - the Singapore test did not test cancellation and passed on the old code;
  - the safety contract did not mention `causeCategory`.

  It confirmed by testing: the hang on 22.22.0 and the fix on 22.23.4; that the cause-code and body-cancel tests fail on the base code; and `errorFields` behaviour for real DNS, socket and mid-body failures. Re-review of `ae90de6`: **APPROVE**. It confirmed all four new tests fail on the base code (the endless stream at the 30 s test timeout) and pass on the head in about 118 ms. Its one Low finding was that the repository's log reader did not select `nodeVersion` or `causeCategory`. Fixed in the next commit, which adds them, and the journal 125 shutdown fields, to `scripts/cloudwatch-logs.mjs`. Re-review of `30537c4`: **APPROVE**, no findings. Devin found no issues.

## Verification and outcome

The tests above pass, and the hang was reproduced and shown fixed on Node 22.23.4. Released in `9ab96c2`; see the release closure below.

- **Pi image:** `config/coding-pi.json` pins it by digest, so the new Pi `Dockerfile` takes effect only after the image is republished (`pi-coding-image` workflow, run by hand) and the digest is updated in a reviewed change. Until then, Pi jobs keep their current Node.
- **Gateway and browser images:** the release of `9ab96c2` built the gateway on `node:22.23.4-bookworm-slim`, and `npm run logs:cloudwatch -- heartbeat` showed `nodeVersion: v22.23.4` (measured; release closure below). The gathering-browser images are rebuilt only through their operator procedure.

### Release closure — 2026-10-27

- **PR:** [PR 332](https://github.com/akhilvuputuri/chief-agent/pull/332) merged as `9ab96c2754370d170b60357b1faa0702df6a2b2b` (version unchanged, 0.3.103) from the independently approved head `30537c4`.
- **Release:** `checks` passed on `main` (11:44–11:48 UTC), and the [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/40498941212) deployed it at 11:54 UTC.
- **Node (measured, CloudWatch `heartbeat`):** `gateway.started` for `9ab96c2` at 11:54:07 logged `nodeVersion: v22.23.4`. So the host pulled the pinned base image, and the corrupt-gzip fix (undici 6.29.1) is live in the gateway. No warn or error lines from 11:37 to 12:07.
- **Not yet done:** the Pi image is still the digest pinned in `config/coding-pi.json`, so it keeps its old Node until it is republished and the digest is updated. The gathering-browser images change only through their operator procedure.

## Follow-up and next iteration

- Republish the Pi image and update its digest.
- Upstream: a comment on nodejs/undici#5999 confirming the fix, the node-postgres docs fix, and the `@fastify/websocket` socket fix.
