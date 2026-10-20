#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { serveRpc } from "./rpc.js";
import {
  CodingRuntime,
  TaskStore,
  compatibleModel,
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
const runtime = new CodingRuntime({
  store: new TaskStore(join(state, "tasks"), stateKey),
  model: compatibleModel({
    provider: value("--provider", "openrouter")!,
    model: value("--model", "deepseek/deepseek-v4.1-flash")!,
    apiKey: key,
    baseUrl: value("--base-url"),
    reasoning: "high",
  }),
  executor: args.includes("--local-execution")
    ? (task) =>
        localExecutor(task.workspace, join(state, "tool-homes", task.id))
    : undefined,
  onEvent: async (_task, event) => {
    process.stderr.write(JSON.stringify(event) + "\n");
  },
});
try {
  let result: unknown;
  if (command === "rpc") {
    await serveRpc(runtime, process.stdin, process.stdout);
    process.exitCode = 0;
  } else if (command === "start") {
    if (!args[0] || !args[1])
      throw new Error(
        "Usage: pi-runtime start REPOSITORY OBJECTIVE [--mode learn|plan] [--check COMMAND] [--state DIRECTORY]",
      );
    await mkdir(join(state, "workspaces"), { recursive: true, mode: 0o700 });
    const workspace = await mkdtemp(join(state, "workspaces", "task-"));
    await promisify(execFile)(
      "git",
      ["clone", "--no-hardlinks", "--", args[0], workspace],
      {
        env: {
          PATH: process.env.PATH,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    );
    const mode = value("--mode", "plan");
    if (mode !== "plan" && mode !== "learn")
      throw new Error("Initial mode must be learn or plan");
    const checks = args.flatMap((v, i) =>
      v === "--check" && args[i + 1] ? [args[i + 1]!] : [],
    );
    result = await runtime.start({
      workspace,
      objective: args[1],
      intent: mode,
      checks,
    });
  } else if (command === "run") result = await runtime.run(args[0]!);
  else if (command === "status") result = await runtime.inspect(args[0]!);
  else if (command === "approve")
    result = await runtime.approve(args[0]!, Number(args[1]), args[2]!);
  else if (command === "reply")
    result = await runtime.reply(args[0]!, Number(args[1]), args[2]!);
  else if (command === "resume") result = await runtime.resume(args[0]!);
  else if (command === "cancel") {
    await runtime.cancel(args[0]!);
    result = { cancelled: true };
  } else
    throw new Error(
      "Commands: start, run, status, approve, reply, resume, cancel. Model credentials use PI_RUNTIME_API_KEY. Local generated commands require --local-execution; use an isolated container for untrusted source.",
    );
  if (command !== "rpc")
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : "Runtime operation failed") +
      "\n",
  );
  process.exitCode = 1;
}
