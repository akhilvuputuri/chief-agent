import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import {
  BoxController,
  BoxCredentialRefused,
  type BoxTimings,
} from "../src/boxes/controller.js";
import { FakeBoxProvider } from "../src/boxes/provider.js";
import { boxApi } from "../src/boxes/api.js";
import { server } from "../src/server.js";
import type { BoxConfig } from "../src/boxes/schema.js";
import { ToolValidationError } from "../src/tool-errors.js";

const image = `ghcr.io/example/box@sha256:${"a".repeat(64)}`;
const MIN = 60_000;

async function fixture(
  t: TestContext,
  options: {
    canStop?: boolean;
    concurrency?: number;
    idle?: number;
    retention?: number;
    hardMax?: number;
    identity?: boolean;
    timings?: Partial<BoxTimings>;
  } = {},
) {
  const pg = new PGlite();
  t.after(() => pg.close());
  for (const f of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + f, import.meta.url), "utf8"),
    );
  // The box migration is staged outside db/ until its reviewed rollout (docs/boxes.md).
  await pg.exec(
    await readFile(
      new URL("../db-staged/032_boxes.sql", import.meta.url),
      "utf8",
    ),
  );
  const db = pg as unknown as Database;
  await ensureUser(db, "owner");
  await ensureUser(db, "other");
  let now = new Date("2026-10-20T00:00:00Z");
  const provider = new FakeBoxProvider({ canStop: options.canStop ?? true });
  const identityOk = { value: true };
  if (options.identity)
    (provider as any).verifyIdentity = async () => identityOk.value;
  const config: BoxConfig = {
    environment: "test",
    profiles: {
      echo: {
        provider: "fake",
        image,
        idleTtlMinutes: options.idle ?? 15,
        retentionHours: options.retention ?? 24,
        hardMaxHours: options.hardMax ?? 24,
        absoluteDays: 7,
        concurrency: options.concurrency ?? 2,
      },
    },
  };
  const inputs = new Set<string>(["run-1:input-1"]);
  const boxes = new BoxController(
    db,
    config,
    { fake: provider },
    "b".repeat(64),
    "https://companion.example.com",
    () => now,
    { pollMs: 0, hostGraceMs: 0, ...options.timings },
    async (user, run, inputId) =>
      user === "owner" && inputs.has(`${run}:${inputId}`),
  );
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const row = async (id: string) =>
    (await db.query("SELECT * FROM boxes WHERE id=$1", [id])).rows[0];
  const secretOf = (id: string) =>
    [...provider.boxes.values()].find((b) => b.boxId === id)!.request.bootstrap
      .secret;
  /** Spawn, launch and complete the bootstrap hello; returns the live credential. */
  const live = async (key = "box-1") => {
    const box = await boxes.spawn("owner", {
      requestKey: key,
      profile: "echo",
      subject: `coding:${key}`,
    });
    await boxes.tick();
    const hello = await boxes.hello(box.id, {
      protocol: 1,
      credential: secretOf(box.id),
    });
    return { id: box.id, credential: hello.credential };
  };
  return {
    db,
    boxes,
    provider,
    advance,
    row,
    secretOf,
    live,
    identityOk,
    inputs,
  };
}

test("spawn is idempotent per request key and bound to one subject", async (t) => {
  const f = await fixture(t);
  const a = await f.boxes.spawn("owner", {
    requestKey: "k",
    profile: "echo",
    subject: "coding:job-1",
  });
  const again = await f.boxes.spawn("owner", {
    requestKey: "k",
    profile: "echo",
    subject: "coding:job-1",
  });
  assert.equal(again.id, a.id);
  await assert.rejects(
    f.boxes.spawn("owner", {
      requestKey: "k",
      profile: "echo",
      subject: "coding:job-2",
    }),
    ToolValidationError,
  );
  await assert.rejects(
    f.boxes.spawn("owner", { requestKey: "x", profile: "nope", subject: "s" }),
    /Unknown box profile/,
  );
  await assert.rejects(f.boxes.status("other", a.id), /Box not found/);
});

