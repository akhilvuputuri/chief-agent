import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  CodingRuntime,
  TaskStore,
  anthropicModel,
  documentHash,
} from "../src/index.js";
import { messagesStream, toolUse, type FakeBlock } from "./anthropic-sse.js";

test("complete large review evidence survives native compaction and explicit runtime/store replacement", async (t) => {
  const text = Array.from(
    { length: 6000 },
    (_, i) => `+Immutable changed line ${i}: preserve exact evidence.\n`,
  )
    .join("")
    .slice(0, 200000);
  assert.equal(text.length, 200000);
  const hash = documentHash(text);
  const root = await mkdtemp(join(tmpdir(), "pi-review-doc-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "work");
  await mkdir(workspace);
  await writeFile(join(workspace, "source.txt"), "Unchanged review tree\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspace, ...args], { stdio: "pipe" });
  git("init", "-q");
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
  let attempt = 0,
    page = 0,
    summaries = 0,
    sequence = 0;
  let handlerError: unknown;
  const observed: string[][] = [[], []];
  const wireSizes: number[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const bytes of req) raw += bytes;
      wireSizes.push(Buffer.byteLength(raw));
      const body = JSON.parse(raw),
        compact = !body.tools?.length;
      const results = (body.messages ?? []).flatMap((message: any) =>
        Array.isArray(message.content)
          ? message.content.filter(
              (b: any) =>
                b.type === "tool_result" && typeof b.content === "string",
            )
          : [],
      );
      for (const result of results) {
        let chunk: any;
        try {
          chunk = JSON.parse(result.content);
        } catch {
          continue;
        }
        if (chunk.id !== "candidate_diff") continue;
        assert.equal(chunk.hash, hash);
        for (let i = chunk.from; i < chunk.to; i++)
          observed[attempt]![i] = chunk.text[i - chunk.from];
      }
      if (!compact) {
        const names = body.tools.map((tool: any) => tool.name);
        assert(names.includes("read_document"));
        assert(
          !names.some((name: string) =>
            ["bash", "edit", "write"].includes(name),
          ),
        );
      }
      const interrupt = !compact && attempt === 0 && page === 45;
      let content: FakeBlock[], finish: string;
      if (compact) {
        summaries++;
        content = [
          {
            type: "text",
            text: `Review immutable candidate_diff, hash ${hash}. Continue reading its remaining pages; the host retains the complete document. No files changed. No verdict submitted.`,
          },
        ];
        finish = "end_turn";
      } else if (interrupt) {
        content = [
          { type: "text", text: "Controlled incomplete model response" },
        ];
        finish = "max_tokens";
      } else {
        const call =
          page < 50
            ? {
                name: "read_document",
                arguments: { id: "candidate_diff", page: page++ },
              }
            : {
                name: "report",
                arguments: {
                  kind: "review",
                  verdict: "APPROVE",
                  summary: "Controlled read-only review",
                  detail:
                    "The complete immutable evidence was available after replacement.",
                },
              };
        content = [toolUse(`evidence-${sequence}`, call.name, call.arguments)];
        finish = "tool_use";
      }
      const input = Math.ceil(Buffer.byteLength(raw) / 4);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        messagesStream({
          id: `review-evidence-${sequence++}`,
          content,
          stopReason: finish,
          usage: { input_tokens: input, output_tokens: 100 },
        }),
      );
    } catch (error) {
      handlerError = error;
      res.writeHead(500);
      res.end("Controlled fixture assertion failed");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const state = join(root, "state"),
    key = "synthetic-review-evidence-key-at-least32";
  const make = () => {
    const store = new TaskStore(state, key);
    return {
      store,
      runtime: new CodingRuntime({
        store,
        model: anthropicModel({
          model: "claude-opus-5-5",
          apiKey: "synthetic",
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
          // A small window makes Pi compact during the long review.
          contextWindow: 60000,
          maxTokens: 16000,
        }),
      }),
    };
  };
  const initial = make();
  const task = await initial.runtime.start({
    workspace,
    objective: "Review the exact candidate without writing files",
    referenceDocuments: [
      { id: "candidate_diff", title: "Complete bound diff", text },
    ],
    limits: { ms: 90000, models: 400, tools: 1000 },
  });
  task.intent = "review";
  await initial.store.save(task);
  const paused = await initial.runtime.run(task.id);
  assert.equal(handlerError, undefined);
  assert.equal(paused.status, "paused", paused.summary);
  assert(summaries > 0, "Must compact before the interrupted review");
  const firstEntries = SessionManager.open(paused.sessionFile!).getBranch();
  assert(firstEntries.some((entry) => entry.type === "compaction"));
  const replacement = make();
  assert.deepEqual(
    (await replacement.runtime.inspect(task.id)).referenceDocuments,
    task.referenceDocuments,
  );
  await assert.rejects(replacement.runtime.run(task.id), /explicit action/);
  attempt = 1;
  page = 0;
  await replacement.runtime.resume(task.id);
  const done = await replacement.runtime.run(task.id);
  assert.equal(handlerError, undefined);
  assert.equal(done.status, "completed", done.summary);
  assert.equal(done.report?.verdict, "APPROVE");
  assert.equal(observed[1]!.join(""), text);
  assert.equal(git("status", "--short").toString(), "");
  console.log(
    JSON.stringify({
      pagesAfterReplacement: page,
      compactions: summaries,
      maxWireBytes: Math.max(...wireSizes),
    }),
  );
});
