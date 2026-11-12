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
  anthropicModel,
  purposeHeader,
} from "../src/index.js";
import { messagesStream, toolUse, type FakeTurn } from "./anthropic-sse.js";

async function workspace(root: string) {
  const dir = join(root, "work");
  await mkdir(dir);
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Synthetic"]);
  execFileSync("git", [
    "-C",
    dir,
    "config",
    "user.email",
    "synthetic@example.invalid",
  ]);
  await writeFile(join(dir, "sum.js"), "// synthetic\n");
  await writeFile(
    join(dir, "AGENTS.md"),
    "Synthetic project rule: preserve the owner-selected objective.\n",
  );
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "Fixture"]);
  return dir;
}

for (const investigationTurns of [1, 32])
  test(`Pi's Anthropic client resends each response's content blocks unchanged (${investigationTurns} investigation turns)`, async (t) => {
    const requests: { headers: Record<string, unknown>; body: any }[] = [];
    const turns: FakeTurn[] = [];
    const server = createServer(async (req, res) => {
      assert.equal(req.url, "/gateway/v1/messages?beta=true");
      let text = "";
      for await (const chunk of req) text += chunk;
      requests.push({ headers: req.headers, body: JSON.parse(text) });
      const n = requests.length;
      const turn: FakeTurn =
        n <= investigationTurns
          ? {
              id: `msg_${n}`,
              content: [
                // Omitted-display thinking: empty text, real signature.
                { type: "thinking", thinking: "", signature: `sig-${n}-Zm9v` },
                { type: "text", text: `Reading café ${n}` },
                toolUse(`toolu_read_${n}`, "read", { path: "sum.js" }),
              ],
            }
          : {
              id: `msg_${n}`,
              content: [
                {
                  type: "thinking",
                  thinking: "Summarised reasoning",
                  signature: "sig-final",
                },
                toolUse("toolu_report", "report", {
                  kind: "plan",
                  summary: "Fix café sum",
                  detail:
                    "Use addition in sum.js. Check Unicode café and sum(2,3)=5.",
                }),
              ],
            };
      turns.push(turn);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(messagesStream(turn));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const port = (server.address() as { port: number }).port;
    const root = await mkdtemp(join(tmpdir(), "pi-native-protocol-"));
    const runtime = new CodingRuntime({
      store: new TaskStore(
        join(root, "state"),
        "synthetic-state-key-32-characters",
      ),
      model: anthropicModel({
        model: "claude-opus-5-5",
        baseUrl: `http://127.0.0.1:${port}/gateway`,
        apiKey: "synthetic-capability",
        maxTokens: 8000,
        reasoning: "medium",
      }),
    });
    const task = await runtime.start({
      workspace: await workspace(root),
      objective: "Plan the synthetic fix",
    });
    const result = await runtime.run(task.id);
    assert.equal(result.status, "waiting_approval");
    assert(result.plan?.text.includes("café"));
    assert.equal(requests.length, investigationTurns + 1);
    assert.equal(result.used.models, investigationTurns + 1);
    for (const { headers, body } of requests) {
      // The gateway capability travels as Pi's API key; there is no Anthropic key in the box.
      assert.equal(headers["x-api-key"], "synthetic-capability");
      assert.equal(headers[purposeHeader], "agent");
      assert.equal(body.model, "claude-opus-5-5");
      assert.equal(body.stream, true);
      assert.equal(body.max_tokens, 8000);
      assert.equal(body.thinking.type, "adaptive");
      // Pi's per-turn effort marker carries the configured level.
      assert.deepEqual(body.messages.at(-1), {
        role: "system",
        content: [],
        output_config: { effort: "medium" },
      });
    }
    // Every earlier response comes back in the next request exactly as the API sent it.
    const last = requests.at(-1)!.body;
    const assistants = last.messages.filter((m: any) => m.role === "assistant");
    assert.equal(assistants.length, investigationTurns);
    assistants.forEach((m: any, i: number) => {
      assert.equal(
        JSON.stringify(m.content),
        JSON.stringify(turns[i]!.content),
      );
    });
    assert(
      last.messages.some(
        (m: any) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some(
            (b: any) =>
              b.type === "tool_result" && b.tool_use_id === "toolu_read_1",
          ),
      ),
    );
    if (investigationTurns === 32) {
      const system = last.system.map((b: any) => b.text).join("\n");
      assert(system.includes("Host workflow phase: final report"));
      assert(system.includes("Plan the synthetic fix"));
      assert(system.includes("preserve the owner-selected objective"));
      assert.deepEqual(
        last.tools.map((tool: any) => tool.name),
        requests[0]!.body.tools.map((tool: any) => tool.name),
      );
    }
  });

test("a model Pi's catalogue does not list is refused before any request", async () => {
  await assert.rejects(
    anthropicModel({ model: "claude-unknown-0" })(async () => {}),
    /no Anthropic model claude-unknown-0/,
  );
});
