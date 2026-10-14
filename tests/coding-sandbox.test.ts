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
test("CodeBuild refuses an insufficient or unconfirmed timeout while retaining the created sandbox identity", async () => {
  for (const actual of [45, undefined, NaN, 1, 2161]) {
    let calls = 0;
    const p = new CodeBuildSandbox(
      {
        send: async () => {
          calls++;
          return { build: { id: "fixture:short", timeoutInMinutes: actual } };
        },
      } as any,
      "fixture-project",
    );
    await assert.rejects(
      p.create({
        jobId: randomUUID(),
        attemptId: randomUUID(),
        token: "synthetic",
        origin: "https://example.invalid",
        image: settings.image,
        timeoutMinutes: 125,
      }),
      (error: unknown) => {
        assert(error instanceof SandboxTimeoutMismatch);
        assert.equal(error.sandboxId, "fixture:short");
        assert.equal(error.requestedMinutes, 125);
        assert.equal(error.actualMinutes, actual === 45 ? 45 : undefined);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});
test("cancelled launch retains its rejected receipt identity without changing cancellation or relaunching", async (t) => {
  const f = await fixture(t),
    job = await f.start("cancelled-timeout-receipt", "plan");
  let rejectReceipt!: () => void;
  const receipt = new Promise<string>((_resolve, reject) => {
    rejectReceipt = () =>
      reject(new SandboxTimeoutMismatch("fixture:cancelled-short", 125, 45));
  });
  f.provider.create = async () => receipt;
  const dispatch = f.c.tick();
  let launching;
  for (let i = 0; i < 30; i++) {
    launching = await f.row(job.id);
    if (launching.state === "provisioning") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(launching.state, "provisioning");
  await f.c.call("a", f.run, { operation: "coding_cancel", id: job.id });
  rejectReceipt();
  await dispatch;
  const cancelled = await f.row(job.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.summary, "Cancelled by the owner");
  assert.equal(cancelled.sandbox_id, "fixture:cancelled-short");
  assert.equal(cancelled.cleanup, "pending");
  assert.equal(
    (
      await f.db.query(
        "SELECT 1 FROM coding_events WHERE job_id=$1 AND event_key=$2",
        [job.id, `${cancelled.attempt_id}:paused`],
      )
    ).rows.length,
    0,
  );
  f.provider.find = async () => {
    throw new Error("reconciliation must not discard a known receipt");
  };
  let stopped = false;
  f.provider.inspect = async () => (stopped ? "terminal" : "running");
  f.provider.terminate = async (id) => {
    assert.equal(id, "fixture:cancelled-short");
    stopped = true;
  };
  await f.c.tick();
  await f.c.tick();
  assert.equal((await f.row(job.id)).cleanup, "complete");
  assert.equal(f.modelCalls(), 0);
});
test("restart reconciliation verifies active allocation before allowing worker authentication", async (t) => {
  const f = await fixture(t),
    job = await f.start("recovered-short-timeout", "plan");
  await f.db.query(
    "UPDATE coding_jobs SET settings=jsonb_set(settings,'{limits}', $2::jsonb) WHERE id=$1",
    [job.id, JSON.stringify({ ms: 7200000, models: 400, tools: 1000 })],
  );
  await f.c.tick();
  await f.db.query("UPDATE coding_jobs SET sandbox_id=NULL WHERE id=$1", [
    job.id,
  ]);
  f.provider.find = async (_id: string, required?: number) => {
    assert.equal(required, 125);
    throw new SandboxTimeoutMismatch("fixture:recovered-short", 125, 45);
  };
  await f.c.tick();
  const paused = await f.row(job.id);
  assert.equal(paused.state, "paused");
  assert.equal(paused.sandbox_id, "fixture:recovered-short");
  assert.match(paused.summary, /accepted 45 minutes/);
  await assert.rejects(
    f.c.authenticate(job.id, f.c.token(job.id, paused.attempt_id)),
    /Invalid worker capability/,
  );
  let stopped = false;
  f.provider.inspect = async () => (stopped ? "terminal" : "running");
  f.provider.terminate = async () => {
    stopped = true;
  };
  await f.c.tick();
  await f.c.tick();
  assert.equal((await f.row(job.id)).cleanup, "complete");
  assert.equal(f.creates(), 1);
  assert.equal(f.modelCalls(), 0);
});
test("CodeBuild reconciliation validates active receipts while permitting cleanup lookup of a short sandbox", async () => {
  const attempt = randomUUID();
  const p = new CodeBuildSandbox(
    {
      send: async (command) =>
        command.constructor.name === "ListBuildsForProjectCommand"
          ? { ids: ["fixture:recovered"] }
          : {
              builds: [
                {
                  id: "fixture:recovered",
                  timeoutInMinutes: 45,
                  environment: {
                    environmentVariables: [
                      { name: "CODING_ATTEMPT_ID", value: attempt },
                    ],
                  },
                },
              ],
            },
    } as any,
    "fixture-project",
  );
  await assert.rejects(p.find(attempt, 125), SandboxTimeoutMismatch);
  assert.equal(await p.find(attempt), "fixture:recovered");
});
test("CodeBuild accepts a confirmed sufficient timeout", async () => {
  for (const actual of [125, 130]) {
    const p = new CodeBuildSandbox(
      {
        send: async () => ({
          build: { id: "fixture:accepted", timeoutInMinutes: actual },
        }),
      } as any,
      "fixture-project",
    );
    assert.equal(
      await p.create({
        jobId: randomUUID(),
        attemptId: randomUUID(),
        token: "synthetic",
        origin: "https://example.invalid",
        image: settings.image,
        timeoutMinutes: 125,
      }),
      "fixture:accepted",
    );
  }
});
test("terminal provider metadata explains timeout and falls back safely if the diagnostic read fails", async (t) => {
  for (const diagnosticReadFails of [false, true]) {
    const f = await fixture(t),
      job = await f.start(`terminal-diagnostic-${diagnosticReadFails}`, "plan");
    await f.c.tick();
    f.provider.inspect = async () => "terminal";
    Object.assign(f.provider, {
      terminalReason: async () => {
        if (diagnosticReadFails)
          throw new Error("private provider diagnostic error");
        return "Sandbox provider hit its 45-minute build timeout before a result was recorded; saved work is retained";
      },
    });
    await f.c.tick();
    const paused = await f.row(job.id);
    assert.equal(paused.state, "paused");
    assert.equal(paused.cleanup, "pending");
    assert.match(
      paused.summary,
      diagnosticReadFails
        ? /stopped before a result/
        : /45-minute build timeout/,
    );
    assert(!paused.summary.includes("private"));
    await f.c.tick();
    assert.equal((await f.row(job.id)).cleanup, "complete");
    assert.equal(f.creates(), 1);
    assert.equal(f.modelCalls(), 0);
  }
});
