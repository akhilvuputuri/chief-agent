# 125 — What happens when Postgres drops a connection, or the gateway is told to stop?

Work date: 2026-10-27. Written: 2026-10-27.
Status: released in `211b2a2` ([#329](https://github.com/akhilvuputuri/chief-agent/issues/329) items 1 and 2). The new shutdown ran cleanly on its first production stop. A real Postgres restart in production has not been observed.

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
  - It logs `gateway.stopped`, or `gateway.stop_incomplete` with `intakeStopped`, `handlersLeft`, `httpClosed` and `databaseClosed` (added to the ops-log field allow-list and to [operational logs](../operational-logs.md)).
  - After a complete stop, an unref'd 1 s timer exits the process, so another open handle cannot hold it until SIGKILL.
  - `runner` is declared before the handler is registered, and a `stopping` flag stops it from starting if the signal arrives during `bot.init()`. So a signal during startup closes HTTP and the database without throwing, and polling never begins against a closed pool, which would confirm updates to Telegram that could not be recorded (inferred from the code order; not run).
- Tests: `tests/db-hardening.test.ts` (12). They cover commit and release, a session ending mid-transaction, `ROLLBACK` failure, a healthy rollback, responsibility reservations, the pool listener, shutdown ordering, a hung HTTP close at the deadline, a handler that outlasts the deadline, synchronous throws, a fetch loop that does not stop in time, and a failing close step.
- Independent review (Opus 5.5) of `767dae9`: **APPROVE**. The reviewer:
  - confirmed 5 of the original tests fail on the base code;
  - reproduced both crashes and the recovery on Postgres 16;
  - added cases: a session killed inside a transaction, SQL and deferred-constraint errors keeping healthy clients, two concurrent reservations still serialized by `FOR UPDATE`, and no listener leak.

  Its low findings, all addressed in the next commit: a slow handler could consume the whole deadline; a signal during startup reached `runner` before it existed; a complete stop had no exit deadline; the event catalog lacked the new events. Re-review of `403ca33`: **REQUEST CHANGES**. The startup fix let polling start after a stop had begun, if `bot.init()` resolved within the 1 s exit timer; fixed in the next commit with a `stopping` flag. Re-review of `f8e8548`: **APPROVE**, with an informational note that `gateway.started` can be logged after a stop that began during startup (not changed). Devin Review on `f8e8548` then found that a fetch loop that did not stop within the deadline was not counted, so the stop could be reported complete. The next commit requires `intakeStopped` for a complete stop and logs it. Re-review of `f105ad8`: **APPROVE**. The reviewer rated Devin's finding Low: `runner.stop()` calls `source.close()`, which aborts the pending `getUpdates`, so updates can't realistically be confirmed afterwards, and a full sink was already reported through `handlersLeft`. The code comment that overstated this was corrected in journal 126's PR. PR #331 merged as `211b2a2` after all 11 CI checks passed.

## Verification and outcome

Unit tests and the local Postgres reproduction pass. Released in `211b2a2`. A deploy's container stop has been observed: the first production stop logged `gateway.stopped` in 160 ms (see the release closure below). A real Postgres restart in production has not been observed.

### Release closure — 2026-10-27

- **PR:** [PR 331](https://github.com/akhilvuputuri/chief-agent/pull/331) merged as `211b2a2add939647e1e4a46e34932d839eca2430` (version unchanged, 0.3.103) from the independently approved head `f105ad8`.
- **Release:** `checks` passed on `main` (11:13–11:18 UTC). The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/40495096407) deployed it at 11:22 UTC; no migration. CloudWatch:
  - `gateway.stopping` from the old release `cd45085` at 11:22:50, then `gateway.started` for `211b2a2` at 11:22:54;
  - no warn or error lines from 11:07 to 11:27.
- **First production stop (measured, CloudWatch):** the next release ([PR 332](https://github.com/akhilvuputuri/chief-agent/pull/332)) stopped `211b2a2`. It logged `gateway.stopping` at 11:54:03.605 and `gateway.stopped` at 11:54:03.765 UTC, so the stop was complete in 160 ms, with no `gateway.stop_incomplete`. The new release logged `gateway.started` at 11:54:07.
- **Not yet observed:** a Postgres restart or terminated session in production (`db.idle_client_error` / `db.client_error`), and a stop with handlers still running.

## Follow-up and next iteration

- #329 items 3–5: the Node 22 fetch hang on broken gzip, fetch hygiene, and small items.
- Upstream contributions: the node-postgres docs fix (#3202) and the `@fastify/websocket` socket fix.
