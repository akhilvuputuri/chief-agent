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

test("the coder's own git configuration never runs in or shapes a snapshot (journal 193)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-config-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(join(repo, "a.txt"), "base\n");
  await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
  await writeFile(join(repo, "ignored.txt"), "tracked although ignored\n");
  git("add", "-f", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  // What a coder could configure: a clean filter that would hang or rewrite every file, an
  // fsmonitor hook, a file hidden from git by an index flag, and ignore and attribute files
  // in its home directory.
  await writeFile(join(repo, "a.txt"), "changed\n");
  git("update-index", "--skip-worktree", "a.txt");
  await writeFile(join(repo, ".gitattributes"), "* filter=hang\n");
  git("config", "filter.hang.clean", "sleep 600");
  git("config", "filter.hang.required", "true");
  git("config", "core.fsmonitor", "sleep 600");
  await mkdir(join(home, ".config", "git"), { recursive: true });
  await writeFile(join(home, ".config", "git", "ignore"), "hidden.txt\n");
  await writeFile(
    join(home, ".config", "git", "attributes"),
    "* filter=hang\n",
  );
  await writeFile(join(repo, "hidden.txt"), "new file\n");
  await writeFile(join(repo, "ignored.txt"), "tracked and changed\n");
  const execute = localExecutor(repo, home, () => {});
  const signal = new AbortController().signal;
  const workspace = await new Workspace(repo).initialize();
  const started = Date.now();
  const snapshot = await workspace.snapshot(execute, signal, base);
  assert(Date.now() - started < 30_000);
  assert.deepEqual(snapshot.files.map((f) => [f.path, f.content]).sort(), [
    [".gitattributes", "* filter=hang\n"],
    ["a.txt", "changed\n"],
    ["hidden.txt", "new file\n"],
    ["ignored.txt", "tracked and changed\n"],
  ]);
  // The coder's own index and staging are untouched.
  assert.equal(
    git("-c", "core.fsmonitor=false", "diff", "--cached", "--name-only"),
    "",
  );
});

test("a snapshot that reuses its own index equals a fresh one, and tampering with that index or its configuration changes nothing (journal 193)", async () => {
  const { chmod, rename, rm: remove } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "pi-reuse-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  for (const name of ["a.txt", "b.txt", "c.txt", "run.sh"])
    await writeFile(join(repo, name), `${name}\n`);
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const execute = localExecutor(repo, join(root, "home"), () => {});
  const signal = new AbortController().signal;
  const reused = await new Workspace(repo).initialize();
  const same = async () => {
    const fresh = await new Workspace(repo).snapshot(execute, signal, base);
    const kept = await reused.snapshot(execute, signal, base);
    assert.deepEqual(kept, fresh);
    return kept;
  };
  await same();
  await writeFile(join(repo, "new.txt"), "added\n");
  await same();
  await writeFile(join(repo, "a.txt"), "modified\n");
  await same();
  await remove(join(repo, "b.txt"));
  await same();
  await rename(join(repo, "c.txt"), join(repo, "moved.txt"));
  await same();
  await chmod(join(repo, "run.sh"), 0o755);
  // A file the coder made, then told git to ignore, leaves the candidate as in a fresh index.
  await writeFile(join(repo, "build.out"), "generated\n");
  await same();
  await writeFile(join(repo, ".gitignore"), "*.out\n");
  await same();
  await remove(join(repo, ".gitignore"));
  await remove(join(repo, "build.out"));
  const last = await same();
  assert.deepEqual(
    last.files.map((f) => [f.path, f.content, f.mode ?? null]).sort(),
    [
      ["a.txt", "modified\n", "100644"],
      ["b.txt", null, null],
      ["c.txt", null, null],
      ["moved.txt", "c.txt\n", "100644"],
      ["new.txt", "added\n", "100644"],
      ["run.sh", "run.sh\n", "100755"],
    ],
  );
  // A coder that finds the snapshot's directory: a filter in its configuration, an attribute
  // file naming it, and a skip-worktree flag on its index.
  const own = (reused as any).own as string;
  execFileSync(
    "git",
    [
      `--git-dir=${own}`,
      "--work-tree=.",
      "update-index",
      "--skip-worktree",
      "a.txt",
    ],
    { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
  );
  await writeFile(
    join(own, "config"),
    '[core]\n\tbare = true\n[filter "hang"]\n\tclean = sleep 600\n\trequired = true\n',
  );
  await mkdir(join(own, "info"), { recursive: true });
  await writeFile(join(own, "info", "attributes"), "* filter=hang\n");
  await writeFile(join(repo, "a.txt"), "changed again\n");
  const started = Date.now();
  const after = await same();
  assert(Date.now() - started < 30_000);
  assert.equal(
    after.files.find((f) => f.path === "a.txt")?.content,
    "changed again\n",
  );
});
