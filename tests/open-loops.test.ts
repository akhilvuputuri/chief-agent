import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { openLoops } from "../src/open-loops.js";
async function fixture() {
  const pg = new PGlite();
  // Every migration in order, so the approvals operation check matches production.
  const dir = new URL("../db/", import.meta.url);
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort())
    await pg.exec(await readFile(new URL(f, dir), "utf8"));
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  const job = async ({
    user = "123",
    state = "plan_ready",
    stage = "plan_ready",
    summary = "summary",
    question = "",
    age = "1 hour",
  } = {}) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO coding_jobs(id,user_id,request_key,request_hash,origin_run,objective,context,mode,base_sha,settings,state,stage,summary,question,updated_at)
       VALUES($1,$2,$3,'h',$4,'Fix the reminders','context','plan',$5,'{}',$6,$7,$8,$9,now()-$10::interval)`,
      [
        id,
        user,
        randomUUID(),
        randomUUID(),
        "a".repeat(40),
        state,
        stage,
        summary,
        question,
        age,
      ],
    );
    return id;
  };
  const card = async (jobId: string, confirmUntil: string, decided = false) =>
    db.query(
      "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,$2,$3::jsonb,'sent')",
      [
        jobId,
        `requirements:1:${randomUUID()}`,
        JSON.stringify({
          confirmUntil,
          telegramMessageId: 7,
          ...(decided ? { decision: "approved" } : {}),
        }),
      ],
    );
  const approval = async (
    operation: string,
    expires: string,
    status = "pending",
    user = "123",
  ) =>
    db.query(
      "INSERT INTO approvals(id,user_id,run_id,operation,payload,status,expires_at) VALUES($1,$2,$6,$3,'{}',$4,now()+$5::interval)",
      [randomUUID(), user, operation, status, expires, randomUUID()],
    );
  return { db, job, card, approval };
}
const hour = (n: number) => new Date(Date.now() + n * 3600000).toISOString();
test("nothing waiting on the owner adds nothing to the context", async () => {
  const f = await fixture();
  await f.job({ state: "cancelled", stage: "cancelled" });
  await f.job({ state: "pr_ready", stage: "awaiting_ci" });
  assert.equal(await openLoops(f.db, "123", { coding: true }), undefined);
});
test("coding jobs waiting on the owner say what they need, newest first", async () => {
  const f = await fixture();
  const expired = await f.job({ age: "5 hours" });
  await f.card(expired, hour(-1));
  const open = await f.job({ age: "4 hours" });
  await f.card(open, hour(20));
  await f.job({
    state: "awaiting_input",
    stage: "question",
    question: "Which repo?",
    age: "3 hours",
  });
  await f.job({
    state: "paused",
    stage: "paused",
    summary: "sandbox restarted",
    age: "2 hours",
  });
  await f.job({
    state: "pr_ready",
    stage: "manual_review",
    summary: "main moved",
    age: "1 hour",
  });
  const loops = await openLoops(f.db, "123", { coding: true });
  assert.ok(loops);
  assert.deepEqual(
    loops.coding!.map((j) => j.awaiting),
    [
      "PR stopped for owner attention (main moved)",
      "paused (sandbox restarted); offer to resume or start fresh",
      "owner to answer: Which repo?",
      "owner to confirm the requirements card",
      "requirements ready; the card expired or was never sent, so offer a fresh one (coding_resume)",
    ],
  );
  assert.match(loops.note, /Before coding_start/);
});
test("a decided card does not count as open, and old, other-owner or long-failed jobs are left out", async () => {
  const f = await fixture();
  const decided = await f.job();
  await f.card(decided, hour(20), true);
  await f.job({ age: "20 days" });
  await f.job({ user: "456" });
  await f.job({ state: "failed", stage: "failed", age: "5 days" });
  const recentFailure = await f.job({
    state: "failed",
    stage: "failed",
    summary: "provider error",
  });
  const loops = await openLoops(f.db, "123", { coding: true });
  assert.deepEqual(
    loops!.coding!.map((j) => [j.id === recentFailure, j.awaiting]).sort(),
    [
      [
        false,
        "requirements ready; the card expired or was never sent, so offer a fresh one (coding_resume)",
      ],
      [true, "failed (provider error); offer to retry or start fresh"],
    ].sort(),
  );
});
test("monitoring and calendar cards that expired unanswered in the last three days are listed", async () => {
  const f = await fixture();
  await f.approval("responsibility_confirm", "-2 hours");
  await f.approval("calendar_create", "-1 day");
  await f.approval("responsibility_confirm", "-5 days"); // too old
  await f.approval("responsibility_confirm", "2 hours"); // still open
  await f.approval("responsibility_confirm", "-1 hour", "approved"); // decided
  await f.approval("skill_activate", "-1 hour"); // other kind
  await f.approval("responsibility_confirm", "-1 hour", "pending", "456");
  const loops = await openLoops(f.db, "123", { coding: false });
  assert.deepEqual(
    loops!.expiredCards!.map((c) => c.operation),
    ["responsibility_confirm", "calendar_create"],
  );
  assert.equal(loops!.coding, undefined);
});
