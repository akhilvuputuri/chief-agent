import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentGitHubTokens,
  AGENT_TOKEN_PERMISSIONS,
} from "../src/coding/agent-github.js";
import { publishSandboxBranch } from "../src/coding/agent-git-publish.js";
import { localExecutor } from "@chief-agent/pi-runtime";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function github(options: {
  rules?: any[];
  bypass?: string;
  autoMerge?: boolean;
  granted?: Record<string, string> | null;
}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const transport = (async (url: string, init: any = {}) => {
    const method = init.method ?? "GET";
    calls.push({
      method,
      url,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (url.endsWith("/access_tokens"))
      return json(
        {
          token: "ghs_fixture",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          permissions:
            options.granted === null
              ? undefined
              : (options.granted ?? {
                  ...AGENT_TOKEN_PERMISSIONS,
                  metadata: "read",
                }),
        },
        201,
      );
    if (url.endsWith("/rules/branches/main"))
      return json(
        options.rules ?? [
          { type: "update", ruleset_id: 2 },
          { type: "pull_request", ruleset_id: 1 },
          {
            type: "required_status_checks",
            ruleset_id: 1,
            parameters: { required_status_checks: [{ context: "test" }] },
          },
        ],
      );
    if (/\/rulesets\/\d+$/.test(url))
      return json({ current_user_can_bypass: options.bypass ?? "never" });
    if (url.endsWith("/repos/akhilvuputuri/chief-agent"))
      return json({ allow_auto_merge: options.autoMerge ?? false });
    if (url.endsWith("/installation/token") && method === "DELETE")
      return new Response(null, { status: 204 });
    return json({ message: "unexpected" }, 404);
  }) as typeof fetch;
  return {
    calls,
    tokens: new AgentGitHubTokens(
      "akhilvuputuri/chief-agent",
      "123",
      "456",
      key,
      transport,
    ),
  };
}

test("agent tokens request exactly the pinned single-repository permissions and pass rule checks", async () => {
  const g = github({});
  const issued = await g.tokens.issue();
  assert.equal(issued.token, "ghs_fixture");
  const request = g.calls.find((c) => c.url.endsWith("/access_tokens"))!;
  assert.deepEqual(request.body, {
    repositories: ["chief-agent"],
    permissions: {
      contents: "write",
      pull_requests: "write",
      checks: "read",
      statuses: "read",
    },
  });
  assert.equal(g.calls.filter((c) => /\/rulesets\/\d+$/.test(c.url)).length, 2);
  assert.equal(
    g.calls.some((c) => c.method === "DELETE"),
    false,
  );
});

test("agent tokens fail closed and are revoked when main is not safe or permissions widen", async () => {
  for (const [options, message] of [
    [
      {
        rules: [
          { type: "pull_request", ruleset_id: 1 },
          {
            type: "required_status_checks",
            ruleset_id: 1,
            parameters: { required_status_checks: [{ context: "test" }] },
          },
        ],
      },
      /restrict updates/,
    ],
    [{ bypass: "always" }, /must not be able to bypass/],
    [{ autoMerge: true }, /auto-merge/],
    [
      {
        granted: {
          ...AGENT_TOKEN_PERMISSIONS,
          metadata: "read",
          workflows: "write",
        },
      },
      /pinned set/,
    ],
    [{ granted: null }, /pinned set/],
  ] as const) {
    const g = github(options as any);
    await assert.rejects(g.tokens.issue(), message as RegExp);
    assert(
      g.calls.some(
        (c) => c.method === "DELETE" && c.url.endsWith("/installation/token"),
      ),
      `token revoked for ${String(message)}`,
    );
  }
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "agent-publish-"));
  const work = join(root, "work");
  const remote = join(root, "remote.git");
  await mkdir(work);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(work, "init", "-q");
  git(work, "config", "user.name", "Owner");
  git(work, "config", "user.email", "owner@example.invalid");
  git(work, "config", "uploadpack.allowAnySHA1InWant", "true");
  await writeFile(join(work, "a.txt"), "base\n");
  await writeFile(join(work, "gone.txt"), "to delete\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "base");
  const base = git(work, "rev-parse", "HEAD");
  // Like GitHub, the remote already holds the base the job started from.
  git(work, "push", "-q", remote, `${base}:refs/heads/main`);
  // The agent's own working history, including content that was never approved.
  await writeFile(join(work, "secret.txt"), "never approved\n");
  git(work, "add", ".");
  git(
    work,
    "commit",
    "-qm",
    "Agent working commit",
    "--author",
    "Someone <x@example.invalid>",
  );
  return { root, work, remote, base, git };
}
const branch = `chief/coding-${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}`;

test("sandbox publication pushes exactly the approved files as one owner commit on the base, token last", async () => {
  const r = await repository();
  const order: string[] = [];
  const api = (async (url: string, init: any = {}) => {
    order.push(`${init.method ?? "GET"} ${url.replace(/\?.*/, "")}`);
    if ((init.method ?? "GET") === "GET") return json([]);
    return json(
      { html_url: "https://github.com/akhilvuputuri/chief-agent/pull/9" },
      201,
    );
  }) as typeof fetch;
  const published = await publishSandboxBranch({
    execute: localExecutor(r.root, join(r.root, "home"), () => {}),
    signal: new AbortController().signal,
    scratch: r.root,
    repository: "akhilvuputuri/chief-agent",
    branch,
    base: r.base,
    author: { name: "Owner", email: "owner@example.invalid" },
    title: "Chief coding job: fixture",
    body: "Reviewed",
    files: [
      { path: "a.txt", content: "approved change\n" },
      { path: "docs/new.md", content: "new file\n" },
      { path: "gone.txt", content: null },
    ],
    token: async () => {
      order.push("token");
      return "ghs_fixture";
    },
    remote: r.remote,
    baseSource: r.work,
    api,
  });
  assert.equal(order[0], "token");
  assert.equal(
    published.url,
    "https://github.com/akhilvuputuri/chief-agent/pull/9",
  );
  const remoteGit = (...args: string[]) =>
    execFileSync("git", ["--git-dir", r.remote, ...args], {
      encoding: "utf8",
    }).trim();
  assert.equal(remoteGit("rev-parse", `refs/heads/${branch}`), published.head);
  assert.equal(remoteGit("rev-parse", `${published.head}^`), r.base);
  assert.equal(
    remoteGit("log", "-1", "--format=%an <%ae>|%cn <%ce>", published.head),
    "Owner <owner@example.invalid>|Owner <owner@example.invalid>",
  );
  assert.deepEqual(
    remoteGit("ls-tree", "-r", "--name-only", published.head).split("\n"),
    ["a.txt", "docs/new.md"],
  );
  assert.equal(remoteGit("show", `${published.head}:a.txt`), "approved change");
  assert.equal(remoteGit("rev-list", "--count", published.head), "2");
  assert.throws(() =>
    execFileSync(
      "git",
      [
        "--git-dir",
        r.remote,
        "cat-file",
        "-e",
        r.git(r.work, "rev-parse", "HEAD"),
      ],
      {
        stdio: "pipe",
      },
    ),
  );
  assert(
    order.includes(
      "POST https://api.github.com/repos/akhilvuputuri/chief-agent/pulls",
    ),
  );
});

test("publication refuses unsafe branches or paths before requesting any token", async () => {
  const r = await repository();
  let tokens = 0;
  const base = {
    execute: localExecutor(r.root, join(r.root, "home"), () => {}),
    signal: new AbortController().signal,
    scratch: r.root,
    repository: "akhilvuputuri/chief-agent",
    base: r.base,
    author: { name: "Owner", email: "owner@example.invalid" },
    title: "fixture",
    body: "fixture",
    token: async () => {
      tokens++;
      return "ghs_fixture";
    },
    remote: r.remote,
    baseSource: r.work,
    api: (async () => json([])) as typeof fetch,
  };
  await assert.rejects(
    publishSandboxBranch({
      ...base,
      branch: "main",
      files: [{ path: "a.txt", content: "x" }],
    }),
    /job's chief\/coding branch/,
  );
  for (const path of ["../escape.txt", ".git/config", "/abs.txt", "a//b.txt"])
    await assert.rejects(
      publishSandboxBranch({
        ...base,
        branch,
        files: [{ path, content: "x" }],
      }),
      /path is invalid/,
    );
  assert.equal(tokens, 0);
  assert.equal(
    execFileSync(
      "git",
      ["--git-dir", r.remote, "for-each-ref", "--format=%(refname)"],
      { encoding: "utf8" },
    ).trim(),
    "refs/heads/main",
  );
});
