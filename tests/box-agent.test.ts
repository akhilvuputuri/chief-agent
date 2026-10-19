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
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  BoxAgent,
  lineProtocol,
  ProcessRunner,
  StateStore,
  type TaskOutcome,
  type TaskRunner,
} from "../src/boxes/agent.js";
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

/** A scripted host for agent-only tests: records every request and answers from a plan. */
function stubHost(plan: {
  next?: (n: number) => Response | Promise<Response> | "throw";
  events?: (body: any) => number;
  hello?: () => Response;
}) {
  const calls: { path: string; body?: any }[] = [];
  let polls = 0;
  const fetch = (async (url: string, init: any = {}) => {
    const path = new URL(url).pathname.split("/").pop()!;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    if (path === "hello")
      return (
        plan.hello?.() ??
        Response.json({
          credential: "c".repeat(43),
          epoch: 1,
          remainingMs: 3_600_000,
        })
      );
    if (path === "events")
      return new Response("{}", { status: plan.events?.(body) ?? 200 });
    const answer =
      plan.next?.(polls++) ?? Response.json({ messages: [], remainingMs: 0 });
    if (answer === "throw") throw new Error("network down");
    await new Promise((r) => setTimeout(r, 5));
    return answer;
  }) as typeof fetch;
  return { fetch, calls };
}

const taskId = "11111111-1111-4111-8111-111111111111";
const assign = (seq: number, id = taskId, payload: object = {}) =>
  Response.json({
    messages: [
      {
        seq,
        kind: "task.assign",
        payload: { taskId: id, kind: "echo", payload },
      },
    ],
    remainingMs: 3_600_000,
  });

function scriptedRunner(outcome: TaskOutcome, reset?: () => Promise<void>) {
  const started: string[] = [];
  const runner: TaskRunner = {
    start: (task) => {
      started.push(task.id);
      return {
        send: () => {},
        cancel: () => {},
        done: Promise.resolve(outcome),
      };
    },
    reset: reset ?? (async () => {}),
  };
  return { runner, started };
}

async function agentDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "box-agent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a message after a task's result never crashes the agent, and a lingering task is killed", async (t) => {
  const dir = await agentDir(t);
  const lingering = join(dir, "linger.mjs");
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(
      lingering,
      'process.stdin.once("data", () => { console.log(JSON.stringify({ type: "result", payload: { ok: true } })); setInterval(() => {}, 1000); });',
    ),
  );
  const runner = new ProcessRunner(
    [process.execPath, lingering],
    join(dir, "work"),
    {
      deadlineMs: 60_000,
      graceMs: 200,
    },
  );
  const running = runner.start(
    { id: taskId, kind: "echo", payload: {} },
    () => {},
  );
  // Owner messages keep arriving through the moment the task's input is closed.
  const spam = setInterval(() => running.send("a late answer"), 0);
  const started = Date.now();
  const outcome = await running.done;
  clearInterval(spam);
  assert.deepEqual(outcome, { type: "result", payload: { ok: true } });
  assert.ok(Date.now() - started < 5000, "killed after the grace period");
});

test("unbounded or malformed results become failures, and a rejected result is replaced", async (t) => {
  const dir = await agentDir(t);
  const script = join(dir, "bad.mjs");
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(
      script,
      'process.stdin.once("data", () => console.log(JSON.stringify({ type: "result", payload: "not an object" })));',
    ),
  );
  const runner = new ProcessRunner(
    [process.execPath, script],
    join(dir, "work"),
  );
  const outcome = await runner.start(
    { id: taskId, kind: "echo", payload: {} },
    () => {},
  ).done;
  assert.equal(outcome.type, "failed");
  assert.match(String(outcome.payload.error), /bounded JSON object/);

  // The host rejects the result: the agent replaces it with a bounded failure.
  const host = stubHost({
    next: (n) =>
      n === 0
        ? assign(1)
        : Response.json({ messages: [], remainingMs: n > 3 ? 0 : 3_600_000 }),
    events: (body) => (body.events[0].kind === "task.result" ? 400 : 200),
  });
  const { runner: scripted } = scriptedRunner({
    type: "result",
    payload: { big: true },
  });
  await new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    bootstrap: "s".repeat(43),
    store: new StateStore(join(dir, "state")),
    runner: scripted,
    shutdown: () => {},
    fetch: host.fetch,
    retryMs: 1,
  }).run();
  const kinds = host.calls
    .filter((c) => c.path === "events")
    .map((c) => c.body.events[0]);
  const result = kinds.findIndex((e) => e.kind === "task.result");
  assert.ok(result >= 0);
  assert.equal(kinds[result + 1].kind, "task.failed");
  assert.match(kinds[result + 1].payload.error, /rejected/);
  assert.ok(kinds[result + 1].seq > kinds[result].seq);
});