test("launch records the secret before the provider call and respects per-profile concurrency", async (t) => {
  const f = await fixture(t, { concurrency: 1 });
  const one = await f.boxes.spawn("owner", {
    requestKey: "1",
    profile: "echo",
    subject: "a",
  });
  const two = await f.boxes.spawn("owner", {
    requestKey: "2",
    profile: "echo",
    subject: "b",
  });
  await f.boxes.tick();
  assert.equal((await f.row(one.id)).state, "booting");
  assert.equal((await f.row(two.id)).state, "requested");
  const launched = [...f.provider.boxes.values()][0].request;
  assert.equal(launched.clientToken, one.id);
  assert.equal(launched.environment, "test");
  assert.equal(launched.bootstrap.origin, "https://companion.example.com");
  assert.equal(f.provider.calls.filter((c) => c === "launch").length, 1);
});

test("a stopped box restarts only within its profile's concurrency, and no box connects before it is recorded", async (t) => {
  const f = await fixture(t, { concurrency: 1 });
  const { id, credential } = await f.live();
  f.advance(16 * MIN);
  await f.boxes.next(id, credential, 0);
  await f.boxes.tick();
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "stopped");
  const other = await f.boxes.spawn("owner", {
    requestKey: "2",
    profile: "echo",
    subject: "b",
  });
  const third = await f.boxes.spawn("owner", {
    requestKey: "3",
    profile: "echo",
    subject: "c",
  });
  await f.boxes.tick();
  assert.equal((await f.row(other.id)).state, "booting");
  assert.equal((await f.row(third.id)).state, "requested");
  await assert.rejects(
    f.boxes.hello(third.id, { protocol: 1, credential: "x".repeat(43) }),
    BoxCredentialRefused,
  );
  await f.boxes.delegate("owner", id, {
    requestKey: "t",
    kind: "echo",
    payload: {},
  });
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "stopped");
});

test("bootstrap hello is idempotent until first use; then a replay is refused and alerted, not obeyed", async (t) => {
  const f = await fixture(t);
  const box = await f.boxes.spawn("owner", {
    requestKey: "k",
    profile: "echo",
    subject: "s",
  });
  await f.boxes.tick();
  const secret = f.secretOf(box.id);
  const first = await f.boxes.hello(box.id, {
    protocol: 1,
    credential: secret,
  });
  // The response was lost: the agent retries with the same secret and gets the same credential.
  const retry = await f.boxes.hello(box.id, {
    protocol: 1,
    credential: secret,
  });
  assert.equal(retry.credential, first.credential);
  assert.equal(retry.epoch, 1);
  assert.equal((await f.row(box.id)).state, "ready");
  await f.boxes.next(box.id, first.credential, 0);
  await assert.rejects(
    f.boxes.hello(box.id, { protocol: 1, credential: secret }),
    BoxCredentialRefused,
  );
  const notices = (
    await f.db.query("SELECT notice_key FROM box_notices WHERE box_id=$1", [
      box.id,
    ])
  ).rows.map((r) => r.notice_key);
  assert.deepEqual(notices, ["alert:retired-hello:1"]);
  assert.equal((await f.row(box.id)).state, "ready");
});

test("rotation: the predecessor only retries hello; a retired credential on the channel is compromise", async (t) => {
  const f = await fixture(t);
  const { id, credential: c1 } = await f.live();
  await f.boxes.next(id, c1, 0);
  const c2 = (await f.boxes.hello(id, { protocol: 1, credential: c1 }))
    .credential;
  assert.notEqual(c2, c1);
  assert.equal(
    (await f.boxes.hello(id, { protocol: 1, credential: c1 })).credential,
    c2,
  );
  // While the replacement is unused, the predecessor is refused outside hello, without alarm.
  await assert.rejects(f.boxes.next(id, c1, 0), BoxCredentialRefused);
  assert.equal((await f.row(id)).state, "ready");
  await f.boxes.next(id, c2, 0);
  const task = await f.boxes.delegate("owner", id, {
    requestKey: "t",
    kind: "echo",
    payload: {},
  });
  await assert.rejects(f.boxes.next(id, c1, 0), BoxCredentialRefused);
  const row = await f.row(id);
  assert.equal(row.state, "terminating");
  assert.match(row.reason, /Compromised/);
  const failed = (
    await f.db.query("SELECT state FROM box_tasks WHERE id=$1", [task.taskId])
  ).rows[0];
  assert.equal(failed.state, "failed");
  assert.ok(
    (
      await f.db.query(
        "SELECT 1 FROM box_notices WHERE box_id=$1 AND notice_key='compromised'",
        [id],
      )
    ).rows.length,
  );
  await assert.rejects(f.boxes.next(id, c2, 0), BoxCredentialRefused);
});

