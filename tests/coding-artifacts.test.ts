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
test("a long owner request and a long follow-up are kept whole and wait for Start", async (t) => {
  const f = await fixture(t);
  const objective = "字".repeat(30000);
  const context = "字".repeat(60000);
  const job: any = await f.c.call("a", f.run, {
    operation: "coding_start",
    requestKey: "large",
    objective,
    context,
  });
  assert.equal(job.state, "plan_ready");
  const stored = await f.row(job.id);
  assert.equal(stored.objective, objective);
  assert.equal(stored.context, context);
  const message = "字".repeat(40000);
  const replied: any = await f.c.call("a", f.run, {
    operation: "coding_reply",
    id: job.id,
    baseRevision: 1,
    requestKey: "more",
    message,
  });
  assert.equal(replied.revision, 2);
  assert.equal(replied.state, "plan_ready");
  assert.equal(
    (await f.row(job.id)).context,
    `${context}\nOwner follow-up: ${message}`,
  );
  await f.c.tick();
  assert.equal(f.creates(), 0);
  assert.equal(f.modelCalls(), 0);
});
