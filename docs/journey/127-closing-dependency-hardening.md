# 127 — What was left of the dependency hardening, and can #329 close?

Work date: 2026-10-27. Written: 2026-10-27.
Status: released in `da2a5ff` ([#329](https://github.com/akhilvuputuri/chief-agent/issues/329), now closed). No production stop has gone through `closeServer()` yet; the next release's stop will be the first.

## User-visible problem and preceding iteration

No incident is recorded. [Journal 125](125-db-drops-and-shutdown.md) and [journal 126](126-fetch-hygiene-and-node.md) fixed and released #329's main defects: the gateway exiting when Postgres ends a session, unbounded shutdown, the Node 22 corrupt-gzip hang and fetch hygiene. They left these items open:

- The Postgres fix was verified on a local Postgres only; CI tested it with a fake client.
- An Upgrade request answered over plain HTTP still left its socket open. Journal 125's 8 s deadline bounded the shutdown hang but reported the stop as incomplete.
- The bounded body readers were still duplicated, and several failure paths still left bodies unread.
- The corrupt-gzip fix depended on the Node pin, with no test guarding it.
- The `@fastify/websocket` 11.3.4 bump and the pool timeouts.

## Evidence

- **Upgrade sockets (tested, Fastify 5.12.5, `@fastify/websocket` 11.3.2 and 11.3.4).** With the plugin registered in a child context, as `src/miniapp.ts` does, an Upgrade request to `/healthz` (200), a missing route (404) or `/%zz` (400) was answered, but the server never closed the socket. `app.close()` then never resolved. Registering the plugin at the root was tried and rejected:
  - every `GET` route then accepted the WebSocket handshake (`/healthz` answered `101`);
  - `/%zz` still leaked, because Fastify answers a malformed URL before any hook runs, so the plugin's `onResponse` cleanup never sees it.

  An `onResponse` hook in Chief has the same gap for `/%zz`. Fastify's `frameworkErrors` option is the public hook for that path.

- **Postgres session drops in CI (tested).** The new `scripts/db-drop-postgres-smoke.mjs` runs on local Postgres 16 and passes. With the pool listener removed from the built `dist/db.js`, it exits 1 with the unhandled `57P01` error. With the checked-out client listener removed from `dist/db-transaction.js`, it exits 1 with `Connection terminated unexpectedly`.
- **Corrupt gzip guard (tested).** The new test serves `content-encoding: gzip` with 16 zero bytes, sent after the headers on a connection the server keeps open. Node 22.22.0 times out at 10 s; Node 22.23.4 rejects. When the server ends the response instead, Node 22.22.0 also rejects, so the delayed body is what reproduces the hang.
- **`@fastify/websocket` 11.3.4 (tested by diff).** Its `index.js` is byte-identical to 11.3.2; the release changes types only.

## Diagnosis and alternatives

- **Upgrade sockets.** Node hands every Upgrade request to the "upgrade" listener once one exists, and marks it `upgrade`. `src/server.ts` now watches those requests from a root `onRequest` hook and from `frameworkErrors`:
  - each socket is destroyed once its plain HTTP response finishes;
  - a WebSocket handshake never finishes that response, so real WebSockets are untouched.

  The sockets are also tracked until they close. `closeServer()` gives open WebSockets 1 s to finish the closing handshake that the plugin starts, then destroys what is left: the `ws` close timeout is 30 s, longer than the stop deadline. The plugin stays in the miniapp context. The upstream fix, destroying the socket when the plugin's own response finishes, is still worth proposing; this change does not depend on it.

- **Malformed URLs** now get Chief's error shape, `{"error":"Bad request"}`, instead of Fastify's default body, which echoed the URL.
- **Bounded readers.** A new `src/http-body.ts` holds `readBody()` and `discardBody()`. `readBody()` checks the declared length, stops at the limit on the decoded stream, and cancels the body on every early exit. These now use it:
  - `boundedBytes()` in `src/providers.ts`;
  - the IBKR MCP client;
  - the library client;
  - the Gmail client;
  - the gathering browser client;
  - the mail-recall embedding client, which previously read the whole body with `text()` before checking its size.

  Gmail, the gathering browser client and mail-recall now also cancel bodies they refuse on a failed status (tested for the gathering browser client; by reading the code for the other two). These were not changed:
  - `oauthErrorCode()` in `calendar.ts` reads a bounded prefix by design and already cancels;
  - `mcp-client.ts` limits a stream it passes to the MCP SDK;
  - the streaming readers in `openrouter-stream.ts` and `news-feed.ts`.

- **Pool timeouts: declined, unchanged since journal 125.** A connect timeout adds a failure mode under load, and `pg-pool` has an open connection-leak bug on that path (brianc/node-postgres#3543). `idleTimeoutMillis` already defaults to 10 s. `client.getTransactionStatus()` was not added either: a client whose `ROLLBACK` failed is already discarded.

## Implementation and review

- `src/server.ts`: `watchUpgrade()`, the `frameworkErrors` handler and `closeServer()`. `src/main.ts` closes HTTP through `closeServer()`.
- `src/http-body.ts`, plus the call sites above.
- `package.json`: `@fastify/websocket` 11.3.4.
- `.github/workflows/ci.yml`: the PostgreSQL 17 step also runs `scripts/db-drop-postgres-smoke.mjs` in the built app image.
- Tests:
  - `tests/server-upgrade.test.ts` (3). Upgrade sockets close on `/healthz`, a 404 and `/%zz`. A WebSocket client that ignores the closing handshake cannot hold `closeServer()` open. Ordinary keep-alive requests are unaffected, and the malformed-URL body is Chief's. The file fails within 3 s, rather than hanging, on the old `server.ts` and with either the `onRequest` hook or the `frameworkErrors` cleanup removed.
  - `tests/fetch-hygiene.test.ts` (+3): the corrupt-gzip guard, the shared reader, and the gathering browser client cancelling failed bodies.
- Independent review (Opus 5.5) of `f28a83e`: **REQUEST CHANGES**. No High findings; the reviewer judged the product code correct. Its findings, addressed in the commit after the release record:
  - **Medium:** on a regression, the first upgrade test's cleanup waited forever on the leaked socket, because node:test's timeout does not cover after-hooks. A CI shard would have hung, and this journal said the file "times out". The tests now destroy their client sockets before closing.
  - **Low:** the Pi re-pin records were stale. The release-record commit `229ab4b` had already fixed them.
  - **Low:** the smoke script's comment claimed the full-width query check proves the broken client was discarded. `pg-pool` drops an ended client by itself, so it does not. The comment now says so, and the fixed pauses became polling.

  It verified by running:
  - `request.raw.upgrade` is set only when the request goes to an "upgrade" listener;
  - a real `ws` client on a browser-control-style route still works, and `closeServer()` closes it in 3 ms;
  - the response is flushed before the destroy;
  - the 11.3.4 package diff;
  - the smoke script fails without either listener;
  - the new tests pass on both Node versions (15 of 15 repeated runs on 22.23.4).

  Info, not changed:
  - Fastify's 503-while-closing answer bypasses hooks, so an Upgrade request in that window could still hold `close()` until the 8 s deadline (by reading code; not reproduced).
  - `frameworkErrors` also receives the 414 and async-constraint errors, which now answer `{"error":"Bad request"}` with their own status.
  - The new `content-length` precheck can refuse a body that doesn't compress and whose decoded size is just under the limit.

## Verification and outcome

Tested locally and in CI. Released in `da2a5ff`; see the release closure below.

### Release closure — 2026-10-27

- **PR:** [PR 335](https://github.com/akhilvuputuri/chief-agent/pull/335) merged as `da2a5ff752e5501f313c51c8904b2df21540631d` (version unchanged, 0.3.104) at 16:25 UTC. It came from the head `8498cae`, which the independent reviewer approved. On that head, all 11 CI checks passed, and Devin found no issues.
- **CI (measured):** the `sandbox and app images` job ran the new smoke script against PostgreSQL 17 in the built app image. It logged "Idle and in-transaction session terminations were logged; the process and pool survived".
- **Release:** `checks` passed on `main` (16:25–16:29 UTC). The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/40541427136) deployed it at 16:35 UTC. No migration.
- **CloudWatch (measured):**
  - `gateway.started` for `da2a5ff` at 16:35:07, `nodeVersion: v22.23.4`;
  - the previous release, `c4ba246`, logged `gateway.stopped` 14 ms after `gateway.stopping`;
  - no warn or error lines from 16:15 to 16:35.
- **Not yet observed:**
  - A stop through `closeServer()`. The stop above ran `c4ba246`'s code, so the next release's stop will be the first.
  - An Upgrade request to a non-WebSocket route in production.
  - A real Postgres restart.
- **Issue:** #329 closed as completed on the merge. A [summary comment](https://github.com/akhilvuputuri/chief-agent/issues/329#issuecomment-6447669325) lists the PRs, what was declined and the optional upstream follow-ups.

## Follow-up and next iteration

- Upstream, at the owner's discretion: the node-postgres docs fix (brianc/node-postgres#3202, #2843), the `@fastify/websocket` socket fix, and a comment on nodejs/undici#5999 confirming the fix.
- A real Postgres restart in production has still not been observed.
