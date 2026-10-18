import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/coding-fixture.js";

/** A started job, paused by the host for `cause` (or by the worker), `age` ago. */
async function paused(
  t: TestContext,
  {
    cause = "sandbox_stopped" as string,
    worker = undefined as { code: string; status: string } | undefined,
    age = "5 minutes",
    cleanup = "complete",
    publication = false,
    result = "paused",
    recovered = false,
    pr = false,
  } = {},
) {
  const f = await fixture(t);
  const job = await f.start("request", "plan");
  const attempt = randomUUID();
  await f.db.query(
    `UPDATE coding_jobs SET state='paused',stage='paused',attempt_id=$2,cleanup=$3,publication_started=$4,
       lease=NULL,lease_until=NULL,updated_at=now()-$5::interval,result=$6::jsonb,pr_url=$7 WHERE id=$1`,
    [
      job.id,
      attempt,
      cleanup,
      publication,
      age,
      worker ? JSON.stringify({ kind: result, summary: "Paused" }) : null,
      pr ? "https://github.com/example/repo/pull/1" : null,
    ],
  );
  if (worker) {
    await f.db.query(
      'INSERT INTO coding_events(job_id,event_key,payload) VALUES($1,$2,\'{"summary":"Paused"}\')',
      [job.id, `${attempt}:finished`],
    );
    await f.db.query(
      "INSERT INTO coding_events(job_id,event_key,payload) VALUES($1,$2,$3::jsonb)",
      [
        job.id,
        `${attempt}:request-rejected:${randomUUID()}`,
        JSON.stringify({
          kind: "worker_request_rejected",
          code: worker.code,
          providerStatus: worker.status,
        }),
      ],
    );
    // Generation recovery retried the rejected request and it completed.
    if (recovered)
      await f.db.query(
        `INSERT INTO coding_model_calls(id,job_id,attempt_id,role,request_hash,input,state,created_at)
         VALUES($1,$2,$3,'coder','h','{}'::jsonb,'complete',now()+interval '1 second')`,
        [randomUUID(), job.id, attempt],
      );
  } else
    await f.db.query(
      "INSERT INTO coding_events(job_id,event_key,payload) VALUES($1,$2,$3::jsonb)",
      [
        job.id,
        `${attempt}:paused`,
        JSON.stringify({
          summary: "Paused",
          ...(cause === "none" ? {} : { cause }),
        }),
      ],
    );
  const before = await f.row(job.id);
  return { f, job, attempt, before };
}
const retries = async (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  (
    await f.db.query(
      "SELECT request_key,message FROM coding_revisions WHERE job_id=$1 AND request_key LIKE 'auto-retry:%'",
      [id],
    )
  ).rows;

test("a sandbox that stopped without a reason is retried once, keyed to its attempt", async (t) => {
  const { f, job, attempt, before } = await paused(t);
  await f.c.autoRetryOnce();
  const after = await f.row(job.id);
  assert.equal(after.state, "queued");
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.attempt_id, null);
  assert.deepEqual(
    (await retries(f, job.id)).map((r) => r.request_key),
    [`auto-retry:${attempt}`],
  );
  const notice = (
    await f.db.query(
      "SELECT payload,delivery FROM coding_events WHERE job_id=$1 AND event_key=$2",
      [job.id, `auto-retry:${attempt}`],
    )
  ).rows[0];
  assert.match(
    notice.payload.summary,
    /If it pauses again, it will wait for you/,
  );
  assert.equal(notice.delivery, "pending");
  // Idempotent: a second pass finds nothing to do.
  await f.c.autoRetryOnce();
  assert.equal((await f.row(job.id)).revision, before.revision + 1);
});

test("a lost heartbeat and a provider 503 or 429 are transient; a 400 or an unclassified pause is not", async (t) => {
  for (const [opts, expected] of [
    [{ cause: "heartbeat_lost" }, "queued"],
    [{ worker: { code: "model_transient_failure", status: "503" } }, "queued"],
    [{ worker: { code: "model_rate_limited", status: "429" } }, "queued"],
    [{ worker: { code: "model_transient_failure", status: "400" } }, "paused"],
    [{ cause: "none" }, "paused"],
  ] as const) {
    const { f, job } = await paused(t, opts as any);
    await f.c.autoRetryOnce();
    assert.equal((await f.row(job.id)).state, expected, JSON.stringify(opts));
  }
});