test("tasks flow as ordered, acknowledged messages and idempotent events", async (t) => {
  const f = await fixture(t);
  const { id, credential } = await f.live();
  const { taskId } = await f.boxes.delegate("owner", id, {
    requestKey: "t1",
    kind: "echo",
    payload: { text: "hi" },
  });
  const again = await f.boxes.delegate("owner", id, {
    requestKey: "t1",
    kind: "echo",
    payload: {},
  });
  assert.equal(again.taskId, taskId);
  const polled = await f.boxes.next(id, credential, 0);
  assert.equal(polled.messages.length, 1);
  assert.equal(polled.messages[0].kind, "task.assign");
  assert.equal(polled.messages[0].payload.taskId, taskId);
  // At-least-once: until acknowledged, the message is delivered again.
  assert.equal((await f.boxes.next(id, credential, 0)).messages.length, 1);
  assert.equal(
    (await f.boxes.next(id, credential, polled.messages[0].seq)).messages
      .length,
    0,
  );
  const batch = {
    epoch: 1,
    events: [
      { seq: 1, kind: "box.state", state: "busy" },
      { seq: 2, kind: "task.started", taskId },
      { seq: 3, kind: "task.result", taskId, payload: { text: "hi" } },
      { seq: 4, kind: "box.state", state: "idle" },
    ],
  };
  assert.deepEqual(await f.boxes.events(id, credential, batch), { applied: 4 });
  assert.deepEqual(await f.boxes.events(id, credential, batch), { applied: 0 });
  const status = await f.boxes.status("owner", id);
  assert.equal(status.state, "ready");
  assert.equal(status.tasks[0].state, "done");
  assert.deepEqual(status.tasks[0].result, { text: "hi" });
  const other = await f.live("box-2");
  await assert.rejects(
    f.boxes.events(other.id, other.credential, {
      epoch: 1,
      events: [{ seq: 1, kind: "task.started", taskId }],
    }),
    /another box's task/,
  );
});

test("steering needs the owner's own input and a running task", async (t) => {
  const f = await fixture(t);
  const { id, credential } = await f.live();
  const { taskId } = await f.boxes.delegate("owner", id, {
    requestKey: "t",
    kind: "echo",
    payload: {},
  });
  await assert.rejects(
    f.boxes.send("owner", "run-1", id, {
      requestKey: "m",
      taskId,
      text: "go",
      ownerInputId: "forged",
    }),
    /owner's own message/,
  );
  // An input from another turn does not authorise steering in this one.
  await assert.rejects(
    f.boxes.send("owner", "run-2", id, {
      requestKey: "m",
      taskId,
      text: "go",
      ownerInputId: "input-1",
    }),
    /owner's own message/,
  );
  await f.boxes.send("owner", "run-1", id, {
    requestKey: "m",
    taskId,
    text: "go",
    ownerInputId: "input-1",
  });
  const kinds = (await f.boxes.next(id, credential, 0)).messages.map(
    (m) => m.kind,
  );
  assert.deepEqual(kinds, ["task.assign", "task.message"]);
});

test("an idle box stops, keeps its place, and starts again for new work", async (t) => {
  const f = await fixture(t);
  const { id, credential } = await f.live();
  f.advance(10 * MIN);
  await f.boxes.next(id, credential, 0);
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "ready");
  f.advance(6 * MIN);
  await f.boxes.next(id, credential, 0);
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "stopping");
  await f.boxes.tick();
  const stopped = await f.row(id);
  assert.equal(stopped.state, "stopped");
  assert.equal(Number(stopped.running_ms), 16 * MIN);
  await f.boxes.delegate("owner", id, {
    requestKey: "t",
    kind: "echo",
    payload: {},
  });
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "starting");
  assert.deepEqual(
    f.provider.calls.filter((c) => c === "start"),
    ["start"],
  );
  // Warm start: the agent re-hellos with its stored credential.
  const rotated = await f.boxes.hello(id, { protocol: 1, credential });
  assert.equal(rotated.epoch, 2);
  assert.equal((await f.row(id)).state, "ready");
});

