import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codingApi } from "../src/coding/api.js";
import { runPiWorker, NativePiWorkerClient } from "../src/coding/pi-worker.js";
import { server } from "../src/server.js";
import { reviewDocumentReader } from "./helpers/pi-review-documents.js";
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
      reviewCandidate: { hash: "b".repeat(64), checks: [] },
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
  assert.equal(after.checkpoint.piState.reviewRound, 2);
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

test("a transiently paused job the owner changed is not retried automatically", async (t) => {
  const { f, c, row, update, id } = await setup(t);
  await f.db.query(
    "UPDATE coding_jobs SET attempt_id=gen_random_uuid(),updated_at=now()-interval '3 minutes' WHERE id=$1",
    [id],
  );
  const attempt = (await row()).attempt_id;
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload) VALUES($1,$2,$3::jsonb)",
    [id, `${attempt}:paused`, JSON.stringify({ cause: "sandbox_stopped" })],
  );
  const before = (await row()).updated_at;
  await update({ reviewerModel: opus });
  assert.deepEqual((await row()).updated_at, before);
  await c.autoRetryOnce();
  assert.equal((await row()).state, "paused");
});

test("a switched coder or reviewer does not inherit a report failure", async (t) => {
  for (const [phase, field] of [
    ["build", "coderModel"],
    ["review", "reviewerModel"],
  ] as const) {
    const { f, row, update, id } = await setup(t, phase);
    const before = await row();
    await f.db.query(
      "UPDATE coding_jobs SET checkpoint=$2::jsonb WHERE id=$1",
      [
        id,
        JSON.stringify({
          ...before.checkpoint,
          piState: { ...before.checkpoint.piState, reportFailure: "Too long" },
        }),
      ],
    );
    await update({ [field]: opus });
    const { piState } = (await row()).checkpoint;
    assert.equal(piState.reportFailure, undefined);
    assert.notEqual(piState.sessionScope, session);
  }
});

test("a report failure stays when the current step's model is unchanged", async (t) => {
  const { f, row, update, id } = await setup(t, "build");
  const before = await row();
  await f.db.query("UPDATE coding_jobs SET checkpoint=$2::jsonb WHERE id=$1", [
    id,
    JSON.stringify({
      ...before.checkpoint,
      piState: { ...before.checkpoint.piState, reportFailure: "Too long" },
    }),
  ]);
  await update({ reviewerModel: opus });
  const { piState } = (await row()).checkpoint;
  assert.equal(piState.reportFailure, "Too long");
  assert.equal(piState.sessionScope, session);
});

