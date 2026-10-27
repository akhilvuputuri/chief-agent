import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeAfter, migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { BoxController } from "../src/boxes/controller.js";
import { FakeBoxProvider } from "../src/boxes/provider.js";
import type { BoxConfig } from "../src/boxes/schema.js";
import { CodingController } from "../src/coding/controller.js";
import { codingSettings } from "../src/coding/schema.js";
import {
  BOX_VIEW_STATES,
  BoxSandbox,
  CODING_TASK_COMMAND,
  boxView,
  codingSandbox,
} from "../src/coding/box-sandbox.js";
import type {
  SandboxProvider,
  SandboxRequest,
} from "../src/coding/provider.js";

const image = `ghcr.io/example/coding@sha256:${"a".repeat(64)}`;
const previous = `ghcr.io/example/coding@sha256:${"9".repeat(64)}`;

async function fixture(t: TestContext) {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  await ensureUser(db, "owner");
  let now = new Date("2026-10-20T00:00:00Z");
  const provider = new FakeBoxProvider({ canStop: true });
  const config: BoxConfig = {
    environment: "test",
    profiles: {
      coding: {
        provider: "fake",
        image,
        previousImages: [previous],
        idleTtlMinutes: 15,
        retentionHours: 0,
        hardMaxHours: 3,
        absoluteDays: 1,
        concurrency: 1,
      },
    },
  };
  const boxes = new BoxController(
    db,
    config,
    { fake: provider },
    "b".repeat(64),
    "https://companion.example.com",
    () => now,
    { pollMs: 0, hostGraceMs: 0 },
  );
  const sandbox = new BoxSandbox(db, boxes, "coding", [image, previous]);
  const job = async () => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO coding_jobs(id,user_id,request_key,request_hash,origin_run,objective,context,mode,base_sha,settings)
       VALUES($1,'owner',$2,'h',$3,'o','c','implement',$4,'{}'::jsonb)`,
      [id, `job-${id}`, randomUUID(), "a".repeat(40)],
    );
    return id;
  };
  const request = async (
    overrides: Partial<SandboxRequest> = {},
  ): Promise<SandboxRequest> => ({
    jobId: await job(),
    attemptId: randomUUID(),
    token: "c".repeat(64),
    origin: "https://companion.example.com",
    image,
    runtime: "pi",
    timeoutMinutes: 45,
    ...overrides,
  });
  const boxOf = (id: string) => id.slice("box:".length);
  const row = async (id: string) =>
    (await db.query("SELECT * FROM boxes WHERE id=$1", [boxOf(id)])).rows[0];
  const task = async (id: string) =>
    (await db.query("SELECT * FROM box_tasks WHERE box_id=$1", [boxOf(id)]))
      .rows[0];
  /** Launches the box and completes its bootstrap hello; returns its credential. */
  const live = async (id: string) => {
    await boxes.tick();
    const secret = [...provider.boxes.values()].find(
      (b) => b.boxId === boxOf(id),
    )!.request.bootstrap.secret;
    return (await boxes.hello(boxOf(id), { protocol: 1, credential: secret }))
      .credential;
  };
  /** Ticks until the reconciler has verified the box's termination. */
  const settle = async (id: string) => {
    for (let i = 0; i < 6 && (await row(id)).state !== "terminated"; i++)
      await boxes.tick();
  };
  /**
   * `coding_status` over this database. Its provider, publisher and model all throw, so a
   * status call that touched any of them would fail the test rather than go unnoticed.
   */
  const controller = new CodingController(
    db,
    codingSettings.parse({
      repository: "akhilvuputuri/chief-agent",
      branch: "main",
      image,
      model: "fixture/coder",
      reviewerModel: "fixture/reviewer",
      effort: "high",
      limits: { ms: 900000, models: 40, tools: 100 },
    }),
    {
      create: async () => {
        throw new Error("status must not create a sandbox");
      },
      find: async () => {
        throw new Error("status must not find a sandbox");
      },
      inspect: async () => {
        throw new Error("status must not inspect a sandbox");
      },
      terminate: async () => {
        throw new Error("status must not terminate a sandbox");
      },
    } as unknown as SandboxProvider,
    {
      resolve: async () => {
        throw new Error("status must not resolve a repository");
      },
      publish: async () => {
        throw new Error("status must not publish");
      },
    } as any,
    "c".repeat(64),
    "https://companion.example.com",
    (user) => user === "owner",
    (() => {
      throw new Error("status must not call a model");
    }) as any,
    () => now,
  );
  const status = async (id?: string) =>
    (await controller.status("owner", id)) as any;
  /** Records the sandbox of a job's current attempt, as the controller does after launch. */
  const attach = async (jobId: string, sandboxId: string) =>
    db.query("UPDATE coding_jobs SET sandbox_id=$2 WHERE id=$1", [
      jobId,
      sandboxId,
    ]);
  return {
    db,
    boxes,
    sandbox,
    request,
    row,
    task,
    live,
    settle,
    status,
    attach,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

test("an attempt becomes one task in its own coding box, idempotently", async (t) => {
  const f = await fixture(t);
  const r = await f.request();
  const id = await f.sandbox.create(r);
  assert.match(id, /^box:/);
  assert.equal(await f.sandbox.create(r), id);
  assert.equal(await f.sandbox.find(r.attemptId), id);
  assert.equal(await f.sandbox.find(randomUUID()), undefined);
  const box = await f.row(id);
  assert.equal(box.user_id, "owner");
  assert.equal(box.profile, "coding");
  assert.equal(box.subject, `coding:${r.jobId}`);
  const tasks = (
    await f.db.query("SELECT * FROM box_tasks WHERE box_id=$1", [box.id])
  ).rows;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, "coding");
  assert.deepEqual(tasks[0].payload, {
    jobId: r.jobId,
    attemptId: r.attemptId,
    token: r.token,
    origin: r.origin,
  });
  assert.equal(await f.sandbox.inspect(id), "running");
});

test("a finished worker closes its box; terminal only once termination is verified", async (t) => {
  const f = await fixture(t);
  const id = await f.sandbox.create(await f.request());
  const credential = await f.live(id);
  const taskId = (await f.task(id)).id;
  await f.boxes.events(id.slice(4), credential, {
    epoch: 1,
    events: [
      { seq: 1, kind: "task.started", taskId },
      { seq: 2, kind: "task.result", taskId, payload: { exitCode: 1 } },
    ],
  });
  // The box is still alive, so cleanup must not complete yet.
  assert.equal(await f.sandbox.inspect(id), "running");
  assert.equal((await f.row(id)).state, "terminating");
  assert.equal(await f.sandbox.terminalReason(id), undefined);
  await f.settle(id);
  assert.equal(await f.sandbox.inspect(id), "terminal");
  // A worker that exited without a result is the transient case the controller retries.
  assert.equal(await f.sandbox.terminalReason(id), undefined);
});

test("terminate closes the box, and a closed box reports no stated reason", async (t) => {
  const f = await fixture(t);
  const id = await f.sandbox.create(await f.request());
  await f.live(id);
  await f.sandbox.terminate(id);
  assert.equal((await f.row(id)).state, "terminating");
  await f.settle(id);
  assert.equal(await f.sandbox.inspect(id), "terminal");
  await f.sandbox.terminate(id);
  assert.equal(await f.sandbox.terminalReason(id), undefined);
});

test("a box ended by its own limits, or a task past its deadline, gives the owner a reason", async (t) => {
  const f = await fixture(t);
  const id = await f.sandbox.create(await f.request());
  const credential = await f.live(id);
  const taskId = (await f.task(id)).id;
  await f.boxes.events(id.slice(4), credential, {
    epoch: 1,
    events: [
      { seq: 1, kind: "task.started", taskId },
      {
        seq: 2,
        kind: "task.failed",
        taskId,
        payload: { error: "The task passed its deadline" },
      },
    ],
  });
  await f.sandbox.inspect(id);
  await f.settle(id);
  assert.match((await f.sandbox.terminalReason(id))!, /passed its deadline/);

  const other = await f.sandbox.create(await f.request());
  await f.live(other);
  await f.boxes.close("owner", other.slice(4), "Hard maximum reached");
  await f.settle(other);
  assert.match(
    (await f.sandbox.terminalReason(other))!,
    /Coding box ended \(Hard maximum reached\)/,
  );
});

test("a held coding box is left for an operator: never terminal, never closed", async (t) => {
  const f = await fixture(t);
  const id = await f.sandbox.create(await f.request());
  await f.db.query("UPDATE boxes SET state='held' WHERE id=$1", [id.slice(4)]);
  assert.equal(await f.sandbox.inspect(id), "running");
  await f.sandbox.terminate(id);
  assert.equal((await f.row(id)).state, "held");
});

test("only the attempt's own end, idle close and infrastructure faults are unstated", async (t) => {
  const f = await fixture(t);
  for (const [reason, stated] of [
    ["Idle time-to-live reached", false],
    ["The box stopped polling and is lost", false],
    ["Compromised: retired credential", true],
    ["Closed by the owner", true],
    ["Lifetime limit reached", true],
  ] as const) {
    const id = await f.sandbox.create(await f.request());
    await f.live(id);
    await f.boxes.close("owner", id.slice(4), reason);
    await f.settle(id);
    const said = await f.sandbox.terminalReason(id);
    if (stated) assert.match(said!, new RegExp(reason.split(":")[0]));
    else assert.equal(said, undefined);
  }
});

test("the attempt token is dropped from stored payloads once the box is gone", async (t) => {
  const f = await fixture(t);
  const id = await f.sandbox.create(await f.request());
  await f.live(id);
  await f.sandbox.terminate(id);
  await f.settle(id);
  assert.equal(await f.sandbox.inspect(id), "terminal");
  assert.equal((await f.task(id)).payload.token, undefined);
  const message = (
    await f.db.query(
      "SELECT payload FROM box_messages WHERE box_id=$1 AND kind='task.assign'",
      [id.slice(4)],
    )
  ).rows[0].payload;
  assert.equal(message.payload.token, undefined);
  assert.ok(message.payload.jobId);
});

test("the box sandbox runs the job's own snapshotted image when the profile still lists it", async (t) => {
  const f = await fixture(t);
  assert.equal(f.sandbox.accepts(await f.request()), true);
  // After a re-pin, a job snapshotted with the previous image still runs, on that image.
  const r = await f.request({ image: previous });
  assert.equal(f.sandbox.accepts(r), true);
  const id = await f.sandbox.create(r);
  assert.equal((await f.row(id)).image, previous);
  const retired = `ghcr.io/example/coding@sha256:${"d".repeat(64)}`;
  assert.equal(f.sandbox.accepts(await f.request({ image: retired })), false);
  assert.equal(
    f.sandbox.accepts(await f.request({ runtime: "python" })),
    false,
  );
  await assert.rejects(
    f.sandbox.create(await f.request({ image: retired })),
    /cannot run in a coding box/,
  );
  // The box layer itself refuses an image its profile does not list.
  await assert.rejects(
    f.boxes.spawn("owner", {
      profile: "coding",
      requestKey: "direct",
      subject: "direct",
      image: retired,
    }),
    /does not run that image/,
  );
});
test("startup needs boxes and the reviewed coding profile, and refuses while a CodeBuild attempt is live", async (t) => {
  const f = await fixture(t);
  const base = {
    db: f.db,
    settings: { runtime: "pi", image },
    boxes: f.boxes,
    taskCommand: CODING_TASK_COMMAND,
  };
  const chosen = await codingSandbox(base);
  assert.ok(chosen instanceof BoxSandbox);
  assert.deepEqual(chosen.images, [image, previous]);
  for (const [o, error] of [
    [{ boxes: undefined }, /BOXES_RUNTIME=on/],
    [
      { settings: { runtime: "pi", image: "other" } },
      /selected Pi worker image/,
    ],
    [{ settings: { runtime: "node", image } }, /selected Pi worker image/],
    [
      { taskCommand: ["node", "/opt/chief-worker/dist/boxes/coding-task.js"] },
      /must run node --disable-sigusr1/,
    ],
    [{ taskCommand: undefined }, /must run/],
  ] as const)
    await assert.rejects(codingSandbox({ ...base, ...o }), error);
  // An attempt still on a CodeBuild build would be stranded without CodeBuild.
  const r = await f.request();
  await f.db.query(
    "UPDATE coding_jobs SET sandbox_id='chief-coding:build-1',state='running' WHERE id=$1",
    [r.jobId],
  );
  await assert.rejects(codingSandbox(base), /depends on a CodeBuild build/);
  await f.db.query(
    "UPDATE coding_jobs SET state='paused',cleanup='complete' WHERE id=$1",
    [r.jobId],
  );
  assert.ok(await codingSandbox(base));
  // An unrecorded launch whose image no box runs (an uncertain CodeBuild create) also would.
  await f.db.query(
    "UPDATE coding_jobs SET sandbox_id=NULL,state='paused',cleanup='pending',settings=jsonb_build_object('image','ghcr.io/example/old@sha256:'||repeat('c',64)) WHERE id=$1",
    [r.jobId],
  );
  await assert.rejects(codingSandbox(base), /depends on a CodeBuild build/);
  // Even with an image no longer listed, an unrecorded launch whose box exists is found.
  const attempt = (
    await f.db.query(
      "UPDATE coding_jobs SET attempt_id=gen_random_uuid() WHERE id=$1 RETURNING attempt_id",
      [r.jobId],
    )
  ).rows[0].attempt_id;
  await f.boxes.spawn("owner", {
    profile: "coding",
    requestKey: `coding:${attempt}`,
    subject: `coding:${r.jobId}`,
  });
  assert.ok(await codingSandbox(base));
  await f.db.query("UPDATE boxes SET state='terminated'");
  await f.db.query("DELETE FROM box_tasks");
  await f.db.query("DELETE FROM box_messages");
  await f.db.query("DELETE FROM box_events");
  await f.db.query("DELETE FROM boxes WHERE request_key=$1", [
    `coding:${attempt}`,
  ]);
  // An unrecorded box launch with a listed image is reconciled by the box sandbox.
  await f.db.query(
    "UPDATE coding_jobs SET settings=jsonb_build_object('image',$2::text) WHERE id=$1",
    [r.jobId, previous],
  );
  assert.ok(await codingSandbox(base));
  // Box attempts never block startup.
  await f.db.query(
    "UPDATE coding_jobs SET sandbox_id='box:x',state='running' WHERE id=$1",
    [r.jobId],
  );
  assert.ok(await codingSandbox(base));
});

test("coding_status shows the box view of a live box, and keeps the list call unchanged", async (t) => {
  const f = await fixture(t);
  const r = await f.request();
  const id = await f.sandbox.create(r);
  await f.attach(r.jobId, id);
  const credential = await f.live(id);
  let box = (await f.status(r.jobId)).box;
  assert.equal(box.state, "ready");
  assert.ok(box.launchedAt instanceof Date);
  assert.ok(box.lastReportAt instanceof Date);
  assert.ok(box.lastReportAt >= box.launchedAt);
  assert.equal("endReason" in box, false);
  // The list call stays as it was: a box view only ever appears on one job's details.
  for (const item of await f.status()) assert.equal("box" in item, false);
  // A busy box says so, and a closing box is terminating, not yet ended.
  await f.boxes.events(id.slice(4), credential, {
    epoch: 1,
    events: [{ seq: 1, kind: "box.state", state: "busy" }],
  });
  assert.equal((await f.status(r.jobId)).box.state, "busy");
  await f.boxes.events(id.slice(4), credential, {
    epoch: 1,
    events: [
      {
        seq: 2,
        kind: "task.result",
        taskId: (await f.task(id)).id,
        payload: { exitCode: 1 },
      },
    ],
  });
  await f.sandbox.inspect(id);
  box = (await f.status(r.jobId)).box;
  assert.equal((await f.row(id)).state, "terminating");
  assert.equal(box.state, "terminating");
  assert.equal("endReason" in box, false);
});

test("coding_status states why a box ended, only once it is terminated and has a reason", async (t) => {
  const f = await fixture(t);
  const r = await f.request();
  const id = await f.sandbox.create(r);
  await f.attach(r.jobId, id);
  await f.live(id);
  assert.equal("endReason" in (await f.status(r.jobId)).box, false);
  await f.boxes.close("owner", id.slice(4), "Hard maximum reached");
  await f.settle(id);
  const box = (await f.status(r.jobId)).box;
  assert.equal(box.state, "terminated");
  assert.equal(box.endReason, "Hard maximum reached");
  assert.ok(box.lastReportAt instanceof Date);

  // A verified ending with nothing stated about it gives the owner no reason.
  const other = await f.request();
  const otherId = await f.sandbox.create(other);
  await f.attach(other.jobId, otherId);
  await f.live(otherId);
  await f.db.query(
    "UPDATE boxes SET state='terminated',reason='' WHERE id=$1",
    [otherId.slice(4)],
  );
  const ended = (await f.status(other.jobId)).box;
  assert.equal(ended.state, "terminated");
  assert.equal("endReason" in ended, false);
});

test("a job on an older sandbox shows no box view", async (t) => {
  const f = await fixture(t);
  const r = await f.request();
  await f.attach(r.jobId, "chief-coding:build-1");
  const detail = await f.status(r.jobId);
  assert.equal("box" in detail, false);
  assert.equal(detail.id, r.jobId);
  assert.equal(await boxView(f.db, "chief-coding:build-1", "owner"), undefined);
  // A box: id that is not a box UUID is refused before any query, so it has no view.
  await f.db.query("UPDATE coding_jobs SET sandbox_id='box:x' WHERE id=$1", [
    r.jobId,
  ]);
  assert.equal("box" in (await f.status(r.jobId)), false);
});

test("every stored box state maps to one of the seven view states", async (t) => {
  const f = await fixture(t);
  const documented: Record<string, string> = {
    requested: "requested",
    launching: "requested",
    booting: "booting",
    starting: "booting",
    ready: "ready",
    busy: "busy",
    stopping: "terminating",
    stopped: "terminating",
    terminating: "terminating",
    terminated: "terminated",
    held: "held",
  };
  // The mapping is only total if it covers the states the column actually allows.
  const check = (
    await f.db.query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='boxes'::regclass AND contype='c'",
    )
  ).rows.map((c: any) => String(c.def))[0];
  const stored = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...stored].sort(), Object.keys(documented).sort());
  const r = await f.request();
  const id = await f.sandbox.create(r);
  await f.attach(r.jobId, id);
  await f.live(id);
  for (const [state, view] of Object.entries(documented)) {
    await f.db.query("UPDATE boxes SET state=$2,reason='' WHERE id=$1", [
      id.slice(4),
      state,
    ]);
    const box = (await f.status(r.jobId)).box;
    assert.ok(BOX_VIEW_STATES.includes(box.state), `${state} -> ${box.state}`);
    assert.equal(box.state, view, state);
    assert.equal("endReason" in box, false, state);
  }
  // A state a later migration might allow is reported as held: neither live nor gone.
  await f.db.query("ALTER TABLE boxes DROP CONSTRAINT boxes_state_check");
  await f.db.query("UPDATE boxes SET state='draining' WHERE id=$1", [
    id.slice(4),
  ]);
  assert.equal((await f.status(r.jobId)).box.state, "held");
});

test("a box id with no row, another owner's box, or a malformed id has no view", async (t) => {
  const f = await fixture(t);
  assert.equal(await boxView(f.db, `box:${randomUUID()}`, "owner"), undefined);
  assert.equal(await boxView(f.db, "box:not-a-uuid", "owner"), undefined);
  // A job whose attempt names no box row still gets its normal status details.
  const r = await f.request();
  await f.attach(r.jobId, `box:${randomUUID()}`);
  const detail = await f.status(r.jobId);
  assert.equal("box" in detail, false);
  assert.equal(detail.id, r.jobId);
  // The view is owner-scoped like every other coding read.
  const id = await f.sandbox.create(await f.request());
  assert.ok(await boxView(f.db, id, "owner"));
  assert.equal(await boxView(f.db, id, "someone-else"), undefined);
});

test("a held box shows held without stating a reason for ending", async (t) => {
  const f = await fixture(t);
  const r = await f.request();
  const id = await f.sandbox.create(r);
  await f.attach(r.jobId, id);
  await f.live(id);
  await f.db.query(
    "UPDATE boxes SET state='held',reason='Launch outcome unknown; inspect the provider' WHERE id=$1",
    [id.slice(4)],
  );
  const box = (await f.status(r.jobId)).box;
  assert.equal(box.state, "held");
  assert.equal("endReason" in box, false);
});
