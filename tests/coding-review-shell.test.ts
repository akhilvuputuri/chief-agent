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

async function reviewWith(t: any, command: string) {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), "pi-reviewer-switch-"));
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
  const started = await f.start("pi-switch", true);
  await f.db.query(
    "UPDATE coding_jobs SET settings=$2::jsonb,base_sha=$3 WHERE id=$1",
    [
      started.id,
      JSON.stringify({
        ...settings,
        limits: undefined,
        runtime: "pi",
        squad: false,
        autoMerge: false,
      }),
      commit,
    ],
  );
  const plan =
    "Change sum.js subtraction to addition; preserve exported API; run checks.";
  const turns = new Map<string, number>();
  f.setGeneration((selected, input) => {
    const system =
      input.messages.find((m: any) => m.role === "system")?.content ?? "";
    const phase =
      selected === settings.reviewerModel
        ? "review"
        : system.includes("You are the coder")
          ? "build"
          : "plan";
    if (phase === "review") {
    }
    const count = turns.get(phase) ?? 0;
    turns.set(phase, count + 1);
    const tool =
      phase === "plan"
        ? count === 0
          ? { name: "read", arguments: { path: "sum.js" } }
          : {
              name: "report",
              arguments: {
                kind: "plan",
                summary: "Fix addition",
                detail: plan,
              },
            }
        : phase === "build"
          ? count === 0
            ? {
                name: "edit",
                arguments: {
                  path: "sum.js",
                  edits: [{ oldText: "a - b", newText: "a + b" }],
                },
              }
            : {
                name: "report",
                arguments: {
                  kind: "done",
                  summary: "Addition fixed",
                  detail: "Implemented; actual checks follow.",
                },
              }
          : count === 0
            ? { name: "bash", arguments: { command } }
            : {
                name: "report",
                arguments: {
                  kind: "review",
                  summary: "Reviewed",
                  detail: "Addition is correct.",
                  verdict: "APPROVE",
                },
              };
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `${phase}-${count}`,
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
  return { f, id: started.id as string, run };
}

test("a reviewer may run commands and change files in its own copy, which never reach the candidate", async (t) => {
  const { f, id, run } = await reviewWith(
    t,
    "node --version && ls && printf tampered > sum.js && git -c user.name=r -c user.email=r@x commit -qam reviewer",
  );
  await run();
  const job = await f.row(id);
  assert.equal(job.state, "publishing");
  assert.deepEqual(
    job.result.checkpoint.files.map((file: any) => file.content),
    ["export const sum = (a, b) => a + b;\n"],
  );
});

test("a reviewer that changes the coder's checkout stops the attempt", async (t) => {
  const { run } = await reviewWith(t, "printf hook > ../workspace/sneaky.txt");
  await assert.rejects(run(), /workspace changed during review/);
});

test("a reviewer that plants a git hook in the coder's checkout stops the attempt", async (t) => {
  const { run } = await reviewWith(
    t,
    "printf '#!/bin/sh' > ../workspace/.git/hooks/pre-commit",
  );
  await assert.rejects(run(), /workspace changed during review/);
});

for (const [label, command] of [
  [
    "adds a git ignore rule",
    "printf 'src/\\n' >> ../workspace/.git/info/exclude",
  ],
  [
    "plants a package in the coder's cache",
    "mkdir -p ../tool-home/kite-store && printf poison > ../tool-home/kite-store/planted",
  ],
  [
    "plants a session for the coder",
    "mkdir -p ../state/planted && printf x > ../state/planted/a.jsonl",
  ],
  [
    "plants a FIFO as a git hook",
    "mkfifo ../workspace/.git/hooks/post-checkout",
  ],
  [
    "hides a file from git in the coder's index",
    "git -C ../workspace update-index --skip-worktree sum.js",
  ],
] as const)
  test(`a reviewer that ${label} stops the attempt`, async (t) => {
    const { run } = await reviewWith(t, command);
    await assert.rejects(run(), /workspace changed during review/);
  });
