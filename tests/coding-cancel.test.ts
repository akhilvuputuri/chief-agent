import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/coding-fixture.js";
import { toolError, ToolValidationError } from "../src/tool-errors.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const cancel = (f: Fixture, id: string) =>
  f.c.call("a", f.run, { operation: "coding_cancel", id });
const cancelEvents = async (f: Fixture, id: string) =>
  (
    await f.db.query(
      "SELECT count(*)::int n FROM coding_events WHERE job_id=$1 AND event_key='cancelled'",
      [id],
    )
  ).rows[0].n;
/** A job published as a PR, with the given workflow and stage. */
async function prReady(
  f: Fixture,
  key: string,
  { flow, autoMerge = false, stage = "pr_ready" } = {} as {
    flow?: "owner_merge";
    autoMerge?: boolean;
    stage?: string;
  },
) {
  const job = await f.start(key);
  await f.db.query(
    `UPDATE coding_jobs SET state='pr_ready',stage=$2,pr_url='https://github.com/example/repo/pull/7',
       head_sha=$3,settings=settings||$4::jsonb WHERE id=$1`,
    [
      job.id,
      stage,
      "b".repeat(40),
      JSON.stringify({
        ...(flow ? { prWorkflow: flow } : {}),
        ...(autoMerge ? { autoMerge: true } : {}),
      }),
    ],
  );
  return job.id as string;
}

test("a coding worker-slot conflict is reported as such, never as a work_status task", async (t) => {
  const f = await fixture(t);
  const first = await f.start("first");
  const second = await f.start("second");
  await f.c.tick();
  assert.equal((await f.row(first.id)).state, "provisioning");
  // The real index violation, as a second job entering the single worker slot raises it.
  const error = await f.db
    .query("UPDATE coding_jobs SET state='running' WHERE id=$1", [second.id])
    .then(
      () => assert.fail("the single-worker index should refuse a second job"),
      (e: unknown) => e,
    );
  const mapped = toolError(error);
  assert.equal(mapped.code, "CODING_WORKER_BUSY");
  assert.equal(mapped.retryable, false);
  assert.match(mapped.message, /another coding job is using/);
  assert.doesNotMatch(mapped.message, /Inspect work_status/);
  // Another coding identity conflict, as its message names it.
  assert.equal(
    toolError(
      new Error(
        'duplicate key value violates unique constraint "coding_revisions_job_id_request_key_key"',
      ),
    ).code,
    "CODING_CONFLICT",
  );
  // The durable work index keeps its own guidance; other indexes get a neutral one.
  assert.equal(
    toolError(
      new Error(
        'duplicate key value violates unique constraint "work_one_active"',
      ),
    ).code,
    "ACTIVE_WORK_EXISTS",
  );
  const other = toolError(
    Object.assign(
      new Error(
        'duplicate key value violates unique constraint "parcels_tracking"',
      ),
      { code: "23505", constraint: "parcels_tracking" },
    ),
  );
  assert.equal(other.code, "DUPLICATE_RECORD");
  assert.doesNotMatch(other.message, /work_status/);
});

test("cancelling a job with a published PR fails with the reason and leaves it unchanged", async (t) => {
  const f = await fixture(t);
  const draft = await prReady(f, "draft");
  await assert.rejects(
    () => cancel(f, draft),
    (e: any) =>
      e instanceof ToolValidationError &&
      /^Not cancelled: this job already published a PR \(https:\/\/github\.com\/example\/repo\/pull\/7\)/.test(
        e.message,
      ) &&
      /owner closes the PR on GitHub/.test(e.message) &&
      /draft PR/.test(e.message),
  );
  assert.equal((await f.row(draft)).state, "pr_ready");
  assert.equal(await cancelEvents(f, draft), 0);

  const owner = await prReady(f, "owner", {
    flow: "owner_merge",
    stage: "manual_review",
  });
  await assert.rejects(
    () => cancel(f, owner),
    (e: any) =>
      e instanceof ToolValidationError &&
      /Merge card/.test(e.message) &&
      /no tool to close pull requests/.test(e.message),
  );
  assert.equal((await f.row(owner)).state, "pr_ready");

  const merging = await prReady(f, "merging", {
    autoMerge: true,
    stage: "merging",
  });
  await assert.rejects(
    () => cancel(f, merging),
    (e: any) =>
      e instanceof ToolValidationError &&
      /already merging \(stage merging\)/.test(e.message),
  );
  assert.equal((await f.row(merging)).stage, "merging");

  // An automatic-merge job that has not reached merging can still be cancelled.
  const waiting = await prReady(f, "waiting", {
    autoMerge: true,
    stage: "awaiting_ci",
  });
  await cancel(f, waiting);
  assert.equal((await f.row(waiting)).state, "cancelled");
});

