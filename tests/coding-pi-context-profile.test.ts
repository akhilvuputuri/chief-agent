import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fixture, settings } from "./helpers/coding-fixture.js";
import { runPiWorker, NativePiWorkerClient } from "../src/coding/pi-worker.js";
import { codingApi } from "../src/coding/api.js";
import { server } from "../src/server.js";
import { ModelError } from "../src/model.js";

test("Pi bridge preserves selected model context metadata and final-report output allowance", async (t) => {
  const f = await fixture(t),
    source = await mkdtemp(join(tmpdir(), "pi-bridge-context-"));
  await writeFile(
    join(source, "source.js"),
    Array.from(
      { length: 16 },
      (_, i) =>
        `export const evidence_${i} = ${JSON.stringify({ id: i, owner: "synthetic", rule: "Preserve this source-grounded validation requirement and exact identifier while preparing the implementation plan. No edit or check has been approved or completed." })};`,
    ).join("\n") + "\n",
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" });
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
  const base = git("rev-parse", "HEAD").trim();
  const started = await f.start("native-model-context", "plan");
  await f.db.query(
    "UPDATE coding_jobs SET base_sha=$2,settings=$3::jsonb WHERE id=$1",
    [
      started.id,
      base,
      JSON.stringify({
        ...settings,
        runtime: "pi",
        squad: false,
        autoMerge: false,
        model: "deepseek/deepseek-v4.1-flash",
        leaderModel: "deepseek/deepseek-v4.1-flash",
        reviewerModel: "openai/gpt-6.1-sol",
        maxOutputTokens: 16000,
        limits: { ms: 900000, models: 100, tools: 1000 },
      }),
    ],
  );
  let reads = 0;
  const finalBudgets: number[] = [];
  f.setGeneration((_model, input) => {
    if (!input.tools?.length)
      return {
        message: {
          role: "assistant",
          content:
            "Inspected source.js; preserve the exact synthetic objective and report a plan without claiming approval or edits.",
        },
        usage: {
          prompt_tokens: 100,
          completion_tokens: 100,
          total_tokens: 200,
        },
      };
    const finalizing = JSON.stringify(input.messages).includes(
      "Host workflow phase: final report",
    );
    if (finalizing) {
      finalBudgets.push(input.maxOutputTokens);
      if (input.maxOutputTokens < 16000)
        throw new ModelError("Controlled truncated plan", false, {
          failureCode: "incomplete",
          finishReason: "length",
        });
    } else reads++;
    const call = finalizing
      ? {
          name: "report",
          arguments: {
            kind: "plan",
            summary: "Complete plan",
            detail:
              "Implement the synthetic source change only after exact owner confirmation, preserve its validation behavior and verify actual checks.",
          },
        }
      : { name: "read", arguments: { path: "source.js" } };
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call-${reads}-${finalBudgets.length}`,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          },
        ],
      },
      usage: {
        prompt_tokens: 28000,
        completion_tokens: 100,
        total_tokens: 28100,
      },
    };
  });
  const app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  await f.c.tick();
  const job = await f.row(started.id);
  await runPiWorker(
    new NativePiWorkerClient(
      origin,
      job.id,
      f.c.token(job.id, job.attempt_id),
      new AbortController().signal,
    ),
    () => {},
    new AbortController().signal,
    {
      prepareRepository: async (directory, assignment) => {
        execFileSync("git", ["clone", "--no-hardlinks", source, directory], {
          stdio: "pipe",
        });
        execFileSync(
          "git",
          ["-C", directory, "checkout", "--detach", assignment.baseSha],
          { stdio: "pipe" },
        );
      },
    },
  );
  const result = await f.row(job.id);
  console.log(JSON.stringify({ state: result.state, reads, finalBudgets }));
  assert.equal(result.state, "plan_ready");
  assert.equal(reads, 32);
  assert.deepEqual(finalBudgets, [16000]);
  assert.equal(result.checkpoint.files.length, 0);
  assert.equal(result.mode, "plan");
});
