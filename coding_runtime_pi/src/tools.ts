import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readdir, stat } from "node:fs/promises";
import { matchesGlob, relative } from "node:path";
import { Type } from "typebox";
import {
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createBashToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Workspace, type Executor } from "./workspace.js";
import type { Report, Intent } from "./types.js";

export function tools(
  workspace: Workspace,
  intent: Intent,
  execute: Executor | undefined,
  report: (r: Report) => void,
  admit: () => Promise<void>,
): ToolDefinition<any, any>[] {
  const cwd = workspace.requestedRoot;
  const read = async (path: string) => {
    const data = await workspace.read(path);
    if (data.includes(0)) throw new Error("Binary content unsupported");
    return data;
  };
  const scopedGrep: ReturnType<typeof createGrepToolDefinition> = {
    ...createGrepToolDefinition(cwd),
    execute: async (_id, input, signal) => {
      const target = await workspace.path(input.path ?? ".");
      const args = ["--line-number", "--color=never", "--hidden"];
      if (input.ignoreCase) args.push("--ignore-case");
      if (input.literal) args.push("--fixed-strings");
      if (input.glob) args.push("--glob", input.glob);
      args.push(
        "--glob",
        "!**/.git/**",
        "--glob",
        "!**/.env",
        "--glob",
        "!**/.env.*",
      );
      if (input.context)
        args.push("--context", String(Math.min(5, Math.max(0, input.context))));
      args.push("--", input.pattern, target);
      let output = "";
      try {
        output = (
          await promisify(execFile)("rg", args, {
            cwd,
            signal,
            timeout: 10000,
            maxBuffer: 64000,
            env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
          })
        ).stdout;
      } catch (error) {
        if ((error as { code?: number }).code !== 1)
          throw new Error("Scoped search failed or exceeded its bound");
      }
      const allLines = output.split("\n").filter(Boolean);
      const limit = Math.min(1000, Math.max(1, input.limit ?? 100));
      const lines = allLines.slice(0, limit);
      const limited =
        allLines.length > limit || lines.join("\n").length > 32000;
      return {
        content: [
          {
            type: "text",
            text:
              (lines.join("\n").slice(0, 32000) || "No matches") +
              (limited
                ? "\n[Results truncated; narrow the query or inspect specific files.]"
                : ""),
          },
        ],
        details: {},
      };
    },
  };
  const list: ToolDefinition<any, any>[] = [
    createReadToolDefinition(cwd, {
      autoResizeImages: false,
      operations: {
        readFile: read,
        access: async (p) => {
          await workspace.path(p);
        },
      },
    }),
    scopedGrep,
    createFindToolDefinition(cwd, {
      operations: {
        exists: async (p) => {
          await workspace.path(p);
          return true;
        },
        glob: async (pattern, root, { limit }) => {
          await workspace.path(root);
          return (await workspace.files())
            .map((p) => relative(root, `${cwd}/${p}`))
            .filter(
              (p) =>
                p !== ".." && !p.startsWith("../") && matchesGlob(p, pattern),
            )
            .slice(0, limit);
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
  if (intent === "build") {
    if (!execute)
      throw new Error(
        "Build requires an explicitly supplied isolated command executor",
      );
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
    list.push(
      createBashToolDefinition(cwd, {
        exposeSessionEnvironment: false,
        operations: {
          exec: async (command, _cwd, { signal, onData, timeout }) => {
            const result = await execute(
              command,
              signal ?? new AbortController().signal,
              Math.min((timeout ?? 120) * 1000, 120_000),
            );
            onData(Buffer.from(result.output));
            return { exitCode: result.exitCode };
          },
        },
      }),
    );
  }
  list.push({
    name: "report",
    label: "Report",
    description:
      "Return grounded findings, a complete proposed plan, a necessary question, a build result, or an independent review verdict. Reporting does not approve work or mark checks passed.",
    parameters: Type.Object({
      kind: Type.Union(
        ["learned", "plan", "question", "done", "review"].map((v) =>
          Type.Literal(v),
        ),
      ),
      summary: Type.String({ minLength: 1, maxLength: 4000 }),
      detail: Type.String({ minLength: 1, maxLength: 6000 }),
      verdict: Type.Optional(
        Type.Union([Type.Literal("APPROVE"), Type.Literal("REQUEST_CHANGES")]),
      ),
    }),
    execute: async (_id, input) => {
      const r = input as Report;
      const allowed =
        intent === "learn"
          ? ["learned", "question"]
          : intent === "plan"
            ? ["plan", "question"]
            : intent === "review"
              ? ["review", "question"]
              : ["done", "question"];
      if (!allowed.includes(r.kind) || (r.kind === "review" && !r.verdict))
        throw new Error("Report does not match this task intent");
      if (r.kind === "question" && r.detail.length > 2000)
        throw new Error(
          "Return a complete question within 2000 characters; do not omit necessary context",
        );
      if (r.kind === "plan" && r.summary.length > 400)
        throw new Error(
          "Return a concise status summary within 400 characters; keep complete scope in detail",
        );
      if (!r.summary.trim() || !r.detail.trim() || r.detail.length > 6000)
        throw new Error("Return a complete bounded report");
      report(r);
      return {
        content: [
          {
            type: "text",
            text: "Report recorded; the host validates state, checks and authority.",
          },
        ],
        details: {},
      };
    },
  });
  return list.map((tool) => ({
    ...tool,
    executionMode: "sequential" as const,
    execute: async (
      ...args: Parameters<ToolDefinition<any, any>["execute"]>
    ) => {
      await admit();
      return tool.execute(...args);
    },
  }));
}
