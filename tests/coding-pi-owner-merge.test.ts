import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { CodingAutomation } from "../src/coding/automation.js";
import { CodingMergeApprovals } from "../src/coding/merge-approvals.js";
import type { CodingJob } from "../src/coding/controller.js";
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
  const repository = {
    inspect: async () => inspection,
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
  return {
    db,
    auto,
    approvals,
    job,
    id,
    deliverCard,
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
