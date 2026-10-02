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
import { CodingController } from "../src/coding/controller.js";
import { codingSettings, outcome } from "../src/coding/schema.js";
import { codingApi } from "../src/coding/api.js";
import {
  GitHubPublisher,
  artifactHash,
  validateFiles,
} from "../src/coding/github.js";
import { CodeBuildSandbox } from "../src/coding/provider.js";
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

const settings = codingSettings.parse({
  repository: "akhilvuputuri/chief-agent",
  branch: "main",
  image: `ghcr.io/example/worker@sha256:${"a".repeat(64)}`,
  model: "fixture/coder",
  reviewerModel: "fixture/reviewer",
  effort: "high",
  limits: { ms: 900000, models: 40, tools: 100 },
});
const base = "a".repeat(40);
const candidate = () => {
  const c = {
    plan: "Fix the fixture",
    patch: "fixture diff",
    summary: "Fixture changed",
    files: [
      { path: "src/fixture.ts", content: "export const fixture = true;\n" },
    ],
  };
  return outcome.parse({
    kind: "candidate",
    summary: "Fixture complete",
    checkpoint: c,
    checks: ["check", "build", "format:check"].map((s) => ({
      command: `npm run ${s}`,
      exitCode: 0,
      output: "passed",
    })),
    review: {
      verdict: "APPROVE",
      findings: "Fixture reviewed",
      model: settings.reviewerModel,
      patchHash: artifactHash(c),
    },
  });
};
async function fixture(t: TestContext) {
  const pg = new PGlite();
  t.after(() => pg.close());
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => /^\d.*sql$/.test(f))
    .sort())
    await pg.exec(
      await readFile(new URL(`../db/${file}`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "a");
  await ensureUser(db, "b");
  const run = randomUUID();
  await db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'a','synthetic coding request')",
    [run],
  );
  let now = new Date();
  let permitted = true;
  let creates = 0,
    publishes = 0,
    modelCalls = 0,
    uncertainCreate = false,
    uncertainPublish = false,
    failModel = false;
  const sandboxes = new Map<
    string,
    { id: string; state: "running" | "terminal" }
  >();
  const provider = {
    create: async (r: any) => {
      creates++;
      const id = `fixture:${r.attemptId}`;
      sandboxes.set(r.attemptId, { id, state: "running" });
      if (uncertainCreate) throw new Error("private provider error");
      return id;
    },
    find: async (attempt: string) => sandboxes.get(attempt)?.id,
    inspect: async (id: string) => {
      const s = [...sandboxes.values()].find((v) => v.id === id);
      if (!s) throw new Error("missing");
      return s.state;
    },
    terminate: async (id: string) => {
      const s = [...sandboxes.values()].find((v) => v.id === id)!;
      s.state = "terminal";
    },
  };
  let published = false;
  const publisher = {
    resolve: async () => base,
    publish: async () => {
      if (!published) {
        publishes++;
        published = true;
        if (uncertainPublish) throw new Error("PR acknowledgement lost");
      }
      return {
        url: "https://github.com/example/repo/pull/1",
        head: "b".repeat(40),
      };
    },
  };
  const c = new CodingController(
    db,
    settings,
    provider,
    publisher,
    "c".repeat(64),
    "https://coding.example.com",
    (u) => u === "a" && permitted,
    () => ({
      generate: async () => {
        modelCalls++;
        if (failModel) throw new Error("private model error");
        return { message: { role: "assistant", content: "fixture reply" } };
      },
    }),
    () => now,
  );
  const start = async (
    key = "request",
    mode: "plan" | "implement" = "implement",
  ) =>
    c.call("a", run, {
      operation: "coding_start",
      requestKey: key,
      objective: "Fix a synthetic bug",
      context: "Synthetic evidence",
      mode,
    }) as Promise<any>;
  const row = async (id: string) =>
    (await db.query("SELECT * FROM coding_jobs WHERE id=$1", [id])).rows[0];
  return {
    db,
    c,
    run,
    start,
    row,
    provider,
    publisher,
    creates: () => creates,
    publishes: () => publishes,
    modelCalls: () => modelCalls,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    revoke: () => {
      permitted = false;
    },
    restoreOwner: () => {
      permitted = true;
    },
    uncertainCreate: () => {
      uncertainCreate = true;
    },
    uncertainPublish: () => {
      uncertainPublish = true;
    },
    failModel: () => {
      failModel = true;
    },
  };
}

