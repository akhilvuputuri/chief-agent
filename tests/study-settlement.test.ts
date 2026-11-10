import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { settleUncertainStudyWrites } from "../src/study-links.js";
import { dedupeKey, linkUrl } from "../src/link-classifier.js";

async function fixture() {
  const pg = await migratedPGlite([
    "001_initial",
    "002_preparation",
    "003_skills",
    "004_daily",
    "005_work",
    "006_runtime",
    "030_mcp",
    "031_link_resolution",
    "036_study_links",
  ]);
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  /** A stopped (or running) run holding one uncertain call that started `age` ago. */
  const call = async ({
    user = "123",
    operation = "link_save",
    args = {} as Record<string, unknown>,
    raw = undefined as string | undefined,
    runState = "stopped",
    age = "10 minutes",
  } = {}) => {
    const run = randomUUID();
    const id = randomUUID();
    await db.query(
      "INSERT INTO runtime_runs(id,user_id,state,stop_reason) VALUES($1,$2,$3,'failed')",
      [run, user, runState],
    );
    await db.query(
      `INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result,started_at,finished_at)
       VALUES($1,$2,'c',$3,$4::jsonb,true,'uncertain','{"error":{"code":"TOOL_FAILED"}}',now()-$5::interval,now()-$5::interval)`,
      [
        id,
        run,
        operation,
        JSON.stringify({ raw: raw ?? JSON.stringify(args) }),
        age,
      ],
    );
    return { run, id };
  };
  /** A study entry whose last update is `age` old. */
  const entry = async ({
    user = "123",
    url = "https://example.org/agents",
    age = "0 minutes",
    /** How long ago the entry was added; a real insert happens during the call. */
    added = "2 hours",
    id = randomUUID(),
  } = {}) => {
    const link = linkUrl(url);
    await db.query(
      `INSERT INTO study_resources(id,user_id,url,canonical_url,title,source,topic,classification_route,classification_reason,classification_confidence,added_at,updated_at)
       VALUES($1,$2,$3,$4,'Building agent architectures','example.org','agent platforms','study','Study material',0.9,now()-$6::interval,now()-$5::interval)`,
      [id, user, link, dedupeKey(link), age, added],
    );
    return id;
  };
  /** A Reader save_link row that was created `age` ago. */
  const readerSave = async ({
    user = "123",
    url = "https://example.org/agents",
    age = "0 minutes",
  } = {}) =>
    db.query(
      `INSERT INTO mcp_operations(user_id,connection,request_key,tool,binding,schema_hash,payload,source_payload,created_at)
       VALUES($1,'reader',$2,'save_link','reader:v1','hash',$3::jsonb,$3::jsonb,now()-$4::interval)`,
      [user, randomUUID(), JSON.stringify({ url }), age],
    );
  const state = async (id: string) =>
    (await db.query("SELECT state,result FROM runtime_calls WHERE id=$1", [id]))
      .rows[0];
  const reconciled = async (run: string) =>
    (
      await db.query(
        "SELECT data FROM events WHERE run_id=$1 AND type='runtime.call_reconciled'",
        [run],
      )
    ).rows.map((r) => r.data);
  return { pg, db, call, entry, readerSave, state, reconciled };
}