test("a limit is refused when it cannot take effect", async (t) => {
  const { update } = await setup(t);
  await assert.rejects(update({ limits: { tools: 2 } }), /already used/);
  await assert.rejects(
    update({ limits: { ms: 14_400_000 } }),
    /most one attempt/,
  );
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

test("a worker reviews with the new reviewer in a fresh round after a switch", async (t) => {
  const f = await fixture(t);
  (f.c as any).catalog = async () => [
    { id: opus, inputPrice: 0.1, outputPrice: 0.5, tools: true },
  ];
  const root = await mkdtemp(join(tmpdir(), "pi-reviewer-switch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(
    join(source, "sum.js"),
    "export const sum = (a, b) => a - b;\n",
  );
  await writeFile(
    join(source, "test.mjs"),
    "import assert from 'node:assert/strict';import {sum} from './sum.js';assert.equal(sum(2,3),5);\n",
  );
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "synthetic-pi-workspace",
      version: "1.0.0",
      type: "module",
      scripts: {
        check: "node test.mjs",
        build: "node --check sum.js",
        "format:check": "node --check test.mjs",
      },
    }),
  );
  await writeFile(
    join(source, "package-lock.json"),
    JSON.stringify({
      name: "synthetic-pi-workspace",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "synthetic-pi-workspace", version: "1.0.0" } },
    }),
  );
  git("add", ".");
  git("commit", "-qm", "Fixture");
  const commit = git("rev-parse", "HEAD").toString().trim();
  const started = await f.start("pi-switch", "plan");
  await f.db.query(
    "UPDATE coding_jobs SET settings=$2::jsonb,base_sha=$3 WHERE id=$1",
    [
      started.id,
      JSON.stringify({
        ...settings,
        runtime: "pi",
        squad: false,
        autoMerge: false,
      }),
      commit,
    ],
  );
  const plan =
    "Change sum.js subtraction to addition; preserve exported API; run checks.";
  const oversized = "x".repeat(32001);
  const readEvidence = reviewDocumentReader();
  const turns = new Map<string, number>();
  const reviewers: string[] = [];
  let switched = false;
  f.setGeneration((selected, input) => {
    const system =
      input.messages.find((m: any) => m.role === "system")?.content ?? "";
    const phase =
      selected === settings.reviewerModel || selected === opus
        ? "review"
        : system.includes("Current intent: build")
          ? "build"
          : "plan";
    if (phase === "review") {
      reviewers.push(selected);
      if (switched)
        assert(
          !JSON.stringify(input.messages).includes("x".repeat(1000)),
          "the new reviewer must not continue the earlier session",
        );
      const evidence = readEvidence(input, `review-${switched}`);
      if (evidence) return evidence;
    }
    const count = turns.get(phase) ?? 0;
    turns.set(phase, count + 1);
    const tool =
      phase === "plan"
        ? count === 0
          ? { name: "read", arguments: { path: "sum.js" } }
          : {
              name: "report",
              arguments: {
                kind: "plan",
                summary: "Fix addition",
                detail: plan,
              },
            }
        : phase === "build"
          ? count === 0
            ? {
                name: "edit",
                arguments: {
                  path: "sum.js",
                  edits: [{ oldText: "a - b", newText: "a + b" }],
                },
              }
            : {
                name: "report",
                arguments: {
                  kind: "done",
                  summary: "Addition fixed",
                  detail: "Implemented; actual checks follow.",
                },
              }
          : count === 0
            ? { name: "read", arguments: { path: "sum.js" } }
            : {
                name: "report",
                arguments: {
                  kind: "review",
                  summary: "Reviewed",
                  detail: switched ? "Addition is correct." : oversized,
                  verdict: "APPROVE",
                },
              };
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `${phase}-${count}`,
            type: "function",
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.arguments),
            },
          },
        ],
      },
    };
  });
  const app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const prepareRepository = async (directory: string, assignment: any) => {
    execFileSync("git", ["clone", "--no-hardlinks", source, directory], {
      stdio: "pipe",
    });
    execFileSync(
      "git",
      ["-C", directory, "checkout", "--detach", assignment.baseSha],
      { stdio: "pipe" },
    );
  };
  const run = async () => {
    const job = await f.row(started.id);
    await runPiWorker(
      new NativePiWorkerClient(
        origin,
        job.id,
        f.c.token(job.id, job.attempt_id),
        new AbortController().signal,
      ),
      () => {},
      new AbortController().signal,
      { prepareRepository },
    );
  };
  await f.c.tick();
  await run();
  await f.c.tick();
  await f.c.tick();
  let receipt = 100;
  let approvalId = "";
  let approvedMessage = 0;
  for (let i = 0; i < 10 && !approvalId; i++)
    await f.c.deliver(async (_owner, _target, _text, id) => {
      const message_id = ++receipt;
      if (id) {
        approvalId = id.id;
        approvedMessage = message_id;
      }
      return { message_id };
    });
  assert(approvalId);
  await f.c.requirements.confirm("a", approvalId, true, "a", approvedMessage);
  await f.c.tick();
  await run();
  await f.c.tick();
  await f.c.tick();
  let paused = await f.row(started.id);
  assert.equal(paused.state, "paused");
  assert.equal(paused.checkpoint.piState.phase, "review");
  const round = paused.checkpoint.piState.reviewRound;
  const coderCalls = turns.get("build");
  await f.c.call("a", f.run, {
    operation: "coding_job_update",
    id: paused.id,
    baseRevision: paused.revision,
    requestKey: "use-opus",
    ownerConfirmed: true,
    reviewerModel: opus,
  });
  paused = await f.row(started.id);
  assert.equal(paused.checkpoint.piState.reviewRound, round + 1);
  await f.c.call("a", f.run, {
    operation: "coding_resume",
    id: paused.id,
    baseRevision: paused.revision,
    requestKey: "resume-with-opus",
  });
  switched = true;
  turns.set("review", 0);
  reviewers.length = 0;
  await f.c.tick();
  await run();
  assert.equal(turns.get("build"), coderCalls);
  assert(reviewers.length > 0 && reviewers.every((m) => m === opus));
  const done = await f.row(started.id);
  assert.equal(done.state, "publishing");
  assert.equal(done.result.review.verdict, "APPROVE");
  assert.equal(done.result.review.model, opus);
});
