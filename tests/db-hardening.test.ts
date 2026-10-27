import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { connect } from "../src/db.js";
import { transaction } from "../src/db-transaction.js";
import { withResponsibilityOwner } from "../src/responsibility-transaction.js";
import { stopGateway } from "../src/gateway-stop.js";
import { setOpsSink } from "../src/ops-log.js";

/** A pg-like checked-out client: emits "error" when its session ends. */
class FakeClient extends EventEmitter {
  queries: string[] = [];
  released: { error?: Error }[] = [];
  constructor(private failing: Set<string> = new Set()) {
    super();
  }
  async query(text: string) {
    this.queries.push(text);
    if (this.failing.has(text)) throw new Error(`${text} failed`);
    return { rows: [] };
  }
  release(error?: Error) {
    this.released.push({ error });
  }
}
const pool = (client: FakeClient) => ({
  query: client.query.bind(client),
  connect: async () => client,
});

function captureLogs(t: { after(fn: () => void): void }) {
  const logs: Record<string, unknown>[] = [];
  const previous = setOpsSink((line) => logs.push(JSON.parse(line)));
  t.after(() => setOpsSink(previous));
  return logs;
}

test("a committed transaction releases the client normally and removes its error listener", async () => {
  const client = new FakeClient();
  const result = await transaction(pool(client), async (db) => {
    assert.equal(client.listenerCount("error"), 1);
    await db.query("SELECT 1");
    return "done";
  });
  assert.equal(result, "done");
  assert.deepEqual(client.queries, ["BEGIN", "SELECT 1", "COMMIT"]);
  assert.deepEqual(client.released, [{ error: undefined }]);
  assert.equal(client.listenerCount("error"), 0);
});

test("a session that ends mid-transaction is logged, not fatal, and the client is discarded", async (t) => {
  const logs = captureLogs(t);
  const client = new FakeClient(new Set(["ROLLBACK"]));
  const ended = Object.assign(new Error("terminating connection"), {
    code: "57P01",
  });
  await assert.rejects(
    transaction(pool(client), async () => {
      // Without a listener this emit would throw (and stop the gateway).
      client.emit("error", ended);
      throw new Error("Connection terminated unexpectedly");
    }),
    /Connection terminated unexpectedly/,
  );
  assert.equal(client.released.length, 1);
  assert.equal(client.released[0]!.error, ended);
  assert.equal(client.listenerCount("error"), 0);
  assert.ok(
    logs.some((l) => l.event === "db.client_error" && l.errorCode === "57P01"),
  );
});

test("a failed ROLLBACK discards the client and keeps the original error", async () => {
  const client = new FakeClient(new Set(["ROLLBACK"]));
  await assert.rejects(
    transaction(pool(client), async () => {
      throw new Error("domain failure");
    }),
    /domain failure/,
  );
  assert.equal(client.released[0]!.error?.message, "ROLLBACK failed");
});