test("a stopped box that cannot start fails its work over instead of hanging", async (t) => {
  const f = await fixture(t);
  const { id, credential } = await f.live();
  f.advance(16 * MIN);
  await f.boxes.next(id, credential, 0);
  await f.boxes.tick();
  await f.boxes.tick();
  const { taskId } = await f.boxes.delegate("owner", id, {
    requestKey: "t",
    kind: "echo",
    payload: {},
  });
  f.provider.fail.add("start");
  await f.boxes.tick();
  const row = await f.row(id);
  assert.equal(row.state, "terminating");
  assert.match(row.reason, /fresh box/);
  const task = (
    await f.db.query("SELECT state FROM box_tasks WHERE id=$1", [taskId])
  ).rows[0];
  assert.equal(task.state, "failed");
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "terminating");
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "terminated");
});

test("retention, lifetime and idle limits terminate, and termination is verified", async (t) => {
  const f = await fixture(t);
  const { id, credential } = await f.live();
  f.advance(16 * MIN);
  await f.boxes.next(id, credential, 0);
  await f.boxes.tick();
  await f.boxes.tick();
  f.advance(25 * 60 * MIN);
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "terminating");
  await f.boxes.tick();
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "terminated");
  assert.equal([...f.provider.boxes.values()][0].state, "terminated");

  const g = await fixture(t, { canStop: false });
  const b = await g.live();
  g.advance(16 * MIN);
  await g.boxes.next(b.id, b.credential, 0);
  await g.boxes.tick();
  assert.match((await g.row(b.id)).reason, /Idle time-to-live/);

  const h = await fixture(t, { hardMax: 1 });
  const c = await h.live();
  for (let i = 0; i < 7; i++) {
    h.advance(10 * MIN);
    await h.boxes.events(c.id, c.credential, {
      epoch: 1,
      events: [{ seq: i, kind: "box.state", state: "busy" }],
    });
  }
  await h.boxes.tick();
  assert.match((await h.row(c.id)).reason, /Lifetime limit/);
});

test("silent boxes are lost only after the host grace, and boxes that never connect are ended", async (t) => {
  const f = await fixture(t);
  const { id, credential } = await f.live();
  await f.boxes.next(id, credential, 0);
  await f.boxes.delegate("owner", id, {
    requestKey: "t",
    kind: "echo",
    payload: {},
  });
  f.advance(4 * MIN);
  await f.boxes.tick();
  assert.match((await f.row(id)).reason, /lost/);

  const g = await fixture(t);
  const box = await g.boxes.spawn("owner", {
    requestKey: "k",
    profile: "echo",
    subject: "s",
  });
  await g.boxes.tick();
  g.advance(11 * MIN);
  await g.boxes.tick();
  assert.match((await g.row(box.id)).reason, /never connected/);
});

test("an uncertain launch is reconciled by search and never repeated; an unresolvable one is held", async (t) => {
  const f = await fixture(t);
  const box = await f.boxes.spawn("owner", {
    requestKey: "k",
    profile: "echo",
    subject: "s",
  });
  f.provider.fail.add("launch");
  await f.boxes.tick();
  assert.equal((await f.row(box.id)).state, "launching");
  await f.boxes.tick();
  const row = await f.row(box.id);
  assert.equal(row.state, "booting");
  assert.equal(row.provider_id, "fake-1");
  assert.equal(f.provider.calls.filter((c) => c === "launch").length, 1);

  const g = await fixture(t);
  const lost = await g.boxes.spawn("owner", {
    requestKey: "k",
    profile: "echo",
    subject: "s",
  });
  g.provider.fail.add("launch");
  await g.boxes.tick();
  g.provider.boxes.clear();
  g.advance(6 * MIN);
  await g.boxes.tick();
  assert.equal((await g.row(lost.id)).state, "held");
  assert.ok(
    (
      await g.db.query(
        "SELECT 1 FROM box_notices WHERE box_id=$1 AND notice_key='held'",
        [lost.id],
      )
    ).rows.length,
  );
  assert.equal(g.provider.calls.filter((c) => c === "launch").length, 1);
});

test("the sweep terminates only resources no live box owns", async (t) => {
  const f = await fixture(t);
  const { id } = await f.live();
  const orphan = f.provider.orphan("00000000-0000-4000-8000-000000000000");
  const terminated = await f.boxes.sweep();
  assert.deepEqual(terminated, [orphan]);
  assert.equal((await f.row(id)).state, "ready");
  const live = [...f.provider.boxes.entries()].find(([, b]) => b.boxId === id)!;
  assert.equal(live[1].state, "running");
});

