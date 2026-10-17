import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { CodingAutomation } from "../src/coding/automation.js";
import { CodingMergeApprovals } from "../src/coding/merge-approvals.js";
import {
  CodingRequirements,
  requirementScope,
} from "../src/coding/requirements.js";
import { CodingController, type CodingJob } from "../src/coding/controller.js";
import { ToolValidationError } from "../src/tool-errors.js";
import { codingSettings, outcome } from "../src/coding/schema.js";
import { artifactHash } from "../src/coding/github.js";
import type { PrInspection } from "../src/coding/merge-policy.js";

const base = "a".repeat(40),
  head = "b".repeat(40),
  tree = "c".repeat(40),
  merged = "d".repeat(40);
const settings = codingSettings.parse({
  repository: "akhilvuputuri/chief-agent",
  branch: "main",
  image: `ghcr.io/example/worker@sha256:${"a".repeat(64)}`,
  model: "fixture/coder",
  leaderModel: "fixture/coder",
  reviewerModel: "fixture/reviewer",
  runtime: "pi",
  prWorkflow: "owner_merge",
  maxOutputTokens: 16000,
  effort: "high",
  limits: { ms: 900000, models: 40, tools: 100 },
});

async function fixture(t: TestContext, piState: any = undefined) {
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
  const id = randomUUID(),
    attempt = randomUUID();
  let now = new Date();
  const files = [{ path: "docs/fixture.md", content: "Fixture\n" }];
  const cp = {
    plan: "Owner-approved docs change",
    summary: "Added the fixture entry",
    patch: "fixture",
    files,
    piState: piState ?? { version: 1, toolsUsed: 20 },
  };
  const hash = artifactHash(cp);
  const result = outcome.parse({
    kind: "candidate",
    summary: "Added the fixture entry",
    checkpoint: cp,
    checks: ["check", "build", "format:check"].map((s) => ({
      command: `npm run ${s}`,
      exitCode: 0,
      output: "passed",
    })),
    review: {
      verdict: "APPROVE",
      findings: "Matches the plan",
      model: settings.reviewerModel,
      patchHash: hash,
    },
  });
  await db.query(
    "INSERT INTO coding_jobs(id,user_id,request_key,request_hash,origin_run,objective,context,mode,base_sha,settings,state,stage,checkpoint,result,attempt_id,cleanup,pr_url,head_sha,attempt_deadline,used_models) VALUES($1,'owner','fixture','fixture',$2,'Docs','Scope','implement',$3,$4::jsonb,'pr_ready','pr_ready',$5::jsonb,$6::jsonb,$7,'complete',$8,$9,$10,12)",
    [
      id,
      randomUUID(),
      base,
      JSON.stringify(settings),
      JSON.stringify(cp),
      JSON.stringify(result),
      attempt,
      "https://github.com/akhilvuputuri/chief-agent/pull/7",
      head,
      new Date(now.getTime() + 600000),
    ],
  );
  let inspection: PrInspection = {
    head,
    tree,
    base,
    main: base,
    merged: false,
    closed: false,
    draft: true,
    mergeable: true,
    checks: "pending",
    feedback: [],
    unresolvedThreads: 0,
  };
  let merges = 0,
    readies = 0;
  let onInspect: (() => Promise<void>) | undefined;
  const repository = {
    inspect: async () => {
      const hook = onInspect;
      onInspect = undefined;
      await hook?.();
      return inspection;
    },
    ready: async () => {
      readies++;
      inspection = { ...inspection, draft: false };
    },
    attest: async () => {},
    merge: async () => {
      merges++;
      return { sha: merged };
    },
    release: async () => "pending" as const,
  };
  const auto = new CodingAutomation(
    db,
    repository,
    () => true,
    async () => true,
    () => now,
  );
  const approvals = new CodingMergeApprovals(
    db,
    () => true,
    () => now,
  );
  const job = async () =>
    (await db.query("SELECT * FROM coding_jobs WHERE id=$1", [id]))
      .rows[0] as CodingJob;
  await auto.start(await job(), tree);
  /** Simulates the Telegram delivery receipt for the newest merge card. */
  const deliverCard = async (messageId = 55) => {
    const card = (
      await db.query(
        "SELECT id,payload FROM coding_events WHERE job_id=$1 AND payload ? 'merge' ORDER BY created_at DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    await db.query(
      "UPDATE coding_events SET delivery='sent',payload=payload || jsonb_build_object('telegramMessageId',$2::bigint,'confirmUntil',$3::text) WHERE id=$1",
      [card.id, messageId, new Date(now.getTime() + 86400000).toISOString()],
    );
    return card as { id: string; payload: any };
  };
  /** A second published owner-merge job sharing the same database and inspection. */
  const addJob = async () => {
    const other = randomUUID();
    await db.query(
      "INSERT INTO coding_jobs(id,user_id,request_key,request_hash,origin_run,objective,context,mode,base_sha,settings,state,stage,checkpoint,result,attempt_id,cleanup,pr_url,head_sha,attempt_deadline,used_models) SELECT $2,user_id,'second',request_hash,origin_run,objective,context,mode,base_sha,settings,'pr_ready','pr_ready',checkpoint,result,$3,cleanup,'https://github.com/akhilvuputuri/chief-agent/pull/8',head_sha,attempt_deadline,used_models FROM coding_jobs WHERE id=$1",
      [id, other, randomUUID()],
    );
    const row = (
      await db.query("SELECT * FROM coding_jobs WHERE id=$1", [other])
    ).rows[0] as CodingJob;
    await auto.start(row, tree);
    return other;
  };
  return {
    db,
    auto,
    approvals,
    job,
    id,
    addJob,
    deliverCard,
    onNextInspect: (hook: () => Promise<void>) => (onInspect = hook),
    setInspection: (i: Partial<PrInspection>) =>
      (inspection = { ...inspection, ...i }),
    counts: () => ({ merges, readies }),
  };
}

test("Pi owner-merge PRs become ready for Devin, then wait for an exact-head owner card before merging", async (t) => {
  const f = await fixture(t);
  await f.auto.tick();
  assert.equal(f.counts().readies, 1);
  assert.equal((await f.job()).stage, "awaiting_ci");
  f.setInspection({ checks: "passed" });
  await f.auto.tick();
  const waiting = await f.job();
  assert.equal(waiting.stage, "awaiting_merge_approval");
  assert.equal(f.counts().merges, 0);
  // Repeated ticks keep waiting and never create a second card for the same head.
  await f.auto.tick();
  const cards = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND payload ? 'merge'",
      [f.id],
    )
  ).rows;
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].payload.merge, { revision: 1, head, tree });
  assert.match(cards[0].payload.question, /Merge this PR\?/);
  assert.equal(f.counts().merges, 0);
  const card = await f.deliverCard();
  await assert.rejects(
    f.approvals.confirm("owner", card.id, true, "owner", 99),
    /unavailable/,
  );
  const decided = await f.approvals.confirm(
    "owner",
    card.id,
    true,
    "owner",
    55,
  );
  assert.deepEqual(decided, {
    status: "merge_approved",
    duplicate: false,
    jobId: f.id,
  });
  assert.equal(
    (await f.approvals.confirm("owner", card.id, true, "owner", 55)).duplicate,
    true,
  );
  await f.auto.tick();
  assert.equal(f.counts().merges, 1);
  assert.equal((await f.job()).stage, "release_pending");
});