test("coding is unavailable by default and discovered through the work tools when enabled", () => {
  const off = runtimeContext({}, null).tools;
  assert(!off.some((t) => t.name.startsWith("coding_")));
  const on = runtimeContext(
    { coding: true },
    null,
    undefined,
    new Set(["work"]),
  ).tools;
  for (const name of [
    "coding_start",
    "coding_status",
    "coding_reply",
    "coding_resume",
    "coding_cancel",
  ])
    assert(
      on.some((t) => t.name === name),
      name,
    );
});
test("dispatch is owner-scoped, foreground-only and idempotent against the original request", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  assert.equal(job.state, "queued");
  assert.equal(f.creates(), 0);
  assert.equal((await f.start()).id, job.id);
  await assert.rejects(f.c.status("b", job.id));
  await assert.rejects(
    f.c.call("a", f.run, {
      operation: "coding_start",
      requestKey: "request",
      objective: "different",
      context: "",
      mode: "implement",
    }),
    /different request/,
  );
  await f.db.query("UPDATE work_turns SET background=true WHERE run_id=$1", [
    f.run,
  ]);
  await assert.rejects(f.start("second"), /foreground/);
});
test("worker jobs survive Chief recovery; attempt capabilities cannot cross jobs or revive cancellation", async (t) => {
  const f = await fixture(t),
    job = await f.start(),
    second = await f.start("second");
  await f.c.tick();
  const j = await f.row(job.id),
    token = f.c.token(j.id, j.attempt_id);
  await recoverRuntime(f.db);
  assert.equal((await f.row(j.id)).state, "provisioning");
  assert.equal((await f.c.authenticate(j.id, token)).id, j.id);
  await assert.rejects(f.c.authenticate(second.id, token));
  await f.c.call("a", f.run, { operation: "coding_cancel", id: j.id });
  await assert.rejects(f.c.authenticate(j.id, token));
  await assert.rejects(f.c.heartbeat(j), /superseded/);
  await assert.rejects(f.c.finish(j, candidate()), /superseded/);
  await f.c.tick();
  await f.c.tick();
  assert.equal((await f.row(j.id)).cleanup, "complete");
  await f.c.tick();
  assert.equal(f.creates(), 2);
});
test("lost provisioning acknowledgement reconciles one sandbox, cleans up and requires explicit resume", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  f.uncertainCreate();
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(j.state, "paused");
  assert.equal(j.cleanup, "pending");
  await assert.rejects(
    f.c.call("a", f.run, {
      operation: "coding_resume",
      id: j.id,
      baseRevision: 1,
      requestKey: "resume",
    }),
    /cleanup/,
  );
  await f.c.tick();
  await f.c.tick();
  assert.equal(f.creates(), 1);
  assert.equal((await f.row(j.id)).cleanup, "complete");
  const r: any = await f.c.call("a", f.run, {
    operation: "coding_reply",
    id: j.id,
    baseRevision: 1,
    requestKey: "reply",
    message: "Use a synthetic regression",
    mode: "plan",
  });
  assert.equal(r.revision, 2);
  assert.equal(r.mode, "plan");
  assert.equal(
    (
      (await f.c.call("a", f.run, {
        operation: "coding_reply",
        id: j.id,
        baseRevision: 1,
        requestKey: "reply",
        message: "Use a synthetic regression",
        mode: "plan",
      })) as any
    ).revision,
    2,
  );
  await assert.rejects(
    f.c.call("a", f.run, {
      operation: "coding_resume",
      id: j.id,
      baseRevision: 1,
      requestKey: "stale",
    }),
    /scope changed/,
  );
});
test("heartbeat expiry pauses instead of starting another worker and revokes the old capability", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  f.advance(181000);
  await f.c.tick();
  assert.equal((await f.row(j.id)).state, "paused");
  await assert.rejects(f.c.authenticate(j.id, f.c.token(j.id, j.attempt_id)));
  await f.c.tick();
  await f.c.tick();
  assert.equal(f.creates(), 1);
});
test("only verified artifact candidates publish; lost PR acknowledgement is reconciled without duplicate publication", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id),
    r = candidate();
  await assert.rejects(
    f.c.finish(j, { ...r, review: { ...r.review, patchHash: "d".repeat(64) } }),
    /exact artifact/,
  );
  await assert.rejects(f.c.finish(j, { ...r, checks: [] }), /passing checks/);
  await f.c.finish(j, r);
  assert.equal((await f.row(j.id)).state, "publishing");
  await f.c.tick();
  f.uncertainPublish();
  await assert.rejects(f.c.tick());
  assert.equal((await f.row(j.id)).cleanup, "complete");
  assert.equal((await f.row(j.id)).state, "publishing");
  await f.c.tick();
  assert.equal(f.publishes(), 1);
  assert.equal((await f.row(j.id)).state, "pr_ready");
  assert.equal((await f.row(j.id)).head_sha, "b".repeat(40));
});
test("worker HTTP routes validate capabilities and reject malformed calls without private error text", async (t) => {
  const f = await fixture(t),
    job = await f.start("plan", "plan");
  await f.c.tick();
  const j = await f.row(job.id),
    app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const path = `/coding/worker/${j.id}/assignment`,
    headers = { authorization: `Bearer ${f.c.token(j.id, j.attempt_id)}` };
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  assert.equal((await app.inject({ url: path, headers })).json().baseSha, base);
  const bad = await app.inject({
    method: "POST",
    url: `/coding/worker/${j.id}/checkpoint`,
    headers,
    payload: {
      plan: "private text",
      files: [{ path: "../escape", content: "secret" }],
    },
  });
  assert.equal(bad.statusCode, 409);
  assert(!bad.body.includes("private text"));
  assert(!bad.body.includes("secret"));
  await assert.rejects(f.c.finish(j, candidate()), /Plan-only/);
});
test("model calls are counted once, persist evidence and never replay an uncertain request", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  const input = {
    callId: randomUUID(),
    role: "coder" as const,
    messages: [{ role: "user" as const, content: "Synthetic request" }],
    tools: [],
  };
  await f.c.generate(j, input);
  await f.c.generate(j, input);
  assert.equal(f.modelCalls(), 1);
  assert.equal((await f.row(j.id)).used_models, 1);
  f.failModel();
  const failed = { ...input, callId: randomUUID() };
  await assert.rejects(f.c.generate(j, failed));
  await assert.rejects(f.c.generate(j, failed), /uncertain/);
  assert.equal(f.modelCalls(), 2);
  const records = (
    await f.db.query("SELECT state FROM coding_model_calls ORDER BY created_at")
  ).rows;
  assert.deepEqual(
    records.map((r) => r.state),
    ["complete", "uncertain"],
  );
});
test("progress duplicates do not rewrite later state and uncertain Telegram deliveries stay inspectable", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  const first = { key: "first", stage: "planning", summary: "Planning" };
  await f.c.progress(j, first);
  await f.c.progress(j, {
    key: "second",
    stage: "verifying",
    summary: "Verifying",
  });
  await f.c.progress(j, first);
  assert.equal((await f.row(j.id)).stage, "verifying");
  await assert.rejects(
    f.c.progress(j, { ...first, summary: "different" }),
    /conflict/,
  );
  await f.c.deliver(async () => {
    throw new Error("delivery uncertain");
  });
  const events = (
    await f.db.query("SELECT delivery FROM coding_events ORDER BY created_at")
  ).rows;
  assert.equal(events.filter((e) => e.delivery === "uncertain").length, 1);
  await f.db.query(
    "UPDATE coding_events SET delivery='sending' WHERE delivery='pending'",
  );
  await f.c.recoverDelivery();
  assert(
    (await f.db.query("SELECT 1 FROM coding_events WHERE delivery='pending'"))
      .rows.length === 0,
  );
});
test("the CodeBuild request uses a trusted worker image and fixed buildspec, no project source or logs", async () => {
  const commands: any[] = [];
  const p = new CodeBuildSandbox(
    {
      send: async (command: any) => {
        commands.push(command);
        return { build: { id: "fixture:one" } };
      },
    } as any,
    "fixture-project",
  );
  await p.create({
    jobId: randomUUID(),
    attemptId: randomUUID(),
    token: "a".repeat(64),
    origin: "https://fixture.example",
    image: settings.image,
    timeoutMinutes: 20,
  });
  const req = commands[0].input;
  assert.equal(req.sourceTypeOverride, "NO_SOURCE");
  assert.equal(req.privilegedModeOverride, false);
  assert.equal(req.autoRetryLimitOverride, 0);
  assert.equal(req.imageOverride, settings.image);
  assert(req.buildspecOverride.includes("run-as: node"));
  assert(!req.buildspecOverride.includes("npm"));
  assert.equal(req.logsConfigOverride.cloudWatchLogs.status, "DISABLED");
});
test("workspace rejects traversal and symlinks, captures new/deleted files and kills commands on cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-workspace-test-"));
  const stop = new AbortController(),
    w = new Workspace(root, stop.signal);
  await w.command("git", ["init"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  await w.write("src/new.ts", "export const a=1;\n");
  await assert.rejects(w.write("../escape", "x"));
  const outside = await mkdtemp(join(tmpdir(), "chief-outside-"));
  await symlink(outside, join(root, "link"));
  await assert.rejects(w.write("link/escape", "x"));
  await rm(join(root, "link"));
  await w.command("git", ["add", "src/new.ts"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  await w.remove("src/new.ts");
  await w.write("src/other.ts", "export const b=2;\n");
  const c = await w.snapshot("plan", "summary");
  assert.equal(c.files.find((f) => f.path === "src/new.ts")?.content, null);
  assert.equal(
    c.files.find((f) => f.path === "src/other.ts")?.content,
    "export const b=2;\n",
  );
  const running = w.command(process.execPath, [
    "-e",
    "setInterval(()=>{},10000)",
  ]);
  setTimeout(() => stop.abort(), 25);
  assert.equal((await running).exitCode, -1);
});
test("review tools cannot write even if the model invents an unavailable command", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-review-test-")),
    w = new Workspace(root, new AbortController().signal);
  let call = 0;
  const messages: any[] = [
    { role: "system", content: "review" },
    { role: "user", content: "fixture" },
  ];
  const model: any = {
    generate: async () => ({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: String(++call),
            type: "function",
            function: {
              name: call === 1 ? "command" : "report",
              arguments: JSON.stringify(
                call === 1
                  ? { command: "touch forbidden" }
                  : {
                      kind: "REQUEST_CHANGES",
                      summary: "Concrete fixture finding",
                    },
              ),
            },
          },
        ],
      },
    }),
  };
  const r = await codingLoop({
    model,
    workspace: w,
    messages,
    mode: "review",
    budget: { models: 3, tools: 3 },
    signal: new AbortController().signal,
    checkpoint: async () => {
      throw new Error("unexpected write");
    },
  });
  assert.equal(r.kind, "REQUEST_CHANGES");
  assert(messages[3].content.includes("rejected"));
  assert(!(await readdir(root)).includes("forbidden"));
});
test("publication rejects unsafe file manifests", () => {
  for (const path of [
    "../escape",
    ".git/config",
    ".env",
    ".github/workflows/pwn.yml",
  ])
    assert.throws(() => validateFiles([{ path, content: "x" }]));
});

