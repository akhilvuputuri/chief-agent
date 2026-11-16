import { test } from "node:test";
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

test("a Pi job on a retired worker image is told to move to the current image and resume (journal 200)", async (t) => {
  const pi = codingSettings.parse({
    ...settings,
    limits: undefined,
    runtime: "pi",
  });
  const provider = new FakeBoxProvider({ canStop: true });
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
  const retired = `ghcr.io/example/coding@sha256:${"9".repeat(64)}`;
  await f.db.query(
    "UPDATE coding_jobs SET settings=jsonb_set(settings,'{image}',to_jsonb($2::text)) WHERE id=$1",
    [job.id, retired],
  );
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(j.state, "paused");
  assert.match(j.summary, /worker image has been retired/);
  assert.match(j.summary, /saved work is kept/);
  assert.match(
    j.summary,
    /move the job to the current worker image \(coding_job_update with upgradeWorker\), then resume it/,
  );
  assert.doesNotMatch(j.summary, /start a new coding job/);
  assert.equal(j.sandbox_id, null);
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