test("declining keeps the PR open and a changed head invalidates an unanswered card", async (t) => {
  const f = await fixture(t);
  f.setInspection({ checks: "passed" });
  await f.auto.tick();
  await f.auto.tick();
  const card = await f.deliverCard();
  await f.approvals.confirm("owner", card.id, false, "owner", 55);
  assert.equal((await f.job()).stage, "merge_declined");
  await f.auto.tick();
  assert.equal(f.counts().merges, 0);

  const g = await fixture(t);
  g.setInspection({ checks: "passed" });
  await g.auto.tick();
  await g.auto.tick();
  const stale = await g.deliverCard();
  g.setInspection({ head: "f".repeat(40) });
  await g.auto.tick();
  assert.equal((await g.job()).stage, "manual_review");
  await assert.rejects(
    g.approvals.confirm("owner", stale.id, true, "owner", 55),
    /expired or the PR changed/,
  );
  assert.equal(g.counts().merges, 0);
});

test("MR feedback starts a bounded fresh Pi repair round on the published candidate", async (t) => {
  const f = await fixture(t);
  f.setInspection({
    draft: false,
    feedback: [{ id: "devin-1", text: "Devin: the heading level is wrong" }],
  });
  await f.auto.tick();
  const queued = await f.job();
  assert.equal(queued.state, "queued");
  assert.equal(queued.revision, 2);
  assert.deepEqual(Object.keys(queued.checkpoint.piState!).sort(), [
    "mrFeedback",
    "toolsUsed",
    "version",
  ]);
  assert.equal(queued.checkpoint.piState!.toolsUsed, 20);
  assert.equal(queued.checkpoint.piState!.mrFeedback!.round, 1);
  assert.match(
    queued.checkpoint.piState!.mrFeedback!.text,
    /untrusted evidence[\s\S]*heading level is wrong/,
  );
  assert.deepEqual(queued.checkpoint.files, [
    { path: "docs/fixture.md", content: "Fixture\n" },
  ]);
  const budget = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='feedback:2'",
      [f.id],
    )
  ).rows[0].payload;
  assert.deepEqual(budget.handled, ["devin-1"]);

  const limit = await fixture(t, {
    version: 1,
    toolsUsed: 20,
    mrFeedback: { round: 3, text: "Earlier feedback" },
  });
  limit.setInspection({
    draft: false,
    feedback: [{ id: "devin-9", text: "Devin: still wrong" }],
  });
  await limit.auto.tick();
  const stopped = await limit.job();
  assert.equal(stopped.state, "pr_ready");
  assert.equal(stopped.stage, "manual_review");
  assert.equal(limit.counts().merges, 0);
});

