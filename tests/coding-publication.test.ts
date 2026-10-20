import { reportDocument } from "@chief-agent/pi-runtime/report";
import { execFileSync } from "node:child_process";
import {
  runPiWorker,
  NativePiWorkerClient,
  piReviewInstructions,
} from "../src/coding/pi-worker.js";
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
import {
  codingSettings,
  outcome,
  assertCodingBrief,
} from "../src/coding/schema.js";
import { codingApi } from "../src/coding/api.js";
import {
  GitHubPublisher,
  AgentPublicationMismatch,
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
  requirementBrief,
} from "./helpers/coding-fixture.js";
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

test("agent-published PRs are accepted only for the job branch, exact reviewed tree and pinned base", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const repo = "example/repo",
    id = randomUUID(),
    pushed = "a".repeat(39) + "f";
  let pr: any, headTree: string, compare: any, branchTip: string;
  const reset = () => {
    pr = {
      state: "open",
      head: {
        ref: `chief/coding-${id}`,
        sha: pushed,
        repo: { full_name: repo },
      },
      base: { ref: "main", repo: { full_name: repo } },
    };
    headTree = "candidate-tree";
    compare = { ahead_by: 2, behind_by: 0 };
    branchTip = pushed;
  };
  reset();
  const transport: any = async (url: string, options: any = {}) => {
    const path = new URL(url).pathname;
    let data: any;
    if (path.endsWith("/access_tokens"))
      data = {
        token: "fixture",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
    else if (path.endsWith("/pulls/9")) data = pr;
    else if (path.endsWith(`/git/commits/${base}`))
      data = { tree: { sha: "base-tree" } };
    else if (path.endsWith("/git/trees/base-tree"))
      data = { tree: [], truncated: false };
    else if (path.endsWith("/git/trees") && options.method === "POST")
      data = { sha: "candidate-tree" };
    else if (path.endsWith(`/git/commits/${pushed}`))
      data = { tree: { sha: headTree } };
    else if (path.endsWith(`/compare/${base}...${pushed}`)) data = compare;
    else if (path.endsWith(`/git/ref/heads/chief/coding-${id}`))
      data = { object: { sha: branchTip } };
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
    objective: "Synthetic",
    result: candidate(),
    settings: { repository: repo },
  };
  const published = { url: `https://github.com/${repo}/pull/9`, head: pushed };
  assert.deepEqual(await publisher.verifyAgentPublication(job, published), {
    url: published.url,
    head: pushed,
    tree: "candidate-tree",
  });
  for (const [change, message] of [
    [() => (pr.head.ref = "chief/coding-other"), /identity/],
    [() => (pr.base.ref = "release"), /identity/],
    [() => (headTree = "something-else"), /differs from the reviewed/],
    [() => (compare = { ahead_by: 2, behind_by: 1 }), /descend/],
  ] as const) {
    reset();
    change();
    await assert.rejects(
      publisher.verifyAgentPublication(job, published),
      message as RegExp,
    );
  }
  // GitHub has not caught up with the push yet: retry, never a mismatch.
  reset();
  pr.head.sha = "0".repeat(40);
  await assert.rejects(
    publisher.verifyAgentPublication(job, published),
    (error: Error) => {
      assert(!(error instanceof AgentPublicationMismatch));
      assert.match(error.message, /still updating/);
      return true;
    },
  );
  branchTip = "1".repeat(40);
  await assert.rejects(
    publisher.verifyAgentPublication(job, published),
    AgentPublicationMismatch,
  );
  reset();
  await assert.rejects(
    publisher.verifyAgentPublication(job, {
      url: "https://github.com/other/repo/pull/9",
      head: pushed,
    }),
    /outside the configured repository/,
  );
});

test("a rebased continuation rebuilds on the new base and force-updates only the job branch", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const repo = "example/repo",
    id = randomUUID(),
    oldHead = "1".repeat(40),
    newBase = "2".repeat(40),
    newHead = "3".repeat(40),
    branch = `chief/coding-${id}-r1`;
  for (const behind of [3, 0]) {
    let head = oldHead;
    const writes: any[] = [];
    const transport: any = async (url: string, options: any = {}) => {
      const path = new URL(url).pathname;
      const method = options.method ?? "GET";
      let data: any;
      if (path.endsWith("/access_tokens"))
        data = {
          token: "fixture",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        };
      else if (path.endsWith("/pulls/7"))
        data = {
          state: "open",
          head: { ref: branch, sha: head, repo: { full_name: repo } },
          base: { ref: "main", sha: "0".repeat(40), repo: { full_name: repo } },
        };
      else if (path.endsWith(`/compare/${newBase}...${oldHead}`))
        data = { behind_by: behind, ahead_by: 1 };
      else if (path.endsWith(`/git/commits/${newBase}`))
        data = { tree: { sha: "base-tree" } };
      else if (path.endsWith(`/git/commits/${oldHead}`))
        data = { tree: { sha: "old-tree" } };
      else if (path.endsWith("/git/trees/base-tree"))
        data = { tree: [], truncated: false };
      else if (path.endsWith("/git/trees") && method === "POST")
        data = { sha: "candidate-tree" };
      else if (path.endsWith("/git/commits") && method === "POST") {
        writes.push({ commit: JSON.parse(options.body) });
        data = { sha: newHead };
      } else if (
        path.endsWith(`/git/refs/heads/${branch}`) &&
        method === "PATCH"
      ) {
        writes.push({ ref: JSON.parse(options.body) });
        head = newHead;
        data = {};
      } else throw new Error(`Unexpected fixture path ${method} ${path}`);
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
    const published = await publisher.publish({
      id,
      revision: 3,
      base_sha: newBase,
      objective: "Synthetic",
      result: candidate(),
      settings: { repository: repo },
      pr_url: `https://github.com/${repo}/pull/7`,
      head_sha: oldHead,
    });
    assert.equal(published.head, newHead);
    assert.deepEqual(writes[0].commit.parents, [behind ? newBase : oldHead]);
    assert.deepEqual(writes[1].ref, { sha: newHead, force: behind > 0 });
  }
});
