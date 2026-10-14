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
test("Pi admits a small 100-tool-turn transcript within the existing byte and job allocations", async (t) => {
  const f = await fixture(t),
    started = await f.start("pi-small-history", "plan");
  await f.c.tick();
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    started.id,
    JSON.stringify({
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
      limits: { ms: 2400000, models: 400, tools: 1000 },
    }),
  ]);
  const job = await f.row(started.id),
    app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const messages: any[] = [
    { role: "system", content: "Synthetic approved scope remains protected." },
    { role: "user", content: "Continue the controlled task." },
  ];
  for (let i = 0; i < 100; i++)
    messages.push(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `read-${i}`,
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: `source-${i}.ts` }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: `read-${i}`, content: `Source fact ${i}` },
    );
  const payload = {
    runtime_call_id: randomUUID(),
    model: settings.model,
    messages,
    tools: [],
    stream: true,
  };
  assert(Buffer.byteLength(JSON.stringify(payload)) < 180000);
  f.setGeneration((_model, input) => {
    assert.equal(input.messages.length, 202);
    return {
      message: { role: "assistant", content: "Retained all controlled facts" },
    };
  });
  const response = await app.inject({
    method: "POST",
    url: `/coding/worker/${job.id}/pi/coder/v1/chat/completions`,
    headers: { authorization: `Bearer ${f.c.token(job.id, job.attempt_id)}` },
    payload,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(f.modelCalls(), 1);
});
