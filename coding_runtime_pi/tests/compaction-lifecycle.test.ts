import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  CodingRuntime,
  TaskStore,
  compatibleModel,
  localExecutor,
} from "../src/index.js";

// Actual Pi session/automatic compaction, with a deterministic HTTP provider.
// This is a lifecycle regression, not a model-quality acceptance workload.
for (const failure of [
  "truncated",
  "oversized",
  "disconnect",
  "cancel",
  "terminal-recovered",
  "terminal-second-failure",
  "terminal-cancel",
] as const) {
  test(`automatic ${failure} compaction preserves recovery boundaries`, async (t) => {
    const terminal = failure.startsWith("terminal-"),
      attemptId = randomUUID();
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
        if (
          terminal &&
          (summaries === 1 || failure === "terminal-second-failure")
        ) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              code: "model_transient_failure",
              recovery: {
                version: 1,
                kind: "terminal-provider-http",
                callId: request.runtime_call_id,
                attemptId,
                providerStatus: 504,
              },
            }),
          );
          if (failure === "terminal-cancel")
            setTimeout(() => {
              void cancelRun!();
            }, 10);
          return;
        }
        if (failure === "disconnect") {
          req.socket.destroy();
          return;
        }
        if (failure === "cancel") {
          await cancelRun!();
          res.destroy();
          return;
        }
        if (failure === "truncated") {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "model_incomplete",
                type: "invalid_request_error",
                code: "model_incomplete",
              },
            }),
          );
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
          : ordinary <= 20 &&
              !(failure === "terminal-recovered" && summaries >= 2)
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
      const delta = compact
        ? {
            role: "assistant",
            content: "Retained requirement and investigation state. ".repeat(
              terminal ? 12 : 5000,
            ),
          }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                index: 0,
                id: `tool-${phase}-${ordinary}`,
                type: "function",
                function: {
                  name: tool.name,
                  arguments: JSON.stringify(tool.arguments),
                },
              },
            ],
          };
      const header = {
        id: `fixture-${ordinary}-${summaries}`,
        model: "fixture/compaction",
        choices: [{ index: 0, delta, finish_reason: null }],
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify(header)}\n\ndata: ${JSON.stringify({ ...header, choices: [{ index: 0, delta: {}, finish_reason: compact ? "stop" : "tool_calls" }], usage: { prompt_tokens: phase === "build" && !compact ? 35000 : 100, completion_tokens: 100, total_tokens: phase === "build" && !compact ? 35100 : 200 } })}\n\ndata: [DONE]\n\n`,
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
      model: compatibleModel({
        provider: "synthetic",
        model: "fixture/compaction",
        apiKey: "synthetic",
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        contextWindow: 40000,
        maxTokens: 16000,
        maxRequestBytes: 179000,
        ...(terminal
          ? {
              requestIdField: "runtime_call_id",
              requestPurposeField: "runtime_purpose",
              terminalHttpRecovery: { attemptId },
            }
          : {}),
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
      failure === "terminal-recovered"
        ? "completed"
        : failure === "cancel" || failure === "terminal-cancel"
          ? "cancelled"
          : "paused",
      JSON.stringify({
        status: result.status,
        summary: result.summary,
        ordinary,
        summaries,
      }),
    );
    if (failure !== "terminal-recovered")
      assert.match(
        result.summary,
        failure === "cancel" || failure === "terminal-cancel"
          ? /stopped/i
          : /compaction|summari[sz]/i,
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
    assert.equal(
      summaries,
      failure === "terminal-recovered" || failure === "terminal-second-failure"
        ? 2
        : 1,
      "A failed compaction must not be retried implicitly after each subsequent tool turn",
    );
    if (terminal) {
      const entries = (await readFile(result.sessionFile!, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        entries.filter((entry) => entry.type === "compaction").length,
        failure === "terminal-recovered" ? 1 : 0,
      );
      assert.equal(
        result.used.models,
        1 + ordinary + summaries,
        "Every inference, including failed summary, is admitted",
      );
    }
    if (failure !== "terminal-recovered")
      assert.equal(
        ordinary,
        ordinaryAtFirstCompaction,
        "No new investigation should run after unrecovered compaction failure",
      );
  });
}
