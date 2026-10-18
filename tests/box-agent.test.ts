import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { BoxController } from "../src/boxes/controller.js";
import { LocalProcessProvider } from "../src/boxes/local-provider.js";
import { BoxAgent, StateStore, type TaskRunner } from "../src/boxes/agent.js";
import { boxApi } from "../src/boxes/api.js";
import { server } from "../src/server.js";

const MIN = 60_000;
const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = join(root, "node_modules/tsx/dist/loader.mjs");
const agentMain = join(root, "src/boxes/agent-main.ts");
const echoTask = join(root, "src/boxes/echo-task.ts");
const image = `ghcr.io/example/box@sha256:${"a".repeat(64)}`;

async function until<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  ms = 30_000,
) {
  const end = Date.now() + ms;
  let value = await read();
  while (!ok(value)) {
    if (Date.now() > end)
      throw new Error(`Timed out; last value ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 100));
    value = await read();
  }
  return value;
}

test("the state store writes durably and privately", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "box-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(join(dir, "state"));
  store.write("credential", "one");
  store.write("credential", "two");
  assert.equal(store.read("credential"), "two");
  assert.equal(
    (await stat(join(dir, "state", "credential"))).mode & 0o777,
    0o600,
  );
  assert.equal((await stat(join(dir, "state"))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(dir, "state")), ["credential"]);
  assert.deepEqual(store.json("missing", { a: 1 }), { a: 1 });
});

test("an agent whose credential is refused ends its box instead of retrying", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "box-agent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: string[] = [];
  let ended = "";
  const agent = new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    bootstrap: "s".repeat(43),
    store: new StateStore(dir),
    runner: {} as TaskRunner,
    shutdown: (reason) => {
      ended = reason;
    },
    fetch: (async (url: string) => {
      calls.push(url);
      return new Response("{}", { status: 401 });
    }) as typeof fetch,
    retryMs: 1,
  });
  await agent.run();
  assert.match(ended, /refused/);
  assert.equal(calls.length, 1);
  assert.equal(new StateStore(dir).read("credential"), undefined);

  // With no stored credential and no bootstrap secret, the box ends at once.
  let empty = "";
  await new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    store: new StateStore(join(dir, "empty")),
    runner: {} as TaskRunner,
    shutdown: (reason) => {
      empty = reason;
    },
  }).run();
  assert.match(empty, /No box credential/);
});

test("a hello retried after a lost response stores the same credential and never overlaps", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "box-agent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let inFlight = 0;
  let maxInFlight = 0;
  let attempts = 0;
  const agent = new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    bootstrap: "s".repeat(43),
    store: new StateStore(dir),
    runner: {} as TaskRunner,
    shutdown: () => {},
    fetch: (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (++attempts < 3) throw new Error("connection reset");
      return Response.json({
        credential: "c".repeat(43),
        epoch: 1,
        remainingMs: 1,
      });
    }) as typeof fetch,
    retryMs: 1,
  });
  await agent.connect();
  assert.equal(attempts, 3);
  assert.equal(maxInFlight, 1);
  assert.equal(new StateStore(dir).read("credential"), "c".repeat(43));
});

async function harness(t: TestContext) {
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
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const dir = await mkdtemp(join(tmpdir(), "boxes-e2e-"));
  const provider = new LocalProcessProvider(
    join(dir, "boxes"),
    [process.execPath, "--import", tsx, agentMain],
    {
      CHIEF_BOX_RUNNER: "process",
      ...(process.env.CHIEF_BOX_DEBUG ? { CHIEF_BOX_DEBUG: "1" } : {}),
      CHIEF_BOX_TASK_COMMAND: JSON.stringify([
        process.execPath,
        "--import",
        tsx,
        echoTask,
      ]),
    },
  );
  const app = server();
  let boxes!: BoxController;
  await boxApi(
    app,
    new Proxy({} as BoxController, {
      get: (_, key) => (boxes as any)[key].bind(boxes),
    }),
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as { port: number };
  boxes = new BoxController(
    db,
    {
      environment: "test",
      profiles: {
        echo: {
          provider: "local",
          image,
          idleTtlMinutes: 15,
          retentionHours: 24,
          hardMaxHours: 24,
          absoluteDays: 7,
          concurrency: 2,
        },
      },
    },
    { local: provider },
    "b".repeat(64),
    `http://127.0.0.1:${address.port}`,
    clock,
    { pollMs: 400 },
    async () => true,
  );
  t.after(async () => {
    await provider.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const row = async (id: string) =>
    (await db.query("SELECT * FROM boxes WHERE id=$1", [id])).rows[0];
  const task = async (id: string) =>
    (await db.query("SELECT state,result FROM box_tasks WHERE id=$1", [id]))
      .rows[0];
  return {
    db,
    boxes,
    provider,
    dir,
    row,
    task,
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

test("end to end: a real agent runs tasks, is steered, stops warm, resumes and closes", async (t) => {
  const h = await harness(t);
  const box = await h.boxes.spawn("owner", {
    requestKey: "e2e",
    profile: "echo",
    subject: "test:e2e",
  });
  await h.boxes.tick();
  await until(
    () => h.row(box.id),
    (r) => r.state === "ready",
  );
  assert.equal((await h.row(box.id)).epoch, 1);

  // Two tasks in one box, one after the other; the second waits for the owner.
  const one = await h.boxes.delegate("owner", box.id, {
    requestKey: "one",
    kind: "echo",
    payload: { text: "first" },
  });
  const two = await h.boxes.delegate("owner", box.id, {
    requestKey: "two",
    kind: "echo",
    payload: { waitForMessage: true, text: "second" },
  });
  const first = await until(
    () => h.task(one.taskId),
    (r) => r.state === "done",
  ).catch(async (error) => {
    console.log(
      "DEBUG",
      JSON.stringify(
        (
          await h.db.query(
            "SELECT epoch,seq,kind,task_id,payload FROM box_events ORDER BY epoch,seq",
          )
        ).rows,
      ),
    );
    throw error;
  });
  assert.deepEqual(first.result, { echo: "first", messages: [] });
  await until(
    async () =>
      (
        await h.db.query(
          "SELECT 1 FROM box_events WHERE box_id=$1 AND kind='task.question' AND task_id=$2",
          [box.id, two.taskId],
        )
      ).rows.length,
    (n) => n > 0,
  );
  await h.boxes.send("owner", "run-1", box.id, {
    requestKey: "answer",
    taskId: two.taskId,
    text: "an answer",
    ownerInputId: "input-1",
  });
  const second = await until(
    () => h.task(two.taskId),
    (r) => r.state === "done",
  );
  assert.deepEqual(second.result, { echo: "second", messages: ["an answer"] });

  // Idle for the TTL: the box stops with its disk kept.
  await until(
    () => h.row(box.id),
    (r) => r.state === "ready",
  );
  h.advance(16 * MIN);
  const polledAfter = new Date(Date.now() + 16 * MIN);
  await until(
    () => h.row(box.id),
    (r) => new Date(r.seen_at) >= polledAfter,
  );
  await h.boxes.tick();
  assert.equal((await h.row(box.id)).state, "stopping");
  await until(
    async () => {
      await h.boxes.tick();
      return (await h.row(box.id)).state;
    },
    (s) => s === "stopped",
  );
  const stored = join(h.dir, "boxes", box.id, "state", "credential");
  const before = await readFile(stored, "utf8");

  // New work starts the stopped box; the agent resumes with its stored credential.
  const three = await h.boxes.delegate("owner", box.id, {
    requestKey: "three",
    kind: "echo",
    payload: { text: "after a warm start" },
  });
  await h.boxes.tick();
  assert.equal((await h.row(box.id)).state, "starting");
  const third = await until(
    () => h.task(three.taskId),
    (r) => r.state === "done",
  );
  assert.deepEqual(third.result, { echo: "after a warm start", messages: [] });
  assert.equal((await h.row(box.id)).epoch, 2);
  assert.notEqual(await readFile(stored, "utf8"), before);

  // Closing ends the agent and is verified.
  await h.boxes.close("owner", box.id);
  await until(
    async () => {
      await h.boxes.tick();
      return (await h.row(box.id)).state;
    },
    (s) => s === "terminated",
  );
  assert.equal(await h.provider.describe(box.id), "terminated");
});
