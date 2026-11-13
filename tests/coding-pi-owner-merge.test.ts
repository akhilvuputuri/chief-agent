import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { closeAfter, migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { CodingAutomation } from "../src/coding/automation.js";
import { CodingMergeApprovals } from "../src/coding/merge-approvals.js";
import { requirementScope } from "../src/coding/requirements.js";
import { CodingController, type CodingJob } from "../src/coding/controller.js";
import { ToolValidationError } from "../src/tool-errors.js";
import { codingSettings, outcome } from "../src/coding/schema.js";
import { artifactHash, canonicalJson } from "../src/coding/github.js";
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
  reviewerModel: "fixture/reviewer",
  runtime: "pi",
  prWorkflow: "owner_merge",
  maxOutputTokens: 16000,
  effort: "high",
});

/** The job's inbox items, oldest first (journal 192). */
async function inbox(f: { db: Database; id: string }) {
  return (
    await f.db.query(
      "SELECT id,event_key,payload FROM coding_events WHERE job_id=$1 AND event_key LIKE 'inbox:%' ORDER BY created_at,id",
      [f.id],
    )
  ).rows.map((r: any) => ({ id: r.id, key: r.event_key, ...r.payload }));
}
/** Earlier owner-merge feedback rounds, as their requeues recorded them. */
async function priorRounds(f: { db: Database; id: string }, n: number) {
  for (let i = 1; i <= n; i++)
    await f.db.query(
      "INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) VALUES($1,$2,$3,'Earlier feedback','implement')",
      [f.id, 100 + i, `mr-feedback:earlier-${i}`],
    );
}
async function fixture(
  t: TestContext,
  piState: any = undefined,
  paths: string[] = ["docs/fixture.md"],
) {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  await ensureUser(db, "owner");
  const id = randomUUID(),
    attempt = randomUUID();
  let now = new Date();
  const files = paths.map((path) => ({ path, content: "Fixture\n" }));
  const cp = {
    plan: "Owner-approved docs change",
    summary: "Added the fixture entry",
    patch: "fixture",
    files,
    piState: piState ?? { version: 1, delivered: [] },
  };
  const hash = artifactHash(cp);
  const result = outcome.parse({
    kind: "candidate",
    summary: "Added the fixture entry",
    checkpoint: cp,
    checks: ["check", "build", "format:check"].map((s) => ({
      command: `kite run ${s}`,
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
    readies = 0,
    release: "pending" | "success" | "failure" = "pending";
  let onInspect: (() => Promise<void>) | undefined;
  const repository = {
    outcome: async () => inspection,
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
    release: async () => release,
  };
  let started = true;
  let spent = false;
  const auto = new CodingAutomation(
    db,
    repository,
    () => true,
    async () => true,
    () => now,
    async () => started,
    async () => spent,
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
    setRelease: (v: typeof release) => (release = v),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    /** The job no longer has the owner's Start of its current request. */
    withoutStart: () => (started = false),
    /** The job's eight hours of machine time are spent. */
    outOfTime: () => (spent = true),
    counts: () => ({ merges, readies }),
  };
}

test("protected files reach the owner's Merge card, which names them; hard stops never do", async (t) => {
  const f = await fixture(t, undefined, [
    "src/coding/automation.ts",
    "src/runtime.ts",
    "docs/fixture.md",
  ]);
  await f.auto.tick();
  f.setInspection({ checks: "passed" });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_merge_approval");
  assert.equal(f.counts().merges, 0);
  const card = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND payload ? 'merge'",
      [f.id],
    )
  ).rows[0].payload;
  assert.match(card.summary, /Protected files changed/);
  assert.match(card.summary, /`src\/coding\/automation.ts`, `src\/runtime.ts`/);
  assert.doesNotMatch(card.summary, /docs\/fixture.md/);
  for (const path of [
    "db/033_example.sql",
    "compose.yaml",
    ".github/workflows/ci.yml",
    "deploy/.env",
  ]) {
    const g = await fixture(t, undefined, ["docs/fixture.md", path]);
    await g.auto.tick();
    g.setInspection({ checks: "passed" });
    await g.auto.tick();
    const stopped = await g.job();
    assert.equal(stopped.stage, "manual_review", path);
    assert.match(stopped.summary, /Chief does not merge this change/);
    assert.equal(g.counts().merges, 0);
    if (path.startsWith("db/"))
      assert.match(
        stopped.summary,
        /merge it on GitHub and right away run the database rollout for 033_example\.sql/,
      );
  }
});

test("a PR that needs operator work still gets its review feedback fixed first", async (t) => {
  const f = await fixture(t, undefined, [
    "docs/fixture.md",
    "db/036_example.sql",
  ]);
  f.setInspection({
    draft: false,
    feedback: [{ id: "devin-1", text: "Devin: the index is missing" }],
  });
  await f.auto.tick();
  const queued = await f.job();
  assert.equal(queued.state, "queued");
  assert.match((await inbox(f))[0].text, /the index is missing/);
});

test("a tool-picker change tells the owner to run the picker eval before merging", async (t) => {
  const f = await fixture(t, undefined, ["config/tool-picker.json"]);
  await f.auto.tick();
  f.setInspection({ checks: "passed" });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_merge_approval");
  const card = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND payload ? 'merge'",
      [f.id],
    )
  ).rows[0].payload;
  assert.match(card.summary, /Before merging:\*\* run `kite run eval:picker`/);
});
test("dependency and image changes are called out separately on the Merge card", async (t) => {
  const f = await fixture(t, undefined, [
    "package-lock.json",
    "Dockerfile.coding-pi",
  ]);
  await f.auto.tick();
  f.setInspection({ checks: "passed" });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_merge_approval");
  const card = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND payload ? 'merge'",
      [f.id],
    )
  ).rows[0].payload;
  assert.match(
    card.summary,
    /Dependencies or images changed.*`package-lock.json`, `Dockerfile.coding-pi`/s,
  );
  assert.doesNotMatch(card.summary, /Protected files changed/);
});
test("an ordinary owner-merge card carries no protected-files warning", async (t) => {
  const f = await fixture(t);
  await f.auto.tick();
  f.setInspection({ checks: "passed" });
  await f.auto.tick();
  const card = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND payload ? 'merge'",
      [f.id],
    )
  ).rows[0].payload;
  assert.doesNotMatch(card.summary, /Protected files changed/);
});
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

