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
import { codingSettings, outcome } from "../src/coding/schema.js";
import { codingApi } from "../src/coding/api.js";
import {
  GitHubPublisher,
  artifactHash,
  validateFiles,
  canonicalJson,
} from "../src/coding/github.js";
import { SandboxAcknowledgementPending } from "../src/coding/provider.js";
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
  startCard,
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
test("the Start card shows the goal in at most two lines, the models and nothing else", async (t) => {
  const f = await fixture(t);
  const r = await startCard(
    f,
    "card",
    "Fix the reminder bug\n\nKeep the public API\nA third line stays in the request only",
  );
  assert.equal(
    r.card,
    "**Ready to start**\n\nFix the reminder bug\nKeep the public API\n\nCoder: fixture/coder. Reviewer: fixture/reviewer.",
  );
  assert(!/plan|leader|planner/i.test(r.card));
  const parts = formatTelegram(r.card);
  assert.equal(parts.length, 1);
  assert(parts[0]!.entities.some((e) => e.type === "bold"));
  assert.match(
    (await f.row(r.jobId)).objective,
    /A third line stays in the request only/,
  );
  assert.equal(
    (await f.c.requirements.confirm("a", r.approvalId, "a", r.messageId))
      .status,
    "approved",
  );
});
test("a long goal gives a short Start card and the request is kept whole", async (t) => {
  const f = await fixture(t);
  const objective = "Synthetic goal ".repeat(400) + "END_OF_GOAL";
  const r = await startCard(f, "long-goal", objective);
  assert(r.card.length < 500, `${r.card.length}`);
  assert(!r.card.includes("END_OF_GOAL"));
  assert.equal((await f.row(r.jobId)).objective, objective);
});
test("coding_start runs nothing before Start; a model tool cannot start the job", async (t) => {
  const f = await fixture(t),
    r = await startCard(f);
  assert.equal(f.creates(), 0);
  const requested: any = await f.c.call("a", f.run, {
    operation: "coding_resume",
    id: r.jobId,
    baseRevision: 1,
    requestKey: "show-again",
  });
  assert.equal(requested.approvalRequired, true);
  assert.equal((await f.row(r.jobId)).state, "plan_ready");
  await f.c.tick();
  assert.equal(f.creates(), 0);
  assert.equal(
    (await f.db.query("SELECT count(*)::int AS n FROM coding_model_calls"))
      .rows[0].n,
    0,
  );
  const result = await f.c.requirements.confirm(
    "a",
    r.approvalId,
    "a",
    r.messageId,
  );
  assert.equal(result.status, "approved");
  assert.equal((await f.row(r.jobId)).mode, "implement");
  assert.equal((await f.row(r.jobId)).revision, 2);
  await f.c.tick();
  assert.equal(f.creates(), 1);
  assert.equal(
    (await f.c.requirements.confirm("a", r.approvalId, "a", r.messageId))
      .duplicate,
    true,
  );
  await f.c.tick();
  assert.equal(f.creates(), 1);
});
test("a Start card can still start the job 23 hours after delivery", async (t) => {
  // It lapsed after 15 minutes before 18 October; five cards expired that way.
  const f = await fixture(t),
    r = await startCard(f);
  f.advance(23 * 3600000);
  const result = await f.c.requirements.confirm(
    "a",
    r.approvalId,
    "a",
    r.messageId,
  );
  assert.equal(result.status, "approved");
});
test("a Start card refuses another owner, another message, a changed request and expiry", async (t) => {
  const f = await fixture(t),
    r = await startCard(f);
  await assert.rejects(
    f.c.requirements.confirm("b", r.approvalId, "b", r.messageId),
  );
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, "b", r.messageId),
  );
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, "a", r.messageId + 1),
  );
  f.advance(86400001);
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, "a", r.messageId),
    /expired/,
  );
  assert.equal(f.creates(), 0);
  await f.c.call("a", f.run, {
    operation: "coding_reply",
    id: r.jobId,
    baseRevision: 1,
    requestKey: "change",
    message: "Change the acceptance criteria",
  });
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, "a", r.messageId),
    /changed/,
  );
  assert.equal((await f.row(r.jobId)).mode, "plan");
});
test("an unknown Start card delivery cannot authorise work", async (t) => {
  const f = await fixture(t),
    r = await startCard(f);
  await f.c.call("a", f.run, {
    operation: "coding_resume",
    id: r.jobId,
    baseRevision: 1,
    requestKey: "uncertain",
  });
  let uncertainId = "";
  await f.c.deliver(async (_u, _t, _text, id) => {
    uncertainId = id!.id;
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
  await assert.rejects(f.c.requirements.confirm("a", uncertainId, "a", 999));
  assert.equal(f.creates(), 0);
});
