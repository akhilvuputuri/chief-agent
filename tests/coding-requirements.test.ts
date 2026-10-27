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
  requirementBrief,
} from "./helpers/coding-fixture.js";
test("required dependency installation keeps the package store outside the captured checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-lockstep-home-"));
  const signal = new AbortController().signal,
    w = new Workspace(root, signal);
  // A local package inside the repository needs no registry access.
  await w.write(
    "vendor/dep/package.json",
    JSON.stringify({
      name: "chief-fixture-dep",
      version: "1.0.0",
      main: "index.js",
    }),
  );
  await w.write("vendor/dep/index.js", "module.exports=true;\n");
  await w.command("git", ["init"]);
  await w.write(".gitignore", "node_modules\n");
  await w.write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      dependencies: { "chief-fixture-dep": "file:vendor/dep" },
    }),
  );
  const locked = await w.command("lockstep", [
    "install",
    "--lockfile-only",
    "--ignore-scripts",
  ]);
  assert.equal(locked.exitCode, 0, locked.output);
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
  const installed = await w.command("lockstep", ["ci", "--ignore-scripts"]);
  assert.equal(installed.exitCode, 0, installed.output);
  const entries = await readdir(root);
  assert(!entries.includes("lockstep-store") && !entries.includes(".cache"));
  assert.equal((await w.snapshot("plan", "summary")).files.length, 0);
});
test("lease-release failure cannot permanently disable controller ticks", async (t) => {
  const f = await fixture(t),
    job = await f.start(),
    query = f.db.query.bind(f.db);
  let fail = true;
  f.db.query = async (sql, values) => {
    if (fail && sql.startsWith("UPDATE coding_jobs SET lease=NULL")) {
      fail = false;
      throw new Error("synthetic release failure");
    }
    return query(sql, values);
  };
  await assert.rejects(f.c.tick());
  await query(
    "UPDATE coding_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",
    [job.id],
  );
  f.advance(181000);
  await f.c.tick();
  assert.equal((await f.row(job.id)).state, "paused");
  assert.equal(f.creates(), 1);
});
test("review approval requires contiguous delivery of the entire saved plan", async () => {
  let calls = 0;
  const plan = "x".repeat(12000),
    messages: any[] = [
      { role: "system", content: "review" },
      { role: "user", content: "preview only" },
    ];
  const model: any = {
    generate: async () => {
      calls++;
      const read = calls === 2 || calls === 3;
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: String(calls),
              type: "function",
              function: {
                name: read ? "plan_read" : "report",
                arguments: JSON.stringify(
                  read
                    ? { offset: calls === 2 ? 0 : 6000 }
                    : { kind: "APPROVE", summary: "Synthetic approval" },
                ),
              },
            },
          ],
        },
      };
    },
  };
  const r = await codingLoop({
    model,
    workspace: {} as any,
    messages,
    mode: "review",
    budget: { models: 5, tools: 5 },
    signal: new AbortController().signal,
    checkpoint: async () => {},
    plan: () => plan,
  });
  assert.equal(r.kind, "APPROVE");
  assert.equal(calls, 4);
  assert(JSON.parse(messages[3].content).error.includes("complete saved plan"));
});
test("a large unchanged index does not prevent capturing one changed file", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-large-index-")),
    w = new Workspace(root, new AbortController().signal);
  await w.command("git", ["init"]);
  const generated = await w.command(process.execPath, [
    "-e",
    "const fs=require('fs');for(let i=0;i<2100;i++)fs.writeFileSync('f'.repeat(200)+'-'+i+'.txt','fixture\\n');",
  ]);
  assert.equal(generated.exitCode, 0);
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
  const name = "f".repeat(200) + "-0.txt";
  await w.write(name, "changed\n");
  const c = await w.snapshot("plan", "summary");
  assert.equal(c.files.length, 1);
  assert.equal(c.files[0]?.path, name);
  assert.equal(c.files[0]?.content, "changed\n");
});
test("review cannot approve a plan read in the same generated tool batch", async () => {
  let calls = 0;
  const plan = "Acceptance criterion at the end.";
  const model: any = {
    generate: async (input: any) => {
      calls++;
      if (calls === 2)
        assert(
          input.messages.some(
            (m: any) => m.role === "tool" && m.content.includes(plan),
          ),
        );
      const report = {
        id: `report-${calls}`,
        type: "function",
        function: {
          name: "report",
          arguments: JSON.stringify({
            kind: "APPROVE",
            summary: "Synthetic verdict",
          }),
        },
      };
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls:
            calls === 1
              ? [
                  {
                    id: "read",
                    type: "function",
                    function: { name: "plan_read", arguments: '{"offset":0}' },
                  },
                  report,
                ]
              : [report],
        },
      };
    },
  };
  const r = await codingLoop({
    model,
    workspace: {} as any,
    messages: [
      { role: "system", content: "review" },
      { role: "user", content: "preview" },
    ],
    mode: "review",
    budget: { models: 3, tools: 4 },
    signal: new AbortController().signal,
    checkpoint: async () => {},
    plan: () => plan,
  });
  assert.equal(r.kind, "APPROVE");
  assert.equal(calls, 2);
});