test("worker implements, verifies and reviews a real disposable fixture before returning its candidate", async () => {
  let fixtureBase = "";
  const reports: any[] = [];
  let coderCalls = 0,
    reviewerCalls = 0;
  const client: any = {
    request: async (path: string, body: any) => {
      if (path === "assignment")
        return {
          id: randomUUID(),
          revision: 1,
          objective: "Fix the fixture value",
          context: "Synthetic only",
          mode: "implement",
          baseSha: fixtureBase,
          settings,
          checkpoint: { plan: "", summary: "", patch: "", files: [] },
          deadline: new Date(Date.now() + 60000).toISOString(),
          usedModels: 0,
        };
      reports.push({ path, body });
      return { accepted: true };
    },
    adapter: (role: string) => ({
      generate: async (input: any) => {
        if (role === "reviewer") {
          reviewerCalls++;
          assert(input.messages[1].content.includes("fixture = true"));
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "review",
                  type: "function",
                  function: {
                    name: "report",
                    arguments: JSON.stringify({
                      kind: "APPROVE",
                      summary:
                        "Synthetic change matches the requested fixture.",
                    }),
                  },
                },
              ],
            },
          };
        }
        coderCalls++;
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `coder-${coderCalls}`,
                type: "function",
                function: {
                  name: coderCalls === 1 ? "file_write" : "report",
                  arguments: JSON.stringify(
                    coderCalls === 1
                      ? {
                          path: "fixture.js",
                          content: "export const fixture = true;\n",
                        }
                      : {
                          kind: "candidate",
                          summary: "Fixed the fixture",
                          plan: "Change false to true and verify.",
                        },
                  ),
                },
              },
            ],
          },
        };
      },
    }),
  };
  const source = await mkdtemp(join(tmpdir(), "chief-worker-fixture-")),
    seed = new Workspace(source, new AbortController().signal);
  await seed.command("git", ["init"]);
  await seed.write(".gitignore", "node_modules\n");
  await seed.write("fixture.js", "export const fixture = false;\n");
  await seed.write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      type: "module",
      scripts: {
        check:
          "node -e \"import('./fixture.js').then(m=>{if(!m.fixture)process.exit(1)})\"",
        build: "node --check fixture.js",
        "format:check": "node --check fixture.js",
      },
    }),
  );
  await seed.write(
    "package-lock.json",
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "fixture", version: "1.0.0" } },
    }),
  );
  await seed.command("git", ["add", "-A"]);
  await seed.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  fixtureBase = (
    await seed.command("git", ["rev-parse", "HEAD"])
  ).output.trim();
  await runWorker(
    client,
    new AbortController().signal,
    async (w, _repo, _base, c) => {
      assert.equal(
        (await w.command("git", ["clone", source, "."])).exitCode,
        0,
      );
      await w.restore(c);
    },
  );
  const result = reports.find((r) => r.path === "finish").body;
  assert.equal(result.kind, "candidate");
  assert.equal(reviewerCalls, 1);
  assert.equal(result.review.patchHash, artifactHash(result.checkpoint));
  assert.equal(result.checks.length, 3);
  assert(result.checks.every((c: any) => c.exitCode === 0));
  assert(reports.some((r) => r.path === "checkpoint"));
});

