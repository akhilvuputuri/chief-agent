import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  realpath,
  lstat,
  rm,
  chmod,
  mkdtemp,
} from "node:fs/promises";
import { resolve, dirname, relative, join } from "node:path";
import { tmpdir } from "node:os";
import { validateFiles } from "./github.js";
import type { Checkpoint } from "./schema.js";

export type CommandResult = {
  exitCode: number;
  output: string;
  truncated: boolean;
};
export class Workspace {
  private home?: string;
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
    const toolHome = (this.home ??= await mkdtemp(
      join(tmpdir(), "chief-tools-"),
    ));
    if (this.signal.aborted) throw new Error("Coding cancelled");
    return new Promise((accept, reject) => {
      const child = spawn(command, args, {
        cwd: this.root,
        shell,
        detached: true,
        // Commands never inherit the worker capability or CodeBuild credentials.
        env: {
          PATH: process.env.PATH,
          HOME: toolHome,
          NPM_CONFIG_CACHE: join(toolHome, "npm-cache"),
          XDG_CACHE_HOME: join(toolHome, "cache"),
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
      child.stdout.setEncoding("utf8").on("data", append);
      child.stderr.setEncoding("utf8").on("data", append);
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
      "--no-renames",
      "-z",
    ]);
    const index = await this.command(
      "git",
      ["ls-files", "--stage", "-z"],
      false,
      120000,
      500000,
    );
    if (
      diff.exitCode !== 0 ||
      names.exitCode !== 0 ||
      diff.truncated ||
      names.truncated ||
      index.exitCode !== 0 ||
      index.truncated
    )
      throw new Error("Coding patch exceeds supported snapshot size");
    const files: Checkpoint["files"] = [];
    const indexed = new Map(
      index.output
        .split("\u0000")
        .filter(Boolean)
        .map((entry) => {
          const at = entry.indexOf("\t");
          const fields = entry.slice(0, at).split(" ");
          return [entry.slice(at + 1), { mode: fields[0], blob: fields[1] }];
        }),
    );
    for (const path of names.output.split("\u0000").filter(Boolean)) {
      validateFiles([{ path, content: "" }]);
      const entry = indexed.get(path);
      const mode = entry?.mode;
      if (mode !== undefined && mode !== "100644" && mode !== "100755")
        throw new Error("Only regular indexed files are supported");
      let content: string | null = null;
      if (mode) {
        const blob = await this.command(
          "git",
          ["show", `:${path}`],
          false,
          120000,
          128000,
        );
        if (
          blob.exitCode !== 0 ||
          blob.truncated ||
          blob.output.includes("\u0000")
        )
          throw new Error("Only bounded UTF-8 indexed files are supported");
        const bytes = Buffer.from(blob.output, "utf8");
        const identity = createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex");
        if (identity !== entry?.blob)
          throw new Error(
            "Indexed file is not valid UTF-8; no replacement bytes may be published",
          );
        content = blob.output;
      }
      files.push({ path, content, ...(mode ? { mode } : {}) });
    }
    validateFiles(files);
    return { plan, summary, patch: diff.output, files };
  }
}
