# 127 — What was left of the dependency hardening, and can #329 close?

Work date: 2026-10-27. Written: 2026-10-27.
Status: proposed in branch `hardening-finish` ([#329](https://github.com/akhilvuputuri/chief-agent/issues/329)). Not released.

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
  - `tests/server-upgrade.test.ts` (3). Upgrade sockets close on `/healthz`, a 404 and `/%zz`. A WebSocket client that ignores the closing handshake cannot hold `closeServer()` open. Ordinary keep-alive requests and the malformed-URL body are unchanged. On the old `server.ts`, the file times out.
  - `tests/fetch-hygiene.test.ts` (+3): the corrupt-gzip guard, the shared reader, and the gathering browser client cancelling failed bodies.
- Independent review: pending.

## Verification and outcome

Tested locally, as above. Not released.

## Follow-up and next iteration

- Upstream, at the owner's discretion: the node-postgres docs fix (brianc/node-postgres#3202, #2843), the `@fastify/websocket` socket fix, and a comment on nodejs/undici#5999 confirming the fix.
- A real Postgres restart in production has still not been observed.
