import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { CodingRuntime, TaskStore, compatibleModel } from "../src/index.js";

for (const fixedWindow of [true, false]) {
  test(`native planning output with ${fixedWindow ? "artificial fixed window" : "selected model metadata"}`, async (t) => {
    let reads = 0,
      summaries = 0;
    const finalBudgets: number[] = [],
      summaryBudgets: number[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw),
        compact = !body.tools?.length;
      const finalizing = JSON.stringify(body.messages).includes(
        "Host workflow phase: final report",
      );
      const budget = body.max_tokens ?? body.max_completion_tokens;
      if (compact) {
        summaries++;
        summaryBudgets.push(budget);
      } else if (finalizing) finalBudgets.push(budget);
      else reads++;
      const truncated = !compact && finalizing && budget < 16000;
      const call = finalizing
        ? {
            name: "report",
            arguments: {
              kind: "plan",
              summary: "Complete scoped plan",
              detail:
                "Preserve REQUIREMENT_HEADROOM and source.js. Implement only the requested follow-up after exact owner approval, and run actual checks before claiming completion.",
            },
          }
        : { name: "read", arguments: { path: "source.js" } };
      const delta =
        compact || truncated
          ? {
              role: "assistant",
              content: compact
                ? "Inspected source.js. REQUIREMENT_HEADROOM remains authoritative. No edit or check has occurred. Report the source-grounded implementation plan and preserve the owner approval boundary."
                : "Partial planning output must not become an approved plan.",
            }
          : {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: `call-${reads}-${finalBudgets.length}`,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                },
              ],
            };
      const header = {
        id: `response-${reads}-${summaries}-${finalBudgets.length}`,
        model: "fixture/headroom",
      };
      // The provider's usage is below Pi's automatic maintenance threshold.
      // Native request construction still reserves provider safety headroom
      // and clamps output below the selected profile before final reporting.
      const promptTokens = compact ? 100 : 28000;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ ...header, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...header, choices: [{ index: 0, delta: {}, finish_reason: truncated ? "length" : compact ? "stop" : "tool_calls" }], usage: { prompt_tokens: promptTokens, completion_tokens: 100, total_tokens: promptTokens + 100 } })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const root = await mkdtemp(join(tmpdir(), "pi-report-headroom-")),
      workspace = join(root, "work");
    await mkdir(workspace);
    const source =
      Array.from(
        { length: 16 },
        (_, i) =>
          `export const evidence_${i} = ${JSON.stringify({ id: i, owner: "synthetic", rule: "Preserve this source-grounded validation requirement and exact identifier while preparing the implementation plan. No edit or check has been approved or completed." })};`,
      ).join("\n") + "\n";
    await writeFile(join(workspace, "source.js"), source);
    execFileSync("git", ["-C", workspace, "init", "-q"]);
    execFileSync("git", ["-C", workspace, "add", "."]);
    execFileSync("git", [
      "-C",
      workspace,
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "-qm",
      "Controlled fixture",
    ]);
    const runtime = new CodingRuntime({
      store: new TaskStore(
        join(root, "state"),
        "synthetic-report-headroom-key-at-least32",
      ),
      model: compatibleModel({
        provider: "openrouter",
        model: "deepseek/deepseek-v4.1-flash",
        apiKey: "synthetic",
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        ...(fixedWindow ? { contextWindow: 40000 } : {}),
        maxTokens: 16000,
        maxRequestBytes: 179000,
      }),
    });
    const task = await runtime.start({
      workspace,
      objective:
        "Plan the source change while preserving REQUIREMENT_HEADROOM; no implementation is approved.",
      limits: { ms: 90000, models: 100, tools: 100 },
    });
    const result = await runtime.run(task.id);
    console.log(
      JSON.stringify({
        fixedWindow,
        status: result.status,
        reads,
        summaries,
        finalBudgets,
        summaryBudgets,
      }),
    );
    assert.equal(reads, 32);
    assert.equal(summaries, 0);
    assert.equal(await readFile(join(workspace, "source.js"), "utf8"), source);
    assert.equal(result.approved, undefined);
    if (fixedWindow) {
      assert.equal(result.status, "paused");
      assert.equal(finalBudgets.length, 1);
      assert(finalBudgets[0]! < 16000);
      assert.equal(result.plan, undefined);
    } else {
      assert.equal(result.status, "waiting_approval", result.summary);
      assert.deepEqual(finalBudgets, [16000]);
      assert(result.plan?.text.includes("REQUIREMENT_HEADROOM"));
    }
  });
}
