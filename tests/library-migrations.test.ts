import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";

const operations = [
  "library_borrow",
  "library_hold",
  "library_hold_cancel",
  "library_link",
  "library_revoke",
];
async function applyAll(pg: PGlite) {
  const dir = new URL("../db/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort())
    await pg.exec(await readFile(new URL(name, dir), "utf8"));
}

test("the full sorted migration directory applies, keeps library rows across a re-run, and 003/009/016 agree on the approvals constraint", async () => {
  const pg = new PGlite();
  const db = pg as unknown as Database;
  try {
    await applyAll(pg);
    await ensureUser(db, "123");
    for (const [i, op] of operations.entries())
      await db.query(
        "INSERT INTO approvals(id,user_id,run_id,operation,payload) VALUES($1,'123',$2,$3,$4::jsonb)",
        [
          randomUUID(),
          randomUUID(),
          op,
          JSON.stringify({
            draft:
              op === "library_link" || op === "library_revoke"
                ? {}
                : { titleId: String(100 + i) },
            execution: "not_started",
          }),
        ],
      );
    await applyAll(pg);
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM approvals")).rows[0].n,
      5,
    );
    const definition = (
      await db.query(
        "SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='approvals_operation_check'",
      )
    ).rows[0].d as string;
    for (const op of operations) assert.ok(definition.includes(op), op);
    const files = await Promise.all(
      ["003_skills", "009_calendar_approval", "016_library"].map((f) =>
        readFile(new URL(`../db/${f}.sql`, import.meta.url), "utf8"),
      ),
    );
    const lists = files.map(
      (f) => /CHECK\(operation IN \(([^)]*)\)\)/.exec(f)?.[1],
    );
    assert.ok(
      lists[0] && lists[0] === lists[1] && lists[1] === lists[2],
      "003, 009 and 016 must list the same operations",
    );
    // Partial unique indexes: one pending card per title, one executing action per owner, revoke exempt.
    await assert.rejects(
      db.query(
        "INSERT INTO approvals(id,user_id,run_id,operation,payload) VALUES($1,'123',$2,'library_hold',$3::jsonb)",
        [
          randomUUID(),
          randomUUID(),
          JSON.stringify({
            draft: { titleId: "100" },
            execution: "not_started",
          }),
        ],
      ),
      (e: any) => e.code === "23505",
    );
    await db.query(
      "UPDATE approvals SET status='approved',payload=jsonb_set(payload,'{execution}','\"executing\"') WHERE operation='library_hold'",
    );
    await assert.rejects(
      db.query(
        "UPDATE approvals SET status='approved',payload=jsonb_set(payload,'{execution}','\"uncertain\"') WHERE operation='library_borrow'",
      ),
      (e: any) => e.code === "23505",
    );
    await db.query(
      "UPDATE approvals SET status='approved',payload=jsonb_set(payload,'{execution}','\"executing\"') WHERE operation='library_revoke'",
    );
    assert.equal(
      (await db.query("SELECT 1 FROM runtime_migrations WHERE version=16")).rows
        .length,
      1,
    );
    await db.query(
      "INSERT INTO library_notices(user_id,kind,key) VALUES('123','capacity','5665700') ON CONFLICT DO NOTHING",
    );
    await db.query(
      "INSERT INTO library_notices(user_id,kind,key) VALUES('123','capacity','5665700') ON CONFLICT DO NOTHING",
    );
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM library_notices")).rows[0].n,
      1,
    );
  } finally {
    await pg.close();
  }
});
