# 126 — Can a corrupt response hang a fetch, and what do fetch failures leave behind?

Work date: 2026-10-27. Written: 2026-10-27.
Status: proposed in branch `hardening-fetch` ([#329](https://github.com/akhilvuputuri/chief-agent/issues/329) items 3–5). Not released.

## User-visible problem and preceding iteration

No incident is recorded. Follows [journal 125](125-db-drops-and-shutdown.md), which handled #329 items 1–2. The same dependency research found that reading a response with a corrupt gzip body could hang forever on Node 22. It also found that fetch failures and failed responses lost or held information.

## Evidence

- **Corrupt gzip hang (tested, 27 October).** A local server answers `content-encoding: gzip` with 16 zero bytes. The client reads with `arrayBuffer()`, `text()` or a `getReader()` loop under `AbortSignal.timeout(1000)`:

  | Node (bundled undici)                 | Result                                                                                |
  | ------------------------------------- | ------------------------------------------------------------------------------------- |
  | 22.22.0 (6.23.0)                      | Hangs past the 4 s test window in all three read modes; the abort signal doesn't help |
  | 22.23.4 (6.29.1), released 20 October | Rejects with `TypeError` / `Z_DATA_ERROR` in about 140 ms in all three                |

  CI, the release workflow, `.nvmrc` and both Pi images pinned 22.19.0, which is older than both. The gateway, browser and Python-squad images use the floating `node:22-bookworm-slim` tag, so they pick up the current Node 22 when rebuilt.

- **Fetch failures were logged without their cause (tested).** `errorFields()` read only `error.code`. `fetch()` reports network failures as `TypeError("fetch failed")` with the real code (`UND_ERR_SOCKET`, `ECONNRESET`, …) on `error.cause`, so logs showed only `TypeError`.
- **Unread bodies (by reading the code).** `boundedBytes()` and the Singapore client threw on non-OK statuses and declared-oversize responses without cancelling the body, so the connection was held until garbage collection.
- **Singapore decoded size (tested, but not as a failure).** The Singapore client checked `content-length`, which is the _compressed_ size. It then read the whole decoded body with `arrayBuffer()` before comparing it with the limit. A small gzip response that expands past the limit was rejected, but only after the full decoded body was in memory. The new test passes on the old code too: it guards the behaviour and shows no failure.

## Diagnosis and alternatives

- Move the pinned Node 22 versions to 22.23.4 rather than adding an outer deadline around every body read. The fix belongs in undici, and an outer race would leave the hung read running.
- Log the cause's code when the error has none of its own, plus the cause's name (`causeCategory`). The error's own code still wins.
- Cancel unread bodies on every early throw. The Singapore client now reads through `boundedBytes()`, which stops and cancels at the limit on the decoded stream. It keeps its provider-specific messages.
- Not done:
  - **Consolidating the other bounded readers** (`library-client`, `calendar` reuse, `gmail`, `ibkr/mcp`, `gathering/browser-client`, `mcp-client`). This would widen the PR without a failure behind it.
  - **The `@fastify/websocket` 11.3.4 bump.** It contains only type fixes.

## Implementation and review

- `.nvmrc`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `Dockerfile.coding-pi`, `coding_runtime_pi/Dockerfile` and `coding_runtime_pi/README.md`: Node 22.23.4.
- `src/ops-log.ts`: `errorFields()` falls back to `error.cause.code` and adds `causeCategory` (allow-listed).
- `src/providers.ts`: `discardBody()`; `boundedBytes()` cancels the body before throwing on a non-OK status or a declared oversize.
- `src/singapore/http.ts`: the body is cancelled on 429, 5xx, 401 and other non-OK responses. The body is read through `boundedBytes()`, and `"Response too large"` is mapped back to `"<provider> response is too large"`. An empty body still returns an empty buffer.
- `src/gateway-stop.ts`: the `intakeStopped` comment no longer overstates the risk (journal 125 review note).
- `tests/fetch-hygiene.test.ts`: the cause code, cancelled bodies, and the Singapore decoded limit and error status.
- Records: journal 35's proxy note is corrected; journal 125's test count and final review are recorded; operational logs gain `causeCategory`.
- Independent review: pending.

## Verification and outcome

The tests above pass, and the hang was reproduced and shown fixed on Node 22.23.4. Not released.

- **Pi image:** `config/coding-pi.json` pins it by digest, so the new Pi `Dockerfile` takes effect only after the image is republished (`pi-coding-image` workflow, run by hand) and the digest is updated in a reviewed change. Until then, Pi jobs keep their current Node.
- **Gateway image:** whether the running gateway image already has Node ≥ 22.23.4 depends on when it was last built; not checked.

## Follow-up and next iteration

- Republish the Pi image and update its digest.
- Upstream: a comment on nodejs/undici#5999 confirming the fix, the node-postgres docs fix, and the `@fastify/websocket` socket fix.
