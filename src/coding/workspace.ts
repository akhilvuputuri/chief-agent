import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  realpath,
  lstat,
  rm,
  chmod,
} from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { validateFiles } from "./github.js";
import type { Checkpoint } from "./schema.js";

export type CommandResult = {
  exitCode: number;
  output: string;
  truncated: boolean;
};
export class Workspace {
  constructor(
    readonly root: string,
    private signal: AbortSignal,
  ) {}
  async command(
    command: string,
    args: string[] = [],
    shell = false,
    timeoutMs = 120000,
    maxOutput = 32000,
  ): Promise<CommandResult> {
    if (this.signal.aborted) throw new Error("Coding cancelled");
    return new Promise((accept, reject) => {
      const child = spawn(command, args, {
        cwd: this.root,
        shell,
        detached: true,
        // Commands never inherit the worker capability or CodeBuild credentials.
        env: {
          PATH: process.env.PATH,
          HOME: this.root,
          TMPDIR: "/tmp",
          LANG: "C.UTF-8",
          CI: "true",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        settled = false,
        truncated = false;
      const stop = () => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(stop, timeoutMs);
      this.signal.addEventListener("abort", stop, { once: true });
      const append = (b: Buffer) => {
        output += b.toString("utf8");
        if (output.length > maxOutput) {
          truncated = true;
          output = output.slice(-maxOutput);
        }
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const clean = () => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", stop);
      };
      child.on("error", () => {
        if (!settled) {
          settled = true;
          clean();
          reject(new Error("Coding command could not start"));
        }
      });
      child.on("close", (code) => {
        if (!settled) {
          settled = true;
          clean();
          accept({ exitCode: code ?? -1, output, truncated });
        }
      });
    });
  }
  private async path(path: string, writing = false) {
    validateFiles([{ path, content: "" }]);
    const full = resolve(this.root, path);
    let parent = dirname(full);
    while (true) {
      try {
        const actual = await realpath(parent);
        if (relative(await realpath(this.root), actual).startsWith(".."))
          throw new Error("Path leaves coding workspace");
        break;
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        const next = dirname(parent);
        if (next === parent) throw error;
        parent = next;
      }
    }
    try {
      if ((await lstat(full)).isSymbolicLink())
        throw new Error("Symlinks are not supported");
    } catch (e: any) {
      if (e.code !== "ENOENT" || !writing) throw e;
    }
    return full;
  }
  async read(path: string, offset = 0, limit = 16000) {
    const text = await readFile(await this.path(path), "utf8");
    if (text.includes("\u0000"))
      throw new Error("Binary files are not supported");
    return {
      text: text.slice(offset, offset + limit),
      nextOffset: offset + limit < text.length ? offset + limit : null,
    };
  }
  async write(path: string, content: string) {
    const full = await this.path(path, true);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    return { written: true };
  }
  async remove(path: string) {
    const full = await this.path(path);
    await rm(full);
    return { removed: true };
  }
  async restore(c: Checkpoint) {
    validateFiles(c.files);
    for (const file of c.files) {
      if (file.content === null) {
        try {
          await this.remove(file.path);
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
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
  async snapshot(plan: string, summary: string): Promise<Checkpoint> {
    // Stage only inside the disposable checkout so newly created files are captured.
    const added = await this.command("git", ["add", "-A"]);
    if (added.exitCode !== 0) throw new Error("Cannot capture coding changes");
    const diff = await this.command(
      "git",
      [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-renames",
        "--binary",
        "--patch",
      ],
      false,
      120000,
      500000,
    );
    const names = await this.command("git", [
      "diff",
      "--cached",
      "--name-only",
      "-z",
    ]);
    if (
      diff.exitCode !== 0 ||
      names.exitCode !== 0 ||
      diff.truncated ||
      names.truncated
    )
      throw new Error("Coding patch exceeds supported snapshot size");
    const files: Checkpoint["files"] = [];
    for (const path of names.output.split("\u0000").filter(Boolean)) {
      validateFiles([{ path, content: "" }]);
      let content: string | null;
      try {
        content = await readFile(await this.path(path), "utf8");
        if (content.includes("\u0000"))
          throw new Error("Binary changes are not supported");
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
        content = null;
      }
      const mode =
        content === null
          ? undefined
          : (await lstat(await this.path(path))).mode & 0o111
            ? ("100755" as const)
            : ("100644" as const);
      files.push({ path, content, ...(mode ? { mode } : {}) });
    }
    validateFiles(files);
    return { plan, summary, patch: diff.output, files };
  }
}
