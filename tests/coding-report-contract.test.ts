import { reportDocument } from "@chief-agent/pi-runtime/report";
import { execFileSync } from "node:child_process";
import { runPiWorker, NativePiWorkerClient } from "../src/coding/pi-worker.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import {
  readFile,
  readdir,
  mkdtemp,
  mkdir,
  symlink,
  writeFile,
  rm,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { requirementScope } from "../src/coding/requirements.js";
import { CodingController } from "../src/coding/controller.js";
import { selectCodingBackend } from "../src/coding/backend.js";
import { squadScope } from "../src/coding/squad-state.js";
import { ModelError, OpenRouter } from "../src/model.js";
import { formatTelegram } from "../src/telegram-format.js";
import { codingSettings, outcome } from "../src/coding/schema.js";
import { codingApi } from "../src/coding/api.js";
import {
  GitHubPublisher,
  artifactHash,
  validateFiles,
  canonicalJson,
} from "../src/coding/github.js";
import { SandboxAcknowledgementPending } from "../src/coding/provider.js";
import { Workspace } from "../src/coding/workspace.js";
import { codingLoop } from "../src/coding/loop.js";
import {
  runWorker,
  WorkerClient,
  WorkerRequestError,
} from "../src/coding/worker.js";
import { runtimeContext } from "../src/runtime.js";
import { server } from "../src/server.js";
import { recoverRuntime } from "../src/execution.js";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import {
  settings,
  base,
  candidate,
  fixture,
  startCard,
  unusedAnthropic,
} from "./helpers/coding-fixture.js";
test("Pi profile rejects Python selectors and automatic merge", async () => {
  assert(
    codingSettings.safeParse({
      ...settings,
      runtime: "pi",
      maxOutputTokens: 16000,
    }).success,
  );
  assert.equal(
    codingSettings.parse({ ...settings, runtime: "pi" }).maxOutputTokens,
    undefined,
  );
  for (const changes of [
    { maxOutputTokens: 128001 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 1.5 },
  ])
    assert(
      !codingSettings.safeParse({ ...settings, runtime: "pi", ...changes })
        .success,
    );
  assert(
    !codingSettings.safeParse({
      ...settings,
      runtime: "python",
      maxOutputTokens: 16000,
    }).success,
  );
  assert(
    codingSettings.safeParse({
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
    }).success,
  );
  for (const changes of [
    { squad: true },
    { harnessVersion: 2 },
    { autoMerge: true },
  ])
    assert(
      !codingSettings.safeParse({ ...settings, runtime: "pi", ...changes })
        .success,
    );
});
test("a Pi default retains legacy automation support without granting it to Pi jobs", async (t) => {
  const f = await fixture(t);
  let initialized = 0;
  const pi = codingSettings.parse({
    ...settings,
    runtime: "pi",
    squad: false,
    autoMerge: false,
  });
  new CodingController(
    f.db,
    pi,
    f.provider,
    {
      ...f.publisher,
      automation: () => {
        initialized++;
        return {} as any;
      },
    },
    "c".repeat(64),
    "https://coding.example.com",
    () => true,
    () => ({
      generate: async () => ({
        message: { role: "assistant", content: "synthetic" },
      }),
    }),
    undefined,
    undefined,
    { input: 2, output: 10 },
    true,
  );
  assert.equal(initialized, 1);
  assert.equal(pi.autoMerge, false);
});
for (const { documentLength, terminalRecovery } of [
  ...[0, 9357, 32000, -32000].map((documentLength) => ({
    documentLength,
    terminalRecovery: false,
  })),
  { documentLength: 0, terminalRecovery: true },
])
  test(`Pi bridge complete approved workflow preserves ${documentLength || "short"}-character documents${terminalRecovery ? " after Pi's own retry of a provider failure" : ""}`, async (t) => {
    const f = await fixture(t);
    const root = await mkdtemp(join(tmpdir(), "pi-bridge-fixture-"));
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
    const started = await f.start("pi-e2e", true);
    const profile = {
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
    };
    await f.db.query(
      "UPDATE coding_jobs SET settings=$2::jsonb,base_sha=$3 WHERE id=$1",
      [started.id, JSON.stringify(profile), commit],
    );
    const fullReview =
      "The checked fixture implements addition and preserves the API."
        .padEnd(
          Math.abs(documentLength) || 62,
          documentLength < 0 ? "界\n" : " Evidence retained.",
        )
        .slice(0, Math.abs(documentLength) || 62);
    const turns = new Map<string, number>();
    let laterRounds = 0;
    const recoveredPhases = new Set<string>();
    // The second review round reads what changed (journal 192): one coder session, one
    // reviewer session, findings into the coder's session.
    let round = 0;
    f.setGeneration((selected, input) => {
      const all = JSON.stringify(input.messages);
      const phase = selected === settings.reviewerModel ? "review" : "build";
      if (terminalRecovery && !recoveredPhases.has(phase)) {
        recoveredPhases.add(phase);
        throw new ModelError("Synthetic terminal provider failure", true, {
          httpStatus: 504,
        });
      }
      const count = turns.get(phase) ?? 0;
      turns.set(phase, count + 1);
      const repairing = phase === "build" && all.includes("requested changes");
      let tool: { name: string; arguments: any } | undefined;
      if (phase === "build") {
        // The owner's request is the coder's first message, whole.
        assert(all.includes("Synthetic evidence"));
        const steps =
          documentLength === 9357
            ? [
                {
                  name: "write",
                  arguments: {
                    path: "notes.txt",
                    content: Array.from(
                      { length: 1100 },
                      (_, i) => `Synthetic supporting text, line ${i}.\n`,
                    ).join(""),
                  },
                },
                {
                  name: "edit",
                  arguments: {
                    path: "sum.js",
                    edits: [{ oldText: "a - b", newText: "(a + b) || 0" }],
                  },
                },
              ]
            : [
                {
                  name: "edit",
                  arguments: {
                    path: "sum.js",
                    edits: [{ oldText: "a - b", newText: "a + b" }],
                  },
                },
              ];
        const done = {
          name: "report",
          arguments: {
            kind: "done",
            summary: "Addition fixed",
            detail: "Implemented the request and ran the tests.",
          },
        };
        if (repairing) {
          assert(all.startsWith('[{"role":"system"'));
          assert.match(all, /Remove the \|\| 0 fallback/);
          tool = !all.includes('"newText\\":\\"a + b\\"')
            ? {
                name: "edit",
                arguments: {
                  path: "sum.js",
                  edits: [{ oldText: "(a + b) || 0", newText: "a + b" }],
                },
              }
            : done;
        } else tool = steps[count] ?? done;
      } else {
        const last = input.messages.at(-1);
        if (last?.role === "user") {
          round++;
          if (round === 2) {
            laterRounds++;
            // The same reviewer session, told to read only what changed.
            assert.match(all, /Remove the \|\| 0 fallback/);
            assert.match(last.content, /git diff reviewed candidate/);
          } else {
            assert.match(last.content, /git diff [a-f0-9]{40} candidate/);
            assert(last.content.includes(commit));
            assert(last.content.includes("Synthetic evidence"));
          }
          tool = {
            name: "bash",
            arguments: {
              command:
                round === 2
                  ? "git diff reviewed candidate"
                  : `git diff ${commit} candidate -- sum.js`,
            },
          };
        } else {
          if (round === 2)
            assert.match(
              all,
              /-export const sum = \(a, b\) => \(a \+ b\) \|\| 0;\\n\+export const sum = \(a, b\) => a \+ b;/,
            );
          const changes = documentLength === 9357 && round === 1;
          tool = {
            name: "report",
            arguments: {
              kind: "review",
              summary: "Reviewed",
              detail: changes
                ? "Remove the || 0 fallback; preserve normal addition including NaN. ".padEnd(
                    9357,
                    "Keep complete approved scope. ",
                  )
                : fullReview,
              verdict: changes ? "REQUEST_CHANGES" : "APPROVE",
            },
          };
        }
      }
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
      await f.c.deliver(async (_owner, _target, text, id) => {
        const message_id = ++receipt;
        if (id) {
          assert.match(text, /^\*\*Ready to start\*\*/);
          approvalId = id.id;
          approvedMessage = message_id;
        }
        return { message_id };
      });
    assert(approvalId);
    await f.c.requirements.confirm("a", approvalId, "a", approvedMessage);
    await f.c.tick();
    await run();
    const result = await f.row(started.id);
    assert.equal(result.state, "publishing");
    assert.equal(result.result.review.verdict, "APPROVE");
    assert.equal(laterRounds, documentLength === 9357 ? 1 : 0);
    assert.equal(result.checkpoint.plan, "");
    assert.equal(result.result.review.findings, fullReview);
    assert.equal(result.checkpoint.piState.reportDocument.detail, fullReview);
    assert.equal(result.checkpoint.piState.reportDocument.version, 1);
    assert.equal(result.checkpoint.piState.phase, "review");
    if (documentLength === 9357)
      assert(!result.checkpoint.files[0].content.includes("|| 0"));
    // The coder ran the tests itself; the host ran none and needs no receipts.
    assert.deepEqual(result.result.checks, []);
    assert(
      result.checkpoint.files.some(
        (c: any) => c.path === "sum.js" && c.content.includes("a + b"),
      ),
    );
    await f.c.tick();
    await f.c.tick();
    assert.equal((await f.row(started.id)).state, "pr_ready");
    assert.equal(f.publishes(), 1);
    if (terminalRecovery) {
      assert.deepEqual([...recoveredPhases].sort(), ["build", "review"]);
      const calls = (
        await f.db.query(
          "SELECT id,attempt_id,role,state,input FROM coding_model_calls WHERE job_id=$1",
          [started.id],
        )
      ).rows;
      // Each failed call is recorded once; Pi's stock retry sends a new request.
      const failed = calls.filter((call) => call.state === "uncertain");
      assert.equal(failed.length, 2);
      assert.deepEqual(failed.map((call) => call.role).sort(), [
        "coder",
        "reviewer",
      ]);
      assert.equal(
        result.used_models,
        calls.filter((call) => call.attempt_id === result.attempt_id).length,
      );
      assert.equal(
        turns.get("build"),
        2,
        "One edit response and one done response; no tool-loop replay",
      );
    }
  });
test("a replacement Pi worker continues the stored session at the same fixed path", async (t) => {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), "pi-worker-recovery-"));
  const source = join(root, "source");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(
    join(source, "marker.txt"),
    "First-worker observation: synthetic uncertain-action marker.\n",
  );
  git("add", ".");
  git("commit", "-qm", "Fixture");
  const baseSha = git("rev-parse", "HEAD").toString().trim();
  const started = await f.start("pi-replacement");
  await f.db.query(
    "UPDATE coding_jobs SET settings=$2::jsonb,base_sha=$3 WHERE id=$1",
    [
      started.id,
      JSON.stringify({
        ...settings,
        runtime: "pi",
        squad: false,
        autoMerge: false,
      }),
      baseSha,
    ],
  );
  let turn = 0;
  f.setGeneration(() => {
    if (turn++ === 0)
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "read-marker",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: "marker.txt" }),
              },
            },
          ],
        },
      };
    throw new Error("Synthetic interrupted generation");
  });
  const app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const directories: string[] = [];
  const prepareRepository = async (directory: string, assignment: any) => {
    directories.push(directory);
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
  await f.c.tick();
  await run();
  assert.equal((await f.row(started.id)).state, "paused");
  await f.c.tick();
  await f.c.tick();
  const paused = await f.row(started.id);
  await f.c.call("a", f.run, {
    operation: "coding_resume",
    id: paused.id,
    baseRevision: paused.revision,
    requestKey: "explicit-recovery",
  });
  let recovered = false;
  let second = 0;
  f.setGeneration((_model, input) => {
    recovered ||= JSON.stringify(input.messages).includes(
      "First-worker observation: synthetic uncertain-action marker",
    );
    return second++ === 0
      ? {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "report-recovered",
                type: "function",
                function: {
                  name: "report",
                  arguments: JSON.stringify({
                    kind: "ask",
                    summary: "Recovered inspection",
                    ask: "Should the observed marker stay as it is?",
                  }),
                },
              },
            ],
          },
        }
      : { message: { role: "assistant", content: "Finished." } };
  });
  await f.c.tick();
  await run();
  assert.equal((await f.row(started.id)).state, "awaiting_input");
  assert(recovered);
  // The same path in every box, so the restored session's paths still hold (journal 192).
  assert.equal(directories[0], directories[1]);
  const entries = await f.db.query(
    "SELECT payload->>'index' AS index FROM coding_events WHERE job_id=$1 AND payload->>'kind'='pi_session'",
    [started.id],
  );
  assert(entries.rows.length > 5);
});
test("bundled Pi cutover snapshots new jobs while duplicate legacy requests and rollback retain their backends", async (t) => {
  const f = await fixture(t);
  const config = async (name: string) =>
    JSON.parse(
      await readFile(
        new URL(`../config/${name}.json`, import.meta.url),
        "utf8",
      ),
    );
  const legacy = await config("coding"),
    pi = await config("coding-pi");
  const selected = selectCodingBackend(
    await config("coding-backend"),
    legacy,
    pi,
  );
  assert.equal(selected.runtime, "pi");
  const controller = (profile: typeof settings) =>
    new CodingController(
      f.db,
      profile,
      f.provider,
      f.publisher,
      "c".repeat(64),
      "https://coding.example.com",
      (user) => user === "a",
      () => {
        throw new Error("This routing test must not make model calls");
      },
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      unusedAnthropic,
    );
  const prior = controller(
    selectCodingBackend({ default: "legacy" }, legacy, pi),
  );
  const current = controller(selected);
  const start = (c: CodingController, requestKey: string) =>
    c.call("a", f.run, {
      operation: "coding_start",
      requestKey,
      objective: "Inspect a synthetic bug",
      context: "Synthetic evidence",
    }) as Promise<any>;
  const old = await start(prior, "before-cutover");
  const saved = (await f.row(old.id)).settings;
  const retried = await start(current, "before-cutover");
  assert.equal(retried.id, old.id);
  assert.deepEqual((await f.row(old.id)).settings, saved);
  assert.equal(saved.runtime, "python");
  assert.equal(saved.image, legacy.image);
  const fresh = await start(current, "after-cutover");
  const record = await f.row(fresh.id);
  assert.equal(record.settings.runtime, "pi");
  assert.equal(record.settings.image, pi.image);
  assert.equal(record.settings.autoMerge, false);
  assert.deepEqual(record.settings.limits, pi.limits);
  assert.equal(record.mode, "plan");
  assert.equal(f.creates(), 0);
  const rolledBack = await start(prior, "after-rollback");
  assert.equal((await f.row(rolledBack.id)).settings.runtime, "python");
  assert.deepEqual((await f.row(fresh.id)).settings, record.settings);
  await current.call("a", f.run, { operation: "coding_cancel", id: old.id });
  assert.equal((await f.row(old.id)).state, "cancelled");
  assert.deepEqual((await f.row(old.id)).settings, saved);
});
