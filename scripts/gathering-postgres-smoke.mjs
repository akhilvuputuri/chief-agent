// Disposable PostgreSQL 17 regression: no production URL, credentials, model or Telegram access.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Gathering } from "../dist/gathering/controller.js";
import { GatheringBrowsers } from "../dist/gathering/sessions.js";
import { FileVault } from "../dist/gathering/vault.js";
import { action } from "../dist/gathering/schema.js";
const input = process.env.GATHERING_TEST_DATABASE_URL;
if (
  !input ||
  new URL(input).hostname !== "127.0.0.1" ||
  new URL(input).pathname !== "/gathering_test"
)
  throw Error(
    "Use only the disposable gathering_test database in an isolated container namespace",
  );
const pool = new pg.Pool({
  connectionString: input,
  max: 5,
  statement_timeout: 5000,
});
try {
  assert.match(
    (await pool.query("SHOW server_version")).rows[0].server_version,
    /^17\./,
  );
  for (const name of (await readdir(new URL("../db/", import.meta.url)))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await pool.query(
      await readFile(new URL("../db/" + name, import.meta.url), "utf8"),
    );
  await pool.query("INSERT INTO users(id) VALUES('synthetic-gathering-owner')");
  const user = "synthetic-gathering-owner",
    run = randomUUID(),
    key = Buffer.alloc(32, 7);
  await pool.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,$2,'Synthetic concurrency regression')",
    [run, user],
  );
  const client = {
    call: async (_user, _id, c) =>
      c.kind === "done"
        ? {
            storageState: '{"cookies":[],"origins":[]}',
            origins: ["https://chatgpt.com"],
          }
        : c.kind === "downloads"
          ? { files: [] }
          : { closed: true },
  };
  const gather = new Gathering(
    pool,
    new FileVault(pool, key),
    undefined,
    new GatheringBrowsers(pool, key, client),
  );
  const c = await gather.call(
    user,
    run,
    action.parse({
      operation: "gather_start",
      requestKey: randomUUID(),
      objective: "Synthetic concurrency regression",
      targets: [{ key: "one", label: "ChatGPT", month: "2026-09" }],
      sources: ["browser"],
    }),
  );
  const sid = randomUUID();
  await pool.query(
    "INSERT INTO gather_browser_sessions(id,user_id,collection_id,target_key,origin,state,allowed_origins) VALUES($1,$2,$3,'one','https://chatgpt.com','owner','[\"https://chatgpt.com\"]')",
    [sid, user, c.id],
  );
  let doneLocked, forgetLocked, releaseDone;
  const reachedDone = new Promise((r) => (doneLocked = r)),
    reachedForget = new Promise((r) => (forgetLocked = r)),
    gate = new Promise((r) => (releaseDone = r));
  const wrap = (kind) => ({
    query: (sql, values) => pool.query(sql, values),
    connect: async () => {
      const connection = await pool.connect();
      return {
        release: () => connection.release(),
        query: async (sql, values) => {
          const result = await connection.query(sql, values);
          if (
            kind === "done" &&
            sql.startsWith("SELECT s.id FROM work_tasks")
          ) {
            doneLocked();
            await gate;
          }
          if (kind === "forget" && sql.startsWith("SELECT id FROM users"))
            forgetLocked();
          return result;
        },
      };
    },
  });
  const done = new GatheringBrowsers(wrap("done"), key, client).owner(
    user,
    sid,
    { kind: "done", remember: true },
  );
  await reachedDone;
  const forgotten = new GatheringBrowsers(wrap("forget"), key, client).forget(
    user,
    sid,
  );
  await reachedForget;
  releaseDone();
  assert.equal((await done).saved, true);
  assert.equal((await forgotten).forgotten, true);
  assert.equal(
    Number(
      (await pool.query("SELECT count(*) n FROM gather_browser_profiles"))
        .rows[0].n,
    ),
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT state,encrypted_state FROM gather_browser_sessions WHERE id=$1",
        [sid],
      )
    ).rows[0].state,
    "closed",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT encrypted_state FROM gather_browser_sessions WHERE id=$1",
        [sid],
      )
    ).rows[0].encrypted_state,
    null,
  );
  console.log(
    JSON.stringify({
      postgres17: true,
      realConcurrentTransactions: true,
      doneForgetInterleaving: true,
      credentialsRevoked: true,
      modelCalls: 0,
      telegramSends: 0,
      productionDatabaseAccess: false,
    }),
  );
} finally {
  await pool.end();
}
