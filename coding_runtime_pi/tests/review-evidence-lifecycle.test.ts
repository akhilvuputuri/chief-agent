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
  compatibleModel,
  documentHash,
} from "../src/index.js";

test("complete large review evidence survives native compaction and explicit process replacement", async (t) => {
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
      for (const message of body.messages ?? []) {
        if (message.role !== "tool" || typeof message.content !== "string")
          continue;
        let chunk: any;
        try {
          chunk = JSON.parse(message.content);
        } catch {
          continue;
        }
        if (chunk.id !== "candidate_diff") continue;
        assert.equal(chunk.hash, hash);
        for (let i = chunk.from; i < chunk.to; i++)
          observed[attempt]![i] = chunk.text[i - chunk.from];
      }
      if (!compact) {
        const names = body.tools.map((tool: any) => tool.function.name);
        assert(names.includes("read_document"));
        assert(
          !names.some((name: string) =>
            ["bash", "edit", "write"].includes(name),
          ),
        );
      }
      const interrupt = !compact && attempt === 0 && page === 45;
      let delta: any, finish: string;
      if (compact) {
        summaries++;
        delta = {
          role: "assistant",
          content: `Review immutable candidate_diff, hash ${hash}. Continue reading its remaining pages; the host retains the complete document. No files changed. No verdict submitted.`,
        };
        finish = "stop";
      } else if (interrupt) {
        delta = {
          role: "assistant",
          content: "Controlled incomplete model response",
        };
        finish = "length";
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
        delta = {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: `evidence-${sequence}`,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            },
          ],
        };
        finish = "tool_calls";
      }
      const header = {
        id: `review-evidence-${sequence++}`,
        model: "fixture/review-evidence",
      };
      const input = Math.ceil(Buffer.byteLength(raw) / 4);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ ...header, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...header, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: input, completion_tokens: 100, total_tokens: input + 100 } })}\n\ndata: [DONE]\n\n`,
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
        model: compatibleModel({
          provider: "synthetic",
          model: "fixture/review-evidence",
          apiKey: "synthetic",
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          contextWindow: 1000000,
          maxTokens: 16000,
          maxRequestBytes: 179000,
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
  assert(wireSizes.every((size) => size <= 179000));
  assert.equal(git("status", "--short").toString(), "");
  console.log(
    JSON.stringify({
      pagesAfterReplacement: page,
      compactions: summaries,
      maxWireBytes: Math.max(...wireSizes),
    }),
  );
});