test("a hello without the instance's identity proof is refused before anything changes, sparing the real box", async (t) => {
  const f = await fixture(t, { identity: true });
  const box = await f.boxes.spawn("owner", {
    requestKey: "k",
    profile: "echo",
    subject: "s",
  });
  await f.boxes.tick();
  f.identityOk.value = false;
  await assert.rejects(
    f.boxes.hello(box.id, {
      protocol: 1,
      credential: f.secretOf(box.id),
      identity: {},
    }),
    BoxCredentialRefused,
  );
  const row = await f.row(box.id);
  assert.equal(row.state, "booting");
  assert.equal(row.epoch, 0);
  assert.ok(
    (
      await f.db.query(
        "SELECT 1 FROM box_notices WHERE box_id=$1 AND notice_key='alert:identity:0'",
        [box.id],
      )
    ).rows.length,
  );
  // The real box, with its proof, still completes the exchange.
  f.identityOk.value = true;
  const hello = await f.boxes.hello(box.id, {
    protocol: 1,
    credential: f.secretOf(box.id),
    identity: {},
  });
  assert.equal(hello.epoch, 1);
});

test("the HTTP channel answers 401 without detail and serves hello, next and events", async (t) => {
  const f = await fixture(t);
  const app = server();
  await boxApi(app, f.boxes);
  t.after(() => app.close());
  const box = await f.boxes.spawn("owner", {
    requestKey: "k",
    profile: "echo",
    subject: "s",
  });
  await f.boxes.tick();
  const hello = await app.inject({
    method: "POST",
    url: `/boxes/${box.id}/hello`,
    payload: { protocol: 1, credential: f.secretOf(box.id) },
  });
  assert.equal(hello.statusCode, 200);
  const credential = hello.json().credential;
  const bad = await app.inject({
    method: "GET",
    url: `/boxes/${box.id}/next?after=0`,
    headers: { authorization: "Bearer wrong-credential-value" },
  });
  assert.equal(bad.statusCode, 401);
  assert.deepEqual(bad.json(), { error: "Box credential refused" });
  const next = await app.inject({
    method: "GET",
    url: `/boxes/${box.id}/next?after=0`,
    headers: { authorization: `Bearer ${credential}` },
  });
  assert.equal(next.statusCode, 200);
  assert.deepEqual(next.json().messages, []);
  const invalid = await app.inject({
    method: "POST",
    url: `/boxes/${box.id}/events`,
    headers: { authorization: `Bearer ${credential}` },
    payload: { epoch: 1, events: [{ seq: 1, kind: "shell.exec" }] },
  });
  assert.equal(invalid.statusCode, 400);
  const notUuid = await app.inject({
    method: "POST",
    url: "/boxes/x/hello",
    payload: {},
  });
  assert.equal(notUuid.statusCode, 401);
});

test("a box acknowledging a fresh task is never stopped as idle before it reports busy", async (t) => {
  const f = await fixture(t);
  const { id, credential } = await f.live();
  f.advance(20 * MIN);
  const { taskId } = await f.boxes.delegate("owner", id, {
    requestKey: "t",
    kind: "echo",
    payload: {},
  });
  const polled = await f.boxes.next(id, credential, 0);
  await f.boxes.next(id, credential, polled.messages[0].seq);
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "ready");
  await f.boxes.events(id, credential, {
    epoch: 1,
    events: [{ seq: 1, kind: "task.result", taskId, payload: {} }],
  });
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "stopping");
});

test("no task is left open on a closed, ended or held box", async (t) => {
  const f = await fixture(t);
  const { id, credential } = await f.live();
  const first = await f.boxes.delegate("owner", id, {
    requestKey: "t1",
    kind: "echo",
    payload: {},
  });
  await f.boxes.close("owner", id);
  await assert.rejects(
    f.boxes.delegate("owner", id, {
      requestKey: "t2",
      kind: "echo",
      payload: {},
    }),
    /terminating; start a new box/,
  );
  // A retried delegate of an existing task still answers with that task.
  assert.deepEqual(
    await f.boxes.delegate("owner", id, {
      requestKey: "t1",
      kind: "echo",
      payload: {},
    }),
    first,
  );
  const states = async (box: string) =>
    (
      await f.db.query("SELECT state FROM box_tasks WHERE box_id=$1", [box])
    ).rows.map((r) => r.state);
  assert.deepEqual(await states(id), ["failed"]);
  await f.boxes.tick();
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "terminated");
  await assert.rejects(f.boxes.next(id, credential, 0), BoxCredentialRefused);

  // The provider ends a box while it is stopping.
  const g = await fixture(t);
  const b = await g.live();
  g.advance(16 * MIN);
  await g.boxes.next(b.id, b.credential, 0);
  await g.boxes.tick();
  assert.equal((await g.row(b.id)).state, "stopping");
  await g.boxes.delegate("owner", b.id, {
    requestKey: "t",
    kind: "echo",
    payload: {},
  });
  const resource = [...g.provider.boxes.values()][0];
  resource.state = "terminated";
  await g.boxes.tick();
  assert.equal((await g.row(b.id)).state, "terminating");
  assert.deepEqual(
    (
      await g.db.query("SELECT state FROM box_tasks WHERE box_id=$1", [b.id])
    ).rows.map((r) => r.state),
    ["failed"],
  );
});

