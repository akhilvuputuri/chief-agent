import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerProgress } from "../src/coding/progress-text.js";
import { fixture } from "./helpers/coding-fixture.js";

test("the worker's internal progress labels are shown to the owner in plain words", () => {
  for (const [from, to] of [
    ["Pi coder: Running", "Coding started"],
    ["Pi coder: completed", "Coding completed"],
    ["Pi coder: waiting_input", "Coding needs your answer"],
    ["Pi coder: cancelled", "Coding cancelled"],
    ["Pi reviewer: Running", "Review started"],
    ["Pi reviewer: failed", "Review failed"],
    [
      "Pi coder: The model call failed after Pi's retries; the session is kept",
      "Coding: The model call failed after Pi's retries; the session is kept",
    ],
    // Labels from workers before journal 192 are shown as they are.
    ["Pi build: Running build", "Pi build: Running build"],
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
    summary: "Pi coder: Running",
  };
  assert.deepEqual(await f.c.progress(j, report), { accepted: true });
  assert.equal((await f.row(job.id)).summary, "Coding started");
  // The same report again is an idempotent retry, not a key conflict.
  assert.deepEqual(await f.c.progress(j, report), { accepted: true });
  const event = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
      [job.id, `${j.attempt_id}:pi:task:1`],
    )
  ).rows[0].payload;
  assert.equal(event.summary, "Coding started");
});

test("a retry of a progress report stored before the owner wording still matches", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  const report = {
    key: "pi:task:7",
    stage: "implementing",
    summary: "Pi coder: Running",
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
