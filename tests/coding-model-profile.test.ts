import { reviewDocumentReader } from "./helpers/pi-review-documents.js";
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
  unusedAnthropic,
} from "./helpers/coding-fixture.js";
test("coding model-role commands snapshot new Pi jobs without changing existing jobs or other roles", async (t) => {
  const f = await fixture(t);
  const selected = codingSettings.parse({
    ...settings,
    runtime: "pi",
    squad: false,
    autoMerge: false,
  });
  // Pi jobs call Claude directly, so only models with a direct Anthropic route qualify.
  const catalog = [
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-haiku-5.5",
    "anthropic/claude-opus-5.5",
  ].map((id) => ({ id, inputPrice: 1, outputPrice: 5, tools: true }));
  const controller = new CodingController(
    f.db,
    selected,
    f.provider,
    f.publisher,
    "c".repeat(64),
    "https://coding.example.com",
    (user) => user === "a",
    () => {
      throw new Error("Model selection does not dispatch inference");
    },
    undefined,
    async () => [
      ...catalog,
      { id: "openai/gpt-6.1-sol", inputPrice: 1, outputPrice: 5, tools: true },
    ],
    undefined,
    false,
    undefined,
    {
      ...unusedAnthropic,
      route: (model) =>
        model.startsWith("anthropic/") || model.startsWith("fixture/")
          ? unusedAnthropic.route(model)
          : undefined,
    },
  );
  const start = async (requestKey: string) =>
    (await controller.call("a", f.run, {
      operation: "coding_start",
      requestKey,
      objective: "Plan a synthetic fix",
      context: "Fixture",
    })) as any;
  const original = await start("original-pi-models");
  const saved = (await f.row(original.id)).settings;
  for (const [index, choice] of catalog.entries()) {
    for (const role of ["leader", "coder", "reviewer"] as const) {
      const prior = (await controller.call("a", f.run, {
        operation: "coding_models",
      })) as any;
      const result = (await controller.call("a", f.run, {
        operation: "coding_model_set",
        role,
        model: choice.id,
      })) as any;
      assert.equal(result[role], choice.id);
      assert.equal(result.appliesTo, "new jobs only");
      for (const other of ["leader", "coder", "reviewer"].filter(
        (r) => r !== role,
      ))
        assert.equal(result[other], prior.preferences[other]);
    }
    const fresh = await start(`model-${index}`);
    const snapshot = (await f.row(fresh.id)).settings;
    // A Pi job has no planner (journal 191): the leader preference does not apply to it.
    assert.equal(snapshot.leaderModel, undefined);
    assert.equal(snapshot.model, choice.id);
    assert.equal(snapshot.reviewerModel, choice.id);
    assert.equal(snapshot.runtime, "pi");
    assert.equal(snapshot.autoMerge, false);
    assert.deepEqual((await f.row(original.id)).settings, saved);
  }
  await assert.rejects(
    controller.call("b", f.run, {
      operation: "coding_model_set",
      role: "coder",
      model: catalog[0].id,
    }),
  );
  // A catalogue model without a direct Anthropic route cannot be chosen for Pi jobs.
  await assert.rejects(
    controller.call("a", f.run, {
      operation: "coding_model_set",
      role: "coder",
      model: "openai/gpt-6.1-sol",
    }),
    /not a Claude model Chief calls directly/,
  );
  assert.equal(f.creates(), 0);
  assert.equal(f.modelCalls(), 0);
});
test("Pi report documents bind checkpoint content and support the full escaped transport envelope", async (t) => {
  const f = await fixture(t);
  const started = await f.start("pi-document-wire");
  await f.c.tick();
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    started.id,
    JSON.stringify({
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
    }),
  ]);
  const job = await f.row(started.id);
  const detail = "Complete scope " + "\u0001".repeat(31985);
  const doc = reportDocument({
    kind: "done",
    summary: "Complete stored document",
    detail,
  });
  const body = {
    plan: "",
    patch: "\u0001".repeat(400000),
    summary: doc.summary,
    files: [],
    piState: { version: 1, toolsUsed: 0, reportDocument: doc },
  };
  assert(Buffer.byteLength(JSON.stringify(body)) > 800000);
  const app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const response = await app.inject({
    method: "POST",
    url: `/coding/worker/${job.id}/checkpoint`,
    headers: { authorization: `Bearer ${f.c.token(job.id, job.attempt_id)}` },
    payload: body,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    (await f.row(job.id)).checkpoint.piState.reportDocument.detail,
    detail,
  );
  await assert.rejects(
    f.c.save(await f.row(job.id), {
      ...body,
      piState: {
        ...body.piState,
        reportDocument: { ...doc, detail: "tampered" },
      },
    }),
    /identity/,
  );
  await assert.rejects(
    f.c.save(await f.row(job.id), {
      ...body,
      plan: "a plan the owner never saw",
    }),
    /immutable/,
  );
  const entry = {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t".repeat(60000) },
        {
          type: "toolCall",
          name: "report",
          arguments: { kind: "done", summary: doc.summary, detail },
        },
      ],
    },
  };
  assert(Buffer.byteLength(JSON.stringify(entry)) > 160000);
  await f.c.piSessionAppend(await f.row(job.id), {
    scope: "d".repeat(64),
    after: 0,
    entries: [entry],
  });
  assert.deepEqual(
    (await f.c.piSessionRead(await f.row(job.id), "d".repeat(64), 0)).entries,
    [entry],
  );
});
for (const { documentLength, firstCallFailure, reviewerQuestion = false } of [
  { documentLength: 0, firstCallFailure: false },
  { documentLength: 9357, firstCallFailure: false },
  { documentLength: 9357, firstCallFailure: true },
  { documentLength: 9357, firstCallFailure: false, reviewerQuestion: true },
])
  test(`independent reviewer recovery preserves ${documentLength || "short"}-character documents (${reviewerQuestion ? "question" : firstCallFailure ? "before first tool" : "format"})`, async (t) => {
    const f = await fixture(t);
    const root = await mkdtemp(join(tmpdir(), "pi-bridge-fixture-"));
    const source = join(root, "source");
    await mkdir(source);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", source, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.name", "Synthetic");
    git("config", "user.email", "synthetic@example.invalid");
    await writeFile(
      join(source, "sum.js"),
      "export const sum = (a, b) => a - b;\n",
    );
    await writeFile(
      join(source, "test.mjs"),
      "import assert from 'node:assert/strict';import {sum} from './sum.js';assert.equal(sum(2,3),5);\n",
    );
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "synthetic-pi-workspace",
        version: "1.0.0",
        type: "module",
        scripts: {
          check: "node test.mjs",
          build: "node --check sum.js",
          "format:check": "node --check test.mjs",
        },
      }),
    );
    await writeFile(
      join(source, "package-lock.json"),
      JSON.stringify({
        name: "synthetic-pi-workspace",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "synthetic-pi-workspace", version: "1.0.0" } },
      }),
    );
    git("add", ".");
    git("commit", "-qm", "Fixture");
    const commit = git("rev-parse", "HEAD").toString().trim();
    const started = await f.start("pi-e2e", true);
    const profile = {
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
      // Catalog windows of real models. Without them the fixture models fall back to 32,000
      // tokens, and Pi's default compaction threshold (journal 182) compacts the review evidence.
      contextWindows: Object.fromEntries(
        [settings.model, settings.reviewerModel].map((id) => [id, 128000]),
      ),
    };
    await f.db.query(
      "UPDATE coding_jobs SET settings=$2::jsonb,base_sha=$3 WHERE id=$1",
      [started.id, JSON.stringify(profile), commit],
    );
    const fullReview =
      "The checked fixture implements addition and preserves the API."
        .padEnd(
          Math.abs(documentLength) || 62,
          documentLength < 0 ? "界\n" : " Evidence retained.",
        )
        .slice(0, Math.abs(documentLength) || 62);
    let recovered = false;
    const readEvidence = reviewDocumentReader();
    const turns = new Map<string, number>();
    f.setGeneration((selected, input) => {
      const system =
        input.messages.find((m: any) => m.role === "system")?.content ?? "";
      // The longer review contract can push this small fixture window into compaction.
      if (
        selected === settings.reviewerModel &&
        String(system).startsWith("You are a context summarization assistant")
      )
        return {
          message: {
            role: "assistant",
            content:
              "## Goal\nReview the candidate.\n## Progress\nEvidence read so far is retained.",
          },
        };
      const phase = selected === settings.reviewerModel ? "review" : "build";
      const rawCount = turns.get(phase) ?? 0;
      turns.set(phase, rawCount + 1);
      if (phase === "build")
        assert(
          system.includes(
            "host has verified that the owner started this exact request",
          ),
        );
      let count = rawCount;
      if (recovered && phase === "review" && !firstCallFailure) count++;
      if (
        firstCallFailure &&
        !recovered &&
        phase === "review" &&
        rawCount === 0
      )
        throw new ModelError("Synthetic provider failure before tools", true, {
          httpStatus: 503,
        });
      if (phase === "review") {
        const evidence = readEvidence(input, `review-${recovered}`);
        if (evidence) {
          turns.set(phase, rawCount);
          return evidence;
        }
      }
      let tool: { name: string; arguments: any } | undefined;
      if (phase === "build" && count === 0)
        tool = {
          name: "edit",
          arguments: {
            path: "sum.js",
            edits: [{ oldText: "a - b", newText: "a + b" }],
          },
        };
      if (phase === "build" && count === 1)
        tool = {
          name: "report",
          arguments: {
            kind: "done",
            summary: "Addition fixed",
            detail: "Implemented approved behavior; actual checks follow.",
          },
        };
      if (phase === "review" && count === 0) {
        assert(system.includes("The approved scope is the owner's request"));
        assert(!system.includes("No implementation approved"));
        assert(system.includes("host validated the owner's Start"));
        assert(system.includes(commit));
        assert(system.includes("Synthetic evidence"));
        tool = { name: "read", arguments: { path: "sum.js" } };
      }
      if (phase === "review" && count === 1)
        tool = {
          name: "report",
          arguments: {
            kind: reviewerQuestion ? "question" : "review",
            summary: reviewerQuestion ? "Clarification required" : "Reviewed",
            detail: reviewerQuestion
              ? "Should zero inputs return zero?"
              : recovered
                ? fullReview
                : "x".repeat(32001),
            ...(reviewerQuestion ? {} : { verdict: "APPROVE" }),
          },
        };
      return {
        message: {
          role: "assistant",
          content: tool ? null : "Finished.",
          ...(tool
            ? {
                tool_calls: [
                  {
                    id: `${phase}-${count}`,
                    type: "function",
                    function: {
                      name: tool.name,
                      arguments: JSON.stringify(tool.arguments),
                    },
                  },
                ],
              }
            : {}),
        },
      };
    });
    const app = server();
    t.after(() => app.close());
    await codingApi(app, f.c);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const prepareRepository = async (directory: string, assignment: any) => {
      execFileSync("git", ["clone", "--no-hardlinks", source, directory], {
        stdio: "pipe",
      });
      execFileSync(
        "git",
        ["-C", directory, "checkout", "--detach", assignment.baseSha],
        { stdio: "pipe" },
      );
    };
    const run = async () => {
      const job = await f.row(started.id);
      await runPiWorker(
        new NativePiWorkerClient(
          origin,
          job.id,
          f.c.token(job.id, job.attempt_id),
          new AbortController().signal,
        ),
        () => {},
        new AbortController().signal,
        { prepareRepository },
      );
    };
    let receipt = 100;
    let approvalId = "";
    let approvedMessage = 0;
    for (let i = 0; i < 10 && !approvalId; i++)
      await f.c.deliver(async (_owner, _target, text, id) => {
        const message_id = ++receipt;
        if (id) {
          assert.match(text, /^\*\*Ready to start\*\*/);
          approvalId = id.id;
          approvedMessage = message_id;
        }
        return { message_id };
      });
    assert(approvalId);
    await f.c.requirements.confirm("a", approvalId, true, "a", approvedMessage);
    await f.c.tick();
    await run();
    let paused = await f.row(started.id);
    assert.equal(paused.checkpoint.piState.phase, "review");
    assert.equal(
      paused.checkpoint.piState.reviewCandidate.hash,
      artifactHash(paused.checkpoint),
    );
    if (reviewerQuestion) {
      assert.equal(paused.state, "awaiting_input");
      assert.equal(paused.result.question, "Should zero inputs return zero?");
      await f.c.tick();
      const delivered: string[] = [];
      for (let i = 0; i < 10; i++)
        await f.c.deliver(async (_owner, _target, text) => {
          delivered.push(text);
          return { message_id: ++receipt };
        });
      assert(
        delivered.some((text) =>
          text.includes("Should zero inputs return zero?"),
        ),
      );
      return;
    }
    const coderCallsBeforeRecovery = turns.get("build");
    assert.equal(paused.state, "paused");
    await f.c.tick();
    await f.c.tick();
    paused = await f.row(started.id);
    await f.c.call("a", f.run, {
      operation: "coding_resume",
      id: paused.id,
      baseRevision: paused.revision,
      requestKey: "explicit-review-format-recovery",
    });
    recovered = true;
    turns.set("review", 0);
    await f.c.tick();
    const resuming = await f.row(paused.id);
    const retained = resuming.checkpoint;
    await assert.rejects(
      f.c.save(resuming, {
        ...retained,
        piState: { ...retained.piState, sessionScope: "f".repeat(64) },
      }),
      /session/,
    );
    await assert.rejects(
      f.c.save(resuming, {
        ...retained,
        piState: {
          ...retained.piState,
          reviewCandidate: {
            ...retained.piState.reviewCandidate,
            hash: "f".repeat(64),
          },
        },
      }),
      /candidate/,
    );
    await run();
    assert.equal(turns.get("build"), coderCallsBeforeRecovery);
    const result = await f.row(started.id);
    assert.equal(result.state, "publishing");
    assert.equal(result.result.review.verdict, "APPROVE");
    assert.equal(result.checkpoint.plan, "");
    assert.equal(result.result.review.findings, fullReview);
    assert.equal(result.checkpoint.piState.reportDocument.detail, fullReview);
    assert.equal(result.checkpoint.piState.reportDocument.version, 1);
    assert(result.result.checks.every((c: any) => c.exitCode === 0));
    assert(
      result.checkpoint.files.some(
        (c: any) => c.path === "sum.js" && c.content.includes("a + b"),
      ),
    );
    await f.c.tick();
    await f.c.tick();
    assert.equal((await f.row(started.id)).state, "pr_ready");
    assert.equal(f.publishes(), 1);
  });