test("silent boxes are spared during the host's start-up grace", async (t) => {
  const f = await fixture(t, { timings: { hostGraceMs: 10 * MIN } });
  const { id, credential } = await f.live();
  await f.boxes.next(id, credential, 0);
  f.advance(5 * MIN);
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "ready");
  f.advance(6 * MIN);
  await f.boxes.tick();
  assert.match((await f.row(id)).reason, /lost/);
});

test("a lost stop is repeated, a stuck stop escalates, and a box gone before connecting ends", async (t) => {
  const f = await fixture(t);
  const { id, credential } = await f.live();
  f.advance(16 * MIN);
  await f.boxes.next(id, credential, 0);
  f.provider.fail.add("stop");
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "stopping");
  await f.boxes.tick();
  assert.equal(f.provider.calls.filter((c) => c === "stop").length, 2);
  assert.equal((await f.row(id)).state, "stopping");
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "stopped");

  const g = await fixture(t);
  const b = await g.live();
  g.advance(16 * MIN);
  await g.boxes.next(b.id, b.credential, 0);
  (g.provider as any).stop = async () => {};
  await g.boxes.tick();
  g.advance(11 * MIN);
  await g.boxes.tick();
  assert.match((await g.row(b.id)).reason, /Stop did not complete/);

  const h = await fixture(t);
  const box = await h.boxes.spawn("owner", {
    requestKey: "k",
    profile: "echo",
    subject: "s",
  });
  await h.boxes.tick();
  h.provider.boxes.clear();
  await h.boxes.tick();
  assert.match(
    (await h.row(box.id)).reason,
    /ended the box before it connected/,
  );
});

test("running time accumulates across stop and start cycles", async (t) => {
  const f = await fixture(t);
  const { id, credential } = await f.live();
  let current = credential;
  for (let cycle = 0; cycle < 2; cycle++) {
    f.advance(16 * MIN);
    await f.boxes.next(id, current, 0);
    await f.boxes.tick();
    await f.boxes.tick();
    assert.equal((await f.row(id)).state, "stopped");
    f.advance(60 * MIN);
    await f.boxes.delegate("owner", id, {
      requestKey: `t${cycle}`,
      kind: "echo",
      payload: {},
    });
    await f.boxes.tick();
    current = (await f.boxes.hello(id, { protocol: 1, credential: current }))
      .credential;
    const polled = await f.boxes.next(id, current, 0);
    const taskId = polled.messages.at(-1)!.payload.taskId;
    await f.boxes.events(id, current, {
      epoch: (await f.row(id)).epoch,
      events: [{ seq: 1, kind: "task.result", taskId, payload: {} }],
    });
    await f.boxes.next(id, current, polled.messages.at(-1)!.seq);
  }
  assert.equal(Number((await f.row(id)).running_ms), 32 * MIN);
});

test("rotation chains retire every predecessor, and the bootstrap secret is recognised for life", async (t) => {
  const f = await fixture(t);
  const { id, credential } = await f.live();
  const secret = f.secretOf(id);
  let current = credential;
  const seen = [current];
  for (let i = 0; i < 10; i++) {
    // Presenting the still-unused replacement to hello is its first use.
    current = (await f.boxes.hello(id, { protocol: 1, credential: current }))
      .credential;
    seen.push(current);
  }
  await f.boxes.next(id, current, 0);
  assert.equal((await f.row(id)).epoch, 11);
  await assert.rejects(
    f.boxes.hello(id, { protocol: 1, credential: secret }),
    BoxCredentialRefused,
  );
  assert.ok(
    (
      await f.db.query(
        "SELECT 1 FROM box_notices WHERE box_id=$1 AND notice_key LIKE 'alert:retired-hello:%'",
        [id],
      )
    ).rows.length,
  );
  assert.equal((await f.row(id)).state, "ready");
  await assert.rejects(f.boxes.next(id, secret, 0), BoxCredentialRefused);
  assert.match((await f.row(id)).reason, /Compromised/);
});

