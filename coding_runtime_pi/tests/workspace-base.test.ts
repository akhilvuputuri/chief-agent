import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, localExecutor } from "../src/workspace.js";

test("snapshots against the job's base include changes the agent already committed", async () => {
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
  // The base is always the job's commit: there is no snapshot against HEAD.
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

test("a node_modules link never becomes part of the artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-link-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, "pkg"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  await writeFile(join(repo, "a.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(join(repo, "a.txt"), "changed\n");
  await symlink(root, join(repo, "node_modules"));
  await symlink(root, join(repo, "pkg", "node_modules"));
  const execute = localExecutor(repo, join(root, "home"), () => {});
  const signal = new AbortController().signal;
  const workspace = await new Workspace(repo).initialize();
  const artifact = await workspace.snapshot(execute, signal, base);
  assert.deepEqual(
    artifact.files.map((f) => f.path),
    ["a.txt"],
  );
  assert.doesNotMatch(artifact.patch, /node_modules/);
  git("add", "-f", "node_modules");
  assert.deepEqual(
    (await workspace.snapshot(execute, signal, base)).files.map((f) => f.path),
    ["a.txt"],
  );
  git("add", "-f", "pkg/node_modules");
  git("commit", "-qm", "the coder committed a link");
  const committed = await workspace.snapshot(execute, signal, base);
  assert.deepEqual(
    committed.files.map((f) => f.path),
    ["a.txt"],
  );
  assert.doesNotMatch(committed.patch, /node_modules/);
  await symlink(root, join(repo, "other-link"));
  await assert.rejects(
    workspace.snapshot(execute, signal, base),
    /Symlink|regular files/,
  );
});

test("a real tracked node_modules file stays part of the artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-real-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, "fixture", "node_modules"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(join(repo, "fixture", "node_modules", "f.js"), "one\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(join(repo, "fixture", "node_modules", "f.js"), "two\n");
  git("add", ".");
  const workspace = await new Workspace(repo).initialize();
  const artifact = await workspace.snapshot(
    localExecutor(repo, join(root, "home"), () => {}),
    new AbortController().signal,
    base,
  );
  assert.deepEqual(
    artifact.files.map((f) => f.path),
    ["fixture/node_modules/f.js"],
  );
});

test("a node_modules link the repository tracks is left as it is", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tracked-link-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, "fx"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await symlink("../vendor", join(repo, "fx", "node_modules"));
  await writeFile(join(repo, "a.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(join(repo, "a.txt"), "changed\n");
  await symlink(root, join(repo, "node_modules"));
  const execute = localExecutor(repo, join(root, "home"), () => {});
  const signal = new AbortController().signal;
  const workspace = await new Workspace(repo).initialize();
  const artifact = await workspace.snapshot(execute, signal, base);
  assert.deepEqual(
    artifact.files.map((f) => f.path),
    ["a.txt"],
  );
  // The snapshot leaves the links in place: the artifact simply never contains them.
  assert.equal(lstatSync(join(repo, "node_modules")).isSymbolicLink(), true);
  assert.equal(
    lstatSync(join(repo, "fx", "node_modules")).isSymbolicLink(),
    true,
  );
});
