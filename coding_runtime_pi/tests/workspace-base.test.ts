import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, localExecutor } from "../src/workspace.js";

test("snapshots against the pinned base include changes the agent already committed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-base-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(join(repo, "a.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(join(repo, "a.txt"), "committed change\n");
  git("commit", "-qam", "agent commit");
  await writeFile(join(repo, "b.txt"), "uncommitted\n");
  const execute = localExecutor(repo, join(root, "home"), () => {});
  const signal = new AbortController().signal;
  const workspace = await new Workspace(repo).initialize();
  const pinned = await workspace.snapshot(execute, signal, base);
  assert.equal(pinned.base, base);
  assert.deepEqual(pinned.files.map((f) => [f.path, f.content]).sort(), [
    ["a.txt", "committed change\n"],
    ["b.txt", "uncommitted\n"],
  ]);
  // Without the pin, the committed edit disappears into HEAD.
  const head = await workspace.snapshot(execute, signal);
  assert.deepEqual(
    head.files.map((f) => f.path),
    ["b.txt"],
  );
  await assert.rejects(
    workspace.snapshot(execute, signal, "HEAD"),
    /full commit SHA/,
  );
});

test("a large change exports whole: many large files fit, and only a file over 1 MB is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-large-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(join(repo, "seed.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  // Four 250 KB documents: each over the old 128 KB file cap, 1 MB over the old 500 KB total.
  for (const n of [1, 2, 3, 4])
    await writeFile(
      join(repo, `doc-${n}.md`),
      `${"line of text\n".repeat(19_700)}`,
    );
  const execute = localExecutor(repo, join(root, "home"), () => {});
  const signal = new AbortController().signal;
  const workspace = await new Workspace(repo).initialize();
  const snapshot = await workspace.snapshot(execute, signal, base);
  assert.equal(snapshot.files.length, 4);
  assert.ok(snapshot.files.every((f) => (f.content?.length ?? 0) > 250_000));
  await writeFile(join(repo, "huge.md"), "x".repeat(1_000_001));
  await assert.rejects(
    workspace.snapshot(execute, signal, base),
    /Unsupported artifact file/,
  );
});
