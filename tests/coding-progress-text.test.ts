import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerProgress } from "../src/coding/progress-text.js";
import { fixture } from "./helpers/coding-fixture.js";

test("the worker's internal progress labels are shown to the owner in plain words", () => {
  for (const [from, to] of [
    ["Pi plan: Running plan", "Planning started"],
    ["Pi plan: waiting_approval", "Plan ready for your approval"],
    ["Pi plan: paused", "Planning paused"],
    ["Pi build: Running build", "Implementation started"],
    ["Pi build: completed", "Implementation completed"],
    ["Pi review: Running review", "Review started"],
    ["Pi review: failed", "Review failed"],
    ["Pi plan: waiting_input", "Planning needs your answer"],
    ["Pi build: cancelled", "Implementation cancelled"],
    ["Pi build: ready", "Implementation ready"],
    ["Pi check: npm ci: 0", "Check passed: npm ci"],
    ["Pi check: npm run check: 1", "Check failed: npm run check (exit 1)"],
    ["Pi check: npm run build", "Check: npm run build"],
    [
      "Pi plan: Requesting one structured final report",
      "Planning: Requesting one structured final report",
    ],
    ["Owner asked to continue", "Owner asked to continue"],
  ])
    assert.equal(ownerProgress(from), to);
});

test("progress is stored in owner wording, and a retried report still matches", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  const report = {
    key: "pi:task:1",
    stage: "implementing",
    summary: "Pi check: npm run check: 0",
  };
  assert.deepEqual(await f.c.progress(j, report), { accepted: true });
  assert.equal((await f.row(job.id)).summary, "Check passed: npm run check");
  // The same report again is an idempotent retry, not a key conflict.
  assert.deepEqual(await f.c.progress(j, report), { accepted: true });
  const event = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
      [job.id, `${j.attempt_id}:pi:task:1`],
    )
  ).rows[0].payload;
  assert.equal(event.summary, "Check passed: npm run check");
});

test("a retry of a progress report stored before the owner wording still matches", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  const report = {
    key: "pi:task:7",
    stage: "implementing",
    summary: "Pi build: Running build",
  };
  // Stored by the previous host version, in the worker's own words.
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload) VALUES($1,$2,$3::jsonb)",
    [job.id, `${j.attempt_id}:pi:task:7`, JSON.stringify(report)],
  );
  assert.deepEqual(await f.c.progress(j, report), { accepted: true });
  await assert.rejects(
    f.c.progress(j, { ...report, summary: "Pi build: completed" }),
    /Progress key conflict/,
  );
});