test("GitHub publication reconciles a lost PR response and rejects an externally changed head", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const repo = "example/repo",
    id = randomUUID();
  let created = false,
    external = false,
    posts = 0;
  const transport: any = async (url: string, options: any) => {
    const path = new URL(url).pathname;
    let data: any;
    if (path.endsWith("/access_tokens"))
      data = {
        token: "fixture",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
    else if (path.endsWith("/pulls") && options.method === "GET")
      data = created
        ? [
            {
              state: "open",
              draft: true,
              html_url: `https://github.com/${repo}/pull/1`,
              head: { sha: "head", repo: { full_name: repo } },
              base: { repo: { full_name: repo } },
            },
          ]
        : [];
    else if (path.endsWith(`/git/commits/${base}`))
      data = { tree: { sha: "base-tree" } };
    else if (path.endsWith("/git/trees/base-tree"))
      data = { tree: [], truncated: false };
    else if (path.endsWith("/git/trees") && options.method === "POST")
      data = { sha: "candidate-tree" };
    else if (path.endsWith("/git/commits") && options.method === "POST") {
      assert.deepEqual(JSON.parse(options.body).author, {
        name: "Human Fixture",
        email: "fixture@example.com",
      });
      data = { sha: "head" };
    } else if (path.endsWith("/git/refs")) data = {};
    else if (path.endsWith("/pulls") && options.method === "POST") {
      created = true;
      posts++;
      assert(!options.body.includes("private incident"));
      throw new Error("Response lost after PR creation");
    } else if (path.endsWith("/git/commits/head"))
      data = {
        tree: { sha: external ? "externally-changed" : "candidate-tree" },
        parents: [{ sha: base }],
      };
    else throw new Error(`Unexpected fixture path ${path}`);
    return new Response(JSON.stringify(data), { status: 200 });
  };
  const publisher = new GitHubPublisher(
    repo,
    "1",
    "2",
    key,
    { name: "Human Fixture", email: "fixture@example.com" },
    transport,
  );
  const job = {
    id,
    revision: 1,
    base_sha: base,
    objective: "private incident",
    result: candidate(),
    settings: { repository: repo },
  };
  await assert.rejects(publisher.publish(job));
  assert.equal((await publisher.publish(job)).head, "head");
  assert.equal(posts, 1);
  external = true;
  await assert.rejects(publisher.publish(job), /no longer matches/);
});

