import assert from "node:assert/strict";
import test from "node:test";
import { databaseStats, migratedPGlite } from "./helpers/pglite.js";

// The pool is shared by every test in this process, so each test measures differences.
const supplied = async <T>(work: () => Promise<T>) => {
  const before = databaseStats();
  const value = await work();
  const after = databaseStats();
  return {
    value,
    created: after.created - before.created,
    reused: after.reused - before.reused,
    discarded: after.discarded - before.discarded,
  };
};

// These tests describe reuse, so each turns it on whatever the caller's environment says,
// and puts the caller's setting back. A hook at the top of the file would not do: when
// test files share a process, such a hook runs around every file's tests.
const withReuse = (name: string, body: () => Promise<void>) =>
  test(name, async () => {
    const callerSetting = process.env.TEST_DB_REUSE;
    delete process.env.TEST_DB_REUSE;
    try {
      await body();
    } finally {
      if (callerSetting !== undefined)
        process.env.TEST_DB_REUSE = callerSetting;
    }
  });

withReuse(
  "a closed database comes back empty, with seeds, sequences and settings restored",
  async () => {
    const first = await migratedPGlite();
    const seeded = (
      await first.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM runtime_migrations",
      )
    ).rows[0]!.n;
    await first.query("INSERT INTO users(id) VALUES('owner')");
    await first.query("DELETE FROM runtime_migrations");
    await first.exec("SET statement_timeout = 1234");
    const sequence = (
      await first.query<{ name: string }>(
        "SELECT format('%I.%I', schemaname, sequencename) AS name FROM pg_sequences WHERE schemaname = 'public' LIMIT 1",
      )
    ).rows[0]!.name;
    const start = (
      await first.query<{ value: string }>(
        `SELECT nextval('${sequence}')::text AS value`,
      )
    ).rows[0]!.value;
    await first.query(`SELECT nextval('${sequence}')`);
    await first.query("SELECT pg_advisory_lock(42)");
    await first.exec("BEGIN; INSERT INTO users(id) VALUES('unfinished')");
    const closing = await supplied(() => first.close());
    assert.equal(closing.discarded, 0);

    // The old handle is dead, as a closed database's would be.
    assert.equal(first.closed, true);
    await assert.rejects(first.query("SELECT 1"), /PGlite is closed/);
    await first.close();

    const second = await supplied(() => migratedPGlite());
    assert.deepEqual([second.created, second.reused], [0, 1]);
    const db = second.value;
    const one = async (sql: string) =>
      Object.values((await db.query<Record<string, unknown>>(sql)).rows[0]!)[0];
    assert.equal(await one("SELECT count(*)::int FROM users"), 0);
    assert.equal(
      await one("SELECT count(*)::int FROM runtime_migrations"),
      seeded,
    );
    assert.equal(await one(`SELECT nextval('${sequence}')::text`), start);
    assert.equal(await one("SHOW statement_timeout"), "0");
    assert.equal(await one("SHOW search_path"), "public");
    assert.equal(await one("SHOW session_replication_role"), "origin");
    assert.equal(
      await one(
        "SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory'",
      ),
      0,
    );
    // Foreign keys are enforced again.
    await assert.rejects(
      db.query(
        "INSERT INTO work_tasks(id,user_id,objective,request) VALUES(gen_random_uuid(),'nobody','x','x')",
      ),
      /foreign key/,
    );
    await db.close();
  },
);

withReuse(
  "a changed schema is discarded, and a rolled-back change is not",
  async () => {
    const changed = await migratedPGlite();
    await changed.exec("ALTER TABLE users ADD COLUMN extra int");
    assert.equal((await supplied(() => changed.close())).discarded, 1);

    const temporary = await migratedPGlite();
    await temporary.exec("CREATE TEMP TABLE scratch(a int)");
    assert.equal((await supplied(() => temporary.close())).discarded, 1);

    const undone = await migratedPGlite();
    await undone.exec(
      "BEGIN; ALTER TABLE users ADD COLUMN extra int; ROLLBACK",
    );
    assert.equal((await supplied(() => undone.close())).discarded, 0);

    const fresh = await migratedPGlite();
    await assert.rejects(fresh.query("SELECT extra FROM users"), /extra/);
    await fresh.close();
  },
);

