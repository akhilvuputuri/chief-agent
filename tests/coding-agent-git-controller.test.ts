import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, settings } from "./helpers/coding-fixture.js";
import { CodingController } from "../src/coding/controller.js";
import { codingSettings, outcome } from "../src/coding/schema.js";
import { requirementScope } from "../src/coding/requirements.js";
import { artifactHash } from "../src/coding/github.js";
import { ToolValidationError } from "../src/tool-errors.js";

const pi = codingSettings.parse({
  ...settings,
  runtime: "pi",
  prWorkflow: "owner_merge",
  agentGit: true,
  model: "fixture/coder",
  leaderModel: "fixture/coder",
  reviewerModel: "fixture/reviewer",
  maxOutputTokens: 16000,
});

function controller(f: Awaited<ReturnType<typeof fixture>>, enabled = true) {
  const tokens = { issued: 0, revoked: [] as string[] };
  const c = new CodingController(
    f.db,
    pi,
    f.provider as any,
    f.publisher as any,
    "c".repeat(64),
    "https://coding.example.com",
    (u) => u === "a",
    () => ({
      generate: async () => ({ message: { role: "assistant", content: "" } }),
    }),
    () => new Date(),
    undefined,
    undefined,
    false,
    enabled
      ? {
          tokens: {
            issue: async () => {
              tokens.issued++;
              return {
                token: `ghs_${tokens.issued}`,
                expiresAt: new Date(Date.now() + 3600000).toISOString(),
              };
            },
            revoke: async (token: string) => {
              tokens.revoked.push(token);
            },
          } as any,
          author: { name: "Owner", email: "owner@example.invalid" },
        }
      : undefined,
  );
  return { c, tokens };
}

async function runningJob(
  f: Awaited<ReturnType<typeof fixture>>,
  c: CodingController,
  key: string,
) {
  const started = (await c.call("a", f.run, {
    operation: "coding_start",
    requestKey: key,
    objective: "Synthetic objective",
    context: "Synthetic context",
    mode: "plan",
  })) as any;
  const plan = { plan: "Approved plan", patch: "", summary: "", files: [] };
  await f.db.query(
    "UPDATE coding_jobs SET mode='implement',state='running',checkpoint=$2::jsonb,attempt_id=$3,attempt_deadline=$4 WHERE id=$1",
    [
      started.id,
      JSON.stringify(plan),
      randomUUID(),
      new Date(Date.now() + 600000),
    ],
  );
  const job = (
    await f.db.query("SELECT * FROM coding_jobs WHERE id=$1", [started.id])
  ).rows[0];
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,'fixture-approved',$2::jsonb,'suppressed')",
    [
      job.id,
      JSON.stringify({
        decision: "approved",
        approvedScope: requirementScope(job),
      }),
    ],
  );
  return job;
}

test("agent git is snapshotted only when the agent App is configured and stays host-side", async (t) => {
  const f = await fixture(t);
  const off = controller(f, false);
  const plain = (await off.c.call("a", f.run, {
    operation: "coding_start",
    requestKey: "no-agent-app",
    objective: "Synthetic",
    context: "Synthetic",
    mode: "plan",
  })) as any;
  const stored = (
    await f.db.query("SELECT settings FROM coding_jobs WHERE id=$1", [plain.id])
  ).rows[0].settings;
  assert.equal(stored.agentGit, undefined);

  const on = controller(f);
  const job = await runningJob(f, on.c, "agent-app");
  assert.equal(job.settings.agentGit, true);
  const assignment: any = await on.c.assignment({
    ...job,
    settings: codingSettings.parse(job.settings),
  });
  assert.equal("agentGit" in assignment.settings, false);
  assert.deepEqual(assignment.agentGit, {
    repository: "akhilvuputuri/chief-agent",
    branch: `chief/coding-${job.id}`,
    author: { name: "Owner", email: "owner@example.invalid" },
  });
});

