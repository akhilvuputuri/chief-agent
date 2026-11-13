import { test } from "node:test";
import assert from "node:assert/strict";
import { CodingAutomation } from "../src/coding/automation.js";
import { GitHubAutomation } from "../src/coding/github-automation.js";
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
  let outcome: (id: string) => PrOutcome | Error = () => open;
  let reads = 0;
  let now = new Date("2026-11-01T00:00:00Z");
  const auto = new CodingAutomation(
    f.db,
    {
      outcome: async ({ id }: { id: string }) => {
        reads++;
        const answer = outcome(id);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as any,
    () => true,
    async () => true,
    () => now,
    async () => true,
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
        "SELECT payload,delivery FROM coding_events WHERE job_id=$1 AND event_key LIKE 'settled-on-github:%'",
        [id],
      )
    ).rows;
  return {
    f,
    auto,
    park,
    events,
    set: (o: PrOutcome | Error) => (outcome = () => o),
    setFor: (f: (id: string) => PrOutcome | Error) => (outcome = f),
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
  assert.equal(job.stage, "merged_on_github");
  assert.match(job.summary, /merged on GitHub as c{40}/);
  assert.match(job.summary, /did not confirm its release/);
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
  assert.equal(job.stage, "closed_on_github");
  assert.match(job.summary, /closed on GitHub without merging/);
});

test("a finished job no longer waits on the owner", async (t) => {
  const s = await setup(t);
  const id = await s.park("loops");
  const { codingWaitsOnOwner } = await import("../src/open-loops.js");
  assert.equal(await codingWaitsOnOwner(s.f.db, "a"), true);
  s.set(merged);
  await s.auto.tick();
  assert.equal((await s.f.row(id)).stage, "merged_on_github");
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
  const failing = await s.park("failing");
  const other = await s.park("other");
  s.setFor((id) => (id === failing ? new Error("GitHub unavailable") : merged));
  await s.auto.tick();
  const job = await s.f.row(failing);
  assert.equal(job.stage, "manual_review");
  assert.deepEqual(await s.events(failing), []);
  assert.equal((await s.f.row(other)).stage, "merged_on_github");
  await assert.rejects(
    s.cancel(failing),
    /Not cancelled: this job already published/,
  );
});

test("stages with an active watcher or a leased job are left alone", async (t) => {
  const s = await setup(t);
  s.set(merged);
  for (const stage of [
    "merge_approved",
    "merging",
    "release_pending",
    "awaiting_ci",
    "awaiting_merge_approval",
    "deployed",
  ]) {
    const id = await s.park(`watched-${stage}`, stage);
    assert.equal(await s.auto.settleOutside(await s.f.row(id)), false, stage);
    assert.equal((await s.f.row(id)).stage, stage);
  }
  const leased = await s.park("leased");
  await s.f.db.query(
    "UPDATE coding_jobs SET lease=gen_random_uuid(),lease_until=now()+interval '3 minutes' WHERE id=$1",
    [leased],
  );
  assert.equal(await s.auto.settleOutside(await s.f.row(leased)), false);
  assert.equal((await s.f.row(leased)).stage, "manual_review");
});

test("a stop after Chief's own merge keeps its release warning", async (t) => {
  const s = await setup(t);
  const id = await s.park("released");
  const warning = "PR merged, but release failed; inspect the exact release.";
  await s.f.db.query("UPDATE coding_jobs SET summary=$2 WHERE id=$1", [
    id,
    warning,
  ]);
  await s.f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,'automation:1',$2::jsonb,'suppressed')",
    [id, JSON.stringify({ mergeSha: "c".repeat(40) })],
  );
  s.set(merged);
  await s.auto.tick();
  assert.equal(s.reads(), 0);
  assert.equal(await s.auto.settleOutside(await s.f.row(id)), false);
  const job = await s.f.row(id);
  assert.equal(job.stage, "manual_review");
  assert.equal(job.summary, warning);
  await assert.rejects(s.cancel(id), (e: any) => {
    assert(e instanceof ToolValidationError);
    assert.match(e.message, /already merged as c{40}/);
    assert.match(e.message, /release must be inspected/);
    assert.doesNotMatch(e.message, /closes the PR/);
    return true;
  });
  await s.f.db.query(
    `UPDATE coding_jobs SET settings=settings||'{"autoMerge":true}'::jsonb WHERE id=$1`,
    [id],
  );
  await assert.rejects(s.cancel(id), /already merged/);
  const after = await s.f.row(id);
  assert.equal(after.state, "pr_ready");
  assert.equal(after.summary, warning);
});

