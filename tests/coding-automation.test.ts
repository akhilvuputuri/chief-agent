import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { CodingAutomation } from "../src/coding/automation.js";
import { CodingController, type CodingJob } from "../src/coding/controller.js";
import { codingSettings, outcome } from "../src/coding/schema.js";
import { artifactHash } from "../src/coding/github.js";
import type { PrInspection } from "../src/coding/merge-policy.js";
import { codingDiagnostics } from "../src/coding/diagnostics.js";
import {
  modelPreferences,
  setModelPreference,
} from "../src/coding/model-settings.js";
const base = "a".repeat(40),
  head = "b".repeat(40),
  tree = "c".repeat(40),
  merge = "d".repeat(40);
const settings = codingSettings.parse({
  repository: "akhilvuputuri/chief-agent",
  branch: "main",
  image: `ghcr.io/example/worker@sha256:${"a".repeat(64)}`,
  model: "fixture/coder",
  reviewerModel: "fixture/reviewer",
  leaderModel: "fixture/leader",
  squad: true,
  autoMerge: true,
  effort: "high",
  limits: { ms: 900000, models: 40, tools: 100 },
});
async function fixture(t: TestContext) {
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
  await ensureUser(db, "other");
  const id = randomUUID(),
    attempt = randomUUID();
  let now = new Date();
  const checkpoint = {
    plan: "Owner-approved feature",
    summary: "Test candidate",
    patch: "fixture",
    files: [{ path: "src/fixture.ts", content: "export const ok=true;\n" }],
  };
  const hash = artifactHash(checkpoint);
  const cp = {
    ...checkpoint,
    squadState: {
      sequence: 5,
      revision: 1,
      attemptId: attempt,
      scopeHash: "a".repeat(64),
      phase: "approved",
      candidateVersion: 1,
      candidateHash: hash,
      toolsUsed: 70,
      checks: [],
      findings: "Reviewed",
    },
  };
  const result = outcome.parse({
    kind: "candidate",
    summary: "Reviewed",
    checkpoint: cp,
    checks: ["check", "build", "format:check"].map((s) => ({
      command: `npm run ${s}`,
      exitCode: 0,
      output: "passed",
    })),
    review: {
      verdict: "APPROVE",
      findings: "Reviewed",
      model: settings.reviewerModel,
      patchHash: hash,
    },
  });
  await db.query(
    "INSERT INTO coding_jobs(id,user_id,request_key,request_hash,origin_run,objective,context,mode,base_sha,settings,state,stage,checkpoint,result,attempt_id,cleanup,pr_url,head_sha,attempt_deadline,used_models) VALUES($1,'owner','fixture','fixture',$2,'Feature','Scope','implement',$3,$4::jsonb,'pr_ready','pr_ready',$5::jsonb,$6::jsonb,$7,'complete',$8,$9,$10,30)",
    [
      id,
      randomUUID(),
      base,
      JSON.stringify(settings),
      JSON.stringify(cp),
      JSON.stringify(result),
      attempt,
      "https://github.com/akhilvuputuri/chief-agent/pull/1",
      head,
      new Date(now.getTime() + 120000),
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
  };
  let merges = 0,
    attests = 0,
    allowed = true,
    proof = true,
    uncertain = false,
    release: "pending" | "success" | "failure" = "pending";
  const repository = {
    inspect: async () => inspection,
    attest: async () => {
      attests++;
    },
    merge: async () => {
      merges++;
      if (uncertain) throw Error("lost acknowledgement");
      return { sha: merge };
    },
    release: async () => release,
  };
  const auto = new CodingAutomation(
    db,
    repository,
    () => allowed,
    async () => proof,
    () => now,
  );
  const job = async () =>
    (await db.query("SELECT * FROM coding_jobs WHERE id=$1", [id]))
      .rows[0] as CodingJob;
  await auto.start(await job(), tree);
  return {
    db,
    auto,
    job,
    id,
    cp,
    result,
    setInspection: (i: Partial<PrInspection>) =>
      (inspection = { ...inspection, ...i }),
    setAllowed: (v: boolean) => (allowed = v),
    setProof: (v: boolean) => (proof = v),
    setUncertain: () => (uncertain = true),
    setRelease: (v: typeof release) => (release = v),
    counts: () => ({ merges, attests }),
    clock: () => now,
    repository,
    advance: () => (now = new Date(now.getTime() + 3600001)),
  };
}
test("exact artifact waits for CI, merges once and records only the exact successful release", async (t) => {
  const f = await fixture(t);
  await f.auto.tick();
  assert.equal((await f.job()).stage, "awaiting_ci");
  assert.equal(f.counts().merges, 0);
  f.setInspection({ checks: "passed" });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "release_pending");
  assert.equal(f.counts().merges, 1);
  await f.auto.tick();
  assert.equal((await f.job()).stage, "release_pending");
  f.setRelease("success");
  await f.auto.tick();
  assert.equal((await f.job()).stage, "deployed");
  await f.auto.tick();
  assert.equal(f.counts().merges, 1);
});
for (const scenario of [
  "head",
  "tree",
  "main",
  "review",
  "owner",
  "protected",
  "python-runtime",
  "plugin-registry",
  "runtime-policy",
]) {
  test(`${scenario} invalidation never merges`, async (t) => {
    const f = await fixture(t);
    f.setInspection({ checks: "passed" });
    if (scenario === "head") f.setInspection({ head: "e".repeat(40) });
    if (scenario === "tree") f.setInspection({ tree: "e".repeat(40) });
    if (scenario === "main") f.setInspection({ main: "e".repeat(40) });
    if (scenario === "review") f.setProof(false);
    if (scenario === "owner") f.setAllowed(false);
    if (
      [
        "protected",
        "python-runtime",
        "plugin-registry",
        "runtime-policy",
      ].includes(scenario)
    ) {
      const r = structuredClone(f.result);
      r.checkpoint.files[0].path =
        scenario === "python-runtime"
          ? "coding_runtime/src/chief_coding_runtime/worker.py"
          : scenario === "plugin-registry"
            ? "plugins/registry.json"
            : scenario === "runtime-policy"
              ? "src/model-policy.ts"
              : "src/coding/automation.ts";
      await f.db.query("UPDATE coding_jobs SET result=$2::jsonb WHERE id=$1", [
        f.id,
        JSON.stringify(r),
      ]);
    }
    await f.auto.tick();
    assert.equal((await f.job()).stage, "manual_review");
    assert.equal(f.counts().merges, 0);
  });
}
test("MR feedback queues the coder with findings while preserving approved scope and shared allocation", async (t) => {
  const f = await fixture(t);
  f.setInspection({
    checks: "failed",
    feedback: [{ id: "comment1", text: "Fix the failing edge case" }],
  });
  await f.auto.tick();
  const j = await f.job();
  assert.equal(j.state, "queued");
  assert.equal(j.revision, 2);
  assert.equal(j.used_models, 30);
  assert.equal(j.context, "Scope");
  assert.equal(j.base_sha, base);
  assert.equal(j.checkpoint.plan, f.cp.plan);
  assert.equal(j.checkpoint.squadState?.toolsUsed, 70);
  assert.match(j.checkpoint.squadState!.findings, /Fix the failing edge case/);
  const budget = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='feedback:2'",
      [f.id],
    )
  ).rows[0].payload;
  assert.equal(budget.remainingMs, 120000);
  assert.deepEqual(budget.handled, ["comment1"]);
  assert.equal(f.counts().merges, 0);
});
test("lost merge acknowledgement is reconciled without replaying the merge", async (t) => {
  const f = await fixture(t);
  f.setInspection({ checks: "passed" });
  f.setUncertain();
  await f.auto.tick();
  assert.equal((await f.job()).stage, "merging");
  await f.auto.tick();
  assert.equal(f.counts().merges, 1);
  f.setInspection({ merged: true, closed: true, mergeSha: merge });
  await f.auto.tick();
  assert.equal((await f.job()).stage, "release_pending");
  assert.equal(f.counts().merges, 1);
});
test("active owner work delays merge; failed exact release is never called deployed", async (t) => {
  const f = await fixture(t);
  f.setInspection({ checks: "passed" });
  const run = randomUUID();
  await f.db.query(
    "INSERT INTO runtime_runs(id,user_id,state) VALUES($1,'owner','running')",
    [run],
  );
  await f.auto.tick();
  assert.equal(f.counts().merges, 0);
  await f.db.query("UPDATE runtime_runs SET state='done' WHERE id=$1", [run]);
  await f.auto.tick();
  f.setRelease("failure");
  await f.auto.tick();
  assert.equal((await f.job()).stage, "manual_review");
  assert.match((await f.job()).summary, /release failed/);
});
test("diagnostics are owner scoped, bounded and exclude raw failures, messages and tool payloads", async (t) => {
  const f = await fixture(t);
  const mine = randomUUID(),
    other = randomUUID();
  for (const [id, user] of [
    [mine, "owner"],
    [other, "other"],
  ])
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,state,model) VALUES($1,$2,'failed','fixture/model')",
      [id, user],
    );
  await f.db.query(
    "INSERT INTO events(user_id,run_id,type,data) VALUES('owner',$1,'model.failed',$2::jsonb),('other',$3,'model.failed',$4::jsonb)",
    [
      mine,
      JSON.stringify({
        error: "PRIVATE EMAIL BODY",
        messages: "PRIVATE CONVERSATION",
        latencyMs: 4,
        diagnostics: { httpStatus: 429, provider: "OpenAI" },
      }),
      other,
      JSON.stringify({ model: "OTHER_OWNER_SECRET" }),
    ],
  );
  await f.db.query(
    "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) VALUES($1,$2,'fixture','calendar_read',$3::jsonb,false,'failed',$3::jsonb)",
    [randomUUID(), mine, JSON.stringify({ secret: "PRIVATE TOKEN" })],
  );
  const data = await codingDiagnostics(f.db, "owner", {
    minutes: 60,
    limit: 10,
  });
  const text = JSON.stringify(data);
  assert(!text.includes("PRIVATE"));
  assert(!text.includes("OTHER_OWNER"));
  assert.equal(data.runs.length, 1);
  assert.equal(data.calls.length, 1);
  assert.equal(data.events[0].record?.httpStatus, 429);
  assert.equal(
    (await codingDiagnostics(f.db, "owner", { runId: other })).runs.length,
    0,
  );
  await assert.rejects(codingDiagnostics(f.db, "owner", { minutes: 1441 }));
});
test("model choices are owner scoped, survive concurrent role updates and reject provider price changes", async (t) => {
  const f = await fixture(t);
  const catalog = async () => [
    { id: "cheap/coder", inputPrice: 1, outputPrice: 2, tools: true },
    { id: "cheap/reviewer", inputPrice: 2, outputPrice: 9, tools: true },
    { id: "expensive/model", inputPrice: 10, outputPrice: 50, tools: true },
  ];
  await Promise.all([
    setModelPreference(
      f.db,
      "owner",
      settings,
      "coder",
      "cheap/coder",
      catalog,
      2,
      10,
    ),
    setModelPreference(
      f.db,
      "owner",
      settings,
      "reviewer",
      "cheap/reviewer",
      catalog,
      2,
      10,
    ),
  ]);
  const choices = await modelPreferences(f.db, "owner", settings);
  assert.equal(choices.coder, "cheap/coder");
  assert.equal(choices.reviewer, "cheap/reviewer");
  assert.equal(
    (await modelPreferences(f.db, "other", settings)).coder,
    settings.model,
  );
  await assert.rejects(
    setModelPreference(
      f.db,
      "owner",
      settings,
      "coder",
      "expensive/model",
      catalog,
      2,
      10,
    ),
    /price filters/,
  );
  assert.equal(
    (await modelPreferences(f.db, "owner", settings)).coder,
    "cheap/coder",
  );
  assert.equal((await f.job()).settings.model, settings.model);
});