test("agent tokens are issued only to a running, approved implementation attempt and revoked when it finishes", async (t) => {
  const f = await fixture(t);
  const { c, tokens } = controller(f);
  const job = await runningJob(f, c, "agent-token");
  const first = await c.githubToken(job);
  const again = await c.githubToken(job);
  assert.equal(first.token, again.token);
  assert.equal(tokens.issued, 1);
  for (const blocked of [
    { ...job, mode: "plan" },
    { ...job, state: "pr_ready" },
    { ...job, settings: { ...job.settings, agentGit: undefined } },
  ])
    await assert.rejects(c.githubToken(blocked), /unavailable/);
  const files = [{ path: "docs/a.md", content: "Agent change\n" }];
  const checkpoint = {
    plan: "Approved plan",
    patch: "fixture",
    summary: "Done",
    files,
    piState: { version: 1, toolsUsed: 2 },
  };
  const candidate = {
    kind: "candidate",
    summary: "Done",
    question: "",
    checkpoint,
    checks: [
      "npm ci",
      "npm run check",
      "npm run build",
      "npm run format:check",
    ].map((command) => ({ command, exitCode: 0, output: "ok" })),
    review: {
      verdict: "APPROVE",
      findings: "Approved",
      model: "fixture/reviewer",
      patchHash: artifactHash(checkpoint as any),
    },
  };
  // An agent-git job must report the PR it published.
  await assert.rejects(c.finish(job, candidate), /passing checks and review/);
  const accepted = await c.finish(
    job,
    outcome.parse({
      ...candidate,
      published: {
        url: "https://github.com/akhilvuputuri/chief-agent/pull/9",
        head: "e".repeat(40),
      },
    }),
  );
  assert.deepEqual(accepted, { accepted: true });
  assert.deepEqual(tokens.revoked, [first.token]);
});

test("tokens for attempts that stopped without finishing are revoked by the sweep", async (t) => {
  const f = await fixture(t);
  const { c, tokens } = controller(f);
  const job = await runningJob(f, c, "agent-sweep");
  const issued = await c.githubToken(job);
  await (c as any).sweepAgentTokens();
  assert.deepEqual(tokens.revoked, []);
  await f.db.query("UPDATE coding_jobs SET state='paused' WHERE id=$1", [
    job.id,
  ]);
  await (c as any).sweepAgentTokens();
  assert.deepEqual(tokens.revoked, [issued.token]);
});

test("replying to an owner-merge job that already has a PR is a validation error with guidance, and status shows its flow", async (t) => {
  const f = await fixture(t);
  const { c } = controller(f);
  const job = await runningJob(f, c, "agent-pr-ready");
  await f.db.query(
    "UPDATE coding_jobs SET state='pr_ready',stage='awaiting_ci',cleanup='complete' WHERE id=$1",
    [job.id],
  );
  await assert.rejects(
    c.call("a", f.run, {
      operation: "coding_reply",
      id: job.id,
      baseRevision: job.revision,
      requestKey: "rebase-please",
      message: "Rebase it",
    }),
    (error: Error) => {
      assert(error instanceof ToolValidationError);
      assert.match(error.message, /continues on its own/);
      return true;
    },
  );
  await f.db.query(
    "UPDATE coding_jobs SET stage='manual_review',summary='Main moved again after two automatic rebases; inspect before merging.' WHERE id=$1",
    [job.id],
  );
  await assert.rejects(
    c.call("a", f.run, {
      operation: "coding_reply",
      id: job.id,
      baseRevision: job.revision,
      requestKey: "rebase-please-2",
      message: "Rebase it",
    }),
    (error: Error) => {
      assert(error instanceof ToolValidationError);
      assert.match(
        error.message,
        /stopped for owner attention \(Main moved again/,
      );
      assert.match(error.message, /cannot merge it in this state/);
      return true;
    },
  );
  const status: any = await c.call("a", f.run, {
    operation: "coding_status",
    id: job.id,
  });
  const row = Array.isArray(status) ? status[0] : (status.jobs?.[0] ?? status);
  assert.equal(
    JSON.stringify(status).includes('"mergeFlow":"owner_merge"'),
    true,
    JSON.stringify(row).slice(0, 300),
  );
});