test("a reset that fails ends the box, even during restart recovery", async (t) => {
  const dir = await agentDir(t);
  const store = new StateStore(dir);
  store.write("credential", "c".repeat(43));
  store.write(
    "tasks",
    JSON.stringify({
      [taskId]: { state: "running", kind: "echo", payload: {} },
    }),
  );
  let ended = "";
  const { runner } = scriptedRunner(
    { type: "result", payload: {} },
    async () => {
      throw new Error("container survived");
    },
  );
  await new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    store,
    runner,
    shutdown: (reason) => {
      ended = reason;
    },
    fetch: stubHost({}).fetch,
    retryMs: 1,
  }).run();
  assert.match(ended, /left state behind/);
});

test("after a restart, running tasks fail honestly and acknowledged tasks still run", async (t) => {
  const dir = await agentDir(t);
  const store = new StateStore(dir);
  const queued = "22222222-2222-4222-8222-222222222222";
  store.write("credential", "c".repeat(43));
  store.write(
    "tasks",
    JSON.stringify({
      [taskId]: { state: "running", kind: "echo", payload: {} },
      [queued]: {
        state: "queued",
        kind: "echo",
        payload: { text: "still runs" },
      },
    }),
  );
  const host = stubHost({
    next: (n) =>
      Response.json({ messages: [], remainingMs: n > 2 ? 0 : 3_600_000 }),
  });
  const { runner, started } = scriptedRunner({
    type: "result",
    payload: { done: true },
  });
  await new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    store,
    runner,
    shutdown: () => {},
    fetch: host.fetch,
    retryMs: 1,
  }).run();
  assert.deepEqual(started, [queued]);
  const events = host.calls
    .filter((c) => c.path === "events")
    .map((c) => c.body.events[0]);
  assert.ok(
    events.some((e) => e.kind === "task.failed" && e.taskId === taskId),
  );
  assert.ok(
    events.some((e) => e.kind === "task.result" && e.taskId === queued),
  );
});

test("the agent enforces its lifetime and ends when the host stays unreachable", async (t) => {
  const dir = await agentDir(t);
  let ended = "";
  await new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    bootstrap: "s".repeat(43),
    store: new StateStore(join(dir, "a")),
    runner: scriptedRunner({ type: "result", payload: {} }).runner,
    shutdown: (reason) => {
      ended = reason;
    },
    fetch: stubHost({
      hello: () =>
        Response.json({
          credential: "c".repeat(43),
          epoch: 1,
          remainingMs: 50,
        }),
      next: () => "throw",
    }).fetch,
    retryMs: 5,
    watchMs: 10,
  }).run();
  assert.match(ended, /lifetime/);

  let silent = "";
  await new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    bootstrap: "s".repeat(43),
    store: new StateStore(join(dir, "b")),
    runner: scriptedRunner({ type: "result", payload: {} }).runner,
    shutdown: (reason) => {
      silent = reason;
    },
    fetch: stubHost({ next: () => "throw" }).fetch,
    retryMs: 5,
    watchMs: 10,
    maxSilentMs: 50,
  }).run();
  assert.match(silent, /unreachable/);
});

test("a not-yet-recorded box keeps retrying hello on 503, and malformed task IDs are ignored", async (t) => {
  const dir = await agentDir(t);
  let hellos = 0;
  const host = stubHost({
    hello: () =>
      ++hellos < 3
        ? new Response("{}", { status: 503 })
        : Response.json({
            credential: "c".repeat(43),
            epoch: 1,
            remainingMs: 3_600_000,
          }),
    next: (n) =>
      n === 0
        ? Response.json({
            messages: [
              {
                seq: 1,
                kind: "task.assign",
                payload: { taskId: "../escape", kind: "echo" },
              },
            ],
            remainingMs: 3_600_000,
          })
        : Response.json({ messages: [], remainingMs: 0 }),
  });
  const { runner, started } = scriptedRunner({ type: "result", payload: {} });
  let ended = "";
  await new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    bootstrap: "s".repeat(43),
    store: new StateStore(dir),
    runner,
    shutdown: (reason) => {
      ended = reason;
    },
    fetch: host.fetch,
    retryMs: 1,
  }).run();
  assert.equal(hellos, 3);
  assert.deepEqual(started, []);
  assert.match(ended, /lifetime/);
});

