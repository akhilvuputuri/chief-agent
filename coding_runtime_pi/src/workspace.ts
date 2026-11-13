import { processCleanup } from "./process-boundary.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  realpath,
  lstat,
  readdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Artifact, FileChange } from "./types.js";

export type Execution = {
  exitCode: number;
  output: string;
  truncated?: boolean;
  timedOut?: boolean;
};
/**
 * Runs one command. Without `timeoutMs` the command runs until it exits or `signal` aborts.
 * With `onData`, output streams to the caller and is not kept in `output`.
 */
export type Executor = (
  command: string,
  signal: AbortSignal,
  timeoutMs?: number,
  maxOutput?: number,
  onData?: (chunk: string) => void,
) => Promise<Execution>;
export function artifactHash(patch: string, files: FileChange[]) {
  const ordered = {
    files: [...files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    patch,
  };
  // Defined wire identity, independent of the client publisher's identity scheme.
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
export function localExecutor(
  root: string,
  home: string,
  cleanup: (() => void) | undefined = processCleanup(),
): Executor {
  return async (command, signal, timeoutMs, maxOutput = 32000, onData) => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    if (signal.aborted) throw new Error("Cancelled");
    return new Promise((accept, reject) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: root,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: home,
          KITE_STORE: `${home}/kite-store`,
          XDG_CACHE_HOME: `${home}/cache`,
          TMPDIR: home,
          LANG: "C.UTF-8",
          CI: "true",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      });
      let output = "",
        timedOut = false,
        settled = false,
        truncated = false;
      const kill = () => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              kill();
            }, timeoutMs);
      signal.addEventListener("abort", kill, { once: true });
      if (signal.aborted) kill();
      const append = (data: string) => {
        if (onData) return onData(data);
        output += data;
        if (output.length > maxOutput) {
          truncated = true;
          output = output.slice(-maxOutput);
        }
      };
      child.stdout.setEncoding("utf8").on("data", append);
      child.stderr.setEncoding("utf8").on("data", append);
      const finish = (error?: Error, code?: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", kill);
        kill();
        try {
          cleanup?.();
        } catch {
          child.stdout.destroy();
          child.stderr.destroy();
          reject(
            new Error(
              "Command descendant cleanup failed; inspect before continuing",
            ),
          );
          return;
        }
        child.stdout.destroy();
        child.stderr.destroy();
        if (error) reject(new Error("Command could not start"));
        else
          accept({
            exitCode: signal.aborted || timedOut ? -1 : (code ?? -1),
            output,
            truncated,
            timedOut,
          });
      };
      child.on("error", (e) => finish(e));
      // exit, rather than close, prevents daemon-held output pipes from hanging.
      child.on("exit", (code) => finish(undefined, code));
    });
  };
}
export class Workspace {
  private root = "";
  /** The snapshot's own git directory, kept for this workspace's life (journal 193). */
  private own?: string;
  /** The base the kept index was started from; another base starts it again. */
  private indexBase?: string;
  /** Where that directory is made: the temporary directory when the workspace was opened. */
  private readonly scratch = tmpdir();
  constructor(readonly requestedRoot: string) {}
  async initialize() {
    this.root = await realpath(this.requestedRoot);
    return this;
  }
  async path(input: string, write = false): Promise<string> {
    if (!this.root) await this.initialize();
    const full = resolve(this.root, input);
    const parts = relative(this.root, full).split(sep);
    if (
      parts.some(
        (p) =>
          p === ".." ||
          p === ".git" ||
          p === ".env" ||
          (p.startsWith(".env.") && p !== ".env.example"),
      )
    )
      throw new Error("Path is outside the workspace or protected");
    if (
      relative(this.root, full).startsWith(`..${sep}`) ||
      full === dirname(this.root)
    )
      throw new Error("Path is outside the workspace");
    let current = this.root;
    for (const part of parts.filter(Boolean)) {
      current = resolve(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("Symlink paths are unsupported");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !write) throw e;
      }
    }
    return full;
  }
  /** Regular files outside protected and dependency directories, walked lazily so a caller can stop early. */
  async *files(): AsyncGenerator<string> {
    async function* walk(dir: string, prefix: string): AsyncGenerator<string> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (
          [".git", "node_modules", ".env"].includes(entry.name) ||
          (entry.name.startsWith(".env.") && entry.name !== ".env.example")
        )
          continue;
        if (entry.isSymbolicLink()) continue;
        const path = prefix + entry.name;
        if (entry.isDirectory())
          yield* walk(resolve(dir, entry.name), path + "/");
        else if (entry.isFile()) yield path;
      }
    }
    yield* walk(await this.path("."), "");
  }
  async read(path: string) {
    return readFile(await this.path(path));
  }
  async write(path: string, data: string) {
    const full = await this.path(path, true);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }
  async restore(files: FileChange[]) {
    for (const file of files) {
      if (file.content === null) {
        const { unlink } = await import("node:fs/promises");
        await unlink(await this.path(file.path)).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
      } else {
        await this.write(file.path, file.content);
        if (file.mode)
          await chmod(
            await this.path(file.path),
            file.mode === "100755" ? 0o755 : 0o644,
          );
      }
    }
  }
  /**
   * The working tree against the job's base commit, never against HEAD, so commits, branches
   * and staging the model does never hide or change the candidate.
   *
   * It runs in a git directory of its own that shares the repository's objects: none of the
   * coder's repository configuration (filters, hooks, external diff, fsmonitor, its index
   * flags, `.git/info/exclude`, `core.autocrlf`) or home-directory ignore and attribute files
   * applies, so nothing the coder configured can run or hang here (journal 193). The
   * directory lives outside the coder's repository and keeps its index between snapshots, so
   * unchanged files are not read again (the first snapshot on a base reads every file); its
   * configuration is written afresh and any index flag cleared before every snapshot.
   */
  async snapshot(
    execute: Executor,
    signal: AbortSignal,
    base: string,
  ): Promise<Artifact> {
    if (!/^[a-f0-9]{40}$/.test(base))
      throw new Error("Artifact base must be a full commit SHA");
    if (!this.root) await this.initialize();
    if (!this.own || !(await lstat(this.own).catch(() => undefined))) {
      this.own = await mkdtemp(join(this.scratch, "chief-snapshot-"));
      this.indexBase = undefined;
    }
    const own = this.own;
    for (const name of ["hooks", "info", "config.worktree", "commondir"])
      await rm(join(own, name), { recursive: true, force: true });
    await mkdir(join(own, "objects", "info"), { recursive: true });
    await mkdir(join(own, "refs"), { recursive: true });
    await writeFile(join(own, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(
      join(own, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tbare = true\n",
    );
    await writeFile(
      join(own, "objects", "info", "alternates"),
      `${join(this.root, ".git", "objects")}\n`,
    );
    const fresh = this.indexBase !== base;
    this.indexBase = undefined;
    const artifact = await this.snapshotIn(own, execute, signal, base, fresh);
    this.indexBase = base;
    return artifact;
  }
  private async snapshotIn(
    own: string,
    execute: Executor,
    signal: AbortSignal,
    base: string,
    fresh: boolean,
  ): Promise<Artifact> {
    const quote = (value: string) =>
      "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const run = async (args: string[], max = 20_000_000) => {
      // No time limit: a large repository is slow, not stuck; cancellation still stops it.
      // The output bound guards memory.
      const result = await execute(
        [
          "git",
          `--git-dir=${own}`,
          "--work-tree=.",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.excludesFile=/dev/null",
          "-c",
          "core.attributesFile=/dev/null",
          ...args,
        ]
          .map(quote)
          .join(" "),
        signal,
        undefined,
        max,
      );
      if (result.exitCode !== 0 || result.truncated)
        throw new Error("Git artifact operation failed or exceeded its bound");
      return result.output;
    };
    // The base's tree first, so a tracked file an ignore rule matches stays tracked. The
    // index is kept between snapshots on the same base, so `add` reads only changed files.
    // The worker builds a fresh index from the base itself, never from the coder's index: the
    // coder's file times decide what `add` re-reads, and they cannot be trusted (journal 193).
    if (fresh) await run(["read-tree", base]);
    // No flag may hide a file from `add`.
    const flagged = (await run(["ls-files", "-v", "-z"]))
      .split("\0")
      .filter((row) => /^(?:[a-z]|S) /.test(row))
      .map((row) => row.slice(2));
    // A flagged entry is dropped, so `add` takes the file from the working tree as it is.
    if (flagged.length)
      await run(["update-index", "--force-remove", "--", ...flagged]);
    await run(["add", "-A"]);
    // As a fresh index would have it: a file an ignore rule now matches is in the candidate
    // only if the base tracks it.
    if (!fresh) {
      const ignored = (
        await run(["ls-files", "-z", "-c", "-i", "--exclude-standard"])
      )
        .split("\0")
        .filter(Boolean);
      if (ignored.length) {
        const tracked = new Set(
          (
            await run([
              "--literal-pathspecs",
              "ls-tree",
              "-r",
              "-z",
              "--name-only",
              base,
              "--",
              ...ignored,
            ])
          )
            .split("\0")
            .filter(Boolean),
        );
        const drop = ignored.filter((path) => !tracked.has(path));
        if (drop.length)
          await run(["update-index", "--force-remove", "--", ...drop]);
      }
    }
    // `.gitignore`'s `node_modules/` does not match a link, and a dependency link is never
    // an artifact. Matching the base drops an added one and keeps one the repository tracks.
    const links = (await run(["ls-files", "--stage", "-z"]))
      .split("\0")
      .filter((row) => row.startsWith("120000 "))
      .map((row) => row.slice(row.indexOf("\t") + 1))
      .filter((path) => path.split("/").at(-1) === "node_modules");
    if (links.length)
      await run(["--literal-pathspecs", "reset", "-q", base, "--", ...links]);
    const patch = await run([
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--binary",
      "--patch",
      base,
    ]);
    const names = (
      await run(["diff", "--cached", "--name-only", "--no-renames", "-z", base])
    )
      .split("\0")
      .filter(Boolean);
    if (names.length > 500) throw new Error("Artifact has too many files");
    const index = names.length
      ? await run(["ls-files", "--stage", "-z", "--", ...names])
      : "";
    const indexed = new Map(
      index
        .split("\0")
        .filter(Boolean)
        .map((row) => {
          const at = row.indexOf("\t");
          const fields = row.slice(0, at).split(" ");
          return [row.slice(at + 1), { mode: fields[0], blob: fields[1] }];
        }),
    );
    const files: FileChange[] = [];
    for (const path of names) {
      await this.path(path, true);
      const entry = indexed.get(path);
      if (!entry) {
        files.push({ path, content: null });
        continue;
      }
      if (entry.mode !== "100644" && entry.mode !== "100755")
        throw new Error("Only regular files can be exported");
      const content = await run(["show", ":" + path], 1_000_001);
      if (content.includes("\0") || content.length > 1_000_000)
        throw new Error("Unsupported artifact file");
      const bytes = Buffer.from(content, "utf8");
      const identity = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (identity !== entry.blob)
        throw new Error(
          "Indexed file is not exact UTF-8; no replacement bytes may be exported",
        );
      files.push({ path, content, mode: entry.mode });
    }
    if (Buffer.byteLength(JSON.stringify(files)) > 10_000_000)
      throw new Error("Artifact too large");
    return { base, patch, files, hash: artifactHash(patch, files) };
  }
}