test("the predecessor is refused on events without alarm, and future epochs are rejected", async (t) => {
  const f = await fixture(t);
  const { id, credential: c1 } = await f.live();
  await f.boxes.next(id, c1, 0);
  const c2 = (await f.boxes.hello(id, { protocol: 1, credential: c1 }))
    .credential;
  await assert.rejects(
    f.boxes.events(id, c1, {
      epoch: 1,
      events: [{ seq: 1, kind: "box.state", state: "busy" }],
    }),
    BoxCredentialRefused,
  );
  assert.equal((await f.row(id)).state, "ready");
  await assert.rejects(
    f.boxes.events(id, c2, {
      epoch: 3,
      events: [{ seq: 1, kind: "box.state", state: "busy" }],
    }),
    /Unknown epoch/,
  );
});

test("the sweep spares held, launching and other-environment resources and ends duplicates", async (t) => {
  const f = await fixture(t);
  const { id } = await f.live();
  const duplicate = f.provider.orphan(id);
  const foreign = f.provider.orphan(
    "00000000-0000-4000-8000-000000000001",
    "prod",
  );
  const launching = await f.boxes.spawn("owner", {
    requestKey: "l",
    profile: "echo",
    subject: "l",
  });
  f.provider.fail.add("launch");
  await f.boxes.tick();
  assert.equal((await f.row(launching.id)).state, "launching");
  const held = await f.boxes.spawn("owner", {
    requestKey: "h",
    profile: "echo",
    subject: "h",
  });
  await f.db.query("UPDATE boxes SET state='held' WHERE id=$1", [held.id]);
  const heldResource = f.provider.orphan(held.id);
  const terminated = await f.boxes.sweep();
  assert.deepEqual(terminated, [duplicate]);
  assert.equal(f.provider.boxes.get(foreign)!.state, "running");
  assert.equal(f.provider.boxes.get(heldResource)!.state, "running");
});

test("closing during an uncertain launch finds and ends the resource", async (t) => {
  const f = await fixture(t);
  const box = await f.boxes.spawn("owner", {
    requestKey: "k",
    profile: "echo",
    subject: "s",
  });
  f.provider.fail.add("launch");
  await f.boxes.tick();
  await f.boxes.close("owner", box.id);
  await f.boxes.tick();
  await f.boxes.tick();
  await f.boxes.tick();
  assert.equal((await f.row(box.id)).state, "terminated");
  assert.equal([...f.provider.boxes.values()][0].state, "terminated");
});

test("a long-poll returns as soon as a message arrives", async (t) => {
  const f = await fixture(t, { timings: { pollMs: 5000 } });
  const { id, credential } = await f.live();
  const started = Date.now();
  const polling = f.boxes.next(id, credential, 0);
  setTimeout(() => {
    void f.boxes.delegate("owner", id, {
      requestKey: "t",
      kind: "echo",
      payload: {},
    });
  }, 300);
  const result = await polling;
  assert.equal(result.messages.length, 1);
  assert.ok(Date.now() - started < 3000);
  const app = server();
  await boxApi(app, f.boxes);
  t.after(() => app.close());
  const missing = await app.inject({
    method: "GET",
    url: `/boxes/${id}/next?after=0`,
  });
  assert.equal(missing.statusCode, 401);
});

test("a task acknowledged just before a stop restarts the box", async (t) => {
  const f = await fixture(t);
  const { id, credential } = await f.live();
  f.advance(16 * MIN);
  await f.boxes.next(id, credential, 0);
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "stopping");
  await f.boxes.delegate("owner", id, {
    requestKey: "t",
    kind: "echo",
    payload: {},
  });
  const polled = await f.boxes.next(id, credential, 0);
  await f.boxes.next(id, credential, polled.messages[0].seq);
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "stopped");
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "starting");
});

