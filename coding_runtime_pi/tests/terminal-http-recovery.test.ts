import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  CodingRuntime,
  TaskStore,
  compatibleModel,
  localExecutor,
} from "../src/index.js";

test("native terminal HTTP recovery admits a fresh generation without reopening the agent loop", async (t) => {
  const attemptId = randomUUID();
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push({ body, parent: req.headers["x-runtime-retry-of"] });
    if (requests.length === 1) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Coding request rejected; inspect job state before retrying",
          code: "model_transient_failure",
          recovery: {
            version: 1,
            kind: "terminal-provider-http",
            callId: body.runtime_call_id,
            attemptId,
            providerStatus: 504,
          },
        }),
      );
      return;
    }
    const chunk = {
      id: "synthetic",
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                index: 0,
                id: "plan",
                type: "function",
                function: {
                  name: "report",
                  arguments: JSON.stringify({
                    kind: "plan",
                    summary: "Retained scope",
                    detail:
                      "Inspect value.js and retain the selected objective.",
                  }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    const end = {
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const root = await mkdtemp(join(tmpdir(), "pi-terminal-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "work");
  await mkdir(workspace);
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", ["-C", workspace, "config", "user.name", "Synthetic"]);
  execFileSync("git", [
    "-C",
    workspace,
    "config",
    "user.email",
    "synthetic@example.invalid",
  ]);
  await writeFile(join(workspace, "value.js"), "export const value = 1;\n");
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", ["-C", workspace, "commit", "-qm", "Fixture"]);
  const runtime = new CodingRuntime({
    store: new TaskStore(
      join(root, "state"),
      "synthetic-state-key-32-characters",
    ),
    model: compatibleModel({
      provider: "synthetic",
      model: "synthetic/model",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      apiKey: "synthetic-capability",
      requestIdField: "runtime_call_id",
      terminalHttpRecovery: { attemptId },
    }),
  });
  const task = await runtime.start({
    workspace,
    objective: "Retain the selected objective",
  });
  const result = await runtime.run(task.id);
  assert.equal(result.status, "waiting_approval");
  assert.equal(result.used.models, 2);
  assert.equal(requests.length, 2);
  assert.notEqual(
    requests[0].body.runtime_call_id,
    requests[1].body.runtime_call_id,
  );
  assert.equal(requests[1].parent, requests[0].body.runtime_call_id);
  assert.deepEqual(
    { ...requests[1].body, runtime_call_id: requests[0].body.runtime_call_id },
    requests[0].body,
  );
});

for (const scenario of [
  "edit-once",
  "second-failure",
  "worker-budget",
  "lost-receipt",
  "disabled",
] as const)
  test(`native approved build recovery: ${scenario}`, async (t) => {
    const attemptId = randomUUID(),
      requests: any[] = [];
    const root = await mkdtemp(join(tmpdir(), "pi-terminal-build-")),
      workspace = join(root, "work");
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(workspace);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", workspace, ...args], { stdio: "pipe" });
    git("init", "-q");
    await writeFile(join(workspace, "value.js"), "export const value = 1;\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "-qm",
      "Fixture",
    );
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      requests.push(body);
      const n = requests.length;
      if (n === 2 || (n === 3 && scenario === "second-failure")) {
        if (scenario === "lost-receipt") {
          req.socket.destroy();
          return;
        }
        res.writeHead(409, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            code: "model_transient_failure",
            recovery: {
              version: 1,
              kind: "terminal-provider-http",
              callId: body.runtime_call_id,
              attemptId,
              providerStatus: 504,
            },
          }),
        );
        return;
      }
      const tool =
        n === 1
          ? {
              name: "report",
              arguments: {
                kind: "plan",
                summary: "Update value",
                detail:
                  "Change value.js from 1 to 2 and check JavaScript syntax.",
              },
            }
          : n === 3
            ? {
                name: "edit",
                arguments: {
                  path: "value.js",
                  edits: [{ oldText: "value = 1", newText: "value = 2" }],
                },
              }
            : {
                name: "report",
                arguments: {
                  kind: "done",
                  summary: "Value updated",
                  detail: "Ready for the configured host check.",
                },
              };
      const chunk = {
        id: `synthetic-${n}`,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: `tool-${n}`,
                  type: "function",
                  function: {
                    name: tool.name,
                    arguments: JSON.stringify(tool.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const runtime = new CodingRuntime({
      store: new TaskStore(
        join(root, "state"),
        "synthetic-state-key-32-characters",
      ),
      model: compatibleModel({
        provider: "synthetic",
        model: "synthetic/model",
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        apiKey: "synthetic",
        requestIdField: "runtime_call_id",
        ...(scenario !== "disabled"
          ? { terminalHttpRecovery: { attemptId } }
          : {}),
      }),
      executor: (task) => localExecutor(task.workspace, join(root, "home")),
    });
    const task = await runtime.start({
      workspace,
      objective: "Update value from 1 to 2",
      checks: ["node --check value.js"],
      limits: {
        ms: 15000,
        models: scenario === "worker-budget" ? 2 : 10,
        tools: 10,
      },
    });
    const plan = await runtime.run(task.id);
    assert.equal(plan.status, "waiting_approval");
    await runtime.approve(task.id, plan.plan!.revision, plan.plan!.hash);
    const result = await runtime.run(task.id);
    assert.equal(
      result.status,
      scenario === "edit-once" ? "completed" : "paused",
    );
    assert.equal(
      requests.length,
      scenario === "edit-once" ? 4 : scenario === "second-failure" ? 3 : 2,
    );
    assert.equal(result.used.models, requests.length);
    assert.equal(
      result.used.tools,
      scenario === "edit-once" ? 3 : 1,
      "Only the successful generation may execute its tool",
    );
    assert.equal(
      await readFile(join(workspace, "value.js"), "utf8"),
      `export const value = ${scenario === "edit-once" ? 2 : 1};\n`,
    );
    if (scenario === "edit-once")
      assert.deepEqual(
        result.checks.map((check) => check.exitCode),
        [0],
      );
    if (scenario === "lost-receipt") {
      const replacement = new CodingRuntime({
        store: new TaskStore(
          join(root, "state"),
          "synthetic-state-key-32-characters",
        ),
        model: compatibleModel({
          provider: "synthetic",
          model: "synthetic/model",
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          apiKey: "synthetic",
          requestIdField: "runtime_call_id",
          terminalHttpRecovery: { attemptId },
        }),
      });
      await assert.rejects(
        replacement.run(task.id),
        /explicit action|not ready/i,
      );
      assert.equal(
        requests.length,
        2,
        "Replacing runtime/store cannot reconstruct an automatic retry",
      );
    }
  });
