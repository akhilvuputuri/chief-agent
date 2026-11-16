import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { BoxController } from "../src/boxes/controller.js";
import { FakeBoxProvider } from "../src/boxes/provider.js";
import { codingSettings } from "../src/coding/schema.js";
import { BoxSandbox } from "../src/coding/box-sandbox.js";
import { fixture, settings } from "./helpers/coding-fixture.js";

test("a coding attempt in a box: the controller pauses a worker that exited as transient (sandbox_stopped) and cleans up only once the box is gone", async (t) => {
  const pi = codingSettings.parse({
    ...settings,
    limits: undefined,
    runtime: "pi",
  });
  const provider = new FakeBoxProvider({ canStop: true });
  let boxes!: BoxController;
  let now = new Date();
  const f = await fixture(t, {
    settings: pi,
    provider: (db) => {
      boxes = new BoxController(
        db,
        {
          environment: "test",
          profiles: {
            coding: {
              provider: "fake",
              image: pi.image!,
              idleTtlMinutes: 15,
              retentionHours: 0,
              hardMaxHours: 3,
              absoluteDays: 1,
              concurrency: 1,
            },
          },
        },
        { fake: provider },
        "b".repeat(64),
        "https://coding.example.com",
        () => now,
        { pollMs: 0, hostGraceMs: 0 },
      );
      return new BoxSandbox(db, boxes, "coding", [pi.image!]);
    },
  });
  const job = await f.start();
  await f.c.tick();
  let j = await f.row(job.id);
  assert.equal(j.state, "provisioning");
  assert.match(j.sandbox_id, /^box:/);
  const boxId = j.sandbox_id.slice(4);
  // The box boots; the worker has not spoken yet, which the startup grace allows.
  await boxes.tick();
  const secret = [...provider.boxes.values()].find((b) => b.boxId === boxId)!
    .request.bootstrap.secret;
  const { credential } = await boxes.hello(boxId, {
    protocol: 1,
    credential: secret,
  });
  f.advance(5 * 60_000);
  now = new Date(now.getTime() + 5 * 60_000);
  await f.c.tick();
  assert.equal((await f.row(job.id)).state, "provisioning");
  // The worker heartbeats, then exits without a result.
  await f.c.heartbeat(await f.row(job.id));
  const task = (
    await f.db.query("SELECT id FROM box_tasks WHERE box_id=$1", [boxId])
  ).rows[0];
  await boxes.events(boxId, credential, {
    epoch: 1,
    events: [
      { seq: 1, kind: "task.started", taskId: task.id },
      {
        seq: 2,
        kind: "task.result",
        taskId: task.id,
        payload: { exitCode: 1 },
      },
    ],
  });
  // The controller sees the ended task as a still-live box: the box is closed first.
  await f.c.tick();
  j = await f.row(job.id);
  assert.equal(j.state, "running");
  const box = async () =>
    (await f.db.query("SELECT state FROM boxes WHERE id=$1", [boxId])).rows[0]
      .state;
  assert.equal(await box(), "terminating");
  for (let i = 0; i < 4 && (await box()) !== "terminated"; i++)
    await boxes.tick();
  assert.equal(await box(), "terminated");
  await f.c.tick();
  j = await f.row(job.id);
  assert.equal(j.state, "paused");
  const paused = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
      [job.id, `${j.attempt_id}:paused`],
    )
  ).rows[0].payload;
  assert.equal(paused.cause, "sandbox_stopped");
  await f.c.tick();
  assert.equal((await f.row(job.id)).cleanup, "complete");
});

/** A controller whose coding boxes run only the image new jobs use. */
async function retiredFixture(t: TestContext) {
  const pi = codingSettings.parse({
    ...settings,
    limits: undefined,
    runtime: "pi",
  });
  const provider = new FakeBoxProvider({ canStop: true });
  const runs = pi.image!;
  return fixture(t, {
    settings: pi,
    provider: (db) =>
      new BoxSandbox(
        db,
        new BoxController(
          db,
          {
            environment: "test",
            profiles: {
              coding: {
                provider: "fake",
                image: runs,
                idleTtlMinutes: 15,
                retentionHours: 0,
                hardMaxHours: 3,
                absoluteDays: 1,
                concurrency: 1,
              },
            },
          },
          { fake: provider },
          "b".repeat(64),
          "https://coding.example.com",
        ),
        "coding",
        [runs],
      ),
  });
}