withReuse(
  "rows come back in insertion order after many reuses, as in a fresh database",
  async () => {
    // Deleting without vacuuming let later rows land in freed space: with rows of these
    // sizes the order first went wrong on about the sixteenth reuse.
    for (let cycle = 0; cycle < 60; cycle++) {
      const db = await migratedPGlite();
      const ids = Array.from(
        { length: 5 + (cycle % 40) },
        (_, i) => `${i}-${cycle}-${"x".repeat(cycle % 3 ? 20 : 200)}`,
      );
      await db.query("INSERT INTO users(id) SELECT unnest($1::text[])", [ids]);
      if (cycle % 2)
        await db.query("UPDATE users SET created_at = now() + interval '1 s'");
      assert.deepEqual(
        (await db.query<{ id: string }>("SELECT id FROM users")).rows.map(
          (row) => row.id,
        ),
        ids,
        `reuse ${cycle}`,
      );
      await db.close();
    }
  },
);

withReuse("the rows migrations inserted are restored exactly", async () => {
  const dump = async (db: Awaited<ReturnType<typeof migratedPGlite>>) =>
    Promise.all(
      ["runtime_migrations", "library_pacing"].map(
        async (table) =>
          (
            await db.query<{ row: string }>(
              `SELECT t::text AS row FROM ${table} t`,
            )
          ).rows,
      ),
    );
  const first = await migratedPGlite();
  const fresh = await dump(first);
  assert.ok(fresh.every((rows) => rows.length > 0));
  await first
    .query("UPDATE library_pacing SET updated_at = now()")
    .catch(() => {});
  await first.query("DELETE FROM runtime_migrations");
  await first.close();
  const second = await supplied(() => migratedPGlite());
  assert.equal(second.reused, 1);
  assert.deepEqual(await dump(second.value), fresh);
  await second.value.close();
});

withReuse(
  "a closed test's listeners hear nothing from the next test",
  async () => {
    const heard: string[] = [];
    const first = await migratedPGlite();
    await first.listen("pool_channel", (payload) =>
      heard.push(`first:${payload}`),
    );
    first.onNotification((channel, payload) =>
      heard.push(`first-any:${payload}`),
    );
    await first.close();
    const second = await supplied(() => migratedPGlite());
    assert.equal(second.reused, 1);
    await second.value.listen("pool_channel", (payload) =>
      heard.push(`second:${payload}`),
    );
    await second.value.query("NOTIFY pool_channel, 'x'");
    assert.deepEqual(heard, ["second:x"]);
    await second.value.close();
  },
);

withReuse("state a reset cannot undo is never reused", async () => {
  const cases: Record<string, string> = {
    "a schema change hidden by RESET ALL":
      "ALTER TABLE users ADD COLUMN extra int; RESET ALL",
    "a schema change made in replica mode":
      "SET session_replication_role = replica; CREATE TABLE made_in_replica(a int)",
    "a large object": "SELECT lo_from_bytea(0, 'x')",
    "a role": "CREATE ROLE pool_test_role",
  };
  for (const [name, sql] of Object.entries(cases)) {
    const db = await migratedPGlite();
    await db.exec(sql);
    assert.equal((await supplied(() => db.close())).discarded, 1, name);
  }
});

withReuse("a sequence moved without being called is put back", async () => {
  const first = await migratedPGlite();
  const sequence = (
    await first.query<{ name: string }>(
      "SELECT format('%I.%I', schemaname, sequencename) AS name FROM pg_sequences WHERE schemaname = 'public' LIMIT 1",
    )
  ).rows[0]!.name;
  const start = (
    await first.query<{ value: string }>(
      `SELECT nextval('${sequence}')::text AS value`,
    )
  ).rows[0]!.value;
  await first.query(`SELECT setval('${sequence}', 100, false)`);
  assert.equal((await supplied(() => first.close())).discarded, 0);
  const second = await migratedPGlite();
  assert.equal(
    (
      await second.query<{ value: string }>(
        `SELECT nextval('${sequence}')::text AS value`,
      )
    ).rows[0]!.value,
    start,
  );
  await second.close();
});

withReuse("different migration lists never share a database", async () => {
  const partial = await migratedPGlite(["001_initial"]);
  await partial.close();
  const full = await supplied(() => migratedPGlite());
  assert.equal(
    (
      await full.value.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM runtime_migrations",
      )
    ).rows[0]!.n > 0,
    true,
  );
  await full.value.close();
  const again = await supplied(() => migratedPGlite(["001_initial"]));
  assert.deepEqual([again.created, again.reused], [0, 1]);
  await again.value.close();
});

test("TEST_DB_REUSE=0 restores the snapshot every time", async () => {
  const previous = process.env.TEST_DB_REUSE;
  process.env.TEST_DB_REUSE = "0";
  try {
    const first = await supplied(() => migratedPGlite());
    await first.value.close();
    assert.equal(first.value.closed, true);
    const second = await supplied(() => migratedPGlite());
    assert.deepEqual([second.created, second.reused], [1, 0]);
    await second.value.close();
  } finally {
    if (previous === undefined) delete process.env.TEST_DB_REUSE;
    else process.env.TEST_DB_REUSE = previous;
  }
});
