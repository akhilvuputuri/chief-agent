import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { BoxController } from "../src/boxes/controller.js";
import { FakeBoxProvider } from "../src/boxes/provider.js";
import type { BoxConfig } from "../src/boxes/schema.js";
import {
  BoxSandbox,
  CODING_TASK_COMMAND,
  RoutedSandbox,
  codingSandbox,
} from "../src/coding/box-sandbox.js";
import type {
  SandboxProvider,
  SandboxRequest,
} from "../src/coding/provider.js";

const image = `ghcr.io/example/coding@sha256:${"a".repeat(64)}`;

async function fixture(t: TestContext) {
  const pg = new PGlite();
  t.after(() => pg.close());
  for (const f of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + f, import.meta.url), "utf8"),
    );
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
  const sandbox = new BoxSandbox(db, boxes, "coding", image);
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
  return {
    db,
    boxes,
    sandbox,
    request,
    row,
    task,
    live,
    settle,
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

test("routing keeps older images and existing sandboxes on the previous provider", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  const fallback: SandboxProvider = {
    create: async (r) => {
      calls.push(`create:${r.image}`);
      return "build-1";
    },
    find: async (attemptId) => {
      calls.push(`find:${attemptId}`);
      return undefined;
    },
    inspect: async (id) => {
      calls.push(`inspect:${id}`);
      return "terminal";
    },
    terminate: async (id) => {
      calls.push(`terminate:${id}`);
    },
    terminalReason: async () => "from fallback",
  };
  const routed = new RoutedSandbox(f.sandbox, fallback);
  const old = `ghcr.io/example/coding@sha256:${"d".repeat(64)}`;
  assert.equal(await routed.create(await f.request({ image: old })), "build-1");
  assert.equal(
    await routed.create(await f.request({ runtime: "python" })),
    "build-1",
  );
  assert.equal(await routed.inspect("build-1"), "terminal");
  await routed.terminate("build-1");
  assert.equal(await routed.terminalReason("build-1"), "from fallback");
  assert.equal(routed.startupGraceMs("build-1"), 0);

  const r = await f.request();
  const id = await routed.create(r);
  assert.match(id, /^box:/);
  assert.equal(await routed.find(r.attemptId), id);
  assert.equal(await routed.inspect(id), "running");
  assert.equal(routed.startupGraceMs(id), 12 * 60_000);
  assert.equal(await routed.find("unknown"), undefined);
  assert.deepEqual(calls, [
    `create:${old}`,
    `create:${image}`,
    "inspect:build-1",
    "terminate:build-1",
    "find:unknown",
  ]);

  const alone = new RoutedSandbox(f.sandbox);
  await assert.rejects(
    alone.create(await f.request({ image: old })),
    /not configured/,
  );
  assert.equal(await alone.find("unknown"), undefined);
});

test("startup keeps box attempts routable whenever a coding profile exists, and refuses to strand them", async (t) => {
  const f = await fixture(t);
  const codebuild: SandboxProvider = {
    create: async () => "build-1",
    find: async () => undefined,
    inspect: async () => "terminal",
    terminate: async () => {},
  };
  const base = {
    db: f.db,
    codebuild,
    settings: { runtime: "pi", image },
    taskCommand: CODING_TASK_COMMAND,
  };
  // On CodeBuild for new attempts, an existing box attempt is still served by its box.
  const back = await codingSandbox({
    ...base,
    sandbox: "codebuild",
    boxes: f.boxes,
  });
  const r = await f.request();
  assert.equal(await back.create(r), "build-1");
  const boxed = await f.sandbox.create(await f.request());
  assert.equal(await back.inspect(boxed), "running");
  // Without boxes, startup refuses while that attempt still depends on its box.
  await f.db.query(
    "UPDATE coding_jobs SET sandbox_id=$1,state='running' WHERE id=(SELECT id FROM coding_jobs LIMIT 1)",
    [boxed],
  );
  await assert.rejects(
    codingSandbox({ ...base, sandbox: "codebuild" }),
    /still depend on boxes/,
  );
  await f.db.query("UPDATE coding_jobs SET state='paused',cleanup='complete'");
  assert.equal(
    await codingSandbox({ ...base, sandbox: "codebuild" }),
    codebuild,
  );
  // Switching new attempts to boxes is checked against the reviewed profile.
  const routed = await codingSandbox({
    ...base,
    sandbox: "box",
    boxes: f.boxes,
  });
  assert.match(await routed.create(await f.request()), /^box:/);
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
    await assert.rejects(
      codingSandbox({ ...base, sandbox: "box", boxes: f.boxes, ...o }),
      error,
    );
});
