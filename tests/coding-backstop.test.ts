import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, settings } from "./helpers/coding-fixture.js";
import { BOX_SAVE_MS } from "../src/coding/schema.js";

const HOUR = 3_600_000;
const pi = {
  ...settings,
  limits: undefined,
  runtime: "pi",
  squad: false,
  autoMerge: false,
};
const empty = {
  plan: "",
  patch: "",
  summary: "",
  files: [],
  piState: { version: 1, base: "a".repeat(40), delivered: [] },
};

/** A started Pi job in its first box, after the worker's first heartbeat. */
async function running(t: TestContext) {
  const f = await fixture(t);
  const job = await f.start(`backstop-${randomUUID()}`);
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    job.id,
    JSON.stringify(pi),
  ]);
  await f.c.tick();
  await f.c.heartbeat(await f.row(job.id));
  return { f, id: job.id as string, row: () => f.row(job.id) };
}
/** A box record for the job: what the boxes controller writes and counts as machine time. */
async function box(
  f: Awaited<ReturnType<typeof fixture>>,
  jobId: string,
  runningMs: number,
) {
  await f.db.query(
    `INSERT INTO boxes(id,user_id,request_key,profile,provider,environment,subject,image,credential_hash,absolute_deadline,running_ms)
     VALUES($1,'a',$2,'coding','ec2','test',$3,'image','hash',now()+interval '1 day',$4)`,
    [randomUUID(), `coding:${randomUUID()}`, `coding:${jobId}`, runningMs],
  );
}
const paused = (summary = "The coding box reached its time limit") => ({
  kind: "paused",
  summary,
  checkpoint: empty,
});
const events = async (
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  like: string,
) =>
  (
    await f.db.query(
      "SELECT event_key,payload,delivery FROM coding_events WHERE job_id=$1 AND event_key LIKE $2 ORDER BY created_at,id",
      [id, like],
    )
  ).rows;

test("an attempt lasts the box's lifetime, and the worker is told to stop a save margin before the host's deadline", async (t) => {
  const { f, row } = await running(t);
  const job = await row();
  assert.equal(
    new Date(job.attempt_deadline).getTime() -
      new Date(job.heartbeat_at).getTime(),
    3 * HOUR,
  );
  const assignment = await f.c.assignment(job);
  assert.equal(assignment.stopInMs, 3 * HOUR - BOX_SAVE_MS);
  // The settings the worker receives carry no limits.
  assert.equal((assignment.settings as any).limits, undefined);
});

test("a box reaching its lifetime continues in a new box with the same work, once, without telling the owner of a pause", async (t) => {
  const { f, id, row } = await running(t);
  const first = await row();
  f.advance(3 * HOUR - BOX_SAVE_MS + 1000);
  assert.deepEqual(await f.c.finish(first, paused()), { accepted: true });
  // A repeated finish is answered from the record.
  assert.deepEqual(await f.c.finish(await row(), paused()), {
    accepted: true,
  });
  const stopped = await row();
  assert.equal(stopped.state, "paused");
  const [finished] = await events(f, id, `${first.attempt_id}:finished`);
  assert.equal(finished.payload.cause, "lifetime");
  assert.equal(finished.delivery, "suppressed");
  // The box is cleaned up first; then one new box starts.
  for (let i = 0; i < 4; i++) await f.c.tick();
  const next = await row();
  assert.equal(next.state, "provisioning");
  assert.equal(next.revision, first.revision + 1);
  assert.notEqual(next.attempt_id, first.attempt_id);
  assert.deepEqual(next.checkpoint, stopped.checkpoint);
  assert.equal(f.creates(), 2);
  const [notice] = await events(f, id, "continue-box:%");
  assert.equal(notice.event_key, `continue-box:${first.attempt_id}`);
  assert.match(notice.payload.summary, /continues in a new box/);
  // Repeated passes start nothing more.
  await f.c.continueAfterLifetime();
  await f.c.tick();
  assert.equal(f.creates(), 2);
  assert.equal((await row()).revision, next.revision);
});

test("a pause before the save margin is an ordinary pause: no continuation", async (t) => {
  const { f, id, row } = await running(t);
  const first = await row();
  f.advance(HOUR);
  await f.c.finish(first, paused("The model call failed after Pi's retries"));
  const [finished] = await events(f, id, `${first.attempt_id}:finished`);
  assert.equal(finished.payload.cause, undefined);
  assert.equal(finished.delivery, "pending");
  for (let i = 0; i < 4; i++) await f.c.tick();
  assert.equal((await row()).state, "paused");
  assert.equal(f.creates(), 1);
});

