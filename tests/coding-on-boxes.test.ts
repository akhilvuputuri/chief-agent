import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  assert.match(notices[0].payload.summary, /coder and reviewer models/);
});

const RETIRED = `ghcr.io/example/coding@sha256:${"9".repeat(64)}`;
/** A started job snapshotted with a retired image. */
async function retiredJob(f: Awaited<ReturnType<typeof retiredFixture>>) {
  const job = await f.start();
  await f.db.query(
    "UPDATE coding_jobs SET settings=jsonb_set(settings,'{image}',to_jsonb($2::text)) WHERE id=$1",
    [job.id, RETIRED],
  );
  return job;
}
/** Runs `act` once, between the claim and the move's statement. */
function beforeMove(
  f: Awaited<ReturnType<typeof retiredFixture>>,
  act: (
    query: (text: string, params?: unknown[]) => Promise<any>,
  ) => Promise<unknown>,
) {
  const query = f.db.query.bind(f.db) as (
    text: string,
    params?: unknown[],
  ) => Promise<any>;
  let done = false;
  (f.db as any).query = async (text: string, params?: unknown[]) => {
    if (!done && typeof text === "string" && text.includes("'worker-moved:'")) {
      done = true;
      await act(query);
    }
    return query(text, params);
  };
}
const movedNotices = async (
  f: Awaited<ReturnType<typeof retiredFixture>>,
  id: string,
) =>
  (
    await f.db.query(
      "SELECT count(*)::int AS n FROM coding_events WHERE job_id=$1 AND event_key LIKE 'worker-moved:%'",
      [id],
    )
  ).rows[0].n as number;
const boxCount = async (f: Awaited<ReturnType<typeof retiredFixture>>) =>
  (await f.db.query("SELECT count(*)::int AS n FROM boxes")).rows[0]
    .n as number;

test("a move that no longer matches the claimed job's settings pauses it with a true text and starts no box", async (t) => {
  const f = await retiredFixture(t);
  const job = await retiredJob(f);
  beforeMove(f, (query) =>
    query(
      "UPDATE coding_jobs SET settings=jsonb_set(settings,'{reviewerModel}','\"synthetic/other\"') WHERE id=$1",
      [job.id],
    ),
  );
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(j.state, "paused");
  assert.match(j.summary, /moving it to the current one did not apply/);
  assert.match(j.summary, /resume it to try again/);
  assert.doesNotMatch(j.summary, /never started/);
  assert.equal(j.settings.image, RETIRED);
  assert.equal(j.sandbox_id, null);
  assert.equal(j.cleanup, "none");
  assert.equal(await movedNotices(f, job.id), 0);
  assert.equal(await boxCount(f), 0);
});

test("a move after this pass lost the claim leaves the job to the pass that holds it", async (t) => {
  const f = await retiredFixture(t);
  const job = await retiredJob(f);
  const other = randomUUID();
  beforeMove(f, (query) =>
    query("UPDATE coding_jobs SET lease=$2 WHERE id=$1", [job.id, other]),
  );
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(j.state, "provisioning");
  assert.equal(j.lease, other);
  assert.equal(j.settings.image, RETIRED);
  assert.equal(j.sandbox_id, null);
  assert.equal(j.cleanup, "pending");
  assert.equal(await movedNotices(f, job.id), 0);
  assert.equal(await boxCount(f), 0);
});

test("replaying the move for the same attempt writes no second notice", async (t) => {
  const f = await retiredFixture(t);
  const job = await retiredJob(f);
  const before = await f.row(job.id);
  await f.c.tick();
  const moved = await f.row(job.id);
  assert.match(moved.sandbox_id, /^box:/);
  assert.equal(await movedNotices(f, job.id), 1);
  // The same attempt, claimed and on the retired image again, goes through the move again.
  await f.db.query(
    "UPDATE coding_jobs SET settings=$2::jsonb,sandbox_id=NULL,state='provisioning',lease=$3 WHERE id=$1",
    [job.id, JSON.stringify(before.settings), randomUUID()],
  );
  const replay = await f.row(job.id);
  assert.equal(replay.attempt_id, moved.attempt_id);
  assert.equal(await (f.c as any).moveRetiredWorker(replay), true);
  assert.equal(await movedNotices(f, job.id), 1);
});

test("a job with a PR that automation queued again is moved and its box launches", async (t) => {
  const f = await retiredFixture(t);
  const job = await retiredJob(f);
  // As the rebase and PR-feedback requeues leave it (automation.ts).
  await f.db.query(
    "UPDATE coding_jobs SET pr_url='https://github.com/example/repo/pull/7',head_sha=$2,cleanup='none',summary='PR feedback went to the coder; review and CI run again before the Merge card' WHERE id=$1",
    [job.id, "c".repeat(40)],
  );
  await f.c.tick();
  const j = await f.row(job.id);
  assert.match(j.sandbox_id, /^box:/);
  assert.notEqual(j.settings.image, RETIRED);
  assert.equal(await movedNotices(f, job.id), 1);
});

test("a moved job whose box stopped is still retried automatically once", async (t) => {
  const f = await retiredFixture(t);
  const job = await retiredJob(f);
  await f.c.tick();
  const moved = await f.row(job.id);
  assert.match(moved.sandbox_id, /^box:/);
  // The box stopped without a reason a few minutes after the move (as the host records it).
  await f.db.query(
    "UPDATE coding_events SET created_at=now()-interval '10 minutes' WHERE job_id=$1 AND payload->>'reason'='worker_image_retired'",
    [job.id],
  );
  await f.db.query(
    "UPDATE coding_jobs SET state='paused',stage='paused',cleanup='complete',summary='The coding box stopped',updated_at=now()-interval '5 minutes' WHERE id=$1",
    [job.id],
  );
  await f.db.query(
    'INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,$2,\'{"summary":"The coding box stopped","cause":"sandbox_stopped"}\'::jsonb,\'suppressed\')',
    [job.id, `${moved.attempt_id}:paused`],
  );
  await f.c.autoRetryOnce();
  const j = await f.row(job.id);
  assert.equal(j.state, "queued");
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM coding_revisions WHERE job_id=$1 AND request_key=$2",
        [job.id, `auto-retry:${moved.attempt_id}`],
      )
    ).rows[0].n,
    1,
  );
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