test("owner-confirmed merge is a Pi-only, host-only setting", () => {
  assert.throws(() =>
    codingSettings.parse({
      ...settings,
      runtime: "python",
      maxOutputTokens: undefined,
    }),
  );
});

test("a job waiting for the owner never starves other PR jobs", async (t) => {
  const f = await fixture(t);
  f.setInspection({ checks: "passed", draft: false });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_merge_approval");
  const second = await f.addJob();
  for (let i = 0; i < 4; i++) await f.auto.tick();
  const other = (
    await f.db.query("SELECT stage FROM coding_jobs WHERE id=$1", [second])
  ).rows[0];
  assert.equal(other.stage, "awaiting_merge_approval");
  assert.equal(f.counts().merges, 0);
});

test("an approval lost to a check flap, or a lapsed card, is re-offered rather than silently hanging", async (t) => {
  const f = await fixture(t);
  f.setInspection({ checks: "passed", draft: false });
  await f.auto.tick();
  const first = await f.deliverCard(55);
  await f.approvals.confirm("owner", first.id, true, "owner", 55);
  f.setInspection({ checks: "pending" });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_ci");
  f.setInspection({ checks: "passed" });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_merge_approval");
  const cards = (
    await f.db.query(
      "SELECT id,payload FROM coding_events WHERE job_id=$1 AND payload ? 'merge' ORDER BY created_at",
      [f.id],
    )
  ).rows;
  assert.equal(cards.length, 2);
  assert.match(cards[1].payload.question, /confirm again/);
  assert.match(cards[1].payload.summary, /not verified by Chief/);
  // The answered card cannot be replayed into a second approval.
  assert.equal(
    (await f.approvals.confirm("owner", first.id, true, "owner", 55)).duplicate,
    true,
  );
  assert.equal(f.counts().merges, 0);
  const second = await f.deliverCard(56);
  await f.db.query(
    "UPDATE coding_events SET payload=payload || jsonb_build_object('confirmUntil',$2::text) WHERE id=$1",
    [second.id, new Date(Date.now() - 1000).toISOString()],
  );
  await f.auto.tick();
  const third = (
    await f.db.query(
      "SELECT count(*)::int AS n FROM coding_events WHERE job_id=$1 AND payload ? 'merge'",
      [f.id],
    )
  ).rows[0].n;
  assert.equal(third, 3);
  const live = await f.deliverCard(57);
  // A tap while the automation holds the job lease is still accepted.
  await f.db.query(
    "UPDATE coding_jobs SET lease=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
    [f.id, randomUUID()],
  );
  await f.approvals.confirm("owner", live.id, true, "owner", 57);
  await f.db.query(
    "UPDATE coding_jobs SET lease=NULL,lease_until=NULL WHERE id=$1",
    [f.id],
  );
  await f.auto.tick();
  assert.equal(f.counts().merges, 1);
});

test("feedback rounds continue review numbering so session scopes never collide", async (t) => {
  const f = await fixture(t, { version: 1, toolsUsed: 20, reviewRound: 2 });
  f.setInspection({
    draft: false,
    feedback: [{ id: "devin-2", text: "Devin: typo" }],
  });
  await f.auto.tick();
  const queued = await f.job();
  assert.equal(queued.checkpoint.piState!.reviewRound, 2);
  assert.equal(queued.checkpoint.piState!.mrFeedback!.round, 1);
});

test("an owner decision recorded mid-tick stands: Keep open is never undone by a check flap or new feedback", async (t) => {
  for (const change of [
    { checks: "pending" as const },
    { feedback: [{ id: "devin-late", text: "Devin: late comment" }] },
  ]) {
    const f = await fixture(t);
    f.setInspection({ checks: "passed", draft: false });
    await f.auto.tick();
    const card = await f.deliverCard();
    f.setInspection(change);
    f.onNextInspect(async () => {
      await f.approvals.confirm("owner", card.id, false, "owner", 55);
    });
    await f.auto.tick();
    const after = await f.job();
    assert.equal(after.state, "pr_ready");
    assert.equal(after.stage, "merge_declined");
    assert.equal(after.revision, 1);
    assert.equal(f.counts().merges, 0);
  }
});

