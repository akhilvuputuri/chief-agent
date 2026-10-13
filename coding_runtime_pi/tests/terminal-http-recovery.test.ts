import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CodingRuntime, TaskStore, compatibleModel } from "../src/index.js";

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
