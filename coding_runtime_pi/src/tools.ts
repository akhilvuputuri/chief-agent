import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import {
  basename,
  isAbsolute,
  matchesGlob,
  relative,
  resolve,
} from "node:path";
import { Type } from "typebox";
import {
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createBashToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Workspace, type Executor } from "./workspace.js";
import { reportLimits, reportDocument, type ReportDocument } from "./report.js";
import type { Report, Role } from "./types.js";

/**
 * Pi's own tools, confined to the workspace through Pi's tool `operations` options. Execution
 * mode, output truncation and bash timeouts are Pi's defaults (journal 182). The reviewer has
 * no edit or write; its shell runs in its own copy (journal 192).
 */
export function tools(
  workspace: Workspace,
  role: Role,
  execute: Executor | undefined,
  report: (r: ReportDocument) => void,
  /** Where Pi writes full output it truncated; `read` alone may open files directly in it. */
  outputs?: string,
): ToolDefinition<any, any>[] {
  const cwd = workspace.requestedRoot;
  const read = (path: string) => workspace.read(path);
  const readable = async (path: string) => {
    const full = resolve(cwd, path);
    const inOutputs = outputs ? relative(outputs, full) : "";
    if (
      outputs &&
      inOutputs &&
      !inOutputs.startsWith("..") &&
      !isAbsolute(inOutputs) &&
      basename(inOutputs) === inOutputs
    ) {
      if ((await lstat(full)).isSymbolicLink())
        throw new Error("Symlink paths are unsupported");
      return full;
    }
    return workspace.path(path);
  };
  const list: ToolDefinition<any, any>[] = [
    createReadToolDefinition(cwd, {
      operations: {
        readFile: async (p) => readFile(await readable(p)),
        access: async (p) => {
          await readable(p);
        },
        detectImageMimeType: async (p) =>
          detectSupportedImageMimeTypeFromFile(await readable(p)),
      },
    }),
    grep(workspace),
    createFindToolDefinition(cwd, {
      operations: {
        exists: async (p) => {
          await workspace.path(p);
          return true;
        },
        // Stock find runs fd, which the box does not ship; Pi would download it at run time.
        glob: async (pattern, root, { limit }) => {
          await workspace.path(root);
          const found: string[] = [];
          for await (const file of workspace.files()) {
            const path = relative(root, `${cwd}/${file}`);
            if (path === ".." || path.startsWith("../")) continue;
            if (!matchesGlob(path, pattern)) continue;
            found.push(path);
            if (found.length >= limit) break;
          }
          return found;
        },
      },
    }),
    createLsToolDefinition(cwd, {
      operations: {
        exists: async (p) => {
          await workspace.path(p);
          return true;
        },
        stat: async (p) => stat(await workspace.path(p)),
        readdir: async (p) =>
          (await readdir(await workspace.path(p))).filter(
            (n) =>
              n !== ".git" &&
              n !== ".env" &&
              (!n.startsWith(".env.") || n === ".env.example"),
          ),
      },
    }),
  ];
  if (!execute)
    throw new Error("A coding session needs an isolated command executor");
  // The reviewer works in a disposable copy, so it may run commands to test the candidate.
  // Its edits never reach the artifact, which comes from the coder's workspace.
  if (role === "coder") {
    list.push(
      createEditToolDefinition(cwd, {
        operations: {
          readFile: read,
          access: async (p) => {
            await workspace.path(p);
          },
          writeFile: async (p, data) => workspace.write(p, data),
        },
      }),
    );
    list.push(
      createWriteToolDefinition(cwd, {
        operations: {
          writeFile: async (p, data) => workspace.write(p, data),
          mkdir: async () => {},
        },
      }),
    );
  }
  list.push(bash(cwd, execute));
  const result = role === "coder" ? "done" : "review";
  list.push({
    name: "report",
    label: "Report",
    description: `Hands your result to Chief and ends your turn. Use kind ${result}${role === "reviewer" ? " with verdict APPROVE or REQUEST_CHANGES" : ""} when finished: summary (at most ${reportLimits.summary} characters) and detail (the full ${role === "coder" ? "account of what you changed and how you tested it" : "findings"}, at most ${reportLimits.document} characters). Use kind ask only when you need the owner: ask is one short question of at most ${reportLimits.ask} characters, with up to ${reportLimits.options} options the owner can tap, each one line of at most ${reportLimits.option} characters; put any background in detail.`,
    parameters: Type.Object({
      kind: Type.Union([Type.Literal(result), Type.Literal("ask")]),
      summary: Type.String({ minLength: 1 }),
      detail: Type.Optional(Type.String()),
      ...(role === "reviewer"
        ? {
            verdict: Type.Optional(
              Type.Union([
                Type.Literal("APPROVE"),
                Type.Literal("REQUEST_CHANGES"),
              ]),
            ),
          }
        : {}),
      ask: Type.Optional(Type.String()),
      options: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_id, input) => {
      const r = input as Report;
      if (r.kind !== result && r.kind !== "ask")
        throw new Error(`Use kind ${result} or ask`);
      report(reportDocument(r));
      return {
        content: [{ type: "text", text: "Report recorded." }],
        details: {},
        // Pi's own early termination: the run ends after this tool batch.
        terminate: true,
      };
    },
  });
  return list;
}

/**
 * Stock bash with commands run by the isolated executor, whose environment holds no secrets.
 * No timeout unless the model passes one; the run's deadline and cancellation abort `signal`.
 */
function bash(cwd: string, execute: Executor) {
  return createBashToolDefinition(cwd, {
    // The executor builds its own environment, so Pi's PI_* variables never reach the command.
    exposeSessionEnvironment: false,
    operations: {
      exec: async (command, _cwd, { signal, onData, timeout }) => {
        if (
          timeout !== undefined &&
          (!Number.isFinite(timeout) ||
            timeout <= 0 ||
            timeout * 1000 > 2_147_483_647)
        )
          throw new Error(
            "Invalid timeout: must be a positive number of seconds",
          );
        const stop = signal ?? new AbortController().signal;
        if (stop.aborted) throw new Error("aborted");
        const result = await execute(
          command,
          stop,
          timeout === undefined ? undefined : timeout * 1000,
          undefined,
          (chunk) => onData(Buffer.from(chunk)),
        );
        // Stock bash reports these two outcomes from these exact messages.
        if (stop.aborted) throw new Error("aborted");
        if (result.timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode: result.exitCode };
      },
    },
  });
}

/**
 * Stock grep's schema, description and output format, with one difference: stock grep runs
 * `rg --hidden` over the tree, which reads `.git` and `.env` files that every other tool refuses.
 */
function grep(
  workspace: Workspace,
): ReturnType<typeof createGrepToolDefinition> {
  const stock = createGrepToolDefinition(workspace.requestedRoot);
  return {
    ...stock,
    execute: async (_id, input, signal) => {
      const target = await workspace.path(input.path ?? ".");
      const directory = (await stat(target)).isDirectory();
      const context = input.context && input.context > 0 ? input.context : 0;
      const limit = Math.max(1, input.limit ?? 100);
      const args = ["--json", "--line-number", "--color=never", "--hidden"];
      if (input.ignoreCase) args.push("--ignore-case");
      if (input.literal) args.push("--fixed-strings");
      if (input.glob) args.push("--glob", input.glob);
      args.push("--glob", "!**/.git/**", "--glob", "!**/.env");
      args.push("--glob", "!**/.env.*");
      if (context) args.push("--context", String(context));
      args.push("--", input.pattern, target);
      const name = (path: string) => {
        const rel = relative(target, path);
        return directory && rel && !rel.startsWith("..") ? rel : basename(path);
      };
      const lines: string[] = [];
      let matches = 0;
      let limited = false;
      let cut = false;
      await new Promise<void>((accept, reject) => {
        if (signal?.aborted) return reject(new Error("Operation aborted"));
        const child = spawn("rg", args, {
          cwd: workspace.requestedRoot,
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
        });
        const abort = () => child.kill();
        signal?.addEventListener("abort", abort, { once: true });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        createInterface({ input: child.stdout }).on("line", (line) => {
          if (limited) return;
          let event: {
            type?: string;
            data?: {
              path?: { text?: string };
              line_number?: number;
              lines?: { text?: string };
            };
          };
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event.type !== "match" && event.type !== "context") return;
          if (event.type === "match" && ++matches > limit) {
            matches = limit;
            limited = true;
            child.kill();
            return;
          }
          const text = truncateLine(
            String(event.data?.lines?.text ?? "")
              .replace(/\r?\n$/, "")
              .replace(/\r/g, ""),
          );
          if (text.wasTruncated) cut = true;
          const at = name(event.data?.path?.text ?? "");
          const separator = event.type === "match" ? ":" : "-";
          lines.push(
            `${at}${separator}${event.data?.line_number}${separator} ${text.text}`,
          );
        });
        child.on("error", (error) => {
          signal?.removeEventListener("abort", abort);
          reject(new Error(`Failed to run ripgrep: ${error.message}`));
        });
        child.on("close", (code) => {
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) return reject(new Error("Operation aborted"));
          if (!limited && code !== 0 && code !== 1)
            return reject(
              new Error(stderr.trim() || `ripgrep exited with code ${code}`),
            );
          accept();
        });
      });
      if (!matches)
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: undefined,
        };
      const truncation = truncateHead(lines.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      const notices: string[] = [];
      if (limited)
        notices.push(
          `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`,
        );
      if (truncation.truncated)
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      if (cut)
        notices.push(
          "Some lines truncated to 500 chars. Use read tool to see full lines",
        );
      return {
        content: [
          {
            type: "text",
            text:
              truncation.content +
              (notices.length ? `\n\n[${notices.join(". ")}]` : ""),
          },
        ],
        details: undefined,
      };
    },
  };
}
