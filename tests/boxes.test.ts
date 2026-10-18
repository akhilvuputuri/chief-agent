import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import {
  BoxController,
  BoxCredentialRefused,
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
  const inputs = new Set<string>(["input-1"]);
  const boxes = new BoxController(
    db,
    config,
    { fake: provider },
    "b".repeat(64),
    "https://companion.example.com",
    () => now,
    { pollMs: 0, hostGraceMs: 0 },
    async (user, inputId) => user === "owner" && inputs.has(inputId),
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
    f.boxes.send("owner", id, {
      requestKey: "m",
      taskId,
      text: "go",
      ownerInputId: "forged",
    }),
    /owner's own message/,
  );
  await f.boxes.send("owner", id, {
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

test("a box whose identity cannot be verified is refused and terminated", async (t) => {
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
  assert.match((await f.row(box.id)).reason, /identity/);
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
