import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codingApi } from "../src/coding/api.js";
import { runPiWorker, NativePiWorkerClient } from "../src/coding/pi-worker.js";
import { server } from "../src/server.js";
import { fixture, settings } from "./helpers/coding-fixture.js";

const checker = "synthetic/checker";

async function planned(t: any, planCheck: boolean, verdicts: string[]) {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), "pi-plan-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(join(source, "a.js"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "Fixture");
  const commit = git("rev-parse", "HEAD").toString().trim();
  const started = await f.start("plan-check", "plan");
  await f.db.query(
    "UPDATE coding_jobs SET settings=$2::jsonb,base_sha=$3 WHERE id=$1",
    [
      started.id,
      JSON.stringify({
        ...settings,
        runtime: "pi",
        squad: false,
        autoMerge: false,
        reviewerModel: checker,
        ...(planCheck ? { planCheck: true } : {}),
      }),
      commit,
    ],
  );
  const plans = [
    "Requirements:\n- change a to 2\nPlan: edit a.js.",
    "Requirements:\n- change a to 2\n- keep a.js exported\nPlan: edit a.js and keep its export.",
  ];
  let planner = 0;
  const checks: { detail: string }[] = [];
  let checkTurn = 0;
  f.setGeneration((selected, input) => {
    const system =
      input.messages.find((m: any) => m.role === "system")?.content ?? "";
    let tool: { name: string; arguments: any };
    if (selected === checker) {
      assert(system.includes("proposed_plan"));
      const read = input.messages.some(
        (m: any) =>
          m.role === "tool" &&
          typeof m.content === "string" &&
          m.content.includes('"id":"proposed_plan"'),
      );
      if (!read) {
        tool = {
          name: "read_document",
          arguments: { id: "proposed_plan", page: 0 },
        };
      } else {
        const verdict = verdicts[checkTurn++] ?? "APPROVE";
        const detail =
          verdict === "APPROVE"
            ? "Every requirement is kept."
            : "Gap: the owner asked to keep a.js exported; the plan does not say so.";
        checks.push({ detail });
        tool = {
          name: "report",
          arguments: { kind: "review", summary: "Checked", detail, verdict },
        };
      }
    } else {
      const text = plans[Math.min(planner++, plans.length - 1)]!;
      tool = {
        name: "report",
        arguments: { kind: "plan", summary: "Change a", detail: text },
      };
    }
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call-${Math.random()}`,
            type: "function",
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.arguments),
            },
          },
        ],
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
      prepareRepository: async (directory: string, assignment: any) => {
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
  return { f, id: started.id as string, plans, checks, planner: () => planner };
}

test("a plan with a missing requirement goes back to the planner before the Start card", async (t) => {
  const { f, id, plans, checks, planner } = await planned(t, true, [
    "REQUEST_CHANGES",
    "APPROVE",
  ]);
  const job = await f.row(id);
  assert.equal(job.state, "plan_ready");
  assert.equal(job.checkpoint.plan, plans[1]);
  assert.equal(planner(), 2);
  assert.equal(checks.length, 2);
  assert.match(job.summary, /revised once to keep every requirement/);
});

test("a plan that keeps every requirement is offered unchanged", async (t) => {
  const { f, id, plans, checks, planner } = await planned(t, true, ["APPROVE"]);
  const job = await f.row(id);
  assert.equal(job.state, "plan_ready");
  assert.equal(job.checkpoint.plan, plans[0]);
  assert.equal(planner(), 1);
  assert.equal(checks.length, 1);
  assert.match(job.summary, /^Checked against your request\./);
});

test("without the setting the reviewer is never asked about a plan", async (t) => {
  const { f, id, plans, checks } = await planned(t, false, []);
  const job = await f.row(id);
  assert.equal(job.state, "plan_ready");
  assert.equal(job.checkpoint.plan, plans[0]);
  assert.equal(checks.length, 0);
});
