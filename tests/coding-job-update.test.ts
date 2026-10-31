import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CodingController } from "../src/coding/controller.js";
import {
  CodingRequirements,
  requirementScope,
} from "../src/coding/requirements.js";
import { canonicalJson } from "../src/coding/github.js";
import { codingSettings } from "../src/coding/schema.js";
import { fixture, settings } from "./helpers/coding-fixture.js";

const opus = "anthropic/claude-opus-5.5";
const pricey = "synthetic/too-expensive";
const session = "a".repeat(64);

async function setup(t: TestContext, phase: "build" | "review" = "review") {
  const f = await fixture(t);
  const selected = codingSettings.parse({
    ...settings,
    runtime: "pi",
    squad: false,
    autoMerge: false,
    leaderModel: "synthetic/leader",
    model: "synthetic/coder",
    reviewerModel: "synthetic/reviewer",
    contextWindows: {
      "synthetic/leader": 2048,
      "synthetic/coder": 4096,
      "synthetic/reviewer": 8192,
    },
  });
  const c = new CodingController(
    f.db,
    selected,
    f.provider,
    f.publisher,
    "c".repeat(64),
    "https://coding.example.com",
    (user) => user === "a",
    () => {
      throw new Error("Changing settings does not dispatch inference");
    },
    undefined,
    async () => [
      {
        id: opus,
        inputPrice: 0.1,
        outputPrice: 0.5,
        tools: true,
        contextWindow: 1_000_000,
      },
      { id: pricey, inputPrice: 1e6, outputPrice: 1e6, tools: true },
    ],
  );
  const started = (await c.call("a", f.run, {
    operation: "coding_start",
    requestKey: "start",
    objective: "Fix a synthetic bug",
    context: "Synthetic evidence",
    mode: "plan",
  })) as any;
  const checkpoint = {
    plan: "Fix the fixture",
    patch: "",
    summary: "",
    files: [{ path: "src/a.ts", content: "kept\n" }],
    piState: {
      version: 1,
      toolsUsed: 3,
      phase,
      reviewRound: 1,
      sessionScope: session,
    },
  };
  await f.db.query(
    "UPDATE coding_jobs SET mode='implement',state='paused',stage='paused',lease=NULL,cleanup='none',checkpoint=$2::jsonb,settings=$3::jsonb WHERE id=$1",
    [started.id, JSON.stringify(checkpoint), JSON.stringify(selected)],
  );
  const row = async () =>
    (await f.db.query("SELECT * FROM coding_jobs WHERE id=$1", [started.id]))
      .rows[0];
  const update = (fields: Record<string, unknown>, requestKey = "change") =>
    c.call("a", f.run, {
      operation: "coding_job_update",
      id: started.id,
      baseRevision: 1,
      requestKey,
      ownerConfirmed: true,
      ...fields,
    } as any);
  const requirements = new CodingRequirements(
    f.db,
    () => true,
    () => new Date(),
  );
  return { f, c, row, update, requirements, id: started.id as string };
}
const approve = (db: any, id: string, scope: string) =>
  db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,'approved',$2::jsonb,'suppressed')",
    [id, JSON.stringify({ decision: "approved", approvedScope: scope })],
  );
const legacyScope = (job: any) =>
  createHash("sha256")
    .update(
      canonicalJson({
        id: job.id,
        objective: job.objective,
        context: job.context,
        baseSha: job.base_sha,
        settings: job.settings,
        plan: job.checkpoint.plan,
      }),
    )
    .digest("hex");

test("an approval covers the objective, context and plan, not who carries them out", async (t) => {
  const { f, row, requirements, id } = await setup(t);
  const job = await row();
  await approve(f.db, id, requirementScope(job));
  assert.equal(await requirements.approved(job), true);
  for (const changed of [
    { ...job, settings: { ...job.settings, reviewerModel: opus } },
    { ...job, settings: { ...job.settings, image: "" } },
    { ...job, base_sha: "f".repeat(40) },
  ])
    assert.equal(await requirements.approved(changed), true);
  for (const changed of [
    { ...job, objective: "Something else" },
    { ...job, context: "Other context" },
    { ...job, checkpoint: { ...job.checkpoint, plan: "Another plan" } },
  ])
    assert.equal(await requirements.approved(changed), false);
});