test("MR feedback becomes labelled inbox items for the same coder session, with the work kept", async (t) => {
  const f = await fixture(t);
  const published = await f.job();
  f.setInspection({
    draft: false,
    feedback: [{ id: "devin-1", text: "Devin: the heading level is wrong" }],
  });
  await f.auto.tick();
  const queued = await f.job();
  assert.equal(queued.state, "queued");
  assert.equal(queued.revision, 2);
  // The checkpoint, and with it the job's sessions, is kept as it was.
  assert.deepEqual(queued.checkpoint, (await f.job()).checkpoint);
  assert.deepEqual(queued.checkpoint.piState, { version: 1, delivered: [] });
  assert.deepEqual(
    (await inbox(f)).map(({ key, source, text }) => ({ key, source, text })),
    [
      {
        key: "inbox:gh:devin-1",
        source: "review",
        text: "Devin: the heading level is wrong",
      },
    ],
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
  assert.deepEqual(budget.handled, []);
  // Published again with the same comment still on GitHub: its inbox item marks it handled.
  await f.db.query(
    "UPDATE coding_jobs SET state='pr_ready',stage='pr_ready',result=$2::jsonb WHERE id=$1",
    [f.id, JSON.stringify(published.result)],
  );
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,delivery) SELECT job_id,'automation:2',payload,'suppressed' FROM coding_events WHERE job_id=$1 AND event_key='automation:1'",
    [f.id],
  );
  await f.auto.tick();
  const again = await f.job();
  assert.equal(again.state, "pr_ready");
  assert.notEqual(again.stage, "manual_review", again.summary);
  assert.equal((await inbox(f)).length, 1);

  // A fourth round is delivered like the first: there is no round count (journal 193).
  const later = await fixture(t);
  await priorRounds(later, 3);
  later.setInspection({
    draft: false,
    feedback: [{ id: "devin-9", text: "Devin: still wrong" }],
  });
  await later.auto.tick();
  assert.equal((await later.job()).state, "queued");
  assert.deepEqual(
    (await inbox(later)).map((i) => i.key),
    ["inbox:gh:devin-9"],
  );
  assert.equal(later.counts().merges, 0);
});

