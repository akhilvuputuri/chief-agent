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
