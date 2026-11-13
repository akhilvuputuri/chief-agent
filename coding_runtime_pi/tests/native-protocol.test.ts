import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  CodingRuntime,
  TaskStore,
  anthropicModel,
  localExecutor,
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
                  kind: "done",
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
      executor: (task) => localExecutor(task.workspace, join(root, "home")),
    });
    const dir = await workspace(root);
    const task = await runtime.start({
      workspace: dir,
      role: "coder",
      base: execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    });
    const result = await runtime.run(task.id, "Fix the synthetic sum");
    assert.equal(result.status, "completed");
    assert(result.report?.detail.includes("café"));
    // The report ends the run through Pi's own early termination: no call after it.
    assert.equal(requests.length, investigationTurns + 1);
    // The capability lives only in the worker's memory: no file the model's tools could read
    // (workspace, task store, Pi session) contains it.
    for (const file of await readdir(root, {
      recursive: true,
      withFileTypes: true,
    }))
      if (file.isFile())
        assert(
          !(await readFile(join(file.parentPath, file.name), "utf8")).includes(
            "synthetic-capability",
          ),
          join(file.parentPath, file.name),
        );
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
    // The request is the first message, sent once; the system prompt holds the role text.
    assert.equal(
      JSON.stringify(last.messages).split("Fix the synthetic sum").length,
      2,
    );
    if (investigationTurns === 32) {
      // No budget ends the session early: all 32 turns run as sent.
      const system = last.system.map((b: any) => b.text).join("\n");
      assert(system.includes("You are the coder of a Chief coding job"));
      assert(system.includes("preserve the owner-selected objective"));
      assert.deepEqual(
        last.tools.map((tool: any) => tool.name),
        requests[0]!.body.tools.map((tool: any) => tool.name),
      );
    }
  });

test("a model Pi's catalogue does not list is refused before any request", async () => {
  await assert.rejects(
    anthropicModel({ model: "claude-unknown-0" })(),
    /no Anthropic model claude-unknown-0/,
  );
});

test("a session restored in a new box continues, and a tool call the old box never finished gets a result from Pi", async (t) => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      messagesStream({
        id: "msg_restored",
        content: [
          toolUse("toolu_done", "report", {
            kind: "done",
            summary: "Continued",
            detail: "Continued after the box change.",
          }),
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const root = await mkdtemp(join(tmpdir(), "pi-restored-"));
  const dir = await workspace(root);
  // The previous box's session: the request, then a bash call whose box ended mid-tool.
  const old = SessionManager.create(dir, join(root, "old-session"));
  old.appendMessage({
    role: "user",
    content: "Synthetic first request",
    timestamp: Date.now(),
  });
  old.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "toolu_dangling",
        name: "bash",
        arguments: { command: "kite run check" },
      },
    ],
    api: "anthropic-messages",
    provider: "runtime",
    model: "claude-opus-5-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  const store = new TaskStore(
    join(root, "state"),
    "synthetic-state-key-32-characters",
  );
  const runtime = new CodingRuntime({
    store,
    model: anthropicModel({
      model: "claude-opus-5-5",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      apiKey: "synthetic-capability",
    }),
    executor: (task) => localExecutor(task.workspace, join(root, "home")),
  });
  const task = await runtime.start({
    workspace: dir,
    role: "coder",
    base: execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  });
  // The worker writes the restored entries where the task's one session lives.
  await mkdir(join(store.path(task.id), "session"), { recursive: true });
  await writeFile(
    join(store.path(task.id), "session", "restored.jsonl"),
    await readFile(old.getSessionFile()!, "utf8"),
  );
  const result = await runtime.run(
    task.id,
    "The previous box ended; continue.",
  );
  assert.equal(result.status, "completed");
  assert.equal(requests.length, 1);
  const messages = JSON.stringify(requests[0].messages);
  assert(messages.includes("Synthetic first request"));
  assert(messages.includes("The previous box ended; continue."));
  // Anthropic requires a result for every tool_use; Pi supplies one for the dangling call.
  assert(
    requests[0].messages.some(
      (m: any) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some(
          (b: any) =>
            b.type === "tool_result" && b.tool_use_id === "toolu_dangling",
        ),
    ),
  );
  assert.equal(
    result.sessionFile,
    join(store.path(task.id), "session", "restored.jsonl"),
  );
});
