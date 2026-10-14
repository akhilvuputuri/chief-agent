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
test("UTF-8 observations fit the model endpoint byte limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-utf8-test-")),
    w = new Workspace(root, new AbortController().signal);
  await w.write("unicode.txt", "字".repeat(80000));
  let calls = 0;
  const model: any = {
    generate: async (input: any) => {
      assert(
        Buffer.byteLength(
          JSON.stringify({
            callId: randomUUID(),
            role: "coder",
            messages: input.messages,
            tools: input.tools,
          }),
        ) <= 180000,
      );
      calls++;
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: String(calls),
              type: "function",
              function: {
                name: calls <= 3 ? "file_read" : "report",
                arguments: JSON.stringify(
                  calls <= 3
                    ? { path: "unicode.txt", offset: 0 }
                    : { kind: "candidate", summary: "Synthetic complete" },
                ),
              },
            },
          ],
        },
      };
    },
  };
  await codingLoop({
    model,
    workspace: w,
    messages: [
      { role: "system", content: "fixture" },
      { role: "user", content: "assignment" },
    ],
    mode: "implement",
    budget: { models: 5, tools: 5 },
    signal: new AbortController().signal,
    checkpoint: async () => {},
  });
  assert.equal(calls, 4);
});
test("staged executable modes match the artifact even when disk permissions are unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-index-mode-")),
    w = new Workspace(root, new AbortController().signal);
  await w.command("git", ["init"]);
  await w.write("script.sh", "#!/bin/sh\nexit 0\n");
  await w.command("git", ["add", "-A"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  await w.command("git", ["config", "core.filemode", "false"]);
  await w.command("git", ["update-index", "--chmod=+x", "script.sh"]);
  assert.equal((await stat(join(root, "script.sh"))).mode & 0o111, 0);
  const c = await w.snapshot("plan", "summary");
  assert.equal(c.files[0]?.mode, "100755");
  assert.match(c.patch, /new mode 100755/);
});
test("broker retries preserve exact source text while private diagnostic copies remain scrubbed", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  f.setReply("Use the literal template: Bearer ${placeholder}");
  const input = {
    callId: randomUUID(),
    role: "coder" as const,
    messages: [{ role: "user" as const, content: "Synthetic template" }],
    tools: [],
  };
  const first = await f.c.generate(j, input),
    cached = await f.c.generate(j, input);
  assert.deepEqual(cached, first);
  assert.equal(f.modelCalls(), 1);
  const record = (
    await f.db.query(
      "SELECT result,result_box FROM coding_model_calls WHERE id=$1",
      [input.callId],
    )
  ).rows[0];
  assert(record.result_box);
  assert.notEqual(record.result.message.content, first.message.content);
});
test("a rename artifact includes both the old deletion and the new indexed file", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-rename-test-")),
    w = new Workspace(root, new AbortController().signal);
  await w.command("git", ["init"]);
  await w.write("old.txt", "fixture\n");
  await w.command("git", ["add", "-A"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  await w.command("git", ["mv", "old.txt", "new.txt"]);
  const c = await w.snapshot("plan", "summary");
  assert.equal(c.files.find((f) => f.path === "old.txt")?.content, null);
  assert.equal(c.files.find((f) => f.path === "new.txt")?.content, "fixture\n");
});
test("non-UTF-8 indexed content is rejected instead of publishing replacement bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-encoding-test-")),
    w = new Workspace(root, new AbortController().signal);
  await w.command("git", ["init"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  await writeFile(join(root, "latin.txt"), Buffer.from("636166e90a", "hex"));
  await assert.rejects(w.snapshot("plan", "summary"), /not valid UTF-8/);
});
test("oversized owner briefs are rejected and large saved plans remain resumable through paging", async (t) => {
  assert.throws(
    () =>
      assertCodingBrief(
        "字".repeat(8000),
        "字".repeat(23000),
        "字".repeat(32000),
      ),
    /shorter objective/,
  );
  const f = await fixture(t);
  await assert.rejects(
    f.c.call("a", f.run, {
      operation: "coding_start",
      requestKey: "large",
      objective: "字".repeat(8000),
      context: "字".repeat(16000),
      mode: "plan",
    }),
    /brief is too large/,
  );
  assert.equal(f.creates(), 0);
  assert.equal(
    (await f.db.query("SELECT count(*) AS n FROM coding_jobs")).rows[0].n,
    0,
  );
  const job = await f.start();
  await f.db.query(
    "UPDATE coding_jobs SET mode='plan',state='plan_ready',checkpoint=$2::jsonb WHERE id=$1",
    [
      job.id,
      JSON.stringify({
        plan: "字".repeat(32000),
        patch: "",
        summary: "",
        files: [],
      }),
    ],
  );
  const resumed: any = await f.c.call("a", f.run, {
    operation: "coding_reply",
    id: job.id,
    baseRevision: 1,
    requestKey: "revise",
    message: "Keep the same scope, refine the tests",
    mode: "plan",
  });
  assert.equal((await f.row(job.id)).checkpoint.plan.length, 32000);
  assert.equal(resumed.revision, 2);
});