test("a rolled-back transaction returns a healthy client to the pool", async () => {
  const client = new FakeClient();
  await assert.rejects(
    transaction(pool(client), async () => {
      throw new Error("domain failure");
    }),
  );
  assert.deepEqual(client.queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(client.released, [{ error: undefined }]);
});

test("responsibility reservations on a pool use the same guarded transaction", async () => {
  const client = new FakeClient(new Set(["ROLLBACK"]));
  await assert.rejects(
    withResponsibilityOwner(pool(client), "u1", async () => {
      client.emit("error", new Error("session ended"));
      throw new Error("reservation failed");
    }),
    /reservation failed/,
  );
  assert.equal(client.queries[0], "BEGIN");
  assert.match(client.queries[1]!, /FOR UPDATE/);
  assert.equal(client.released[0]!.error?.message, "session ended");
  assert.equal(client.listenerCount("error"), 0);
});

test("an idle pooled client's error is logged instead of crashing the gateway", async (t) => {
  const logs = captureLogs(t);
  // No connection is opened until a query runs.
  const db = connect("postgres://chief@127.0.0.1:1/none");
  t.after(() => db.end());
  assert.ok(db.listenerCount("error") >= 1);
  db.emit(
    "error",
    Object.assign(new Error("terminating connection"), { code: "57P01" }),
  );
  assert.ok(
    logs.some(
      (l) =>
        l.event === "db.idle_client_error" &&
        l.level === "warn" &&
        l.errorCode === "57P01",
    ),
  );
});

test("shutdown waits for running handlers before closing HTTP and then the database", async () => {
  const order: string[] = [];
  let running = 2;
  const drain = setInterval(() => {
    if (running === 0) return;
    running -= 1;
    order.push(`handlers:${running}`);
  }, 20);
  const result = await stopGateway(
    {
      stopIntake: async () => void order.push("intake"),
      handlersRunning: () => running,
      closeHttp: async () => void order.push("http"),
      closeDatabase: async () => void order.push("db"),
    },
    2000,
    5,
  );
  clearInterval(drain);
  assert.deepEqual(result, {
    complete: true,
    intakeStopped: true,
    handlersLeft: 0,
    httpClosed: true,
    databaseClosed: true,
  });
  assert.deepEqual(order, ["intake", "handlers:1", "handlers:0", "http", "db"]);
});

test("shutdown gives up on a hung HTTP close at the deadline and still closes the database", async () => {
  let databaseClosed = false;
  const started = Date.now();
  const result = await stopGateway(
    {
      stopIntake: async () => {},
      handlersRunning: () => 1,
      // An upgrade socket that is never destroyed keeps app.close() pending forever.
      closeHttp: () => new Promise<void>(() => {}),
      closeDatabase: async () => {
        databaseClosed = true;
      },
    },
    150,
    10,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
  assert.equal(result.complete, false);
  assert.equal(result.handlersLeft, 1);
  assert.equal(result.httpClosed, false);
  // closeDatabase ran even though no time was left; it simply was not awaited past the deadline.
  assert.equal(databaseClosed, true);
});

test("a failing close step is reported as not closed", async () => {
  const result = await stopGateway(
    {
      stopIntake: async () => {},
      handlersRunning: () => 0,
      closeHttp: async () => {},
      closeDatabase: async () => {
        throw new Error("end failed");
      },
    },
    500,
  );
  assert.equal(result.complete, false);
  assert.equal(result.databaseClosed, false);
});

test("a handler that outlasts the deadline still leaves time to close HTTP and the database", async () => {
  const result = await stopGateway(
    {
      stopIntake: async () => {},
      handlersRunning: () => 1,
      closeHttp: () => new Promise<void>((r) => setTimeout(r, 20)),
      closeDatabase: () => new Promise<void>((r) => setTimeout(r, 20)),
    },
    400,
    10,
  );
  assert.deepEqual(result, {
    complete: false,
    intakeStopped: true,
    handlersLeft: 1,
    httpClosed: true,
    databaseClosed: true,
  });
});

test("a step that throws synchronously is reported, and later steps still run", async () => {
  let databaseClosed = false;
  const result = await stopGateway(
    {
      stopIntake: () => {
        throw new ReferenceError("runner is not ready");
      },
      handlersRunning: () => 0,
      closeHttp: () => {
        throw new Error("close failed");
      },
      closeDatabase: async () => {
        databaseClosed = true;
      },
    },
    500,
  );
  assert.equal(result.httpClosed, false);
  assert.equal(result.complete, false);
  assert.equal(databaseClosed, true);
});

test("a fetch loop that does not stop in time makes the stop incomplete even when everything else closed", async () => {
  const result = await stopGateway(
    {
      // The loop could still confirm updates to Telegram after the database closes.
      stopIntake: () => new Promise<void>(() => {}),
      handlersRunning: () => 0,
      closeHttp: async () => {},
      closeDatabase: async () => {},
    },
    200,
    10,
  );
  assert.deepEqual(result, {
    complete: false,
    intakeStopped: false,
    handlersLeft: 0,
    httpClosed: true,
    databaseClosed: true,
  });
});