test("a revision created by an automatic retry is never retried again", async (t) => {
  const { f, job } = await paused(t);
  await f.c.autoRetryOnce();
  const retried = await f.row(job.id);
  // The retried attempt pauses again for the same transient cause.
  const attempt = randomUUID();
  await f.db.query(
    "UPDATE coding_jobs SET state='paused',stage='paused',attempt_id=$2,cleanup='complete',updated_at=now()-interval '5 minutes' WHERE id=$1",
    [job.id, attempt],
  );
  await f.db.query(
    'INSERT INTO coding_events(job_id,event_key,payload) VALUES($1,$2,\'{"summary":"Paused","cause":"sandbox_stopped"}\')',
    [job.id, `${attempt}:paused`],
  );
  await f.c.autoRetryOnce();
  const after = await f.row(job.id);
  assert.equal(after.state, "paused");
  assert.equal(after.revision, retried.revision);
  assert.equal((await retries(f, job.id)).length, 1);
});

test("recent pauses, pending cleanup, uncertain publication, revoked owners and the off switch are left alone", async (t) => {
  for (const opts of [
    { age: "30 seconds" },
    { age: "2 days" },
    { cleanup: "pending" },
    { publication: true },
  ]) {
    const { f, job } = await paused(t, opts);
    await f.c.autoRetryOnce();
    assert.equal((await f.row(job.id)).state, "paused", JSON.stringify(opts));
  }
  const revoked = await paused(t);
  revoked.f.revoke();
  await revoked.f.c.autoRetryOnce();
  assert.equal((await revoked.f.row(revoked.job.id)).state, "paused");
  const off = await paused(t);
  // The fixture's settings object is shared by every test; restore it.
  const shared = off.f.c.settings as { autoRetryTransientOnce?: boolean };
  shared.autoRetryTransientOnce = false;
  t.after(() => delete shared.autoRetryTransientOnce);
  await off.f.c.autoRetryOnce();
  assert.equal((await off.f.row(off.job.id)).state, "paused");
});
test("the host records the transient cause when a sandbox stops or its heartbeat is lost", async (t) => {
  for (const [stop, cause] of [
    ["terminal", "sandbox_stopped"],
    ["silent", "heartbeat_lost"],
  ] as const) {
    const f = await fixture(t);
    const job = await f.start("request", "plan");
    await f.c.tick(); // provisions the sandbox
    const j = await f.row(job.id);
    if (stop === "terminal") await f.provider.terminate(j.sandbox_id);
    else f.advance(181000);
    await f.c.tick();
    assert.equal((await f.row(job.id)).state, "paused", stop);
    const event = (
      await f.db.query(
        "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
        [job.id, `${j.attempt_id}:paused`],
      )
    ).rows[0];
    assert.equal(event.payload.cause, cause, stop);
  }
});

const w503 = { code: "model_transient_failure", status: "503" };
test("a recovered provider fault, a publication mismatch and a job with a PR are left for the owner", async (t) => {
  for (const opts of [
    // The 503 was recovered; the later pause (failed checks, no report) is work-caused.
    { worker: w503, recovered: true },
    // The candidate finished; the host paused it because the agent PR did not match.
    { worker: w503, result: "candidate" },
    { pr: true },
    { worker: w503, pr: true },
  ]) {
    const { f, job } = await paused(t, opts);
    await f.c.autoRetryOnce();
    assert.equal((await f.row(job.id)).state, "paused", JSON.stringify(opts));
  }
});

test("a revoked owner's older job does not block another owner's retry", async (t) => {
  const { f, job: other } = await paused(t, { age: "10 minutes" });
  await f.db.query("UPDATE coding_jobs SET user_id='b' WHERE id=$1", [
    other.id,
  ]);
  const job = await f.start("second", "plan");
  const attempt = randomUUID();
  await f.db.query(
    "UPDATE coding_jobs SET state='paused',stage='paused',attempt_id=$2,cleanup='complete',updated_at=now()-interval '5 minutes' WHERE id=$1",
    [job.id, attempt],
  );
  await f.db.query(
    'INSERT INTO coding_events(job_id,event_key,payload) VALUES($1,$2,\'{"summary":"Paused","cause":"heartbeat_lost"}\')',
    [job.id, `${attempt}:paused`],
  );
  await f.c.autoRetryOnce();
  assert.equal((await f.row(other.id)).state, "paused");
  assert.equal((await f.row(job.id)).state, "queued");
});

test("a sandbox whose stop reason could not be read is not classified as transient", async (t) => {
  const f = await fixture(t);
  (f.provider as any).terminalReason = async () => {
    throw new Error("lookup failed");
  };
  const job = await f.start("request", "plan");
  await f.c.tick();
  const j = await f.row(job.id);
  await f.provider.terminate(j.sandbox_id);
  await f.c.tick();
  const event = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
      [job.id, `${j.attempt_id}:paused`],
    )
  ).rows[0];
  assert.equal(event.payload.cause, undefined);
});