test("a waiting plan is cancellable, even while another job holds the worker slot", async (t) => {
  const f = await fixture(t);
  const plan = await f.start("plan", "plan");
  await f.db.query(
    "UPDATE coding_jobs SET state='plan_ready',stage='plan_ready',attempt_id=$2,cleanup='complete' WHERE id=$1",
    [plan.id, randomUUID()],
  );
  const running = await f.start("current");
  await f.c.tick();
  assert.equal((await f.row(running.id)).state, "provisioning");
  const result: any = await cancel(f, plan.id);
  assert.equal(result.state, "cancelled");
  assert.equal((await f.row(plan.id)).cleanup, "complete");
  assert.equal(await cancelEvents(f, plan.id), 1);
  // Cancelling again is an idempotent read of the cancelled job.
  assert.equal(((await cancel(f, plan.id)) as any).state, "cancelled");
  assert.equal(await cancelEvents(f, plan.id), 1);
});

/** A paused job that last changed `age` ago. */
async function parked(f: Fixture, key: string, age: string, state = "paused") {
  const job = await f.start(key, "plan");
  await f.db.query(
    `UPDATE coding_jobs SET state=$2,stage=$2,attempt_id=$3,cleanup='complete',updated_at=now()-$4::interval WHERE id=$1`,
    [job.id, state, randomUUID(), age],
  );
  return f.row(job.id);
}

test("resuming work that has waited more than a day needs the owner's explicit confirmation", async (t) => {
  const f = await fixture(t);
  const old = await parked(f, "old", "3 days");
  const resume = (extra: object = {}) =>
    f.c.call("a", f.run, {
      operation: "coding_resume",
      id: old.id,
      baseRevision: old.revision,
      requestKey: "resume-old",
      ...extra,
    });
  await assert.rejects(
    () => resume(),
    (e: any) =>
      e instanceof ToolValidationError &&
      /waiting since \d{4}-\d{2}-\d{2}, more than 24 hours/.test(e.message) &&
      /confirmStale: true only if the owner explicitly asked/.test(e.message),
  );
  const unchanged = await f.row(old.id);
  assert.equal(unchanged.state, "paused");
  assert.equal(unchanged.revision, old.revision);
  // The owner asked to resume this job: the call carries that confirmation.
  const resumed: any = await resume({ confirmStale: true });
  assert.equal(resumed.state, "queued");
  assert.equal(resumed.revision, old.revision + 1);
  // A retry of the same request is answered from its record.
  assert.equal(((await resume()) as any).revision, old.revision + 1);

  // A recently paused job resumes without the confirmation.
  const recent = await parked(f, "recent", "2 hours");
  const fresh: any = await f.c.call("a", f.run, {
    operation: "coding_resume",
    id: recent.id,
    baseRevision: recent.revision,
    requestKey: "resume-recent",
  });
  assert.equal(fresh.state, "queued");
});

test("a reply that restarts a stale job also needs the confirmation", async (t) => {
  const f = await fixture(t);
  const old = await parked(f, "question", "2 days", "awaiting_input");
  const reply = (extra: object = {}) =>
    f.c.call("a", f.run, {
      operation: "coding_reply",
      id: old.id,
      baseRevision: old.revision,
      requestKey: "answer",
      message: "Use the existing helper",
      ...extra,
    });
  await assert.rejects(
    () => reply(),
    /coding_reply needs the owner's explicit/,
  );
  assert.equal((await f.row(old.id)).state, "awaiting_input");
  assert.equal(((await reply({ confirmStale: true })) as any).state, "queued");
});

test("continuing a stale owner-merge PR needs the confirmation", async (t) => {
  const f = await fixture(t);
  const id = await prReady(f, "stale-pr", {
    flow: "owner_merge",
    stage: "manual_review",
  });
  await f.db.query(
    "UPDATE coding_jobs SET updated_at=now()-interval '4 days' WHERE id=$1",
    [id],
  );
  const job = await f.row(id);
  const resume = (extra: object = {}) =>
    f.c.call("a", f.run, {
      operation: "coding_resume",
      id,
      baseRevision: job.revision,
      requestKey: "continue-pr",
      ...extra,
    });
  await assert.rejects(() => resume(), /waiting since/);
  assert.equal((await f.row(id)).stage, "manual_review");
  await resume({ confirmStale: true });
  assert.equal((await f.row(id)).stage, "awaiting_ci");
});

test("the host's transient retry is not gated by the owner confirmation", async (t) => {
  const f = await fixture(t);
  const job = await parked(f, "transient", "23 hours");
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload) VALUES($1,$2,$3::jsonb)",
    [
      job.id,
      `${job.attempt_id}:paused`,
      JSON.stringify({ summary: "Paused", cause: "sandbox_stopped" }),
    ],
  );
  await f.c.autoRetryOnce();
  const retried = await f.row(job.id);
  assert.equal(retried.state, "queued");
  assert.equal(retried.revision, job.revision + 1);
});
