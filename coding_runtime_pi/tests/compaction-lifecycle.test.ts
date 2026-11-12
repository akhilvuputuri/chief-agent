import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  CodingRuntime,
  TaskStore,
  anthropicModel,
  localExecutor,
} from "../src/index.js";
import { messagesStream, toolUse } from "./anthropic-sse.js";

// Actual Pi session/automatic compaction, with a deterministic HTTP provider.
// This is a lifecycle regression, not a model-quality acceptance workload.
for (const failure of ["truncated", "disconnect", "cancel"] as const) {
  test(`automatic ${failure} compaction preserves recovery boundaries`, async (t) => {
    let cancelRun: (() => Promise<unknown>) | undefined;
    let phase: "plan" | "build" = "plan",
      ordinary = 0,
      summaries = 0,
      ordinaryAtFirstCompaction = 0;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const bytes of req) raw += bytes;
      const request = JSON.parse(raw),
        compact = !request.tools?.length;
      if (compact) {
        summaries++;
        if (summaries === 1) ordinaryAtFirstCompaction = ordinary;
        if (failure === "disconnect") {
          req.socket.destroy();
          return;
        }
        if (failure === "cancel") {
          await cancelRun!();
          res.destroy();
          return;
        }
      } else if (phase === "build") ordinary++;
      const tool =
        phase === "plan"
          ? {
              name: "report",
              arguments: {
                kind: "plan",
                summary: "Inspect fixture",
                detail:
                  "Inspect source evidence and preserve the public API; report whether work can be completed. Only actual checks may establish completion.",
              },
            }
          : ordinary <= 20
            ? { name: "read", arguments: { path: "source.js" } }
            : {
                name: "report",
                arguments: {
                  kind: "done",
                  summary: "Fixture terminal fallback",
                  detail:
                    "Synthetic provider terminal fallback after repeated investigation.",
                },
              };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        messagesStream({
          id: `fixture-${ordinary}-${summaries}`,
          content: compact
            ? [
                {
                  type: "text",
                  text: "Retained requirement and investigation state. ".repeat(
                    5000,
                  ),
                },
              ]
            : [toolUse(`tool-${phase}-${ordinary}`, tool.name, tool.arguments)],
          // The truncated case ends its summary at the output limit.
          stopReason: compact ? "max_tokens" : "tool_use",
          usage: {
            input_tokens: phase === "build" && !compact ? 35000 : 100,
            output_tokens: 100,
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const root = await mkdtemp(join(tmpdir(), "pi-compaction-lifecycle-")),
      workspace = join(root, "work");
    await mkdir(workspace);
    await writeFile(
      join(workspace, "source.js"),
      Array.from(
        { length: 200 },
        (_, i) =>
          `export const requirement_${i} = ${JSON.stringify({ id: i, owner: "synthetic", behavior: "Retain the documented validation behavior, source evidence, current checks and implementation status across context maintenance." })};`,
      ).join("\n") + "\n",
    );
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
      "Synthetic fixture",
    );
    const runtime = new CodingRuntime({
      store: new TaskStore(
        join(root, "state"),
        "synthetic-compaction-state-key-at-least32",
      ),
      model: anthropicModel({
        model: "claude-opus-5-5",
        apiKey: "synthetic",
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
        contextWindow: 40000,
        maxTokens: 16000,
        // Pi's default three retries, with short delays to keep the test quick.
        retry: { baseDelayMs: 10 },
      }),
      executor: (task) => localExecutor(task.workspace, join(root, "home")),
    });
    const task = await runtime.start({
      workspace,
      objective: "Inspect the synthetic source and retain all requirements.",
      checks: ["node --check source.js"],
      limits: { ms: 15000, models: 40, tools: 40 },
    });
    const plan = await runtime.run(task.id);
    assert.equal(plan.status, "waiting_approval");
    await runtime.approve(task.id, plan.plan!.revision, plan.plan!.hash);
    phase = "build";
    cancelRun = () => runtime.cancel(task.id);
    const result = await runtime.run(task.id);
    console.log(
      JSON.stringify({
        failure,
        ordinary,
        summaries,
        ordinaryAtFirstCompaction,
        status: result.status,
      }),
    );
    assert(summaries > 0, "Fixture must reach native automatic compaction");
    assert.equal(
      result.status,
      failure === "cancel" ? "cancelled" : "paused",
      JSON.stringify({
        status: result.status,
        summary: result.summary,
        ordinary,
        summaries,
      }),
    );
    assert.match(
      result.summary,
      failure === "cancel" ? /stopped/i : /compaction|summari[sz]/i,
      "Compaction failure must retain its actual cause",
    );
    const retainedStore = new TaskStore(
      join(root, "state"),
      "synthetic-compaction-state-key-at-least32",
    );
    const restored = await retainedStore.get(task.id);
    assert.equal(restored.status, result.status);
    assert.equal(restored.summary, result.summary);
    assert.equal(restored.plan!.hash, plan.plan!.hash);
    assert.equal(restored.used.models, result.used.models);
    assert.equal(restored.sessionFile, result.sessionFile);
    // A dropped connection is retried by Pi's stock retry (three times) and then stops; a
    // truncated summary or a cancellation is not retried.
    assert.equal(
      summaries,
      failure === "disconnect" ? 4 : 1,
      "A failed compaction must not be retried implicitly after each subsequent tool turn",
    );
    assert.equal(
      ordinary,
      ordinaryAtFirstCompaction,
      "No new investigation should run after unrecovered compaction failure",
    );
  });
}