test("writing to a task whose input has ended is dropped, not an unhandled stream error", async () => {
  const stdout = new PassThrough();
  const written: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      written.push(String(chunk));
      // Stay open long enough that `end()` has been called but the stream is not destroyed.
      setTimeout(callback, 50);
    },
  });
  const child = Object.assign(new EventEmitter(), { stdin, stdout }) as any;
  let killed = 0;
  const running = lineProtocol(
    child,
    { id: taskId, kind: "echo", payload: {} },
    () => {},
    () => {
      killed++;
    },
    { deadlineMs: 60_000, graceMs: 20 },
  );
  stdout.write(
    `${JSON.stringify({ type: "result", payload: { ok: true } })}\n`,
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(stdin.writableEnded, true);
  assert.equal(stdin.destroyed, false);
  running.send("a late answer");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(written.length, 1);
  assert.equal(killed, 1);
  child.emit("close", 0);
  assert.deepEqual(await running.done, {
    type: "result",
    payload: { ok: true },
  });
});

test("a final result line without a trailing newline still counts", async () => {
  const stdout = new PassThrough();
  const stdin = new Writable({ write: (_c, _e, cb) => cb() });
  const child = Object.assign(new EventEmitter(), { stdin, stdout }) as any;
  const running = lineProtocol(
    child,
    { id: taskId, kind: "echo", payload: {} },
    () => {},
    () => {},
    { deadlineMs: 60_000, graceMs: 1000 },
  );
  stdout.end(JSON.stringify({ type: "result", payload: { last: true } }));
  await new Promise((r) => setImmediate(r));
  child.emit("close", 0);
  assert.deepEqual(await running.done, {
    type: "result",
    payload: { last: true },
  });
});

test("questions asked in quick succession are delayed in order, never dropped", async (t) => {
  const dir = await agentDir(t);
  const host = stubHost({
    next: (n) =>
      n === 0
        ? assign(1)
        : new Promise<Response>((resolve) =>
            setTimeout(
              () =>
                resolve(
                  Response.json({
                    messages: [],
                    remainingMs: n > 40 ? 0 : 3_600_000,
                  }),
                ),
              100,
            ),
          ),
  });
  const runner: TaskRunner = {
    start: (task, onOutput) => {
      onOutput({ type: "question", payload: { n: 1 } });
      onOutput({ type: "question", payload: { n: 2 } });
      onOutput({ type: "question", payload: { n: 3 } });
      onOutput({ type: "progress", payload: { dropped: true } });
      onOutput({ type: "progress", payload: { dropped: true } });
      return {
        send: () => {},
        cancel: () => {},
        done: new Promise((r) =>
          setTimeout(() => r({ type: "result", payload: { ok: true } }), 2500),
        ),
      };
    },
    reset: async () => {},
  };
  await new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    bootstrap: "s".repeat(43),
    store: new StateStore(dir),
    runner,
    shutdown: () => {},
    fetch: host.fetch,
    retryMs: 1,
  }).run();
  const sent = host.calls
    .filter((c) => c.path === "events")
    .map((c) => c.body.events[0]);
  assert.deepEqual(
    sent.filter((e) => e.kind === "task.question").map((e) => e.payload.n),
    [1, 2, 3],
  );
  assert.equal(sent.filter((e) => e.kind === "task.progress").length, 1);
});

test("restart recovery re-reports a recorded outcome and completes an interrupted cleanup", async (t) => {
  const dir = await agentDir(t);
  const store = new StateStore(dir);
  const reported = "33333333-3333-4333-8333-333333333333";
  store.write("credential", "c".repeat(43));
  store.write(
    "tasks",
    JSON.stringify({
      [taskId]: {
        state: "finished",
        outcome: { type: "result", payload: { real: "answer" } },
      },
      [reported]: { state: "reported" },
    }),
  );
  const resets: string[] = [];
  const { runner, started } = scriptedRunner(
    { type: "result", payload: {} },
    async () => {},
  );
  runner.reset = async (id) => {
    resets.push(id);
  };
  const host = stubHost({});
  await new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    store,
    runner,
    shutdown: () => {},
    fetch: host.fetch,
    retryMs: 1,
  }).run();
  const events = host.calls
    .filter((c) => c.path === "events")
    .map((c) => c.body.events[0]);
  assert.deepEqual(
    events
      .filter((e) => e.kind === "task.result")
      .map((e) => [e.taskId, e.payload]),
    [[taskId, { real: "answer" }]],
  );
  assert.deepEqual(resets.sort(), [taskId, reported].sort());
  assert.deepEqual(started, []);
  const journal = store.json<Record<string, { state: string }>>("tasks", {});
  assert.deepEqual(
    Object.values(journal).map((e) => e.state),
    ["done", "done"],
  );
});

test("oversized instructions are refused, never run as an empty task", async (t) => {
  const dir = await agentDir(t);
  const host = stubHost({
    next: (n) =>
      n === 0
        ? assign(1, taskId, { brief: "x".repeat(70_000) })
        : Response.json({ messages: [], remainingMs: n > 3 ? 0 : 3_600_000 }),
  });
  const { runner, started } = scriptedRunner({ type: "result", payload: {} });
  await new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    bootstrap: "s".repeat(43),
    store: new StateStore(dir),
    runner,
    shutdown: () => {},
    fetch: host.fetch,
    retryMs: 1,
  }).run();
  assert.deepEqual(started, []);
  const failed = host.calls
    .filter((c) => c.path === "events")
    .map((c) => c.body.events[0])
    .find((e) => e.kind === "task.failed");
  assert.match(failed.payload.error, /exceed the box payload limit/);
});

