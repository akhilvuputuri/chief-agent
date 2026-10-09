import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CodingRuntime, TaskStore, compatibleModel } from "../src/index.js";

test("native Pi protocol performs tool continuation, request identity and Unicode without paid inference", async (t) => {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-capability");
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    const tool = bodies.length === 1;
    const message = tool
      ? {
          role: "assistant",
          content: null,
          reasoning_details: [
            { type: "reasoning.text", text: "Synthetic reasoning", id: "r1" },
          ],
          tool_calls: [
            {
              index: 0,
              id: "report-call",
              type: "function",
              function: {
                name: "report",
                arguments: JSON.stringify({
                  kind: "plan",
                  summary: "Fix café sum",
                  detail:
                    "Use addition in sum.js. Check Unicode café and sum(2,3)=5.",
                }),
              },
            },
          ],
        }
      : { role: "assistant", content: "Finished café." };
    const chunk = {
      id: "synthetic",
      object: "chat.completion.chunk",
      created: 1,
      model: "synthetic/model",
      choices: [{ index: 0, delta: message, finish_reason: null }],
    };
    const end = {
      ...chunk,
      choices: [
        { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const root = await mkdtemp(join(tmpdir(), "pi-native-protocol-"));
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
  await writeFile(join(workspace, "sum.js"), "// synthetic\n");
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
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "synthetic-capability",
      requestIdField: "runtime_call_id",
      contextWindow: 32000,
      maxTokens: 8000,
    }),
  });
  const task = await runtime.start({
    workspace,
    objective: "Plan the synthetic fix",
  });
  const result = await runtime.run(task.id);
  assert.equal(result.status, "waiting_approval");
  assert(result.plan?.text.includes("café"));
  assert.equal(bodies.length, 2);
  assert.notEqual(bodies[0].runtime_call_id, bodies[1].runtime_call_id);
  assert(
    bodies[1].messages.some(
      (m: any) => m.role === "tool" && m.tool_call_id === "report-call",
    ),
  );
  assert(
    bodies[1].messages.some(
      (m: any) =>
        m.role === "assistant" && m.reasoning_details?.[0]?.id === "r1",
    ),
  );
  assert.equal(result.used.models, 2);
});
