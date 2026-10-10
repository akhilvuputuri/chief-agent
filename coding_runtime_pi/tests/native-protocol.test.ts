import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CodingRuntime, TaskStore, compatibleModel } from "../src/index.js";

for (const choice of [
  { provider: "synthetic", model: "synthetic/model", deepseek: false },
  { provider: "synthetic", model: "synthetic/handoff", deepseek: false },
  {
    provider: "openrouter",
    model: "deepseek/deepseek-v4.1-flash",
    deepseek: true,
  },
  ...[
    "openai/gpt-6.1-sol",
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-haiku-5.5",
    "google/gemini-3.8-flash",
    "qwen/qwen3.8-max-0902",
    "z-ai/glm-5.3-flash",
    "mistralai/mistral-large-4-0",
  ].map((model) => ({ provider: "openrouter", model, deepseek: false })),
])
  test(`native Pi ${choice.model} protocol performs tool continuation, request identity and Unicode without paid inference`, async (t) => {
    const bodies: any[] = [];
    const investigationTurns = choice.model === "synthetic/handoff" ? 32 : 1;
    const server = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer synthetic-capability");
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      bodies.push(body);
      const tool = bodies.length <= investigationTurns;
      const message = {
        role: "assistant",
        content: null,
        reasoning_details: [
          { type: "reasoning.text", text: "Synthetic reasoning", id: "r1" },
          {
            type: "reasoning.encrypted",
            data: "synthetic-opaque-signature",
            id: "signature1",
            format: "unknown",
            index: 1,
          },
        ],
        tool_calls: [
          {
            index: 0,
            id: tool ? "read-call" : "report-call",
            type: "function",
            function: {
              name: tool ? "read" : "report",
              arguments: JSON.stringify(
                tool
                  ? { path: "sum.js" }
                  : {
                      kind: "plan",
                      summary: "Fix café sum",
                      detail:
                        "Use addition in sum.js. Check Unicode café and sum(2,3)=5.",
                    },
              ),
            },
          },
        ],
      };
      const chunk = {
        id: "synthetic",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: message, finish_reason: null }],
      };
      const end = {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
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
    await writeFile(
      join(workspace, "AGENTS.md"),
      "Synthetic project rule: preserve the owner-selected objective.\n",
    );
    execFileSync("git", ["-C", workspace, "add", "."]);
    execFileSync("git", ["-C", workspace, "commit", "-qm", "Fixture"]);
    const runtime = new CodingRuntime({
      store: new TaskStore(
        join(root, "state"),
        "synthetic-state-key-32-characters",
      ),
      model: compatibleModel({
        provider: choice.provider,
        model: choice.model,
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
    assert.equal(bodies.length, investigationTurns + 1);
    if (investigationTurns === 32) {
      const final = bodies.at(-1);
      assert.equal(final.messages[0].role, "system");
      assert(
        final.messages[0].content.includes("Host workflow phase: final report"),
      );
      assert(final.messages[0].content.includes("Plan the synthetic fix"));
      assert(
        final.messages[0].content.includes(
          "preserve the owner-selected objective",
        ),
      );
      assert.equal(
        final.messages.filter((m: any) => m.role === "system").length,
        1,
      );
      assert.deepEqual(
        final.tools.map((t: any) => t.function.name),
        bodies[0].tools.map((t: any) => t.function.name),
      );
    }
    assert.notEqual(bodies[0].runtime_call_id, bodies[1].runtime_call_id);
    assert(
      bodies[1].messages.some(
        (m: any) => m.role === "tool" && m.tool_call_id === "read-call",
      ),
    );
    assert(
      bodies[1].messages.some(
        (m: any) =>
          m.role === "assistant" && m.reasoning_details?.[0]?.id === "r1",
      ),
    );
    if (choice.deepseek) {
      const replay = bodies[1].messages.find(
        (m: any) => m.role === "assistant",
      );
      assert.equal(replay.reasoning_content, "");
      assert.equal(replay.reasoning_details[0].id, "r1");
    }
    const continued = bodies[1].messages.find(
      (m: any) => m.role === "assistant",
    );
    assert.equal(
      continued.reasoning_details.find((r: any) => r.id === "signature1").data,
      "synthetic-opaque-signature",
    );
    assert.equal(result.used.models, investigationTurns + 1);
  });