test("every feedback item is delivered whole, however long or however many (journal 193)", async (t) => {
  const f = await fixture(t);
  const ci = JSON.stringify({ job: "check", log: "x".repeat(20_000) });
  const many = Array.from({ length: 250 }, (_, n) => ({
    id: `devin-${n}`,
    text: `Devin finding ${n}: ${"y".repeat(100)}`,
  }));
  f.setInspection({
    draft: false,
    feedback: [{ id: "ci:1:1:9", text: ci }, ...many],
  });
  await f.auto.tick();
  assert.equal((await f.job()).state, "queued");
  const items = await inbox(f);
  assert.equal(items.length, 251);
  assert.equal(items.find((i) => i.source === "ci")?.text, ci);
  // The inbox items are the record of what was handled; no list is copied (journal 193).
  const budget = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='feedback:2'",
      [f.id],
    )
  ).rows[0].payload;
  assert.deepEqual(budget.handled, []);
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

test("a CI failure becomes an untrusted CI inbox item", async (t) => {
  const f = await fixture(t);
  f.setInspection({
    draft: false,
    checks: "failed",
    feedback: [
      { id: "ci:1:1:9", text: '{"job":"test","conclusion":"failure"}' },
    ],
  });
  await f.auto.tick();
  assert.equal((await f.job()).state, "queued");
  const [item] = await inbox(f);
  assert.equal(item.key, "inbox:gh:ci:1:1:9");
  assert.equal(item.source, "ci");
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

test("a PR that conflicts with main goes back to its box with its work, sessions and Start kept, to be rebased (journal 193)", async (t) => {
  const reviewed = {
    hash: "1".repeat(64),
    base,
    patch: "fixture",
    verdict: "APPROVE" as const,
  };
  const f = await fixture(t, { version: 1, delivered: [], reviewed });
  const before = await f.job();
  const moved = "f".repeat(40);
  f.setInspection({
    checks: "passed",
    draft: false,
    main: moved,
    mergeable: false,
  });
  await f.auto.tick();
  const queued = await f.job();
  assert.equal(queued.state, "queued");
  assert.equal(queued.revision, 2);
  assert.equal(queued.base_sha, moved);
  // The work and the job's sessions are kept as they were: nothing is re-implemented.
  assert.deepEqual(queued.checkpoint, before.checkpoint);
  assert.equal(f.counts().merges, 0);
  const [rebase] = await inbox(f);
  assert.equal(rebase.key, `inbox:rebase:${moved}:2`);
  assert.equal(rebase.source, "rebase");
  assert.equal(rebase.from, base);
  assert.equal(rebase.onto, moved);
  // The owner's Start carries over because the request it approved did not change: the
  // approval covers the request, not the base. No approval is copied.
  assert.equal(requirementScope(queued), requirementScope(before));
  assert.equal(
    (
      await f.db.query(
        "SELECT 1 FROM coding_events WHERE job_id=$1 AND (event_key LIKE 'rebase-approval:%' OR event_key LIKE 'rebase-candidate:%')",
        [f.id],
      )
    ).rows.length,
    0,
  );
  const budget = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='feedback:2'",
      [f.id],
    )
  ).rows[0].payload;
  assert.deepEqual(budget, { handled: [] });
  const notice = (
    await f.db.query(
      "SELECT payload,delivery FROM coding_events WHERE job_id=$1 AND payload->>'summary' LIKE 'The PR conflicts with recent changes on main%'",
      [f.id],
    )
  ).rows;
  assert.equal(notice.length, 1);
  assert.equal(notice[0].delivery, "pending");
  assert.match(notice[0].payload.summary, /rebasing your change onto main/);
  // A second tick finds the job queued and does nothing more.
  await f.auto.tick();
  assert.equal((await inbox(f)).length, 1);
});