test("a link_save that left a study entry, a card or a Reader save settles as done", async () => {
  const f = await fixture();
  try {
    const withEntry = await f.call({
      args: { url: "https://example.org/agents" },
    });
    const withReader = await f.call({
      args: { url: "https://example.org/read" },
    });
    await f.readerSave({ url: "https://example.org/read" });
    const card = await f.call({ args: { url: "https://example.org/card" } });
    await f.db.query(
      `INSERT INTO link_decisions(id,user_id,shared_url,canonical_url,route,reason,confidence)
       VALUES($1,'123','https://example.org/card','example.org/card','unsure','test',0.3)`,
      [randomUUID()],
    );
    await f.entry({ url: "https://example.org/agents" });
    assert.equal(await settleUncertainStudyWrites(f.db, "123"), 3);
    for (const c of [withEntry, withReader, card])
      assert.equal((await f.state(c.id)).state, "success");
    assert.equal((await f.reconciled(withEntry.run)).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("a link_save with no record of any kind settles as failed, keeping its error", async () => {
  const f = await fixture();
  try {
    const { run, id } = await f.call({
      args: { url: "https://example.org/never-saved" },
    });
    assert.equal(await settleUncertainStudyWrites(f.db, "123"), 1);
    const row = await f.state(id);
    assert.equal(row.state, "failed");
    assert.equal(row.result.error.code, "TOOL_FAILED");
    assert.match(
      row.result.reconciliation.basis,
      /no study, decision or Reader/,
    );
    assert.equal((await f.reconciled(run)).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("running runs, recent calls, other owners, unreadable arguments and other operations are left alone", async () => {
  const f = await fixture();
  try {
    const args = { url: "https://example.org/agents" };
    const running = await f.call({ args, runState: "running" });
    const recent = await f.call({ args, age: "30 seconds" });
    const other = await f.call({ args, user: "456" });
    const broken = await f.call({ raw: "{not json" });
    const invalid = await f.call({ args: { url: "http://example.org/x" } });
    const unrelated = await f.call({ operation: "memory_set", args });
    assert.equal(await settleUncertainStudyWrites(f.db, "123"), 0);
    for (const c of [running, recent, other, broken, invalid, unrelated])
      assert.equal((await f.state(c.id)).state, "uncertain");
  } finally {
    await f.pg.close();
  }
});

test("a link_move settles from the direction it actually writes", async () => {
  const f = await fixture();
  try {
    // Reader → study: the entry exists, so that write happened.
    const toStudy = await f.call({
      operation: "link_move",
      args: { url: "https://example.org/agents", to: "study" },
    });
    await f.entry({ url: "https://example.org/agents" });
    const toStudyMissing = await f.call({
      operation: "link_move",
      args: { url: "https://example.org/missing", to: "study" },
    });
    // Study → Reader: a Reader save started after the call is the only write it makes.
    const toReader = await f.call({
      operation: "link_move",
      args: { id: randomUUID(), to: "reader" },
      age: "30 minutes",
    });
    await f.readerSave({
      url: "https://example.org/agents",
      age: "10 minutes",
    });
    const toReaderMissing = await f.call({
      operation: "link_move",
      args: { id: randomUUID(), to: "reader" },
    });
    assert.equal(await settleUncertainStudyWrites(f.db, "123"), 4);
    assert.equal((await f.state(toStudy.id)).state, "success");
    assert.equal((await f.state(toStudyMissing.id)).state, "failed");
    assert.equal((await f.state(toReader.id)).state, "success");
    assert.equal((await f.state(toReaderMissing.id)).state, "failed");
  } finally {
    await f.pg.close();
  }
});

test("a save whose page redirected settles from the write it made, not as failed", async () => {
  const f = await fixture();
  try {
    // The public fetcher follows the redirect and stores nothing about it, so the final
    // URL cannot be compared with the shared one.
    const { id } = await f.call({ args: { url: "https://t.co/abc" } });
    await f.entry({ url: "https://example.org/agents", added: "0 minutes" });
    assert.equal(await settleUncertainStudyWrites(f.db, "123"), 1);
    const row = await f.state(id);
    assert.equal(row.state, "success");
    assert.match(row.result.reconciliation.basis, /record for this link/);
  } finally {
    await f.pg.close();
  }
});

test("a save with no write of any kind in its window still settles as failed", async () => {
  const f = await fixture();
  try {
    // The entry was added long before this call started, so it is not evidence of a write.
    await f.entry({ url: "https://example.org/agents", added: "2 hours" });
    const { id } = await f.call({ args: { url: "https://t.co/never-saved" } });
    assert.equal(await settleUncertainStudyWrites(f.db, "123"), 1);
    assert.equal((await f.state(id)).state, "failed");
  } finally {
    await f.pg.close();
  }
});

test("study_update and study_remove settle from the row they own", async () => {
  const f = await fixture();
  try {
    const updated = await f.entry({ age: "0 minutes" });
    const untouched = await f.entry({
      url: "https://example.org/older",
      age: "60 minutes",
    });
    const gone = randomUUID();
    const editDone = await f.call({
      operation: "study_update",
      args: { id: updated, status: "in_progress" },
    });
    const editFailed = await f.call({
      operation: "study_update",
      args: { id: untouched, status: "in_progress" },
    });
    const removeDone = await f.call({
      operation: "study_remove",
      args: { id: gone },
    });
    const removeFailed = await f.call({
      operation: "study_remove",
      args: { id: untouched },
    });
    assert.equal(await settleUncertainStudyWrites(f.db, "123"), 4);
    assert.equal((await f.state(editDone.id)).state, "success");
    assert.equal((await f.state(editFailed.id)).state, "failed");
    // The tool refuses an unknown id, so a row that is gone means this call removed it.
    assert.equal((await f.state(removeDone.id)).state, "success");
    assert.equal((await f.state(removeFailed.id)).state, "failed");
  } finally {
    await f.pg.close();
  }
});

test("a Reader save row is a trace, and stays Reader's own pending operation", async () => {
  const f = await fixture();
  try {
    const { id } = await f.call({
      args: { url: "https://example.org/in-flight" },
      age: "30 minutes",
    });
    await f.readerSave({ url: "https://example.org/in-flight" });
    assert.equal(await settleUncertainStudyWrites(f.db, "123"), 1);
    assert.equal((await f.state(id)).state, "success");
    const operations = (
      await f.db.query(
        "SELECT state FROM mcp_operations WHERE user_id='123' AND tool='save_link'",
      )
    ).rows.map((r) => r.state);
    assert.deepEqual(operations, ["pending"]);
  } finally {
    await f.pg.close();
  }
});
