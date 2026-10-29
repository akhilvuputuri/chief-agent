import { test } from "node:test";
import assert from "node:assert/strict";
import { codingSettings } from "../src/coding/schema.js";
import { settings } from "./helpers/coding-fixture.js";

// Boxes have no CodeBuild-era 45-minute cap, so attempts may run longer and do more.
test("coding limits allow up to four hours, 2,000 model calls and 5,000 tool calls", () => {
  const limits = (l: object) =>
    codingSettings.safeParse({
      ...settings,
      limits: { ...settings.limits, ...l },
    }).success;
  assert.equal(limits({ ms: 5_400_000, models: 800, tools: 2000 }), true);
  assert.equal(limits({ ms: 14_400_000, models: 2000, tools: 5000 }), true);
  assert.equal(limits({ ms: 14_400_001 }), false);
  assert.equal(limits({ models: 2001 }), false);
  assert.equal(limits({ tools: 5001 }), false);
});

test("checkpoints and publishing accept large changes: 1 MB files, 500 files, 10 MB in all", async () => {
  const { checkpoint } = await import("../src/coding/schema.js");
  const file = (n: number, size: number) => ({
    path: `docs/large-${n}.md`,
    content: "a".repeat(size),
  });
  assert.ok(
    checkpoint.safeParse({ files: [file(1, 1_000_000), file(2, 900_000)] })
      .success,
  );
  assert.equal(
    checkpoint.safeParse({ files: [file(1, 1_000_001)] }).success,
    false,
  );
  assert.ok(
    checkpoint.safeParse({
      files: Array.from({ length: 500 }, (_, n) => file(n, 10)),
    }).success,
  );
  assert.equal(
    checkpoint.safeParse({
      files: Array.from({ length: 501 }, (_, n) => file(n, 10)),
    }).success,
    false,
  );
  const { validateFiles } = await import("../src/coding/github.js");
  validateFiles(Array.from({ length: 4 }, (_, n) => file(n, 900_000)));
  assert.throws(
    () => validateFiles(Array.from({ length: 11 }, (_, n) => file(n, 999_000))),
    /exceeds supported size/,
  );
});

test("a Pi session entry may be as large as one model request", async (t) => {
  const { fixture, settings } = await import("./helpers/coding-fixture.js");
  const f = await fixture(t);
  const started = await f.start("big-session", "plan");
  await f.c.tick();
  let job = await f.row(started.id);
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    job.id,
    JSON.stringify({
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
    }),
  ]);
  job = await f.row(job.id);
  const scope = "e".repeat(64);
  // A message carrying a ~1 MB file write: over the old 512 KB entry bound.
  const big = {
    type: "message",
    id: "m1",
    message: { role: "assistant", content: "x".repeat(1_000_000) },
  };
  await f.c.piSessionAppend(job, {
    scope,
    after: 0,
    entries: [{ type: "session", id: "s" }, big],
  });
  await assert.rejects(
    f.c.piSessionAppend(job, {
      scope,
      after: 2,
      entries: [
        {
          ...big,
          id: "m2",
          message: { role: "assistant", content: "x".repeat(4_200_000) },
        },
      ],
    }),
    /exceeds supported size/,
  );
});

test("large files are published as their own blobs; small ones stay inline", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { GitHubPublisher } = await import("../src/coding/github.js");
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const calls: { path: string; body?: any }[] = [];
  const transport: any = async (url: string, options: any) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, body });
    let data: any;
    if (path.endsWith("/access_tokens"))
      data = {
        token: "t",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
    else if (path.endsWith("/git/commits/" + "a".repeat(40)))
      data = { tree: { sha: "base-tree" } };
    else if (path.endsWith("/git/trees/base-tree"))
      data = { tree: [], truncated: false };
    else if (path.endsWith("/git/blobs")) data = { sha: "b".repeat(40) };
    else if (path.endsWith("/git/trees")) data = { sha: "candidate-tree" };
    else throw new Error(`Unexpected ${path}`);
    return new Response(JSON.stringify(data), { status: 200 });
  };
  const publisher = new GitHubPublisher(
    "example/repo",
    "1",
    "2",
    key,
    { name: "F", email: "f@example.com" },
    transport,
  );
  const tree = await (publisher as any).candidateTree({
    base_sha: "a".repeat(40),
    result: {
      checkpoint: {
        files: [
          { path: "docs/big.md", content: "b".repeat(300_000) },
          { path: "docs/small.md", content: "small\n" },
        ],
      },
    },
  });
  assert.equal(tree, "candidate-tree");
  const blobs = calls.filter((c) => c.path.endsWith("/git/blobs"));
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0]!.body.content.length, 300_000);
  const posted = calls.find(
    (c) => c.path.endsWith("/git/trees") && c.body,
  )!.body;
  assert.deepEqual(
    posted.tree.map((e: any) => [e.path, e.sha ?? null, e.content ?? null]),
    [
      ["docs/big.md", "b".repeat(40), null],
      ["docs/small.md", null, "small\n"],
    ],
  );
});

test("inline content stays under 1 MB per tree request; the rest become blobs", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { GitHubPublisher } = await import("../src/coding/github.js");
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  let tree: any;
  let blobs = 0;
  const transport: any = async (url: string, options: any) => {
    const path = new URL(url).pathname;
    let data: any;
    if (path.endsWith("/access_tokens"))
      data = {
        token: "t",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
    else if (path.endsWith("/git/commits/" + "a".repeat(40)))
      data = { tree: { sha: "base-tree" } };
    else if (path.endsWith("/git/trees/base-tree"))
      data = { tree: [], truncated: false };
    else if (path.endsWith("/git/blobs")) {
      blobs++;
      data = { sha: "c".repeat(40) };
    } else if (path.endsWith("/git/trees")) {
      tree = JSON.parse(options.body).tree;
      data = { sha: "candidate-tree" };
    } else throw new Error(`Unexpected ${path}`);
    return new Response(JSON.stringify(data), { status: 200 });
  };
  const publisher = new GitHubPublisher(
    "example/repo",
    "1",
    "2",
    key,
    { name: "F", email: "f@example.com" },
    transport,
  );
  await (publisher as any).candidateTree({
    base_sha: "a".repeat(40),
    result: {
      checkpoint: {
        files: Array.from({ length: 6 }, (_, n) => ({
          path: `docs/part-${n}.md`,
          content: "p".repeat(250_000),
        })),
      },
    },
  });
  const inline = tree
    .filter((e: any) => e.content)
    .reduce((n: number, e: any) => n + e.content.length, 0);
  assert.ok(inline <= 1_000_000);
  assert.equal(blobs, 2);
});