test("a conflict on a job without the owner's Start of its request stops for the owner", async (t) => {
  const f = await fixture(t);
  f.withoutStart();
  f.setInspection({
    checks: "passed",
    draft: false,
    main: "f".repeat(40),
    mergeable: false,
  });
  await f.auto.tick();
  const job = await f.job();
  assert.equal(job.state, "pr_ready");
  assert.equal(job.stage, "manual_review");
  assert.equal(job.base_sha, base);
  assert.match(job.summary, /no owner Start of its current request/);
  assert.equal((await inbox(f)).length, 0);
});

test("feedback on a job without the owner's Start of its request goes to the owner, not to a box that would refuse it", async (t) => {
  const f = await fixture(t);
  f.withoutStart();
  f.setInspection({
    draft: false,
    feedback: [{ id: "devin-1", text: "Devin: rename it" }],
  });
  await f.auto.tick();
  const job = await f.job();
  assert.equal(job.state, "pr_ready");
  assert.equal(job.stage, "manual_review");
  assert.match(job.summary, /no owner Start of its current request/);
  assert.equal((await inbox(f)).length, 0);
});

test("a conflicting PR is rebased however many times main conflicted before", async (t) => {
  const f = await fixture(t);
  for (const n of [1, 2, 3])
    await f.db.query(
      "INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) VALUES($1,$2,$3,'Earlier rebase','implement')",
      [f.id, 10 + n, `rebase:earlier-${n}`],
    );
  f.setInspection({
    checks: "passed",
    draft: false,
    main: "f".repeat(40),
    mergeable: false,
  });
  await f.auto.tick();
  const job = await f.job();
  assert.equal(job.state, "queued");
  assert.equal(job.base_sha, "f".repeat(40));
});

test("main moving with a clean merge changes nothing: the card, the tap, the merge and the release all proceed (journal 180)", async (t) => {
  const f = await fixture(t);
  const moved = "f".repeat(40);
  // A docs-only commit lands on main before the PR is even marked ready.
  f.setInspection({ main: moved, base: moved });
  await f.auto.tick();
  assert.equal(f.counts().readies, 1);
  assert.equal((await f.job()).stage, "awaiting_ci");
  f.setInspection({ checks: "passed" });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_merge_approval");
  const card = await f.deliverCard();
  assert.deepEqual(card.payload.merge, { revision: 1, head, tree });
  // Main moves again while the card waits; still nothing to do.
  const later = "e".repeat(40);
  f.setInspection({ main: later, base: later });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_merge_approval");
  await f.approvals.confirm("owner", card.id, true, "owner", 55);
  await f.auto.tick();
  assert.equal(f.counts().merges, 1);
  const merging = await f.job();
  assert.equal(merging.stage, "release_pending");
  // Nothing about the job was rebuilt: same revision, base, head and saved change.
  assert.equal(merging.revision, 1);
  assert.equal(merging.base_sha, base);
  assert.equal(merging.head_sha, head);
  assert.equal(merging.checkpoint.files.length, 1);
  const rebuilt = (
    await f.db.query(
      "SELECT 1 FROM coding_revisions WHERE job_id=$1 AND request_key LIKE 'rebase:%'",
      [f.id],
    )
  ).rows;
  assert.equal(rebuilt.length, 0);
  // The release is tracked by the merge commit GitHub made on the moved main.
  f.setRelease("success");
  await f.auto.tick();
  const deployed = await f.job();
  assert.equal(deployed.stage, "deployed");
  assert.match(deployed.summary, new RegExp(merged));
});