test("a Pi job on a retired worker image is moved to the current image by the host and its box launches (journal 202)", async (t) => {
  const f = await retiredFixture(t);
  const job = await f.start();
  const current = (await f.row(job.id)).settings.image as string;
  const retired = `ghcr.io/example/coding@sha256:${"9".repeat(64)}`;
  // Snapshotted before journal 193 and 190: the move drops what upgradeWorker drops.
  await f.db.query(
    "UPDATE coding_jobs SET settings=settings || jsonb_build_object('image',$2::text,'leaderModel','synthetic/leader','contextWindows',jsonb_build_object('synthetic/coder',200000)) WHERE id=$1",
    [job.id, retired],
  );
  const before = await f.row(job.id);
  await f.c.tick();
  const j = await f.row(job.id);
  assert.notEqual(j.state, "paused");
  assert.match(j.sandbox_id, /^box:/);
  assert.equal(j.revision, before.revision);
  assert.deepEqual(j.checkpoint, before.checkpoint);
  // Exactly upgradeWorker's change: image replaced; limits, leaderModel and contextWindows gone.
  const expected = { ...before.settings, image: current };
  delete expected.limits;
  delete expected.leaderModel;
  delete expected.contextWindows;
  assert.deepEqual(j.settings, expected);
  const box = (
    await f.db.query("SELECT image FROM boxes WHERE id=$1", [
      j.sandbox_id.slice("box:".length),
    ])
  ).rows[0];
  assert.equal(box.image, current);
  const notices = (
    await f.db.query(
      "SELECT payload,delivery FROM coding_events WHERE job_id=$1 AND event_key LIKE 'worker-moved:%'",
      [job.id],
    )
  ).rows;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].delivery, "pending");
  assert.equal(notices[0].payload.kind, "settings_change");
  assert.equal(notices[0].payload.by, "host");
  assert.deepEqual(notices[0].payload.changes, [
    { field: "Worker image", from: retired.slice(-12), to: current.slice(-12) },
  ]);
  assert.match(notices[0].payload.summary, /worker image was retired/);
  assert.match(notices[0].payload.summary, /Start of the request stay/);
  // A repeated pass moves nothing and writes no second notice.
  await f.c.tick();
  await f.c.tick();
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM coding_events WHERE job_id=$1 AND event_key LIKE 'worker-moved:%'",
        [job.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal((await f.row(job.id)).settings.image, current);
});

test("a retired Pi job whose move fails the model check stays paused and says why", async (t) => {
  const f = await retiredFixture(t);
  const job = await f.start();
  const retired = `ghcr.io/example/coding@sha256:${"9".repeat(64)}`;
  await f.db.query(
    "UPDATE coding_jobs SET settings=settings || jsonb_build_object('image',$2::text,'model','unrouted/model') WHERE id=$1",
    [job.id, retired],
  );
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(j.state, "paused");
  assert.equal(j.settings.image, retired);
  assert.equal(j.sandbox_id, null);
  assert.match(j.summary, /worker image has been retired/);
  assert.match(j.summary, /could not be moved/);
  assert.match(j.summary, /coding_job_update with upgradeWorker/);
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM coding_events WHERE job_id=$1 AND event_key LIKE 'worker-moved:%'",
        [job.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await f.db.query("SELECT count(*)::int AS n FROM boxes")).rows[0].n,
    0,
  );
});

test("a job that is not run by Pi on a retired worker keeps the advice to start a new job", async (t) => {
  const provider = new FakeBoxProvider({ canStop: true });
  const pi = codingSettings.parse({
    ...settings,
    limits: undefined,
    runtime: "pi",
  });
  const f = await fixture(t, {
    settings: pi,
    provider: (db) =>
      new BoxSandbox(
        db,
        new BoxController(
          db,
          {
            environment: "test",
            profiles: {
              coding: {
                provider: "fake",
                image: pi.image!,
                idleTtlMinutes: 15,
                retentionHours: 0,
                hardMaxHours: 3,
                absoluteDays: 1,
                concurrency: 1,
              },
            },
          },
          { fake: provider },
          "b".repeat(64),
          "https://coding.example.com",
        ),
        "coding",
        [pi.image!],
      ),
  });
  const job = await f.start();
  // A legacy job, with the limits such jobs carry: coding_job_update refuses to move its worker
  // ("Only a Pi coding job").
  await f.db.query(
    "UPDATE coding_jobs SET settings=settings || jsonb_build_object('runtime','node','limits',$2::jsonb) WHERE id=$1",
    [job.id, JSON.stringify(settings.limits)],
  );
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(j.state, "paused");
  assert.match(
    j.summary,
    /no longer run by the coding sandbox .* start a new coding job/,
  );
});

test("a job prepared for a worker that no longer runs is paused before launch and frees the queue", async (t) => {
  const pi = codingSettings.parse({
    ...settings,
    limits: undefined,
    runtime: "pi",
  });
  const provider = new FakeBoxProvider({ canStop: true });
  const current = `ghcr.io/example/coding@sha256:${"e".repeat(64)}`;
  const f = await fixture(t, {
    settings: pi,
    provider: (db) =>
      new BoxSandbox(
        db,
        new BoxController(
          db,
          {
            environment: "test",
            profiles: {
              coding: {
                provider: "fake",
                image: current,
                idleTtlMinutes: 15,
                retentionHours: 0,
                hardMaxHours: 3,
                absoluteDays: 1,
                concurrency: 1,
              },
            },
          },
          { fake: provider },
          "b".repeat(64),
          "https://coding.example.com",
        ),
        "coding",
        [current],
      ),
  });
  const job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(j.state, "paused");
  // The image new jobs use is not run either, so moving the job would not help.
  assert.match(
    j.summary,
    /no longer run by the coding sandbox .* start a new coding job/,
  );
  assert.equal(j.cleanup, "none");
  assert.equal(j.sandbox_id, null);
  assert.equal(
    (await f.db.query("SELECT count(*)::int AS n FROM boxes")).rows[0].n,
    0,
  );
  // Nothing holds the single coding slot, so another job can be claimed.
  const next = await f.start("next");
  await f.c.tick();
  assert.equal((await f.row(next.id)).state, "paused");
});