test("oversized aggregate feedback is batched without marking unseen comments handled", async (t) => {
  const f = await fixture(t);
  f.setInspection({
    checks: "passed",
    feedback: [
      { id: "seen", text: "A".repeat(6000) },
      { id: "unseen", text: "B".repeat(6000) },
    ],
  });
  await f.auto.tick();
  const budget = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='feedback:2'",
      [f.id],
    )
  ).rows[0].payload;
  assert.deepEqual(budget.handled, ["seen"]);
  assert(!(await f.job()).checkpoint.squadState!.findings.includes("BBBB"));
});
for (const scenario of ["valid", "forged", "uncertain"]) {
  test(`host reviewer journal ${scenario} controls approval independently of worker report`, async (t) => {
    const f = await fixture(t);
    const publisher = {
      resolve: async () => base,
      publish: async () => ({
        url: "https://github.com/akhilvuputuri/chief-agent/pull/1",
        head,
        tree,
      }),
      automation: () => f.repository,
    };
    const model = {
      generate: async () => ({
        model: settings.reviewerModel,
        message: {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            {
              id: "verdict",
              type: "function" as const,
              function: {
                name: "report",
                arguments: JSON.stringify({
                  kind: "APPROVE",
                  summary: "Reviewed",
                }),
              },
            },
          ],
        },
      }),
    };
    const c = new CodingController(
      f.db,
      settings,
      {
        create: async () => "sandbox",
        find: async () => undefined,
        inspect: async () => "terminal",
        terminate: async () => {},
      },
      publisher,
      "a".repeat(64),
      "https://coding.example.com",
      (u) => u === "owner",
      () => model,
      f.clock,
    );
    await f.db.query("UPDATE coding_jobs SET state='running' WHERE id=$1", [
      f.id,
    ]);
    const j = await f.job();
    await c.generate(j, {
      callId: randomUUID(),
      role: "reviewer",
      messages: [
        { role: "system", content: "Independently review" },
        {
          role: "user",
          content: JSON.stringify({
            objective: j.objective,
            context: j.context,
            baseSha: j.base_sha,
            handoff: {
              recipient: "reviewer",
              candidateHash: artifactHash(j.result.checkpoint),
            },
          }),
        },
      ],
      tools: [{ name: "file_read", description: "Read only", parameters: {} }],
    });
    await f.db.query("UPDATE coding_jobs SET state='pr_ready' WHERE id=$1", [
      f.id,
    ]);
    if (scenario === "forged") {
      const result = structuredClone(j.result);
      result.review!.findings = "Worker invented approval";
      await f.db.query("UPDATE coding_jobs SET result=$2::jsonb WHERE id=$1", [
        f.id,
        JSON.stringify(result),
      ]);
    }
    if (scenario === "uncertain")
      await f.db.query(
        "INSERT INTO coding_model_calls(id,job_id,attempt_id,role,request_hash,state,input,created_at) VALUES($1,$2,$3,'reviewer','fixture','uncertain','{}',now()+interval '1 minute')",
        [randomUUID(), f.id, j.attempt_id],
      );
    f.setInspection({ checks: "passed" });
    await c.automationTick();
    assert.equal(f.counts().merges, scenario === "valid" ? 1 : 0);
  });
}