test("unknown mergeability waits without dropping the card or the owner's tap, and is never a conflict", async (t) => {
  const f = await fixture(t);
  f.setInspection({ checks: "passed" });
  await f.auto.tick();
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_merge_approval");
  const card = await f.deliverCard();
  // Main moved; GitHub is recomputing mergeability. Hours pass.
  f.setInspection({ main: "f".repeat(40), mergeable: null });
  f.advance(2 * 3600000);
  await f.auto.tick();
  const waiting = await f.job();
  assert.equal(waiting.stage, "awaiting_merge_approval");
  assert.equal(waiting.state, "pr_ready");
  await f.approvals.confirm("owner", card.id, true, "owner", 55);
  await f.auto.tick();
  const approved = await f.job();
  assert.equal(approved.stage, "merge_approved");
  assert.equal(approved.revision, 1);
  assert.equal(f.counts().merges, 0);
  // Mergeability turns unknown again between the first and final reads of the merge tick.
  f.setInspection({ mergeable: true });
  f.onNextInspect(async () => {
    f.onNextInspect(async () => {
      f.setInspection({ mergeable: null });
    });
  });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "merge_approved");
  assert.equal(f.counts().merges, 0);
  f.setInspection({ mergeable: true });
  await f.auto.tick();
  assert.equal(f.counts().merges, 1);
  assert.equal((await f.job()).stage, "release_pending");
  const cards = (
    await f.db.query(
      "SELECT 1 FROM coding_events WHERE job_id=$1 AND payload ? 'merge'",
      [f.id],
    )
  ).rows;
  assert.equal(cards.length, 1);
});

test("a conflict reading with main unmoved is stale: it waits and nothing is rebased", async (t) => {
  const f = await fixture(t);
  f.setInspection({ checks: "passed", draft: false, mergeable: false });
  await f.auto.tick();
  const waiting = await f.job();
  assert.equal(waiting.state, "pr_ready");
  assert.equal(waiting.revision, 1);
  assert.equal(waiting.stage, "awaiting_ci");
  assert.equal(waiting.checkpoint.files.length, 1);
  f.setInspection({ mergeable: true });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_merge_approval");
  assert.equal(f.counts().merges, 0);
});

/** Brings the fixture job to an owner Merge tap that has not yet been acted on. */
async function tapped(f: Awaited<ReturnType<typeof fixture>>) {
  f.setInspection({ checks: "passed" });
  await f.auto.tick();
  await f.auto.tick();
  const card = await f.deliverCard();
  await f.approvals.confirm("owner", card.id, true, "owner", 55);
  assert.equal((await f.job()).stage, "merge_approved");
}

