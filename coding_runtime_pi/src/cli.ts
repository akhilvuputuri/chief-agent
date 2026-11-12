#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  CodingRuntime,
  TaskStore,
  anthropicModel,
  localExecutor,
} from "./index.js";

const args = process.argv.slice(2);
const command = args.shift();
const value = (name: string, fallback?: string) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const state = resolve(value("--state", ".pi-runtime")!);
const key = process.env.PI_RUNTIME_API_KEY;
const stateKey = process.env.PI_RUNTIME_STATE_KEY;
if (!stateKey || stateKey.length < 32)
  throw new Error(
    "Set a private PI_RUNTIME_STATE_KEY of at least 32 characters; retain it for task recovery",
  );
delete process.env.PI_RUNTIME_STATE_KEY;
delete process.env.PI_RUNTIME_API_KEY;
const git = (...gitArgs: string[]) =>
  promisify(execFile)("git", gitArgs, {
    env: {
      PATH: process.env.PATH,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
const runtime = new CodingRuntime({
  store: new TaskStore(join(state, "tasks"), stateKey),
  model: anthropicModel({
    model: value("--model", "claude-opus-5-5")!,
    apiKey: key,
    baseUrl: value("--base-url"),
    reasoning: "high",
  }),
  executor: (task) => {
    // Generated commands run with this user's permissions; the flag makes that explicit.
    if (!args.includes("--local-execution"))
      throw new Error(
        "Generated commands need --local-execution; use an isolated container for untrusted source",
      );
    return localExecutor(task.workspace, join(state, "tool-homes", task.id));
  },
  onEvent: async (_task, event) => {
    process.stderr.write(JSON.stringify(event) + "\n");
  },
});
try {
  let result: unknown;
  if (command === "start") {
    if (!args[0])
      throw new Error(
        "Usage: pi-runtime start REPOSITORY [--role coder|reviewer] [--state DIRECTORY]",
      );
    await mkdir(join(state, "workspaces"), { recursive: true, mode: 0o700 });
    const workspace = await mkdtemp(join(state, "workspaces", "task-"));
    await git("clone", "--no-hardlinks", "--", args[0], workspace);
    const base = (
      await git("-C", workspace, "rev-parse", "HEAD")
    ).stdout.trim();
    const role = value("--role", "coder");
    if (role !== "coder" && role !== "reviewer")
      throw new Error("Role must be coder or reviewer");
    result = await runtime.start({ workspace, role, base });
  } else if (command === "run") {
    if (!args[0] || !args[1])
      throw new Error(
        "Usage: pi-runtime run TASK_ID MESSAGE [--state DIRECTORY]",
      );
    result = await runtime.run(args[0], args[1]);
  } else if (command === "status") result = await runtime.inspect(args[0]!);
  else if (command === "cancel") {
    await runtime.cancel(args[0]!);
    result = { cancelled: true };
  } else
    throw new Error(
      "Commands: start, run, status, cancel. Model credentials use PI_RUNTIME_API_KEY. Local generated commands require --local-execution; use an isolated container for untrusted source.",
    );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : "Runtime operation failed") +
      "\n",
  );
  process.exitCode = 1;
}
