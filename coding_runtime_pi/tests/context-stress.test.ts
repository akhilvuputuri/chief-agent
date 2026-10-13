import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  CodingRuntime,
  TaskStore,
  compatibleModel,
  localExecutor,
} from "../src/index.js";

for (const scenario of [
  "progress",
  "large-scope",
  "stagnant",
  "small-progress",
  "small-stagnant",
] as const) {
  test(`native long-context lifecycle: ${scenario}`, async (t) => {
    const stagnant = scenario.endsWith("stagnant");
    const small = scenario.startsWith("small-");
    const rules = Array.from(
      { length: 220 },
      (_, i) =>
        `R${i}: evidence_${i} retains id ${i}, retained=true and exact rule text. Record progress only in progress.json.`,
    ).join("\n");
    const planText =
      "Preserve REQUIREMENT_A and REQUIREMENT_B and source.js. Record progress through step 100 in progress.json; configured checks verify the final artifact." +
      (scenario === "large-scope" ? "\n" + rules : "");
    const pages =
      scenario === "large-scope" ? Math.ceil(planText.length / 4000) : 0;
    let documentReads = 0,
      submitted = false,
      summariesAfterReport = 0;
    let phase: "plan" | "build" = "plan",
      ordinary = 0,
      summaries = 0,
      missingScope = false;
    const wireSizes: number[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const bytes of req) raw += bytes;
      wireSizes.push(Buffer.byteLength(raw));
      const body = JSON.parse(raw),
        compact = !body.tools?.length;
      let page: number | undefined;
      if (compact) {
        summaries++;
        if (submitted) summariesAfterReport++;
      } else if (phase === "build") {
        if (documentReads < pages) page = documentReads++;
        else ordinary++;
        const prompt = JSON.stringify(body.messages);
        missingScope ||=
          !prompt.includes("REQUIREMENT_A") ||
          !prompt.includes("REQUIREMENT_B");
      }
      const tool =
        phase === "plan"
          ? {
              name: "report",
              arguments: {
                kind: "plan",
                summary: "Execute controlled context stress",
                detail: planText,
              },
            }
          : page !== undefined
            ? {
                name: "read_document",
                arguments: { id: "approved_plan", page },
              }
            : ordinary > 100
              ? {
                  name: "report",
                  arguments: {
                    kind: "done",
                    summary: "Controlled work complete",
                    detail:
                      "The implementation candidate is ready for the configured real checks.\n" +
                      planText,
                  },
                }
              : !stagnant && (ordinary % 3 === 0 || ordinary === 100)
                ? {
                    name: "write",
                    arguments: {
                      path: "progress.json",
                      content:
                        JSON.stringify({
                          step: ordinary,
                          preserved: ["REQUIREMENT_A", "REQUIREMENT_B"],
                        }) + "\n",
                    },
                  }
                : { name: "read", arguments: { path: "source.js" } };
      if (!compact && phase === "build" && tool.name === "report")
        submitted = true;
      const delta = compact
        ? {
            role: "assistant",
            content: `Working state: preserve REQUIREMENT_A and REQUIREMENT_B. Source evidence inspected. Latest controlled work step ${ordinary}. Continue the remaining scoped edits, then submit the candidate for checks. Never claim checks passed without a receipt.`,
          }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                index: 0,
                id: `step-${phase}-${ordinary}`,
                type: "function",
                function: {
                  name: tool.name,
                  arguments: JSON.stringify(tool.arguments),
                },
              },
            ],
          };
      const header = {
        id: `stress-${ordinary}-${summaries}`,
        model: "fixture/context-stress",
      };
      // Provider accounting can exceed the locally modeled window (e.g. tokenization
      // differs); a successfully accepted terminal report must still terminate.
      const promptTokens =
        scenario === "large-scope" && submitted && !compact
          ? 40000
          : Math.ceil(Buffer.byteLength(raw) / 4);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ ...header, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...header, choices: [{ index: 0, delta: {}, finish_reason: compact ? "stop" : "tool_calls" }], usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(delta)) / 4), total_tokens: promptTokens + Math.ceil(Buffer.byteLength(JSON.stringify(delta)) / 4) } })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const root = await mkdtemp(join(tmpdir(), "pi-context-stress-")),
      workspace = join(root, "work");
    await mkdir(workspace);
    const source =
      Array.from(
        { length: small ? 1 : 220 },
        (_, i) =>
          `export const evidence_${i} = ${JSON.stringify({ id: i, retained: true, rule: "The public source remains unchanged while progress records advance and immutable original requirements remain available throughout context maintenance." })};`,
      ).join("\n") + "\n";
    await writeFile(join(workspace, "source.js"), source);
    const sourceHash = createHash("sha256").update(source).digest("hex");
    await writeFile(
      join(workspace, "verify.mjs"),
      `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';assert.deepEqual(JSON.parse(readFileSync('progress.json','utf8')),{step:100,preserved:['REQUIREMENT_A','REQUIREMENT_B']});assert.equal(createHash('sha256').update(readFileSync('source.js')).digest('hex'),${JSON.stringify(sourceHash)});`,
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
      "Controlled fixture",
    );
    const runtime = new CodingRuntime({
      store: new TaskStore(
        join(root, "state"),
        "synthetic-long-context-key-at-least32",
      ),
      model: compatibleModel({
        provider: "synthetic",
        model: "fixture/context-stress",
        apiKey: "synthetic",
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        contextWindow: 40000,
        maxTokens: 16000,
        maxRequestBytes: 179000,
      }),
      executor: (task) => localExecutor(task.workspace, join(root, "home")),
    });
    const task = await runtime.start({
      workspace,
      objective:
        "Preserve REQUIREMENT_A and REQUIREMENT_B and source.js. Perform the controlled work and record final step 100 in progress.json.",
      instructions: scenario === "large-scope" ? rules : undefined,
      checks: [!stagnant ? "node verify.mjs" : "node --check source.js"],
      limits: { ms: 90000, models: 400, tools: 1000 },
    });
    const planned = await runtime.run(task.id);
    assert.equal(planned.status, "waiting_approval");
    await runtime.approve(task.id, planned.plan!.revision, planned.plan!.hash);
    phase = "build";
    const result = await runtime.run(task.id);
    console.log(
      JSON.stringify({
        scenario,
        status: result.status,
        ordinary,
        summaries,
        documentReads,
        summariesAfterReport,
        maxWireBytes: Math.max(...wireSizes),
        summary: result.summary,
      }),
    );
    assert.equal(missingScope, false);
    assert(wireSizes.every((n) => n <= 179000));
    if (stagnant) {
      assert.equal(result.status, "paused");
      assert.match(result.summary, /stalled|no workspace progress/i);
      assert(ordinary <= 32);
      assert.equal(result.checks.length, 0);
    } else {
      assert.equal(result.status, "completed", result.summary);
      assert.equal(ordinary, 101);
      assert.equal(documentReads, pages);
      assert.equal(result.plan!.text, planText);
      assert.equal(
        summariesAfterReport,
        0,
        "Accepted reports must not start another automatic summary",
      );
      assert(
        small ? summaries === 0 : summaries >= 20,
        "Must actually exercise at least twenty native compactions",
      );
      assert.equal(result.checks[0]?.exitCode, 0);
      assert.deepEqual(
        JSON.parse(await readFile(join(workspace, "progress.json"), "utf8")),
        { step: 100, preserved: ["REQUIREMENT_A", "REQUIREMENT_B"] },
      );
      const entries = (await readFile(result.sessionFile!, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((x) => JSON.parse(x));
      const compacted = entries.filter((e) => e.type === "compaction");
      assert(small ? compacted.length === 0 : compacted.length >= 20);
      for (const e of compacted) {
        const c = e.details.contextMaintenance;
        assert(c.afterTokens < c.beforeTokens);
        assert(c.projectedBytes <= 179000 * 0.75);
        assert(c.projectedTokens <= 40000 - 8192);
      }
    }
  });
}