test("unknown mergeability never keeps a tap alive past a real change to the PR", async (t) => {
  // (a) New feedback goes to the coder; the tap is gone with the old revision.
  const a = await fixture(t);
  await tapped(a);
  a.setInspection({
    mergeable: null,
    feedback: [{ id: "devin-2", text: "Devin: a new finding" }],
  });
  await a.auto.tick();
  const queued = await a.job();
  assert.equal(queued.state, "queued");
  assert.equal(queued.revision, 2);
  assert.equal(a.counts().merges, 0);

  // (b) An open review thread drops the tap; once resolved, a fresh card is needed.
  const b = await fixture(t);
  await tapped(b);
  b.setInspection({ mergeable: null, unresolvedThreads: 1 });
  await b.auto.tick();
  assert.equal((await b.job()).stage, "awaiting_ci");
  b.setInspection({ mergeable: true, unresolvedThreads: 0 });
  await b.auto.tick();
  assert.equal((await b.job()).stage, "awaiting_merge_approval");
  assert.equal(b.counts().merges, 0);
  const cards = (
    await b.db.query(
      "SELECT 1 FROM coding_events WHERE job_id=$1 AND payload ? 'merge'",
      [b.id],
    )
  ).rows;
  assert.equal(cards.length, 2);

  // (c) Failing checks stop the job.
  const c = await fixture(t);
  await tapped(c);
  c.setInspection({ mergeable: null, checks: "failed" });
  await c.auto.tick();
  assert.equal((await c.job()).stage, "manual_review");
  assert.equal(c.counts().merges, 0);

  // (d) A changed head stops the job.
  const d = await fixture(t);
  await tapped(d);
  d.setInspection({ mergeable: null, head: "f".repeat(40) });
  await d.auto.tick();
  assert.equal((await d.job()).stage, "manual_review");
  assert.equal(d.counts().merges, 0);

  // (e) Fresh feedback on the final read before merge drops the tap even while unknown.
  const e = await fixture(t);
  await tapped(e);
  e.onNextInspect(async () => {
    e.onNextInspect(async () => {
      e.setInspection({
        mergeable: null,
        feedback: [{ id: "devin-3", text: "Devin: late finding" }],
      });
    });
  });
  await e.auto.tick();
  assert.equal((await e.job()).stage, "awaiting_ci");
  assert.equal(e.counts().merges, 0);
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

test("a PR waiting days for CI keeps waiting; it is never parked for the wait (journal 193)", async (t) => {
  const f = await fixture(t);
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_ci");
  f.advance(2 * 86400000);
  await f.auto.tick();
  f.setInspection({ mergeable: null, unresolvedThreads: 1 });
  f.advance(2 * 86400000);
  await f.auto.tick();
  const job = await f.job();
  assert.equal(job.stage, "awaiting_ci");
  assert.match(job.summary, /resolve outstanding GitHub threads/);
});

test("an owner continue re-runs the gates with fresh waits and a hold that applies again is a new notice", async (t) => {
  const f = await fixture(t);
  // GitHub could not be read for over an hour, so the PR stopped for the owner.
  await f.db.query(
    "UPDATE coding_events SET payload=jsonb_set(payload,'{waitingSince}',to_jsonb($2::text)) WHERE job_id=$1 AND event_key='automation:1'",
    [f.id, new Date(Date.now() - 2 * 86400000).toISOString()],
  );
  f.onNextInspect(async () => {
    throw new Error("GitHub unavailable");
  });
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

/** The owner's fix request through Chief, as coding_reply on the job with an open PR. */
async function replyAsOwner(
  f: Awaited<ReturnType<typeof fixture>>,
  requestKey: string,
  message: string,
) {
  const run = randomUUID();
  await f.db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'owner','fix the coding PR')",
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
    operation: "coding_reply",
    id: f.id,
    baseRevision: (await f.job()).revision,
    requestKey,
    message,
  });
}

test("the owner's fix request on a stopped PR goes to the coder on the same PR", async (t) => {
  const f = await fixture(t, undefined, [
    "docs/fixture.md",
    "db/036_example.sql",
  ]);
  await f.auto.tick();
  f.setInspection({ checks: "passed" });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "manual_review");
  await replyAsOwner(f, "fix-1", "Keep the buttons when a tap fails.");
  const waiting = await f.job();
  assert.equal(waiting.stage, "awaiting_ci");
  assert.match(waiting.summary, /The owner asked for changes/);
  await replyAsOwner(f, "fix-1", "Keep the buttons when a tap fails.");
  await assert.rejects(
    replyAsOwner(f, "fix-1", "Something else"),
    /request key conflict/,
  );
  await f.auto.tick();
  const queued = await f.job();
  assert.equal(queued.state, "queued");
  // The owner's own words, labelled as the owner's (journal 192).
  const [request] = await inbox(f);
  assert.equal(request.source, "owner");
  assert.equal(request.text, "Keep the buttons when a tap fails.");
  const handled = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='feedback:2'",
      [f.id],
    )
  ).rows[0].payload.handled;
  // A Pi round copies no handled list (journal 193): the request is marked delivered.
  assert.deepEqual(handled, []);
  const marked = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='owner-feedback:fix-1'",
      [f.id],
    )
  ).rows[0].payload;
  assert.equal(typeof marked.deliveredRound, "number");
});

test("a fix request waits for the next round on a PR still in checks", async (t) => {
  const f = await fixture(t);
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_ci");
  await replyAsOwner(f, "fix-2", "Rename the heading.");
  assert.equal((await f.job()).stage, "awaiting_ci");
  await f.auto.tick();
  assert.equal((await f.job()).state, "queued");
});

