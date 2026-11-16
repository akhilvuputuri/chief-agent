import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodingRuntime,
  TaskStore,
  Workspace,
  localExecutor,
  type ModelFactory,
} from "../src/index.js";

const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * A repository that model-run code could have configured (journal 197): a partial clone whose
 * `AGENTS.md` blob is missing, with `core.sshCommand` and other configured programs that write
 * `marker` when git runs them. Reading the base's `AGENTS.md` with the repository's own
 * configuration makes git lazy-fetch the blob through the configured ssh command.
 */
async function hostile() {
  const root = await mkdtemp(join(tmpdir(), "pi-repo-config-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const marker = join(root, "marker");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      env,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(join(repo, "AGENTS.md"), "Base rules.\n");
  git("add", "AGENTS.md");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const blob = git("rev-parse", "HEAD:AGENTS.md");
  const run = `touch '${marker}'; false`;
  git("config", "core.repositoryformatversion", "1");
  git("config", "extensions.partialClone", "origin");
  git("config", "remote.origin.url", "ssh://synthetic.invalid/repo.git");
  git("config", "remote.origin.promisor", "true");
  git("config", "core.sshCommand", run);
  git("config", "core.pager", run);
  git("config", "diff.external", run);
  git("config", "core.fsmonitor", run);
  git("config", "credential.helper", `!${run}`);
  await rm(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  return { root, repo, base, marker };
}

test("the fixture runs its configured program when git reads with the repository's configuration", async () => {
  const f = await hostile();
  // How the runtime read the reviewer's base AGENTS.md before journal 197.
  assert.throws(() =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "show", `${f.base}:AGENTS.md`],
      { cwd: f.repo, env, stdio: "ignore" },
    ),
  );
  assert.equal(await exists(f.marker), true);
});

test("reading the base file runs nothing the repository's configuration names", async () => {
  const f = await hostile();
  const execute = localExecutor(f.repo, join(f.root, "home"), () => {});
  const workspace = await new Workspace(f.repo).initialize();
  const signal = new AbortController().signal;
  // The blob is missing and no promisor applies in the private git directory: no file.
  assert.equal(
    await workspace.committedFile(execute, signal, f.base, "AGENTS.md"),
    undefined,
  );
  assert.equal(await workspace.hasCommit(execute, signal, f.base), true);
  assert.equal(await exists(f.marker), false);
});

test("a reviewer run and a start run no configured program of the repository", async () => {
  const f = await hostile();
  const commands: string[] = [];
  const runtime = new CodingRuntime({
    store: new TaskStore(
      join(f.root, "state"),
      "synthetic-private-state-key-32-characters",
    ),
    // No usable model: the run reads AGENTS.md, then fails to create the session.
    model: async () => ({}) as Awaited<ReturnType<ModelFactory>>,
    executor: () => {
      const execute = localExecutor(f.repo, join(f.root, "home"), () => {});
      return (command, ...rest) => {
        commands.push(command);
        return execute(command, ...rest);
      };
    },
  });
  const task = await runtime.start({
    workspace: f.repo,
    role: "reviewer",
    base: f.base,
  });
  await runtime.run(task.id, "Review");
  assert.equal(await exists(f.marker), false);
  // Both git reads went through the task's executor, in the private git directory.
  assert(commands.some((c) => c.includes("cat-file' '-e'")));
  assert(commands.some((c) => c.includes("'cat-file' 'blob'")));
  assert(commands.every((c) => c.includes("--git-dir=")));
});

test("a committed file is read as its exact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-repo-bytes-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      env,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  const bytes = Buffer.from([0x52, 0x75, 0x6c, 0x65, 0xff, 0x0a]);
  await writeFile(join(root, "AGENTS.md"), bytes);
  git("add", "AGENTS.md");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const workspace = await new Workspace(root).initialize();
  const execute = localExecutor(root, join(root, "..", "home-bytes"), () => {});
  const signal = new AbortController().signal;
  assert.deepEqual(
    await workspace.committedFile(execute, signal, base, "AGENTS.md"),
    bytes,
  );
  assert.equal(
    await workspace.committedFile(execute, signal, base, "missing.md"),
    undefined,
  );
});