test("an approval recorded under the earlier scope stays valid, and a settings change carries it", async (t) => {
  const { f, row, update, requirements, id } = await setup(t);
  const job = await row();
  await approve(f.db, id, legacyScope(job));
  assert.equal(await requirements.approved(job), true);
  await update({ reviewerModel: opus });
  const after = await row();
  assert.equal(after.settings.reviewerModel, opus);
  assert.equal(await requirements.approved(after), true);
});

test("a changed job with no approval stays unapproved", async (t) => {
  const { row, update, requirements } = await setup(t);
  await update({ reviewerModel: opus });
  assert.equal(await requirements.approved(await row()), false);
});

test("changing the reviewer during review restarts its session and keeps the work", async (t) => {
  const { f, row, update, id } = await setup(t);
  const before = await row();
  await approve(f.db, id, requirementScope(before));
  await update({ reviewerModel: opus });
  const after = await row();
  assert.equal(after.state, "paused");
  assert.equal(after.revision, before.revision);
  assert.notEqual(after.checkpoint.piState.sessionScope, session);
  assert.match(after.checkpoint.piState.sessionScope, /^[a-f0-9]{64}$/);
  assert.deepEqual(after.checkpoint.files, before.checkpoint.files);
  assert.equal(after.checkpoint.plan, before.checkpoint.plan);
  assert.deepEqual(after.settings.contextWindows, {
    "synthetic/leader": 2048,
    "synthetic/coder": 4096,
    [opus]: 1_000_000,
  });
  const notice = (
    await f.db.query(
      "SELECT payload,delivery FROM coding_events WHERE job_id=$1 AND event_key='settings:change'",
      [id],
    )
  ).rows[0];
  assert.equal(notice.delivery, "pending");
  assert.deepEqual(notice.payload.changes, [
    { field: "Reviewer", from: "synthetic/reviewer", to: opus },
  ]);
  assert.match(
    notice.payload.summary,
    /approval of the requirements still stands/,
  );
  assert.match(notice.payload.summary, /stays stopped/);
});

test("the session restarts only when the model of the current step changes", async (t) => {
  const building = await setup(t, "build");
  await building.update({ reviewerModel: opus, limits: { ms: 60000 } });
  const kept = await building.row();
  assert.equal(kept.checkpoint.piState.sessionScope, session);
  assert.equal(kept.settings.limits.ms, 60000);
  assert.equal(kept.settings.limits.models, settings.limits.models);
  await building.update({ coderModel: opus }, "coder");
  assert.notEqual(
    (await building.row()).checkpoint.piState.sessionScope,
    session,
  );
});

test("an identical retry is answered from its record and a reused key is refused", async (t) => {
  const { f, row, update, id } = await setup(t);
  await update({ reviewerModel: opus });
  const first = await row();
  await update({ reviewerModel: opus });
  assert.deepEqual((await row()).checkpoint, first.checkpoint);
  await assert.rejects(update({ coderModel: opus }), /request key conflict/);
  const notices = await f.db.query(
    "SELECT 1 FROM coding_events WHERE job_id=$1 AND event_key LIKE 'settings:%'",
    [id],
  );
  assert.equal(notices.rows.length, 1);
});

test("a job update refuses active jobs, stale revisions, ineligible models and other owners", async (t) => {
  const { f, c, row, update, id } = await setup(t);
  const before = (await row()).settings;
  await assert.rejects(update({ reviewerModel: pricey }), /price filters/);
  await assert.rejects(
    update({ reviewerModel: "synthetic/missing" }),
    /unavailable/,
  );
  await assert.rejects(
    update({ reviewerModel: "synthetic/reviewer" }),
    /already has/,
  );
  await assert.rejects(
    c.call("a", f.run, {
      operation: "coding_job_update",
      id,
      baseRevision: 9,
      requestKey: "stale",
      ownerConfirmed: true,
      reviewerModel: opus,
    } as any),
    /revision changed/,
  );
  await assert.rejects(
    c.call("a", f.run, {
      operation: "coding_job_update",
      id,
      baseRevision: 1,
      requestKey: "unconfirmed",
      reviewerModel: opus,
    } as any),
  );
  await assert.rejects(
    c.call("b", f.run, {
      operation: "coding_job_update",
      id,
      baseRevision: 1,
      requestKey: "other",
      ownerConfirmed: true,
      reviewerModel: opus,
    } as any),
  );
  await f.db.query("UPDATE coding_jobs SET state='running' WHERE id=$1", [id]);
  await assert.rejects(update({ reviewerModel: opus }), /stopped job/);
  assert.deepEqual((await row()).settings, before);
});