test("a merged or finished PR cannot take a fix request", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "UPDATE coding_jobs SET stage='merged_on_github' WHERE id=$1",
    [f.id],
  );
  await assert.rejects(
    replyAsOwner(f, "fix-3", "Rename the heading."),
    /can no longer change/,
  );
  const g = await fixture(t);
  await g.db.query("UPDATE coding_jobs SET stage='manual_review' WHERE id=$1", [
    g.id,
  ]);
  await g.db.query(
    "UPDATE coding_events SET payload=payload || jsonb_build_object('mergeSha',$2::text) WHERE job_id=$1 AND event_key='automation:1'",
    [g.id, "d".repeat(40)],
  );
  await assert.rejects(
    replyAsOwner(g, "fix-4", "Rename the heading."),
    /already merged/,
  );
});

test("a hard-stop PR never merges, even with an owner approval already recorded", async (t) => {
  const f = await fixture(t, undefined, [
    "docs/fixture.md",
    "db/036_example.sql",
  ]);
  await f.auto.tick();
  f.setInspection({ checks: "passed" });
  await f.db.query(
    "UPDATE coding_jobs SET stage='merge_approved' WHERE id=$1",
    [f.id],
  );
  await f.auto.tick();
  const job = await f.job();
  assert.equal(job.stage, "manual_review");
  assert.equal(f.counts().merges, 0);
  const cards = await f.db.query(
    "SELECT 1 FROM coding_events WHERE job_id=$1 AND payload ? 'merge'",
    [f.id],
  );
  assert.equal(cards.rows.length, 0);
});

test("a fix request is taken after any number of rounds and at any length (journal 193)", async (t) => {
  const f = await fixture(t);
  await priorRounds(f, 3);
  await f.db.query("UPDATE coding_jobs SET stage='manual_review' WHERE id=$1", [
    f.id,
  ]);
  await replyAsOwner(f, "fix-5", "One more fix.");
  await replyAsOwner(f, "fix-6", "x".repeat(20_000));
  assert.equal((await f.job()).stage, "awaiting_ci");
  f.setInspection({ draft: false });
  await f.auto.tick();
  assert.equal((await f.job()).state, "queued");
  assert.deepEqual(
    (await inbox(f)).map((i) => i.text.length).sort((a, b) => a - b),
    ["One more fix.".length, 20_000],
  );
});

test("a fix request on a PR stopped for over a day needs the owner's explicit say-so", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "UPDATE coding_jobs SET stage='manual_review',updated_at=now()-interval '3 days' WHERE id=$1",
    [f.id],
  );
  await assert.rejects(
    replyAsOwner(f, "fix-7", "Rename the heading."),
    /waiting since/,
  );
  assert.equal((await f.job()).stage, "manual_review");
});

test("an owner request is sent once, even if a later round starts without its handled list", async (t) => {
  const f = await fixture(t);
  await f.auto.tick();
  await replyAsOwner(f, "fix-8", "Rename the heading.");
  const before = await f.job();
  await f.auto.tick();
  assert.equal((await f.job()).state, "queued");
  const delivered = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='owner-feedback:fix-8'",
      [f.id],
    )
  ).rows[0].payload;
  assert.equal(delivered.deliveredRound, 1);
  // As after an automatic retry: a new revision is published with no handled list. Its
  // coder received the request (the checkpoint lists the inbox item as delivered).
  const sent = (await inbox(f)).map((i: any) => i.id);
  const withDelivery = {
    ...before.checkpoint,
    piState: { ...before.checkpoint.piState, delivered: sent },
  };
  await f.db.query(
    "UPDATE coding_jobs SET state='pr_ready',stage='pr_ready',revision=revision+1,attempt_id=$2,result=$3::jsonb,checkpoint=$4::jsonb WHERE id=$1",
    [
      f.id,
      before.attempt_id,
      JSON.stringify({ ...before.result, checkpoint: withDelivery }),
      JSON.stringify(withDelivery),
    ],
  );
  await f.auto.start(await f.job(), "c".repeat(40));
  f.setInspection({ draft: false, checks: "passed" });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_merge_approval");
});