test("a card whose delivery became uncertain is replaced", async (t) => {
  const f = await fixture(t);
  f.setInspection({ checks: "passed", draft: false });
  await f.auto.tick();
  await f.db.query(
    "UPDATE coding_events SET delivery='uncertain' WHERE job_id=$1 AND payload ? 'merge'",
    [f.id],
  );
  await f.auto.tick();
  const cards = (
    await f.db.query(
      "SELECT delivery FROM coding_events WHERE job_id=$1 AND payload ? 'merge' ORDER BY created_at",
      [f.id],
    )
  ).rows.map((r: any) => r.delivery);
  assert.deepEqual(cards, ["uncertain", "pending"]);
});

test("the bundled Pi profile enables owner-confirmed merge and never automatic merge", async () => {
  const bundled = codingSettings.parse(
    JSON.parse(
      await readFile(
        new URL("../config/coding-pi.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.equal(bundled.runtime, "pi");
  assert.equal(bundled.prWorkflow, "owner_merge");
  assert.equal(bundled.autoMerge, false);
});

test("each Pi owner-merge feedback round gets a fresh active window even after the first is spent", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "UPDATE coding_events SET payload=jsonb_set(payload,'{remainingMs}','0'::jsonb) WHERE job_id=$1 AND event_key='automation:1'",
    [f.id],
  );
  f.setInspection({
    draft: false,
    feedback: [{ id: "human-1", text: "Reviewer: rename the heading" }],
  });
  await f.auto.tick();
  const queued = await f.job();
  assert.equal(queued.state, "queued");
  const budget = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='feedback:2'",
      [f.id],
    )
  ).rows[0].payload;
  assert.equal(budget.remainingMs, 900000);
  assert.equal(queued.used_models, 12);
});

test("when main moves, an owner-merge job is rebased automatically with its approval carried over", async (t) => {
  const f = await fixture(t, { version: 1, toolsUsed: 20, reviewRound: 2 });
  const before = await f.job();
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,'owner-approved',$2::jsonb,'suppressed')",
    [
      f.id,
      JSON.stringify({
        decision: "approved",
        approvedScope: requirementScope(before),
      }),
    ],
  );
  const moved = "f".repeat(40);
  f.setInspection({ checks: "passed", draft: false, main: moved });
  await f.auto.tick();
  const queued = await f.job();
  assert.equal(queued.state, "queued");
  assert.equal(queued.revision, 2);
  assert.equal(queued.base_sha, moved);
  assert.deepEqual(queued.checkpoint.files, []);
  assert.equal(queued.checkpoint.plan, before.checkpoint.plan);
  assert.deepEqual(queued.checkpoint.piState, {
    version: 1,
    toolsUsed: 20,
    reviewRound: 2,
  });
  assert.equal(f.counts().merges, 0);
  const requirements = new CodingRequirements(
    f.db,
    () => true,
    () => new Date(),
  );
  assert.equal(await requirements.approved(queued), true);
  const carried = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='rebase-approval:2'",
      [f.id],
    )
  ).rows[0].payload;
  assert.equal(carried.approvedScope, requirementScope(queued));
  assert.equal(carried.carriedFrom, requirementScope(before));
  const budget = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='feedback:2'",
      [f.id],
    )
  ).rows[0].payload;
  assert.equal(budget.remainingMs, 900000);
  const notice = (
    await f.db.query(
      "SELECT payload,delivery FROM coding_events WHERE job_id=$1 AND payload->>'summary' LIKE 'Main moved since this job started%'",
      [f.id],
    )
  ).rows;
  assert.equal(notice.length, 1);
  assert.equal(notice[0].delivery, "pending");
});

test("automatic rebases stop after two rounds and hand back to the owner", async (t) => {
  const f = await fixture(t);
  for (const n of [1, 2])
    await f.db.query(
      "INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) VALUES($1,$2,$3,'Rebase onto current main earlier','implement')",
      [f.id, 10 + n, `rebase:earlier-${n}`],
    );
  f.setInspection({ checks: "passed", draft: false, main: "f".repeat(40) });
  await f.auto.tick();
  const job = await f.job();
  assert.equal(job.state, "pr_ready");
  assert.equal(job.stage, "manual_review");
  assert.match(job.summary, /two automatic rebases/);
});

