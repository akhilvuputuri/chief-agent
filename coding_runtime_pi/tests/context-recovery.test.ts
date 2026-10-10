import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  CodingRuntime,
  TaskStore,
  compatibleModel,
  localExecutor,
} from "../src/index.js";
for (const scenario of [
  "local-recovery",
  "build-local-recovery",
  "provider-error-after-recovery",
  "finalization-rejection",
]) {
  test(`native local envelope provenance: ${scenario}`, async (t) => {
    let transmitted = 0,
      compactions = 0,
      normal = 0;
    let doneReported = false;
    const sizes: number[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      transmitted++;
      sizes.push(Buffer.byteLength(raw));
      const compact = !body.tools?.length;
      if (compact) compactions++;
      else normal++;
      if (
        scenario === "provider-error-after-recovery" &&
        compactions > 0 &&
        !compact
      ) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "context_length_exceeded",
              type: "invalid_request_error",
              code: "context_length_exceeded",
            },
          }),
        );
        return;
      }
      if (normal > 35) {
        res.writeHead(500);
        res.end("fixture termination");
        return;
      }
      const initialBuildPlan =
        scenario === "build-local-recovery" && normal === 1 && !compact;
      const finishedBuild =
        scenario === "build-local-recovery" && doneReported && !compact;
      const calls = initialBuildPlan
        ? [
            {
              index: 0,
              id: "initial-plan",
              type: "function",
              function: {
                name: "report",
                arguments: JSON.stringify({
                  kind: "plan",
                  summary: "Read and check fixture",
                  detail:
                    "Inspect sum.js and run the configured syntax check without changing source.",
                }),
              },
            },
          ]
        : compact || finishedBuild
          ? []
          : compactions > 0
            ? [
                {
                  index: 0,
                  id: "plan",
                  type: "function",
                  function: {
                    name: "report",
                    arguments: JSON.stringify({
                      kind:
                        scenario === "build-local-recovery" ? "done" : "plan",
                      summary: "Complete fixture result",
                      detail:
                        "Repair sum.js and validate all requested behavior.",
                    }),
                  },
                },
              ]
            : Array.from(
                { length: scenario === "finalization-rejection" ? 32 : 1 },
                (_, i) => ({
                  index: i,
                  id: `r${normal}-${i}`,
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({ path: "sum.js" }),
                  },
                }),
              );
      const header = {
        id: `fixture-${transmitted}`,
        object: "chat.completion.chunk",
        model: "synthetic/overflow",
        created: 1,
      };
      const delta = compact
        ? {
            role: "assistant",
            content:
              "Source inspected. Objective remains the complete fixture repair. Continue to report.",
          }
        : finishedBuild
          ? { role: "assistant", content: "Completed fixture." }
          : { role: "assistant", content: null, tool_calls: calls };
      if (
        scenario === "build-local-recovery" &&
        compactions > 0 &&
        !compact &&
        !finishedBuild
      )
        doneReported = true;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ ...header, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...header, choices: [{ index: 0, delta: {}, finish_reason: compact || finishedBuild ? "stop" : "tool_calls" }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const root = await mkdtemp(join(tmpdir(), "independent-local-envelope-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "sum.js"), "//" + "evidence ".repeat(700));
    execFileSync("git", ["init", "-q", workspace]);
    execFileSync("git", [
      "-C",
      workspace,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "add",
      ".",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Fixture",
    ]);
    const r = new CodingRuntime({
      store: new TaskStore(
        join(root, "state"),
        "fixture-state-key-at-least-32-chars",
      ),
      executor: (task) =>
        localExecutor(task.workspace, join(root, "tool-home")),
      model: compatibleModel({
        provider: "synthetic",
        model: "synthetic/overflow",
        apiKey: "synthetic",
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        contextWindow: 100000,
        maxTokens: 4096,
        maxRequestBytes: 100000,
      }),
    });
    const task = await r.start({
      workspace,
      objective: "Plan all aspects of the fixture repair",
      limits: { ms: 15000, models: 60, tools: 100 },
      checks: ["node --check sum.js"],
    });
    if (scenario === "build-local-recovery") {
      const planned = await r.run(task.id);
      assert.equal(planned.status, "waiting_approval");
      await r.approve(task.id, planned.plan!.revision, planned.plan!.hash);
    }
    const out = await r.run(task.id);
    assert(sizes.every((n) => n <= 100000));
    if (scenario === "build-local-recovery") {
      assert.equal(out.status, "completed");
      assert.equal(compactions, 1);
      assert.equal(out.used.models, transmitted + 1);
      assert.equal(out.checks[0]?.exitCode, 0);
    } else if (scenario === "local-recovery") {
      assert.equal(out.status, "waiting_approval");
      assert.equal(compactions, 1);
      assert.equal(out.used.models, transmitted + 1);
    } else if (scenario === "provider-error-after-recovery") {
      assert.equal(out.status, "paused");
      assert.equal(compactions, 1);
      assert.equal(out.used.models, transmitted + 1);
      assert.equal(out.plan, undefined);
    } else {
      assert.equal(out.status, "paused");
      assert.equal(compactions, 0);
      assert.equal(transmitted, 1);
      assert.equal(out.used.models, 2);
      assert.equal(out.plan, undefined);
    }
  });
}
