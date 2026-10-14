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
test("CodeBuild identifies a timed-out BUILD even when the overall build status is FAILED", async () => {
  const p = new CodeBuildSandbox(
    {
      send: async () => ({
        builds: [
          {
            buildStatus: "FAILED",
            timeoutInMinutes: 45,
            phases: [{ phaseType: "BUILD", phaseStatus: "TIMED_OUT" }],
          },
        ],
      }),
    } as any,
    "fixture-project",
  );
  assert.match(
    (await p.terminalReason("fixture:timedout"))!,
    /45-minute build timeout/,
  );
});
test("provider queue or phase-unknown timeouts do not claim the build allocation elapsed", async () => {
  for (const phases of [
    [{ phaseType: "QUEUED", phaseStatus: "TIMED_OUT" }],
    undefined,
  ]) {
    const p = new CodeBuildSandbox(
      {
        send: async () => ({
          builds: [
            {
              buildStatus: "TIMED_OUT",
              timeoutInMinutes: 125,
              queuedTimeoutInMinutes: 5,
              phases,
            },
          ],
        }),
      } as any,
      "fixture-project",
    );
    const reason = await p.terminalReason("fixture:queue");
    assert(reason?.includes("timed out"));
    assert(!reason.includes("125"));
    if (phases) assert(reason.includes("queue"));
  }
});
test("workspace rejects traversal and symlinks, captures new/deleted files and kills commands on cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-workspace-test-"));
  const stop = new AbortController(),
    w = new Workspace(root, stop.signal);
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
  await w.write("src/new.ts", "export const a=1;\n");
  await assert.rejects(w.write("../escape", "x"));
  const outside = await mkdtemp(join(tmpdir(), "chief-outside-"));
  await symlink(outside, join(root, "link"));
  await assert.rejects(w.write("link/escape", "x"));
  await rm(join(root, "link"));
  await w.command("git", ["add", "src/new.ts"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  await w.remove("src/new.ts");
  await w.write("src/other.ts", "export const b=2;\n");
  const c = await w.snapshot("plan", "summary");
  assert.equal(c.files.find((f) => f.path === "src/new.ts")?.content, null);
  assert.equal(
    c.files.find((f) => f.path === "src/other.ts")?.content,
    "export const b=2;\n",
  );
  const running = w.command(process.execPath, [
    "-e",
    "setInterval(()=>{},10000)",
  ]);
  setTimeout(() => stop.abort(), 25);
  assert.equal((await running).exitCode, -1);
});
test("review tools cannot write even if the model invents an unavailable command", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-review-test-")),
    w = new Workspace(root, new AbortController().signal);
  let call = 0;
  const messages: any[] = [
    { role: "system", content: "review" },
    { role: "user", content: "fixture" },
  ];
  const model: any = {
    generate: async () => ({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: String(++call),
            type: "function",
            function: {
              name: call === 1 ? "command" : "report",
              arguments: JSON.stringify(
                call === 1
                  ? { command: "touch forbidden" }
                  : {
                      kind: "REQUEST_CHANGES",
                      summary: "Concrete fixture finding",
                    },
              ),
            },
          },
        ],
      },
    }),
  };
  const r = await codingLoop({
    model,
    workspace: w,
    messages,
    mode: "review",
    budget: { models: 3, tools: 3 },
    signal: new AbortController().signal,
    checkpoint: async () => {
      throw new Error("unexpected write");
    },
  });
  assert.equal(r.kind, "REQUEST_CHANGES");
  assert(messages[3].content.includes("rejected"));
  assert(!(await readdir(root)).includes("forbidden"));
});
test("publication rejects unsafe file manifests", () => {
  for (const path of [
    "../escape",
    ".git/config",
    ".env",
    ".github/workflows/pwn.yml",
  ])
    assert.throws(() => validateFiles([{ path, content: "x" }]));
});
test("worker implements, verifies and reviews a real disposable fixture before returning its candidate", async () => {
  let fixtureBase = "";
  const reports: any[] = [];
  let coderCalls = 0,
    reviewerCalls = 0;
  const client: any = {
    request: async (path: string, body: any) => {
      if (path === "assignment")
        return {
          id: randomUUID(),
          revision: 1,
          objective: "字".repeat(8000),
          context: "字".repeat(14000),
          mode: "implement",
          baseSha: fixtureBase,
          settings,
          checkpoint: { plan: "", summary: "", patch: "", files: [] },
          deadline: new Date(Date.now() + 60000).toISOString(),
          usedModels: 0,
        };
      reports.push({ path, body });
      return { accepted: true };
    },
    adapter: (role: string) => ({
      generate: async (input: any) => {
        if (role === "reviewer") {
          reviewerCalls++;
          assert(input.messages[1].content.includes("fixture.js"));
          assert(
            Buffer.byteLength(
              JSON.stringify({
                callId: randomUUID(),
                role: "reviewer",
                messages: input.messages,
                tools: input.tools,
              }),
            ) < 180000,
            "review receives bounded metadata, not a full large patch",
          );
          const last = input.messages.findLast((m: any) => m.role === "tool");
          const page = last ? JSON.parse(last.content) : undefined;
          if (!page || page.nextOffset !== null)
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `plan-${reviewerCalls}`,
                    type: "function",
                    function: {
                      name: "plan_read",
                      arguments: JSON.stringify({
                        offset: page?.nextOffset ?? 0,
                      }),
                    },
                  },
                ],
              },
            };
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "review",
                  type: "function",
                  function: {
                    name: "report",
                    arguments: JSON.stringify({
                      kind: "APPROVE",
                      summary:
                        "Synthetic change matches the requested fixture.",
                    }),
                  },
                },
              ],
            },
          };
        }
        coderCalls++;
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `coder-${coderCalls}`,
                type: "function",
                function: {
                  name: coderCalls === 1 ? "file_write" : "report",
                  arguments: JSON.stringify(
                    coderCalls === 1
                      ? {
                          path: "fixture.js",
                          content: "export const fixture = true;\n",
                        }
                      : {
                          kind: "candidate",
                          summary: "Fixed the fixture",
                          plan: "字".repeat(32000),
                        },
                  ),
                },
              },
            ],
          },
        };
      },
    }),
  };
  const source = await mkdtemp(join(tmpdir(), "chief-worker-fixture-")),
    seed = new Workspace(source, new AbortController().signal);
  await seed.command("git", ["init"]);
  await seed.write(".gitignore", "node_modules\n");
  await seed.write("fixture.js", "export const fixture = false;\n");
  await seed.write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      type: "module",
      scripts: {
        check:
          "node -e \"import('./fixture.js').then(m=>{if(!m.fixture)process.exit(1)})\"",
        build: "node --check fixture.js",
        "format:check": "node --check fixture.js",
      },
    }),
  );
  await seed.write(
    "package-lock.json",
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "fixture", version: "1.0.0" } },
    }),
  );
  await seed.command("git", ["add", "-A"]);
  await seed.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  fixtureBase = (
    await seed.command("git", ["rev-parse", "HEAD"])
  ).output.trim();
  // Exercise an artifact larger than one API message without asking the model to emit it.
  await seed.write("large-a.txt", "a".repeat(75000));
  await seed.write("large-b.txt", "b".repeat(75000));
  await runWorker(
    client,
    new AbortController().signal,
    async (w, _repo, _base, c) => {
      assert.equal(
        (await w.command("git", ["clone", source, "."])).exitCode,
        0,
      );
      if (!c.files.length) {
        await w.write("large-a.txt", "a".repeat(75000));
        await w.write("large-b.txt", "b".repeat(75000));
        for (let i = 0; i < 92; i++)
          await w.write(
            `src/${"x".repeat(200)}-${i}.ts`,
            "export const fixture = true;\n",
          );
      }
      await w.restore(c);
    },
  );
  const result = reports.find((r) => r.path === "finish").body;
  assert.equal(result.kind, "candidate");
  assert(result.checkpoint.patch.length > 120000);
  assert.equal(reviewerCalls, 7);
  assert.equal(result.review.patchHash, artifactHash(result.checkpoint));
  assert.equal(result.checks.length, 3);
  assert(result.checks.every((c: any) => c.exitCode === 0));
  assert(reports.some((r) => r.path === "checkpoint"));
});