test("a rebase never carries over a scope the owner did not approve, and blocked PRs are not rebased", async (t) => {
  const f = await fixture(t);
  f.setInspection({ checks: "passed", draft: false, main: "f".repeat(40) });
  await f.auto.tick();
  // The fixture job has no recorded approval for its scope.
  const job = await f.job();
  assert.equal(job.state, "pr_ready");
  assert.equal(job.stage, "manual_review");
  assert.match(job.summary, /no recorded owner approval/);
});

/** The owner's "continue" as Chief's coding_resume call, through the real controller. */
async function continueAsOwner(
  f: Awaited<ReturnType<typeof fixture>>,
  requestKey: string,
) {
  const run = randomUUID();
  await f.db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'owner','continue the coding job')",
    [run],
  );
  const c = new CodingController(
    f.db,
    settings,
    {} as any,
    {} as any,
    "c".repeat(64),
    "https://coding.example.com",
    () => true,
    () => ({
      generate: async () => ({ message: { role: "assistant", content: "" } }),
    }),
    () => new Date(),
  );
  return c.call("owner", run, {
    operation: "coding_resume",
    id: f.id,
    baseRevision: (await f.job()).revision,
    requestKey,
  });
}

test("an owner continue re-runs the gates with fresh waits and a hold that applies again is a new notice", async (t) => {
  const f = await fixture(t);
  // Checks stayed unavailable for over an hour, so the PR stopped for the owner.
  await f.db.query(
    "UPDATE coding_events SET payload=jsonb_set(payload,'{waitingSince}',to_jsonb($2::text)) WHERE job_id=$1 AND event_key='automation:1'",
    [f.id, new Date(Date.now() - 2 * 86400000).toISOString()],
  );
  await f.auto.tick();
  await f.auto.tick();
  assert.equal((await f.job()).stage, "manual_review");
  const notices = async () =>
    (
      await f.db.query(
        "SELECT event_key,delivery FROM coding_events WHERE job_id=$1 AND event_key LIKE 'automation-notice:%' ORDER BY event_key",
        [f.id],
      )
    ).rows;
  assert.deepEqual(
    (await notices()).map((n) => n.event_key),
    ["automation-notice:1:manual_review"],
  );
  // The owner re-ran CI and asks to continue while it is still pending: the job waits, not re-parks.
  await continueAsOwner(f, "continue-1");
  assert.equal((await f.job()).stage, "awaiting_ci");
  await f.auto.tick();
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_ci");
  // A hold that applies again stops it, and the owner is told again.
  f.setInspection({ head: "f".repeat(40) });
  await f.auto.tick();
  const job = await f.job();
  assert.equal(job.stage, "manual_review");
  assert.match(job.summary, /PR changed outside the squad/);
  const sent = await notices();
  assert.deepEqual(
    sent.map((n) => n.event_key),
    [
      "automation-notice:1:manual_review",
      "automation-notice:1:manual_review:continue-1",
    ],
  );
  assert.equal(sent[1].delivery, "pending");
  assert.equal(f.counts().merges, 0);
});

test("continuing after Keep open offers a fresh card and the declined card stays refused", async (t) => {
  const f = await fixture(t);
  f.setInspection({ checks: "passed" });
  await f.auto.tick();
  await f.auto.tick();
  const declined = await f.deliverCard();
  await f.approvals.confirm("owner", declined.id, false, "owner", 55);
  assert.equal((await f.job()).stage, "merge_declined");
  await continueAsOwner(f, "continue-after-keep-open");
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_merge_approval");
  await assert.rejects(
    f.approvals.confirm("owner", declined.id, true, "owner", 55),
  );
  const fresh = await f.deliverCard(56);
  assert.notEqual(fresh.id, declined.id);
  assert.equal(f.counts().merges, 0);
  await f.approvals.confirm("owner", fresh.id, true, "owner", 56);
  assert.equal((await f.job()).stage, "merge_approved");
});

test("a PR that already merged cannot be continued back through the gates", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "UPDATE coding_events SET payload=payload || jsonb_build_object('mergeSha',$2::text) WHERE job_id=$1 AND event_key='automation:1'",
    [f.id, merged],
  );
  await f.db.query(
    "UPDATE coding_jobs SET stage='manual_review',summary='PR merged, but release failed' WHERE id=$1",
    [f.id],
  );
  await assert.rejects(
    continueAsOwner(f, "continue-merged"),
    (error: Error) => {
      assert(error instanceof ToolValidationError);
      assert.match(error.message, /already merged/);
      return true;
    },
  );
  assert.equal((await f.job()).stage, "manual_review");
});
