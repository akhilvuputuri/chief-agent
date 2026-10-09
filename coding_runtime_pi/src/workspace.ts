import { processCleanup } from "./process-boundary.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  realpath,
  lstat,
  readdir,
  chmod,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { Artifact, FileChange } from "./types.js";

export type Execution = {
  exitCode: number;
  output: string;
  truncated?: boolean;
};
export type Executor = (
  command: string,
  signal: AbortSignal,
  timeoutMs: number,
  maxOutput?: number,
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
  return async (command, signal, timeoutMs, maxOutput = 32000) => {
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
          NPM_CONFIG_CACHE: `${home}/npm`,
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
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      signal.addEventListener("abort", kill, { once: true });
      if (signal.aborted) kill();
      const append = (data: string) => {
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
  async files() {
    const found: string[] = [];
    const walk = async (dir: string, prefix: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (
          [".git", "node_modules", ".env"].includes(entry.name) ||
          (entry.name.startsWith(".env.") && entry.name !== ".env.example")
        )
          continue;
        if (entry.isSymbolicLink()) continue;
        const path = prefix + entry.name;
        if (entry.isDirectory())
          await walk(resolve(dir, entry.name), path + "/");
        else if (entry.isFile()) found.push(path);
        if (found.length > 20_000)
          throw new Error("Repository file inventory exceeds bound");
      }
    };
    await walk(await this.path("."), "");
    return found;
  }
  async read(path: string) {
    const full = await this.path(path);
    if ((await lstat(full)).size > 2_000_000)
      throw new Error("File too large; use targeted search");
    return readFile(full);
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
  async snapshot(execute: Executor, signal: AbortSignal): Promise<Artifact> {
    const quote = (value: string) =>
      "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const run = async (args: string[], max = 500_000) => {
      const result = await execute(
        ["git", "-c", "core.hooksPath=/dev/null", ...args].map(quote).join(" "),
        signal,
        120000,
        max,
      );
      if (result.exitCode !== 0 || result.truncated)
        throw new Error("Git artifact operation failed or exceeded its bound");
      return result.output;
    };
    await run(["add", "-A"]);
    const base = (await run(["rev-parse", "HEAD"])).trim();
    const patch = await run([
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--binary",
      "--patch",
    ]);
    const names = (
      await run(["diff", "--cached", "--name-only", "--no-renames", "-z"])
    )
      .split("\0")
      .filter(Boolean);
    if (names.length > 100) throw new Error("Artifact has too many files");
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
      const content = await run(["show", ":" + path], 128_001);
      if (content.includes("\0") || content.length > 128_000)
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
    if (Buffer.byteLength(JSON.stringify(files)) > 500_000)
      throw new Error("Artifact too large");
    return { base, patch, files, hash: artifactHash(patch, files) };
  }
}
