import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  NativePiWorkerClient,
  WorkerRequestError,
  hostUnreachable,
  workerExitCode,
} from "../src/coding/pi-worker.js";
import { BoxSandbox } from "../src/coding/box-sandbox.js";
import { fixture } from "./helpers/coding-fixture.js";

const quick = { windowMs: 2000, maxDelayMs: 5 };
const close = (server: Server) =>
  new Promise((resolve) => server.close(resolve));

async function host(t: any, statuses: number[]) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      res.statusCode = statuses.shift() ?? 200;
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => close(server));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, seen };
}

test("a worker request rides out a restart and repeats the same body", async (t) => {
  const { origin, seen } = await host(t, [502, 503, 504]);
  const client = new NativePiWorkerClient(
    origin,
    "job",
    "token",
    new AbortController().signal,
    quick,
  );
  assert.deepEqual(await client.request("checkpoint", { a: 1 }), { ok: true });
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen).size, 1);
  assert.match(seen[0]!, /POST \/coding\/worker\/job\/checkpoint {"a":1}/);
});

test("an unreachable host is reported as such once the wait runs out", async () => {
  const blocked = createServer();
  await new Promise<void>((resolve) => blocked.listen(0, "127.0.0.1", resolve));
  const down = (blocked.address() as AddressInfo).port;
  await close(blocked);
  const refused = new NativePiWorkerClient(
    `http://127.0.0.1:${down}`,
    "job",
    "token",
    new AbortController().signal,
    { windowMs: 20, maxDelayMs: 5 },
  );
  await assert.rejects(refused.request("heartbeat", {}), (e: any) => {
    assert(e instanceof WorkerRequestError);
    assert.equal(e.status, undefined);
    assert.equal(hostUnreachable(e), true);
    return true;
  });
});

test("a host refusal ends the request at once", async (t) => {
  for (const status of [400, 401, 409, 413, 500]) {
    const { origin, seen } = await host(t, [status]);
    const client = new NativePiWorkerClient(
      origin,
      "job",
      "token",
      new AbortController().signal,
      quick,
    );
    await assert.rejects(client.request("finish", {}), (e: any) => {
      assert.equal(e.status, status);
      assert.equal(hostUnreachable(e), false);
      return true;
    });
    assert.equal(seen.length, 1);
  }
});

test("a stopped worker does not keep waiting for the host", async (t) => {
  const { origin, seen } = await host(t, [502, 502, 502, 502]);
  const stop = new AbortController();
  stop.abort();
  const client = new NativePiWorkerClient(
    origin,
    "job",
    "token",
    stop.signal,
    quick,
  );
  await assert.rejects(client.request("heartbeat", {}));
  assert.equal(seen.length, 0);
});

test("exit codes name the failure without carrying its text", () => {
  assert.equal(workerExitCode(new WorkerRequestError()), 10);
  assert.equal(workerExitCode(new WorkerRequestError(502)), 10);
  assert.equal(workerExitCode(new WorkerRequestError(401)), 11);
  assert.equal(workerExitCode(new Error("private detail")), 1);
});

async function interrupted(t: any) {
  const f = await fixture(t);
  const job = await f.start("restart");
  const attempt = "11111111-1111-4111-8111-111111111111";
  const call = "22222222-2222-4222-8222-222222222222";
  await f.db.query(
    "UPDATE coding_jobs SET attempt_id=$2,state='running',stage='implementing',lease=NULL,lease_until=NULL,cleanup='none',sandbox_id='s' WHERE id=$1",
    [job.id, attempt],
  );
  await f.db.query(
    `INSERT INTO coding_model_calls(id,job_id,attempt_id,role,request_hash,input,state) VALUES($1,$2,$3,'coder','h','{}'::jsonb,'pending')`,
    [call, job.id, attempt],
  );
  return { f, id: job.id as string, attempt, call };
}

test("a restart records the model call it cut off", async (t) => {
  const { f, id, attempt, call } = await interrupted(t);
  await f.c.recoverModels();
  await f.c.recoverModels();
  const { rows } = await f.db.query(
    "SELECT event_key,payload,delivery FROM coding_events WHERE job_id=$1 AND payload->>'code'='gateway_restart'",
    [id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_key, `${attempt}:request-rejected:${call}`);
  assert.equal(rows[0].delivery, "suppressed");
  assert.equal(rows[0].payload.callId, call);
  assert.equal(
    (
      await f.db.query("SELECT state FROM coding_model_calls WHERE id=$1", [
        call,
      ])
    ).rows[0].state,
    "uncertain",
  );
});

test("a pause after a restart cut off a call is retried once", async (t) => {
  const { f, id, attempt } = await interrupted(t);
  await f.c.recoverModels();
  await f.db.query(
    `UPDATE coding_jobs SET state='paused',stage='paused',cleanup='complete',sandbox_id=NULL,result='{"kind":"paused"}'::jsonb,updated_at=now()-interval '3 minutes' WHERE id=$1`,
    [id],
  );
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,$2,'{}'::jsonb,'suppressed')",
    [id, `${attempt}:finished`],
  );
  await f.c.autoRetryOnce();
  const job = await f.row(id);
  assert.equal(job.state, "queued");
  assert.match(job.summary, /Retrying once automatically/);
});

test("the exit note reads the box task's recorded exit code", async () => {
  const sandbox = Object.create(BoxSandbox.prototype) as any;
  for (const [code, note] of [
    [10, /could not reach the gateway/],
    [11, /refused a worker request/],
    [1, /unexpected error/],
  ] as const) {
    sandbox.load = async () => ({ task: { result: { exitCode: code } } });
    assert.match(await sandbox.exitNote("box:x"), note);
  }
  sandbox.load = async () => ({ task: { result: { exitCode: 0 } } });
  assert.equal(await sandbox.exitNote("box:x"), undefined);
});