test("questions queued for a task that has finished are discarded", async (t) => {
  const dir = await agentDir(t);
  const host = stubHost({
    next: (n) =>
      n === 0
        ? assign(1)
        : new Promise<Response>((resolve) =>
            setTimeout(
              () =>
                resolve(
                  Response.json({
                    messages: [],
                    remainingMs: n > 25 ? 0 : 3_600_000,
                  }),
                ),
              100,
            ),
          ),
  });
  const runner: TaskRunner = {
    start: (_task, onOutput) => {
      onOutput({ type: "question", payload: { n: 1 } });
      onOutput({ type: "question", payload: { n: 2 } });
      return {
        send: () => {},
        cancel: () => {},
        done: Promise.resolve({
          type: "result" as const,
          payload: { ok: true },
        }),
      };
    },
    reset: async () => {},
  };
  await new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    bootstrap: "s".repeat(43),
    store: new StateStore(dir),
    runner,
    shutdown: () => {},
    fetch: host.fetch,
    retryMs: 1,
  }).run();
  const sent = host.calls
    .filter((c) => c.path === "events")
    .map((c) => c.body.events[0]);
  assert.deepEqual(
    sent.filter((e) => e.kind === "task.question").map((e) => e.payload.n),
    [1],
  );
  const result = sent.findIndex((e) => e.kind === "task.result");
  assert.ok(sent.slice(result).every((e) => e.kind !== "task.question"));
});

test("a refused task stays refused across a restart", async (t) => {
  const dir = await agentDir(t);
  const store = new StateStore(dir);
  // Acknowledged and refused, then the agent restarted before reporting it.
  const first = stubHost({
    next: () =>
      Response.json({
        messages: [
          {
            seq: 1,
            kind: "task.assign",
            payload: {
              taskId,
              kind: "echo",
              payload: { brief: "x".repeat(70_000) },
            },
          },
        ],
        remainingMs: 3_600_000,
      }),
  });
  const agent = new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    bootstrap: "s".repeat(43),
    store,
    runner: scriptedRunner({ type: "result", payload: {} }).runner,
    shutdown: () => {},
    fetch: first.fetch,
    retryMs: 1,
  });
  (agent as any).handle({
    seq: 1,
    kind: "task.assign",
    payload: { taskId, kind: "echo", payload: { brief: "x".repeat(70_000) } },
  });
  assert.equal(store.json<any>("tasks", {})[taskId].state, "finished");
  const { runner, started } = scriptedRunner({ type: "result", payload: {} });
  const host = stubHost({});
  await new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    store: (() => {
      store.write("credential", "c".repeat(43));
      return store;
    })(),
    runner,
    shutdown: () => {},
    fetch: host.fetch,
    retryMs: 1,
  }).run();
  assert.deepEqual(started, []);
  const failed = host.calls
    .filter((c) => c.path === "events")
    .map((c) => c.body.events[0])
    .find((e) => e.kind === "task.failed");
  assert.match(failed.payload.error, /exceed the box payload limit/);
});

test("a task flooding questions is stopped once, with a reason the owner can read", async (t) => {
  const dir = await agentDir(t);
  const host = stubHost({
    next: (n) =>
      n === 0
        ? assign(1)
        : Response.json({ messages: [], remainingMs: n > 5 ? 0 : 3_600_000 }),
  });
  let cancels = 0;
  let finish!: (o: TaskOutcome) => void;
  const runner: TaskRunner = {
    start: (_task, onOutput) => {
      for (let i = 0; i < 40; i++)
        onOutput({ type: "question", payload: { i } });
      return {
        send: () => {},
        cancel: () => {
          cancels++;
          finish({
            type: "failed",
            payload: { error: "Task exited without a result (code null)" },
          });
        },
        done: new Promise<TaskOutcome>((r) => (finish = r)),
      };
    },
    reset: async () => {},
  };
  await new BoxAgent({
    origin: "https://host.example",
    boxId: "00000000-0000-4000-8000-000000000000",
    bootstrap: "s".repeat(43),
    store: new StateStore(dir),
    runner,
    shutdown: () => {},
    fetch: host.fetch,
    retryMs: 1,
  }).run();
  assert.equal(cancels, 1);
  const failed = host.calls
    .filter((c) => c.path === "events")
    .map((c) => c.body.events[0])
    .find((e) => e.kind === "task.failed");
  assert.match(failed.payload.error, /more than 20 questions without answers/);
});
