# 125 — What happens when Postgres drops a connection, or the gateway is told to stop?

Work date: 2026-10-27. Written: 2026-10-27.
Status: proposed in branch `hardening-db-shutdown` ([#329](https://github.com/akhilvuputuri/chief-agent/issues/329) items 1 and 2). Not released.

## User-visible problem and preceding iteration

No incident is recorded. Dependency research for #329 found two latent failure paths in how the gateway uses `pg` and how it shuts down:

1. **A Postgres connection ending killed the gateway.** The pool (`src/db.ts`) had no `error` listener, and neither did a client checked out by `transaction()` (`src/db-transaction.ts`) or `withResponsibilityOwner()` (`src/responsibility-transaction.ts`). `pg` emits `error` when a session ends: a Postgres restart, failover, `pg_terminate_backend` or an idle timeout. With no listener, Node treats that as an uncaught exception, and `src/process-guard.ts` exits. Compose then restarts the gateway, so a crash would look like a short outage, not a log line.
2. **Shutdown could close the database under running work, or never finish.**
   - `runner.stop()` resolves when the update loop ends, not when running handlers finish. Read in `@grammyjs/runner` 2.0.3's `createRunner`: `stop()` returns the loop task, and the loop only waits for sink capacity.
   - `db.end()` followed right after.
   - `app.close()` had no deadline. An upgrade request answered outside `@fastify/websocket`'s context leaves its socket open, which keeps `app.close()` pending; reproduced during the #329 research.
   - Docker's default 10 s grace then ends in SIGKILL.

## Evidence

- **Reproduced (tested, 2026-10-27, local PostgreSQL 16, built gateway modules).** `pg_terminate_backend` was run against the session behind each case:

  | Case                          | Before                                      | After                                                                                    |
  | ----------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
  | Idle pooled client            | `Unhandled 'error' event` (`57P01`), exit 1 | `db.idle_client_error` warn logged; next pool query succeeds; exit 0                     |
  | Client inside `transaction()` | `Unhandled 'error' event`, exit 1           | `db.client_error` warn logged; the transaction rejects; next pool query succeeds; exit 0 |

  "Before" used a pool and helper identical to `origin/main` (`cd45085`); "after" imported the built `dist/db.js` and `dist/db-transaction.js`.

- **Upstream (reported):** the `pg` transaction example has the same gap (brianc/node-postgres#3202, #2843).

## Diagnosis and alternatives

- Log rather than exit. `pg-pool` has already removed an idle client that errors. A checked-out client whose session failed, or whose `ROLLBACK` failed, is released with the error (`release(err)`), so the pool discards it instead of handing it out again.
- `withResponsibilityOwner()` now shares the same helper. Previously its `ROLLBACK` failure replaced the original error.
- `connectionTimeoutMillis` and `idleTimeoutMillis` were left unchanged. A connect timeout adds a new failure mode under load, and `pg-pool` has an open connection-leak bug on that path (brianc/node-postgres#3543). Revisit with evidence.
- Shutdown order:
  1. stop intake;
  2. wait for running Telegram handlers;
  3. close HTTP;
  4. close the database.

  This all happens inside an 8 s deadline, under Docker's 10 s. A step that misses the deadline is reported and the process exits with status 1, rather than waiting for SIGKILL. Registering `@fastify/websocket` at the root was not done here; the deadline bounds the hang, and the upstream fix is tracked in #329.

## Implementation and review

- `src/db.ts`: `connect()` adds a pool `error` listener that logs `db.idle_client_error`.
- `src/db-transaction.ts`: `withClientTransaction()` attaches a client `error` listener for the checkout (logging `db.client_error`), removes it before release, and releases with the error when the session failed or `ROLLBACK` failed. `transaction()` and `withResponsibilityOwner()` both use it.
- `src/gateway-stop.ts`: `stopGateway()`. Handlers may use the deadline only up to the last 1.5 s, which is kept for closing HTTP and the database. A step that throws, even synchronously, is reported as not closed, and later steps still run. `src/main.ts` calls it on SIGINT/SIGTERM:
  - It logs `gateway.stopped`, or `gateway.stop_incomplete` with `handlersLeft`, `httpClosed` and `databaseClosed` (added to the ops-log field allow-list and to [operational logs](../operational-logs.md)).
  - After a complete stop, an unref'd 1 s timer exits the process, so another open handle cannot hold it until SIGKILL.
  - `runner` is declared before the handler is registered, and a `stopping` flag stops it from starting if the signal arrives during `bot.init()`. So a signal during startup closes HTTP and the database without throwing, and polling never begins against a closed pool, which would confirm updates to Telegram that could not be recorded (inferred from the code order; not run).
- Tests: `tests/db-hardening.test.ts` (11). They cover commit and release, a session ending mid-transaction, `ROLLBACK` failure, a healthy rollback, responsibility reservations, the pool listener, shutdown ordering, a hung HTTP close at the deadline, a handler that outlasts the deadline, synchronous throws, and a failing close step.
- Independent review (Opus 5.5) of `767dae9`: **APPROVE**. The reviewer:
  - confirmed 5 of the original tests fail on the base code;
  - reproduced both crashes and the recovery on Postgres 16;
  - added cases: a session killed inside a transaction, SQL and deferred-constraint errors keeping healthy clients, two concurrent reservations still serialized by `FOR UPDATE`, and no listener leak.

  Its low findings, all addressed in the next commit: a slow handler could consume the whole deadline; a signal during startup reached `runner` before it existed; a complete stop had no exit deadline; the event catalog lacked the new events. Re-review of `403ca33`: **REQUEST CHANGES**. The startup fix let polling start after a stop had begun, if `bot.init()` resolved within the 1 s exit timer; fixed in the next commit with a `stopping` flag. Re-review pending.

## Verification and outcome

Unit tests and the local Postgres reproduction pass. Not released; behaviour in production on a real restart or deploy is not yet observed. After release, the next deploy's container stop should log `gateway.stopped`.

## Follow-up and next iteration

- #329 items 3–5: the Node 22 fetch hang on broken gzip, fetch hygiene, and small items.
- Upstream contributions: the node-postgres docs fix (#3202) and the `@fastify/websocket` socket fix.
