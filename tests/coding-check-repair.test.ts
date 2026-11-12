import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codingApi } from "../src/coding/api.js";
import { runPiWorker, NativePiWorkerClient } from "../src/coding/pi-worker.js";
import { server } from "../src/server.js";
import { reviewDocumentReader } from "./helpers/pi-review-documents.js";
import { fixture, settings } from "./helpers/coding-fixture.js";

async function checksFixedAfter(t: any, wrongRounds: number, ms?: number) {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), "pi-check-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(
    join(source, "sum.js"),
    "export const sum = (a, b) => a - b;\n",
  );
  await writeFile(
    join(source, "test.mjs"),
    "import assert from 'node:assert/strict';import {sum} from './sum.js';assert.equal(sum(2,3),5);\n",
  );
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "synthetic-pi-workspace",
      version: "1.0.0",
      type: "module",
      scripts: {
        check: "node test.mjs",
        build: "node --check sum.js",
        "format:check": "node --check test.mjs",
      },
    }),
  );
  await writeFile(
    join(source, "package-lock.json"),
    JSON.stringify({
      name: "synthetic-pi-workspace",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "synthetic-pi-workspace", version: "1.0.0" } },
    }),
  );
  git("add", ".");
  git("commit", "-qm", "Fixture");
  const commit = git("rev-parse", "HEAD").toString().trim();
  const started = await f.start("pi-check-repair", true);
  await f.db.query(
    "UPDATE coding_jobs SET settings=$2::jsonb,base_sha=$3 WHERE id=$1",
    [
      started.id,
      JSON.stringify({
        ...settings,
        runtime: "pi",
        squad: false,
        autoMerge: false,
        ...(ms ? { limits: { ...settings.limits, ms } } : {}),
      }),
      commit,
    ],
  );
  const plan =
    "Change sum.js subtraction to addition; preserve exported API; run checks.";
  const readEvidence = reviewDocumentReader();
  const turns = new Map<string, number>();
  const wrong = ["a * b", "a / b", "a % b", "a ** b"];
  let current = "a - b";
  let edits = 0;
  const repairDocs: string[] = [];
  let rounds = 0;
  f.setGeneration((selected, input) => {
    const system =
      input.messages.find((m: any) => m.role === "system")?.content ?? "";
    const phase =
      selected === settings.reviewerModel
        ? "review"
        : system.includes("Current intent: build")
          ? "build"
          : "plan";
    if (phase === "review") {
      const evidence = readEvidence(input, "review");
      if (evidence) return evidence;
    }
    const delivered = input.messages
      .filter((m: any) => m.role === "tool" && typeof m.content === "string")
      .map((m: any) => m.content)
      .filter((c: string) => c.includes('"id":"check_failures"'));
    const repairing = String(system).includes("check_failures");
    let tool: { name: string; arguments: any };
    if (phase === "build" && repairing && !delivered.length) {
      // A repair round starts by reading the failures the host recorded.
      rounds++;
      tool = {
        name: "read_document",
        arguments: { id: "check_failures", page: 0 },
      };
    } else {
      const key = `${phase}:${repairing ? rounds : 0}`;
      const count = turns.get(key) ?? 0;
      if (phase === "build" && repairing && count === 0)
        repairDocs.push(
          delivered.map((c: string) => JSON.parse(c).text).join(""),
        );
      turns.set(key, count + 1);
      if (phase === "plan")
        tool =
          count === 0
            ? { name: "read", arguments: { path: "sum.js" } }
            : {
                name: "report",
                arguments: {
                  kind: "plan",
                  summary: "Fix addition",
                  detail: plan,
                },
              };
      else if (phase === "build") {
        if (count === 0) {
          const next = edits < wrongRounds ? wrong[edits]! : "a + b";
          edits++;
          tool = {
            name: "edit",
            arguments: {
              path: "sum.js",
              edits: [{ oldText: current, newText: next }],
            },
          };
          current = next;
        } else
          tool = {
            name: "report",
            arguments: {
              kind: "done",
              summary: "Addition fixed",
              detail: "Implemented; actual checks follow.",
            },
          };
      } else
        tool =
          count === 0
            ? { name: "read", arguments: { path: "sum.js" } }
            : {
                name: "report",
                arguments: {
                  kind: "review",
                  summary: "Reviewed",
                  detail: "Addition is correct.",
                  verdict: "APPROVE",
                },
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
  const prepareRepository = async (directory: string, assignment: any) => {
    execFileSync("git", ["clone", "--no-hardlinks", source, directory], {
      stdio: "pipe",
    });
    execFileSync(
      "git",
      ["-C", directory, "checkout", "--detach", assignment.baseSha],
      { stdio: "pipe" },
    );
  };
  const run = async () => {
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
      { prepareRepository },
    );
  };
  let receipt = 100;
  let approvalId = "";
  let approvedMessage = 0;
  for (let i = 0; i < 10 && !approvalId; i++)
    await f.c.deliver(async (_owner, _target, _text, id) => {
      const message_id = ++receipt;
      if (id) {
        approvalId = id.id;
        approvedMessage = message_id;
      }
      return { message_id };
    });
  assert(approvalId);
  await f.c.requirements.confirm("a", approvalId, "a", approvedMessage);
  await f.c.tick();
  return { f, id: started.id as string, run, repairDocs, edits: () => edits };
}

test("failed checks go back to the coder, who fixes them before review", async (t) => {
  const { f, id, run, repairDocs, edits } = await checksFixedAfter(t, 1);
  await run();
  const job = await f.row(id);
  assert.equal(job.state, "publishing");
  assert.equal(edits(), 2);
  assert.equal(repairDocs.length >= 1, true);
  assert.match(repairDocs[0]!, /\[Failures\]\nAssertionError/);
});

test("checks still failing after two fix rounds pause the job with the failures kept", async (t) => {
  const { f, id, run, edits } = await checksFixedAfter(t, 3);
  await run();
  await f.c.tick();
  await f.c.tick();
  const job = await f.row(id);
  assert.equal(job.state, "paused");
  assert.match(job.summary, /Checks failed/);
  assert.equal(edits(), 3);
  const failed = job.result.checks.find((c: any) => c.exitCode !== 0);
  assert.match(failed.output, /\[Failures\]/);
});

test("a job resumed after its checks failed gets fresh repair rounds and can pass", async (t) => {
  const { f, id, run, edits } = await checksFixedAfter(t, 4);
  await run();
  await f.c.tick();
  await f.c.tick();
  const paused = await f.row(id);
  assert.equal(paused.state, "paused");
  assert.equal(edits(), 3);
  await f.c.call("a", f.run, {
    operation: "coding_resume",
    id,
    baseRevision: paused.revision,
    requestKey: "resume-after-checks",
  } as any);
  await f.c.tick();
  await f.c.tick();
  // The second worker run repairs in sessions of its own; reusing the first run's
  // session names would conflict with what the host already stored.
  await run();
  const job = await f.row(id);
  assert.equal(job.state, "publishing");
  assert.equal(edits(), 5);
});

test("with under ten minutes of the attempt left, failed checks pause without a repair round", async (t) => {
  const { f, id, run, edits } = await checksFixedAfter(t, 1, 540_000);
  await run();
  await f.c.tick();
  await f.c.tick();
  const job = await f.row(id);
  assert.equal(job.state, "paused");
  assert.match(job.summary, /Checks failed/);
  assert.equal(edits(), 1);
});
