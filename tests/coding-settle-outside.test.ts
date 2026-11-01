import { test } from "node:test";
import assert from "node:assert/strict";
import { CodingAutomation } from "../src/coding/automation.js";
import { ToolValidationError } from "../src/tool-errors.js";
import type { PrOutcome } from "../src/coding/merge-policy.js";
import { fixture } from "./helpers/coding-fixture.js";

const url = "https://github.com/example/repo/pull/7";
const open: PrOutcome = { merged: false, closed: false, mergeSha: null };
const merged: PrOutcome = {
  merged: true,
  closed: true,
  mergeSha: "c".repeat(40),
};
const closed: PrOutcome = { merged: false, closed: true, mergeSha: null };

async function setup(t: any) {
  const f = await fixture(t);
  let outcome: PrOutcome | Error = open;
  let reads = 0;
  let now = new Date("2026-11-01T00:00:00Z");
  const auto = new CodingAutomation(
    f.db,
    {
      outcome: async () => {
        reads++;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    } as any,
    () => true,
    async () => true,
    () => now,
  );
  (f.c as any).automation = auto;
  const park = async (key: string, stage = "manual_review") => {
    const job = await f.start(key);
    await f.db.query(
      `UPDATE coding_jobs SET state='pr_ready',stage=$2,pr_url=$3,head_sha=$4,publication_started=true,cleanup='complete',lease=NULL,lease_until=NULL WHERE id=$1`,
      [job.id, stage, url, "b".repeat(40)],
    );
    return job.id as string;
  };
  const events = async (id: string) =>
    (
      await f.db.query(
        "SELECT payload,delivery FROM coding_events WHERE job_id=$1 AND event_key LIKE 'settled-outside:%'",
        [id],
      )
    ).rows;
  return {
    f,
    auto,
    park,
    events,
    set: (o: PrOutcome | Error) => (outcome = o),
    reads: () => reads,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    cancel: (id: string) =>
      f.c.call("a", f.run, { operation: "coding_cancel", id }),
  };
}

test("the sweep finishes a parked job whose PR merged on GitHub, without a message", async (t) => {
  const s = await setup(t);
  const id = await s.park("merged");
  s.set(merged);
  await s.auto.tick();
  const job = await s.f.row(id);
  assert.equal(job.state, "pr_ready");
  assert.equal(job.stage, "merged_outside");
  assert.match(job.summary, /merged on GitHub as c{40}/);
  assert.match(job.summary, /did not watch its release/);
  const [event] = await s.events(id);
  assert.equal(event.delivery, "suppressed");
  assert.equal(event.payload.url, url);
});

test("the sweep finishes a closed PR and keeps an open one waiting", async (t) => {
  const s = await setup(t);
  const open = await s.park("open", "merge_declined");
  await s.auto.tick();
  assert.equal((await s.f.row(open)).stage, "merge_declined");
  assert.deepEqual(await s.events(open), []);
  s.set(closed);
  s.advance(900000);
  await s.auto.tick();
  const job = await s.f.row(open);
  assert.equal(job.stage, "closed_outside");
  assert.match(job.summary, /closed on GitHub without merging/);
});

test("a finished job no longer waits on the owner", async (t) => {
  const s = await setup(t);
  const id = await s.park("loops");
  const { codingWaitsOnOwner } = await import("../src/open-loops.js");
  assert.equal(await codingWaitsOnOwner(s.f.db, "a"), true);
  s.set(merged);
  await s.auto.tick();
  assert.equal((await s.f.row(id)).stage, "merged_outside");
  assert.equal(await codingWaitsOnOwner(s.f.db, "a"), false);
});

test("the sweep runs at most every 15 minutes", async (t) => {
  const s = await setup(t);
  await s.park("rate");
  await s.auto.tick();
  await s.auto.tick();
  assert.equal(s.reads(), 1);
  s.advance(899999);
  await s.auto.tick();
  assert.equal(s.reads(), 1);
  s.advance(1);
  await s.auto.tick();
  assert.equal(s.reads(), 2);
});

test("a failed GitHub read changes nothing and does not stop other jobs", async (t) => {
  const s = await setup(t);
  const id = await s.park("failed");
  s.set(new Error("GitHub unavailable"));
  await s.auto.tick();
  const job = await s.f.row(id);
  assert.equal(job.stage, "manual_review");
  assert.deepEqual(await s.events(id), []);
  await assert.rejects(
    s.cancel(id),
    /Not cancelled: this job already published/,
  );
});

test("stages with an active watcher or a leased job are left alone", async (t) => {
  const s = await setup(t);
  s.set(merged);
  const watched = await s.park("watched", "merge_approved");
  const leased = await s.park("leased");
  await s.f.db.query(
    "UPDATE coding_jobs SET lease=gen_random_uuid(),lease_until=now()+interval '3 minutes' WHERE id=$1",
    [leased],
  );
  assert.equal(await s.auto.settleOutside(await s.f.row(watched)), false);
  assert.equal(await s.auto.settleOutside(await s.f.row(leased)), false);
  assert.equal((await s.f.row(leased)).stage, "manual_review");
});

test("cancel checks GitHub: a gone PR finishes the job and an open one is refused", async (t) => {
  const s = await setup(t);
  const id = await s.park("cancel");
  await assert.rejects(s.cancel(id), (e: any) => {
    assert(e instanceof ToolValidationError);
    assert.match(e.message, /owner closes the PR on GitHub/);
    return true;
  });
  assert.equal((await s.f.row(id)).stage, "manual_review");
  s.set(merged);
  const status = (await s.cancel(id)) as any;
  assert.equal(status.stage, "merged_outside");
  assert.equal((await s.f.row(id)).state, "pr_ready");
  await assert.rejects(s.cancel(id), /Nothing to cancel: .*already merged/);
});

test("a finished job explains itself when asked to resume", async (t) => {
  const s = await setup(t);
  const id = await s.park("resume");
  s.set(closed);
  await s.auto.tick();
  await assert.rejects(
    s.f.c.call("a", s.f.run, {
      operation: "coding_resume",
      id,
      baseRevision: (await s.f.row(id)).revision,
      requestKey: "again",
    }),
    /This job is finished: PR was closed/,
  );
});