test("a draft job is checked, but a pr_ready job automation is handling is not", async (t) => {
  const s = await setup(t);
  s.set(closed);
  const draft = await s.park("draft", "pr_ready");
  const owned = await s.park("owned", "pr_ready");
  await s.f.db.query(
    `UPDATE coding_jobs SET settings=settings||'{"runtime":"pi","squad":false,"prWorkflow":"owner_merge"}'::jsonb,lease=gen_random_uuid(),lease_until=now()+interval '3 minutes' WHERE id=$1`,
    [owned],
  );
  await s.auto.tick();
  assert.equal((await s.f.row(draft)).stage, "closed_on_github");
  await s.f.db.query(
    "UPDATE coding_jobs SET lease=NULL,lease_until=NULL WHERE id=$1",
    [owned],
  );
  assert.equal(await s.auto.settleOutside(await s.f.row(owned)), false);
  assert.equal((await s.f.row(owned)).stage, "pr_ready");
});

test("the sweep reaches every parked job, however many are open", async (t) => {
  const s = await setup(t);
  const ids: string[] = [];
  for (let i = 0; i < 25; i++) ids.push(await s.park(`many-${i}`));
  const seen = new Set<string>();
  s.setFor((id) => {
    seen.add(id);
    return open;
  });
  await s.auto.tick();
  assert.equal(seen.size, 20);
  s.advance(900000);
  await s.auto.tick();
  assert.equal(seen.size, 25);
  assert.deepEqual([...seen].sort(), [...ids].sort());
});

test("cancelling an auto-merge job checks GitHub before cancelling it", async (t) => {
  const s = await setup(t);
  const id = await s.park("auto");
  await s.f.db.query(
    `UPDATE coding_jobs SET settings=settings||'{"autoMerge":true}'::jsonb WHERE id=$1`,
    [id],
  );
  s.set(merged);
  await s.cancel(id);
  const job = await s.f.row(id);
  assert.equal(job.state, "pr_ready");
  assert.equal(job.stage, "merged_on_github");
  await assert.rejects(s.cancel(id), /Nothing to cancel/);
  assert.equal((await s.f.row(id)).state, "pr_ready");
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
  assert.equal(status.stage, "merged_on_github");
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

test("GitHub's answer comes only from the job's own PR", async () => {
  const id = "8dfdfbf0-53de-4b8d-a579-d10ad5efccdf";
  const repo = "example/repo";
  const pr = {
    merged: true,
    state: "closed",
    merge_commit_sha: "c".repeat(40),
    head: { ref: `chief/coding-${id}-r2`, repo: { full_name: repo } },
    base: { ref: "main", repo: { full_name: repo } },
  };
  const paths: string[] = [];
  const gh = new GitHubAutomation(
    repo,
    (async (path: string) => {
      paths.push(path);
      return pr;
    }) as any,
    (async () => ({})) as any,
  );
  assert.deepEqual(await gh.outcome({ id, url }), {
    merged: true,
    closed: true,
    mergeSha: "c".repeat(40),
  });
  assert.deepEqual(paths, ["pulls/7"]);
  await assert.rejects(
    gh.outcome({ id: "another-job", url }),
    /ownership changed/,
  );
  await assert.rejects(
    gh.outcome({ id, url: "https://github.com/other/repo/pull/7" }),
    /Invalid owned PR target/,
  );
});