test("revoking a queued owner leaves no nonexistent sandbox cleanup and releases the global lane", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  f.revoke();
  await f.c.tick();
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(j.state, "paused");
  assert.equal(j.cleanup, "none");
  assert.equal(f.creates(), 0);
  f.restoreOwner();
  await f.start("other");
  await f.c.tick();
  assert.equal(f.creates(), 1);
});
test("revoking a publishing owner pauses the candidate after cleanup and releases the global lane", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  await f.c.finish(j, candidate());
  f.revoke();
  await f.c.tick();
  await f.c.tick();
  await f.c.tick();
  const stopped = await f.row(job.id);
  assert.equal(stopped.state, "paused");
  assert.equal(stopped.cleanup, "complete");
  assert.equal(f.publishes(), 0);
  f.restoreOwner();
  await f.start("other");
  await f.c.tick();
  assert.equal(f.creates(), 2);
});
test("file modes survive snapshot, restore and artifact identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-mode-test-")),
    w = new Workspace(root, new AbortController().signal);
  await w.command("git", ["init"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  await w.write("script.sh", "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "script.sh"), 0o755);
  const c = await w.snapshot("plan", "summary");
  assert.equal(c.files[0]?.mode, "100755");
  const dest = await mkdtemp(join(tmpdir(), "chief-mode-restore-")),
    restored = new Workspace(dest, new AbortController().signal);
  await restored.restore(c);
  assert((await stat(join(dest, "script.sh"))).mode & 0o111);
  const altered = {
    ...c,
    files: c.files.map((f) => ({ ...f, mode: "100644" as const })),
  };
  assert.notEqual(artifactHash(c), artifactHash(altered));
});
test("small histories remain below the worker API message ceiling until the actual allocation is used", async () => {
  let calls = 0;
  const model: any = {
    generate: async (input: any) => {
      assert(input.messages.length <= 120);
      calls++;
      const entries =
        calls <= 33
          ? Array.from({ length: 3 }, (_, i) => ({
              id: `${calls}-${i}`,
              type: "function",
              function: {
                name: "file_read",
                arguments: JSON.stringify({ path: "tiny.ts" }),
              },
            }))
          : [
              {
                id: "finish",
                type: "function",
                function: {
                  name: "report",
                  arguments: JSON.stringify({
                    kind: "candidate",
                    summary: "Synthetic complete",
                  }),
                },
              },
            ];
      return {
        message: { role: "assistant", content: null, tool_calls: entries },
      };
    },
  };
  const report = await codingLoop({
    model,
    workspace: {
      read: async () => ({ text: "tiny", nextOffset: null }),
    } as any,
    messages: [
      { role: "system", content: "fixture" },
      { role: "user", content: "assignment" },
    ],
    mode: "implement",
    budget: { models: 40, tools: 100 },
    signal: new AbortController().signal,
    checkpoint: async () => {},
  });
  assert.equal(calls, 34);
  assert.equal(report.kind, "candidate");
});
test("cancellation while the model claim is acknowledged prevents subsequent paid dispatch", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  const query = f.db.query.bind(f.db);
  let cancelled = false;
  f.db.query = async (sql, values) => {
    const result = await query(sql, values);
    if (sql.includes("INSERT INTO coding_model_calls") && !cancelled) {
      cancelled = true;
      await f.c.call("a", f.run, { operation: "coding_cancel", id: j.id });
    }
    return result;
  };
  await assert.rejects(
    f.c.generate(j, {
      callId: randomUUID(),
      role: "coder",
      messages: [{ role: "user", content: "fixture" }],
      tools: [],
    }),
    /cancelled/,
  );
  assert.equal(f.modelCalls(), 0);
  assert.equal((await f.row(j.id)).state, "cancelled");
});
test("a brief controller outage retries the same safe callback; revoked capabilities fail immediately", async () => {
  let calls = 0;
  const client = new WorkerClient(
    "https://coding.example.com",
    randomUUID(),
    "a".repeat(64),
    new AbortController().signal,
    (async () => {
      calls++;
      return calls === 1
        ? new Response("unavailable", { status: 503 })
        : new Response('{"accepted":true}', { status: 200 });
    }) as any,
  );
  assert.deepEqual(await client.request("heartbeat", {}), { accepted: true });
  assert.equal(calls, 2);
  const denied = new WorkerClient(
    "https://coding.example.com",
    randomUUID(),
    "a".repeat(64),
    new AbortController().signal,
    (async () => new Response("denied", { status: 401 })) as any,
  );
  await assert.rejects(
    denied.request("heartbeat", {}),
    (e) => e instanceof WorkerRequestError && e.status === 401,
  );
});