test("diagnostic response bytes stay bounded without inventing event-time release metadata", async (t) => {
  const f = await fixture(t);
  const run = randomUUID();
  await f.db.query(
    "INSERT INTO runtime_runs(id,user_id,state) VALUES($1,'owner','failed')",
    [run],
  );
  await f.db.query(
    "INSERT INTO events(user_id,run_id,type,data) SELECT 'owner',$1,'model.completed',jsonb_build_object('model',repeat('m',120),'invocationId',repeat('i',100),'latencyMs',999999,'usage',jsonb_build_object('prompt_tokens',999999,'completion_tokens',999999,'cost',0.1)) FROM generate_series(1,100)",
    [run],
  );
  const logs = await codingDiagnostics(f.db, "owner", { limit: 100 });
  assert(logs.truncated);
  assert(Buffer.byteLength(JSON.stringify(logs)) <= 32000);
  assert(
    logs.events.every(
      (e) => e.record?.release === undefined && e.record?.ts === undefined,
    ),
  );
});

test("row-limited diagnostics explicitly report omitted events, calls and fixed-cap runs", async (t) => {
  const f = await fixture(t);
  for (let n = 0; n < 17; n++) {
    const run = randomUUID();
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,state) VALUES($1,'owner','failed')",
      [run],
    );
    await f.db.query(
      "INSERT INTO events(user_id,run_id,type,data) VALUES('owner',$1,'model.failed','{}')",
      [run],
    );
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state) VALUES($1,$2,'fixture','calendar_read','{}',false,'failed')",
      [randomUUID(), run],
    );
  }
  const result = await codingDiagnostics(f.db, "owner", { limit: 1 });
  assert(result.truncated);
  assert.deepEqual(result.hasMore, { runs: true, events: true, calls: true });
  assert.equal(result.runs.length, 15);
  assert.equal(result.events.length, 1);
  assert.equal(result.calls.length, 1);
  assert(Buffer.byteLength(JSON.stringify(result)) <= 32000);
});
