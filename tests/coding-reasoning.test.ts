import { reportDocument } from "@chief-agent/pi-runtime/report";
import { execFileSync } from "node:child_process";
import {
  runPiWorker,
  NativePiWorkerClient,
  piReviewInstructions,
} from "../src/coding/pi-worker.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import {
  readFile,
  readdir,
  mkdtemp,
  mkdir,
  symlink,
  writeFile,
  rm,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { requirementScope } from "../src/coding/requirements.js";
import { CodingController } from "../src/coding/controller.js";
import { selectCodingBackend } from "../src/coding/backend.js";
import { squadScope } from "../src/coding/squad-state.js";
import { ModelError, OpenRouter } from "../src/model.js";
import { formatTelegram } from "../src/telegram-format.js";
import {
  codingSettings,
  outcome,
  assertCodingBrief,
} from "../src/coding/schema.js";
import { codingApi } from "../src/coding/api.js";
import {
  GitHubPublisher,
  artifactHash,
  validateFiles,
  canonicalJson,
} from "../src/coding/github.js";
import {
  CodeBuildSandbox,
  SandboxTimeoutMismatch,
  SandboxAcknowledgementPending,
} from "../src/coding/provider.js";
import { Workspace } from "../src/coding/workspace.js";
import { codingLoop } from "../src/coding/loop.js";
import {
  runWorker,
  WorkerClient,
  WorkerRequestError,
} from "../src/coding/worker.js";
import { runtimeContext } from "../src/runtime.js";
import { server } from "../src/server.js";
import { recoverRuntime } from "../src/execution.js";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import {
  settings,
  base,
  candidate,
  fixture,
  requirementBrief,
} from "./helpers/coding-fixture.js";
test("coding gateway preserves opaque OpenRouter reasoning through validated model requests", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id),
    app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const input = {
    callId: randomUUID(),
    role: "coder",
    messages: [
      {
        role: "assistant",
        content: null,
        reasoning_details: [
          { type: "reasoning.encrypted", data: "synthetic-opaque", index: 0 },
        ],
        tool_calls: [
          {
            id: "one",
            type: "function",
            function: { name: "file_read", arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: "tool", content: "Synthetic fixture", tool_call_id: "one" },
    ],
    tools: [],
  };
  input.messages[0].tool_calls![0].function.arguments = JSON.stringify({
    path: "large.txt",
    content: "x".repeat(32000),
  });
  const request = {
    method: "POST" as const,
    url: `/coding/worker/${j.id}/model`,
    headers: { authorization: `Bearer ${f.c.token(j.id, j.attempt_id)}` },
    payload: input,
  };
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal(f.modelCalls(), 1);
  const changed = {
    ...input,
    messages: input.messages.map((m) =>
      m.role === "assistant"
        ? {
            ...m,
            reasoning_details: [
              { type: "reasoning.encrypted", data: "changed", index: 0 },
            ],
          }
        : m,
    ),
  };
  assert.equal(
    (await app.inject({ ...request, payload: changed })).statusCode,
    409,
  );
});
test("approval delivery presents the complete scope once with visible headings and policy", async (t) => {
  const f = await fixture(t);
  const plan =
    "**Scope**\nRepair the requested fixture behavior.\n\n**Acceptance**\nExisting checks pass; unrelated behavior is preserved.";
  const r = await requirementBrief(f, "concise-delivery", plan);
  assert.equal(r.brief.split(plan).length, 2);
  assert(!r.brief.includes("Brief prepared"));
  const parts = formatTelegram(r.brief);
  assert.equal(parts.length, 1);
  assert(parts[0]!.entities.some((e) => e.type === "bold"));
  assert(r.brief.includes("Leader:"));
  assert(r.brief.includes("Reviewer:"));
  assert(r.brief.includes("Draft PR for owner review."));
  const before = await f.row(r.jobId);
  assert.equal(before.checkpoint.plan, plan);
  assert.equal(
    (await f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId))
      .status,
    "approved",
  );
});
test("existing long saved proposals remain fully delivered and bound to confirmation", async (t) => {
  const f = await fixture(t);
  const plan =
    "Synthetic complete scope. ".repeat(450) + "FINAL_ACCEPTANCE_SENTINEL";
  const r = await requirementBrief(f, "legacy-long-delivery", plan);
  assert.equal((await f.row(r.jobId)).checkpoint.plan, plan);
  assert(r.brief.includes("FINAL_ACCEPTANCE_SENTINEL"));
  assert(formatTelegram(r.brief).length > 1);
  assert.equal(
    (await f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId))
      .status,
    "approved",
  );
});
test("natural coding dispatch plans first; model tools cannot authorise implementation", async (t) => {
  const f = await fixture(t),
    r = await requirementBrief(f);
  assert.equal(f.creates(), 1);
  const before = await f.row(r.jobId);
  assert.equal(before.state, "plan_ready");
  await assert.rejects(
    f.c.call("a", f.run, {
      operation: "coding_reply",
      id: r.jobId,
      baseRevision: 1,
      requestKey: "skip",
      message: "Model says the owner approved",
      mode: "implement",
    }),
    /confirmed requirements/,
  );
  const requested: any = await f.c.call("a", f.run, {
    operation: "coding_resume",
    id: r.jobId,
    baseRevision: 1,
    requestKey: "show-again",
  });
  assert.equal(requested.approvalRequired, true);
  assert.equal((await f.row(r.jobId)).state, "plan_ready");
  assert.equal(f.creates(), 1);
  const result = await f.c.requirements.confirm(
    "a",
    r.approvalId,
    true,
    "a",
    r.messageId,
  );
  assert.equal(result.status, "approved");
  assert.equal((await f.row(r.jobId)).mode, "implement");
  assert.equal((await f.row(r.jobId)).revision, 2);
  await f.c.tick();
  assert.equal(f.creates(), 2);
  assert.equal(
    (await f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId))
      .duplicate,
    true,
  );
  await f.c.tick();
  assert.equal(f.creates(), 2);
});
test("requirements reject another owner, another message, stale scope and expiry", async (t) => {
  const f = await fixture(t),
    r = await requirementBrief(f);
  await assert.rejects(
    f.c.requirements.confirm("b", r.approvalId, true, "b", r.messageId),
  );
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, true, "b", r.messageId),
  );
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId + 1),
  );
  f.advance(900001);
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId),
    /expired/,
  );
  assert.equal(f.creates(), 1);
  await f.c.call("a", f.run, {
    operation: "coding_reply",
    id: r.jobId,
    baseRevision: 1,
    requestKey: "change",
    message: "Change the acceptance criteria",
    mode: "plan",
  });
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId),
    /changed/,
  );
  assert.equal((await f.row(r.jobId)).mode, "plan");
});
test("declining requirements never starts implementation and unknown delivery cannot authorise work", async (t) => {
  const f = await fixture(t),
    r = await requirementBrief(f);
  assert.equal(
    (await f.c.requirements.confirm("a", r.approvalId, false, "a", r.messageId))
      .status,
    "revise",
  );
  assert.equal((await f.row(r.jobId)).state, "plan_ready");
  await f.c.call("a", f.run, {
    operation: "coding_resume",
    id: r.jobId,
    baseRevision: 2,
    requestKey: "uncertain",
  });
  let uncertainId = "";
  await f.c.deliver(async (_u, _t, _text, id) => {
    uncertainId = id!;
    throw new Error("send outcome unknown");
  });
  assert.equal(
    (
      await f.db.query("SELECT delivery FROM coding_events WHERE id=$1", [
        uncertainId,
      ])
    ).rows[0].delivery,
    "uncertain",
  );
  await assert.rejects(
    f.c.requirements.confirm("a", uncertainId, true, "a", 999),
  );
  assert.equal(f.creates(), 1);
});