test("Chief dispatch returns to the conversation and worker delivery preserves the originating thread", async (t) => {
  const f = await fixture(t);
  let modelCalls = 0;
  const assistant = new Assistant(
    f.db,
    new CustomAgent({
      model: "fixture/chief",
      generate: async (input) => {
        modelCalls++;
        if (modelCalls === 1) {
          assert(input.tools.some((t) => t.name === "coding_start"));
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "dispatch",
                  type: "function",
                  function: {
                    name: "coding_start",
                    arguments: JSON.stringify({
                      requestKey: "chief-dispatch",
                      objective: "Plan a synthetic bug fix",
                      mode: "plan",
                    }),
                  },
                },
              ],
            },
          };
        }
        return {
          message: {
            role: "assistant",
            content: "The coding job is queued. I will collect its updates.",
          },
        };
      },
    }),
    new JobTools(
      f.db,
      { call: async () => ({}) },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f.c,
    ),
    { coding: true },
  );
  const response = await assistant.respondDetailed(
    "a",
    "Use the coding sandbox to plan this bug fix",
    undefined,
    undefined,
    { threadId: 17 },
  );
  assert.match(response.reply, /queued/);
  assert.equal(f.creates(), 0);
  const job = (
    await f.db.query(
      "SELECT * FROM coding_jobs WHERE request_key='chief-dispatch'",
    )
  ).rows[0];
  assert.equal(Number(job.thread_id), 17);
  await f.c.tick();
  const j = await f.row(job.id);
  await f.c.progress(j, {
    key: "planning",
    stage: "planning",
    summary: "Inspecting the fixture",
  });
  let thread: number | undefined;
  await f.c.deliver(async (user, threadId) => {
    assert.equal(user, "a");
    thread = threadId;
  });
  assert.equal(thread, 17);
});