test("identity checks and their alerts are reachable only with a live credential", async (t) => {
  const f = await fixture(t, { identity: true });
  const box = await f.boxes.spawn("owner", {
    requestKey: "k",
    profile: "echo",
    subject: "s",
  });
  await f.boxes.tick();
  f.identityOk.value = false;
  await assert.rejects(
    f.boxes.hello(box.id, {
      protocol: 1,
      credential: "y".repeat(43),
      identity: {},
    }),
    BoxCredentialRefused,
  );
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM box_notices WHERE box_id=$1",
        [box.id],
      )
    ).rows[0].n,
    0,
  );
});

test("a retried hello after a lost rotation answer still connects a warm-starting box", async (t) => {
  const f = await fixture(t);
  const { id, credential: c1 } = await f.live();
  await f.boxes.next(id, c1, 0);
  // The rotation to epoch 2 is recorded, but its answer never reaches the box.
  const c2 = (await f.boxes.hello(id, { protocol: 1, credential: c1 }))
    .credential;
  f.advance(16 * MIN);
  await f.db.query("UPDATE boxes SET seen_at=$2 WHERE id=$1", [
    id,
    new Date("2026-10-20T00:16:00Z"),
  ]);
  await f.boxes.tick();
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "stopped");
  await f.boxes.delegate("owner", id, {
    requestKey: "t",
    kind: "echo",
    payload: {},
  });
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "starting");
  const retried = await f.boxes.hello(id, { protocol: 1, credential: c1 });
  assert.equal(retried.credential, c2);
  assert.equal((await f.row(id)).state, "ready");
});

test("a box that connected while marked starting is repaired to ready", async (t) => {
  const f = await fixture(t);
  const { id, credential } = await f.live();
  await f.db.query(
    "UPDATE boxes SET state='starting',running_since=$2 WHERE id=$1",
    [id, new Date("2026-10-19T23:59:00Z")],
  );
  await f.boxes.next(id, credential, 0);
  await f.boxes.tick();
  assert.equal((await f.row(id)).state, "ready");
});

test("removing a profile ends its boxes; removing a provider holds them; the sweep covers every provider", async (t) => {
  const f = await fixture(t);
  const { id } = await f.live();
  const orphan = f.provider.orphan("00000000-0000-4000-8000-000000000002");
  const withoutProfile = new BoxController(
    f.db,
    { environment: "test", profiles: {} },
    { fake: f.provider },
    "b".repeat(64),
    "https://companion.example.com",
    () => new Date("2026-10-20T00:00:00Z"),
    { hostGraceMs: 0 },
  );
  await withoutProfile.tick();
  assert.match((await f.row(id)).reason, /profile is no longer configured/);
  await withoutProfile.tick();
  await withoutProfile.tick();
  assert.equal((await f.row(id)).state, "terminated");
  assert.equal(f.provider.boxes.get(orphan)!.state, "terminated");

  const g = await fixture(t);
  const b = await g.live();
  const withoutProvider = new BoxController(
    g.db,
    { environment: "test", profiles: {} },
    {},
    "b".repeat(64),
    "https://companion.example.com",
  );
  await withoutProvider.tick();
  const held = await g.row(b.id);
  assert.equal(held.state, "held");
  assert.match(held.reason, /provider is no longer configured/);
});

test("an empty long-poll over HTTP waits for the poll interval", async (t) => {
  const f = await fixture(t, { timings: { pollMs: 700 } });
  const { id, credential } = await f.live();
  const app = server();
  await boxApi(app, f.boxes);
  await app.listen({ port: 0, host: "127.0.0.1" });
  t.after(() => app.close());
  const { port } = app.server.address() as { port: number };
  const started = Date.now();
  const response = await fetch(
    `http://127.0.0.1:${port}/boxes/${id}/next?after=0`,
    {
      headers: { authorization: `Bearer ${credential}` },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).messages, []);
  assert.ok(Date.now() - started >= 600, "the poll waited");
});

test("stale busy reports from an earlier epoch are recorded but not applied", async (t) => {
  const f = await fixture(t);
  const { id, credential: c1 } = await f.live();
  await f.boxes.next(id, c1, 0);
  const c2 = (await f.boxes.hello(id, { protocol: 1, credential: c1 }))
    .credential;
  await f.boxes.events(id, c2, {
    epoch: 1,
    events: [{ seq: 9, kind: "box.state", state: "busy" }],
  });
  assert.equal((await f.row(id)).state, "ready");
  await f.boxes.events(id, c2, {
    epoch: 2,
    events: [{ seq: 1, kind: "box.state", state: "busy" }],
  });
  assert.equal((await f.row(id)).state, "busy");
});
