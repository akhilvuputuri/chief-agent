// Disposable PostgreSQL regression for Postgres ending a session (journal 125): an idle
// pooled client and a client inside transaction() are terminated, and the process must
// stay up with the pool usable. No production URL, credentials, model or Telegram access.
import assert from "node:assert/strict";
import pg from "pg";
import { connect } from "../dist/db.js";
import { transaction } from "../dist/db-transaction.js";
import { setOpsSink } from "../dist/ops-log.js";
const input = process.env.DB_DROP_TEST_DATABASE_URL;
if (!input || new URL(input).hostname !== "127.0.0.1")
  throw Error(
    "Use only a disposable database in an isolated container namespace",
  );
// Without the listeners this fix adds, Node raises the "error" event as an uncaught
// exception and this process exits non-zero, failing the step.
const logs = [];
setOpsSink((line) => logs.push(JSON.parse(line)));
const pool = connect(input);
const admin = new pg.Client({ connectionString: input });
await admin.connect();
const terminate = (pid) =>
  admin.query("SELECT pg_terminate_backend($1)", [pid]);
/** Wait up to 5 s for an operational log line. */
async function logged(match) {
  for (let i = 0; i < 50 && !logs.some(match); i++)
    await new Promise((r) => setTimeout(r, 100));
  return logs.some(match);
}
try {
  // 1. An idle pooled client's session ends.
  const idle = (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await terminate(idle);
  assert.ok(
    await logged(
      (l) => l.event === "db.idle_client_error" && l.errorCode === "57P01",
    ),
    "idle client termination is logged",
  );
  assert.equal((await pool.query("SELECT 1 AS ok")).rows[0].ok, 1);
  // 2. A session ends inside transaction().
  await assert.rejects(
    transaction(pool, async (db) => {
      const pid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      setTimeout(() => void terminate(pid), 200);
      await db.query("SELECT pg_sleep(2)");
    }),
  );
  assert.ok(
    await logged((l) => l.event === "db.client_error"),
    "in-transaction termination is logged",
  );
  // The pool still serves queries at full width. (pg-pool also drops an ended client by
  // itself, so this does not prove release(err) discarded it; the unit tests check that.)
  const checks = await Promise.all(
    Array.from({ length: 8 }, () => pool.query("SELECT 1 AS ok")),
  );
  assert.ok(checks.every((r) => r.rows[0].ok === 1));
  console.log(
    "Idle and in-transaction session terminations were logged; the process and pool survived",
  );
} finally {
  await admin.end();
  await pool.end();
}
