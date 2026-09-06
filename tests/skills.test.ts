import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { JobTools } from "../src/tools.js";
import { ensureUser, type Database } from "../src/db.js";
test("skills preserve drafts, enforce ownership/evaluation/approval, and restore immutable history", async () => {
  const pg = new PGlite();
  try {
    for (const file of [
      "001_initial.sql",
      "002_preparation.sql",
      "003_skills.sql",
      "003_skills.sql",
    ])
      await pg.exec(
        await readFile(new URL(`../db/${file}`, import.meta.url), "utf8"),
      );
    const db = pg as unknown as Database;
    await ensureUser(db, "a");
    await ensureUser(db, "b");
    const tools = new JobTools(db, { call: async () => ({}) });
    const call = (
      operation: string,
      args: Record<string, unknown> = {},
      user = "a",
    ) =>
      tools.execute(user, randomUUID(), { operation, ...args }) as Promise<any>;
    const first = await call("skill_draft", {
      key: "prep",
      content: "Ask about missing evidence before claiming a gap.",
      reason: "Avoid unsupported conclusions",
    });
    assert.deepEqual(await call("skill_list"), []);
    await assert.rejects(
      () => call("skill_activate", { id: first.id }),
      /Evaluate/,
    );
    await assert.rejects(
      () => call("skill_read", { key: "prep", id: first.id }, "b"),
      /not found/,
    );
    await assert.rejects(
      () =>
        call(
          "skill_evaluate",
          {
            id: first.id,
            report: "A sufficiently detailed evaluation report for testing.",
          },
          "b",
        ),
      /not found/,
    );
    const report =
      "Fixture: listing asks for RAG, profile is silent. Observed: asks for evidence and marks unknown, not a gap. No live task executed.";
    await call("skill_evaluate", { id: first.id, report });
    const approval = await call("skill_activate", { id: first.id });
    await assert.rejects(() => tools.decide("b", approval.id, true));
    await tools.decide("a", approval.id, true);
    await assert.rejects(() => tools.decide("a", approval.id, true));
    assert.equal(
      (await call("skill_read", { key: "prep" })).version.id,
      first.id,
    );
    const second = await call("skill_draft", {
      key: "prep",
      content: "Ask for evidence; group preparation by topic.",
      reason: "Avoid duplicate tasks",
    });
    await call("skill_evaluate", { id: second.id, report });
    const stale = await call("skill_activate", { id: second.id });
    const accepted = await call("skill_activate", { id: second.id });
    await tools.decide("a", accepted.id, true);
    await assert.rejects(() => tools.decide("a", stale.id, true));
    const rollback = await call("skill_activate", { id: first.id });
    await tools.decide("a", rollback.id, true);
    assert.equal(
      (await call("skill_read", { key: "prep" })).version.content,
      "Ask about missing evidence before claiming a gap.",
    );
    assert.equal((await call("skill_history", { key: "prep" })).length, 2);
    const denied = await call("skill_activate", { id: second.id });
    await tools.decide("a", denied.id, false);
    await assert.rejects(() => tools.decide("a", denied.id, true));
    const expired = await call("skill_activate", { id: second.id });
    await db.query(
      "UPDATE approvals SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.id],
    );
    await assert.rejects(() => tools.decide("a", expired.id, true));
    await assert.rejects(() =>
      call("skill_draft", { key: "../system", content: "x", reason: "x" }),
    );
    await assert.rejects(() =>
      call("skill_draft", {
        key: "safe",
        content: "x",
        reason: "x",
        shell: "echo unsafe",
      }),
    );
  } finally {
    await pg.close();
  }
});