test("a round that loses its lease leaves the owner's request for the next one", async (t) => {
  const f = await fixture(t);
  await f.auto.tick();
  await replyAsOwner(f, "fix-9", "Rename the heading.");
  f.onNextInspect(async () => {
    await f.db.query(
      "UPDATE coding_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",
      [f.id],
    );
  });
  await f.auto.tick();
  assert.notEqual((await f.job()).state, "queued");
  const pending = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='owner-feedback:fix-9'",
      [f.id],
    )
  ).rows[0].payload;
  assert.equal(pending.deliveredRound, undefined);
  await f.auto.tick();
  assert.equal((await f.job()).state, "queued");
});

test("requests waiting together all reach the next round (journal 193)", async (t) => {
  const f = await fixture(t);
  await f.auto.tick();
  await replyAsOwner(f, "fix-10", "a".repeat(5000));
  await replyAsOwner(f, "fix-11", "b".repeat(5000));
  f.setInspection({ draft: false });
  await f.auto.tick();
  assert.equal((await f.job()).state, "queued");
  assert.equal((await inbox(f)).length, 2);
});

test("an owner message kept while the job was publishing starts a feedback round once the PR is open", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,'inbox:reply:kept',$2::jsonb,'suppressed')",
    [
      f.id,
      JSON.stringify({
        kind: "inbox",
        source: "owner",
        text: "Also update the docs.",
      }),
    ],
  );
  f.setInspection({ draft: false });
  await f.auto.tick();
  const queued = await f.job();
  assert.equal(queued.state, "queued");
  // The kept item itself is what the coder gets; no copy is made.
  const items = await inbox(f);
  assert.equal(items.length, 1);
  assert.equal(items[0].key, "inbox:reply:kept");
  const handled = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='feedback:2'",
      [f.id],
    )
  ).rows[0].payload.handled;
  assert.deepEqual(handled, []);
});

test("with its machine time spent, feedback and a conflict stop for the owner instead of starting a box (journal 193)", async (t) => {
  const f = await fixture(t);
  f.outOfTime();
  f.setInspection({
    draft: false,
    feedback: [{ id: "ci:1:1:1", text: "CI failed" }],
  });
  await f.auto.tick();
  let job = await f.job();
  assert.equal(job.state, "pr_ready");
  assert.equal(job.stage, "manual_review");
  assert.equal(
    job.summary,
    "This job has used its eight hours of machine time; resume it to continue.",
  );
  assert.equal((await inbox(f)).length, 0);
  const g = await fixture(t);
  g.outOfTime();
  g.setInspection({
    checks: "passed",
    draft: false,
    main: "f".repeat(40),
    mergeable: false,
  });
  await g.auto.tick();
  job = await g.job();
  assert.equal(job.stage, "manual_review");
  assert.equal(job.base_sha, base);
  assert.match(job.summary, /eight hours of machine time/);
});

test("an hour into a wait for CI the owner hears once, and the PR keeps waiting (journal 193)", async (t) => {
  const f = await fixture(t);
  await f.auto.tick();
  await f.auto.tick();
  const notices = async () =>
    (
      await f.db.query(
        "SELECT payload,delivery FROM coding_events WHERE job_id=$1 AND event_key LIKE 'ci-wait:%'",
        [f.id],
      )
    ).rows;
  assert.equal((await notices()).length, 0);
  f.advance(3_600_001);
  await f.auto.tick();
  f.advance(3 * 3_600_000);
  await f.auto.tick();
  const sent = await notices();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].delivery, "pending");
  assert.match(sent[0].payload.summary, /waited an hour for CI/);
  assert.equal(
    sent[0].payload.url,
    "https://github.com/akhilvuputuri/chief-agent/pull/7",
  );
  assert.equal((await f.job()).stage, "awaiting_ci");
});