test("the host's deadline is a lifetime too; a box that stops before it is a crash with its one retry", async (t) => {
  const late = await running(t);
  const attempt = (await late.row()).attempt_id;
  late.f.advance(3 * HOUR + 1000);
  await late.f.c.tick();
  const [pause] = await events(late.f, late.id, `${attempt}:paused`);
  assert.equal(pause.payload.cause, "lifetime");
  assert.equal(pause.delivery, "suppressed");
  for (let i = 0; i < 4; i++) await late.f.c.tick();
  assert.equal((await late.row()).state, "provisioning");
  assert.equal(late.f.creates(), 2);
  // Never an automatic retry as well.
  assert.equal(
    (
      await late.f.db.query(
        "SELECT 1 FROM coding_revisions WHERE job_id=$1 AND request_key LIKE 'auto-retry:%'",
        [late.id],
      )
    ).rows.length,
    0,
  );

  const crash = await running(t);
  const crashed = (await crash.row()).attempt_id;
  await crash.f.provider.terminate(`fixture:${crashed}`);
  await crash.f.c.tick();
  const [stop] = await events(crash.f, crash.id, `${crashed}:paused`);
  assert.equal(stop.payload.cause, "sandbox_stopped");
  // The box is gone, so its cleanup completes.
  await crash.f.c.tick();
  await crash.f.db.query(
    "UPDATE coding_jobs SET updated_at=now()-interval '5 minutes' WHERE id=$1",
    [crash.id],
  );
  await crash.f.c.continueAfterLifetime();
  assert.equal((await crash.row()).state, "paused");
  await crash.f.c.autoRetryOnce();
  assert.equal((await crash.row()).state, "queued");
  assert.equal(
    (
      await crash.f.db.query(
        "SELECT 1 FROM coding_revisions WHERE job_id=$1 AND request_key LIKE 'continue-box:%'",
        [crash.id],
      )
    ).rows.length,
    0,
  );
});

test("an attempt gets only the machine time the job has left", async (t) => {
  const f = await fixture(t);
  const job = await f.start("machine-left");
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    job.id,
    JSON.stringify(pi),
  ]);
  await box(f, job.id, 7 * HOUR);
  await f.c.tick();
  await f.c.heartbeat(await f.row(job.id));
  const live = await f.row(job.id);
  assert.equal(
    new Date(live.attempt_deadline).getTime() -
      new Date(live.heartbeat_at).getTime(),
    HOUR,
  );
  assert.equal((await f.c.assignment(live)).stopInMs, HOUR - BOX_SAVE_MS);
});

test("at eight hours of machine time the job pauses with one short notice, and the owner's resume starts a new eight hours", async (t) => {
  const { f, id, row } = await running(t);
  await box(f, id, 8 * HOUR);
  const first = await row();
  f.advance(3 * HOUR - 1000);
  await f.c.finish(first, paused());
  for (let i = 0; i < 4; i++) await f.c.tick();
  const stopped = await row();
  assert.equal(stopped.state, "paused");
  assert.equal(
    stopped.summary,
    "This job has used its eight hours of machine time; resume it to continue.",
  );
  const notices = await events(f, id, "machine-time:%");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].delivery, "pending");
  assert.equal(notices[0].payload.summary, stopped.summary);
  assert.equal(f.creates(), 1);
  await f.c.tick();
  assert.equal((await events(f, id, "machine-time:%")).length, 1);
  // The owner resumes: the window restarts, so the earlier boxes no longer count.
  await f.c.call("a", f.run, {
    operation: "coding_resume",
    id,
    baseRevision: stopped.revision,
    requestKey: "resume-after-eight-hours",
  });
  await f.c.tick();
  await f.c.heartbeat(await row());
  const resumed = await row();
  assert.equal(
    new Date(resumed.attempt_deadline).getTime() -
      new Date(resumed.heartbeat_at).getTime(),
    3 * HOUR,
  );
  assert.equal(f.creates(), 2);
});

test("a continuation never starts a job without the owner's Start of its request", async (t) => {
  const { f, id, row } = await running(t);
  const first = await row();
  f.advance(3 * HOUR - 1000);
  await f.c.finish(first, paused());
  // The approval no longer matches (as if the request had changed).
  await f.db.query(
    "UPDATE coding_events SET payload=payload || '{\"approvedScope\":\"other\"}'::jsonb WHERE job_id=$1 AND payload ? 'approvedScope'",
    [id],
  );
  for (let i = 0; i < 4; i++) await f.c.tick();
  const stopped = await row();
  assert.equal(stopped.state, "paused");
  assert.match(stopped.summary, /resume it to continue/);
  assert.equal(f.creates(), 1);
});

test("a lifetime pause the owner changed settings on stays stopped, as the owner was told", async (t) => {
  const { f, id, row } = await running(t);
  const first = await row();
  f.advance(3 * HOUR - 1000);
  await f.c.finish(first, paused());
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,'settings:x','{}'::jsonb,'suppressed')",
    [id],
  );
  for (let i = 0; i < 4; i++) await f.c.tick();
  assert.equal((await row()).state, "paused");
  assert.equal(f.creates(), 1);
});

test("an old row of any shape passes through the continuation without throwing", async (t) => {
  const f = await fixture(t);
  const job = await f.start("old-row");
  await f.db.query(
    'UPDATE coding_jobs SET state=\'pr_ready\',stage=\'pr_ready\',settings=$2::jsonb,checkpoint=\'{"plan":"","patch":"","summary":""}\'::jsonb WHERE id=$1',
    [job.id, JSON.stringify({ ...pi, limits: { ms: 1, models: 1, tools: 1 } })],
  );
  await f.c.continueAfterLifetime();
  await f.c.tick();
  assert.equal((await f.row(job.id)).state, "pr_ready");
});
