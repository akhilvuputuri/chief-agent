import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  CodingRuntime,
  TaskStore,
  Workspace,
  localExecutor,
  type ModelFactory,
} from "../src/index.js";

function scripted(
  replies: Array<Array<{ name: string; arguments: Record<string, unknown> }>>,
): ModelFactory {
  return async (admit) => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    let index = 0;
    runtime.registerProvider("synthetic", {
      api: "synthetic",
      baseUrl: "https://unused.invalid",
      apiKey: "synthetic",
      models: [
        {
          id: "test",
          name: "Test",
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 4096,
        },
      ],
      streamSimple(model, _context, options) {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          await admit();
          const calls = replies[index++] ?? [];
          const message: any = {
            role: "assistant",
            content: calls.length
              ? calls.map((c, i) => ({
                  type: "toolCall",
                  id: `c-${index}-${i}`,
                  name: c.name,
                  arguments: c.arguments,
                }))
              : [{ type: "text", text: "Finished." }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: calls.length ? "toolUse" : "stop",
            timestamp: Date.now(),
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
        })().catch(() =>
          stream.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: "synthetic",
              provider: "synthetic",
              model: "test",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "error",
              timestamp: Date.now(),
              errorMessage: "Exhausted",
            },
          }),
        );
        return stream;
      },
    });
    return { runtime, model: runtime.getModel("synthetic", "test")! };
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", ["-C", workspace, "config", "user.name", "Synthetic"]);
  execFileSync("git", [
    "-C",
    workspace,
    "config",
    "user.email",
    "synthetic@example.invalid",
  ]);
  await writeFile(
    join(workspace, "sum.js"),
    "export const sum = (a, b) => a - b;\n",
  );
  await writeFile(
    join(workspace, "test.mjs"),
    "import assert from 'node:assert/strict';import {sum} from './sum.js';assert.equal(sum(2,3),5);\n",
  );
  await writeFile(join(workspace, "package.json"), '{"type":"module"}');
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", ["-C", workspace, "commit", "-qm", "Fixture"]);
  return {
    root,
    workspace,
    store: new TaskStore(
      join(root, "state"),
      "synthetic-state-key-32-characters",
    ),
  };
}
const report = (kind: string, detail: string) => ({
  name: "report",
  arguments: { kind, summary: "Synthetic result", detail },
});
test("plan requires exact approval; build uses real Pi edits, actual checks and artifacts", async () => {
  const f = await fixture();
  const planner = new CodingRuntime({
    store: f.store,
    model: scripted([
      [
        { name: "read", arguments: { path: "sum.js" } },
        { name: "write", arguments: { path: "unexpected", content: "denied" } },
      ],
      [
        report(
          "plan",
          "Change subtraction to addition. Check sum(2,3) equals 5.",
        ),
      ],
    ]),
  });
  const task = await planner.start({
    workspace: f.workspace,
    objective: "Fix sum",
    checks: ["node test.mjs"],
  });
  const plan = await planner.run(task.id);
  assert.equal(plan.status, "waiting_approval");
  assert(plan.plan);
  await assert.rejects(readFile(join(f.workspace, "unexpected")));
  await assert.rejects(planner.approve(task.id, 1, "stale"));
  await planner.approve(task.id, plan.plan.revision, plan.plan.hash);
  const builder = new CodingRuntime({
    store: f.store,
    model: scripted([
      [
        {
          name: "edit",
          arguments: {
            path: "sum.js",
            edits: [{ oldText: "a - b", newText: "a + b" }],
          },
        },
      ],
      [report("done", "Implemented the approved fix.")],
    ]),
    executor: (t) => localExecutor(t.workspace, join(f.root, "home")),
  });
  const built = await builder.run(task.id);
  assert.equal(built.status, "completed");
  assert.equal(built.checks[0]?.exitCode, 0);
  assert.equal(built.artifact?.files.length, 1);
  assert(built.artifact?.patch.includes("a + b"));
});
test("failed real checks do not become completion; revisions invalidate approval", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([[report("plan", "Fix sum and test it.")]]),
    executor: (t) => localExecutor(t.workspace, join(f.root, "home")),
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Fix sum",
    checks: ["node test.mjs"],
  });
  const plan = await runtime.run(task.id);
  await runtime.approve(task.id, 1, plan.plan!.hash);
  const noFix = new CodingRuntime({
    store: f.store,
    model: scripted([[report("done", "Claims it is fixed.")]]),
    executor: (t) => localExecutor(t.workspace, join(f.root, "home")),
  });
  const built = await noFix.run(task.id);
  assert.equal(built.status, "paused");
  assert.notEqual(built.checks[0]?.exitCode, 0);
  const revised = await noFix.reply(task.id, 1, "Also handle zero");
  assert.equal(revised.approved, undefined);
  assert.equal(revised.plan, undefined);
  assert.equal(revised.intent, "plan");
});
test("outside, credential and symlink paths are denied", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "outside"), "synthetic");
  await symlink(join(f.root, "outside"), join(f.workspace, "link"));
  const w = await new Workspace(f.workspace).initialize();
  for (const p of [
    "../outside",
    "link",
    ".git/config",
    ".env",
    ".git/.env.example",
  ])
    await assert.rejects(w.read(p));
  await assert.rejects(w.write("../escape", "bad"));
});
test("restart pauses; no automatic model call or tool replay", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({ store: f.store, model: scripted([]) });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Read source",
  });
  task.status = "running";
  await f.store.save(task);
  const restored = await runtime.inspect(task.id);
  assert.equal(restored.status, "paused");
  await assert.rejects(runtime.run(task.id));
});
test("command timeout and cancellation return failure and strip private environment", async () => {
  const f = await fixture();
  process.env.PI_SYNTHETIC_SECRET = "not-for-commands";
  const execute = localExecutor(f.workspace, join(f.root, "home"));
  const stop = new AbortController();
  const safe = await execute(
    'test -z "$PI_SYNTHETIC_SECRET"',
    stop.signal,
    1000,
  );
  assert.equal(safe.exitCode, 0);
  const timeout = await execute("sleep 10", stop.signal, 30);
  assert.equal(timeout.exitCode, -1);
  const running = execute("sleep 10", stop.signal, 1000);
  setTimeout(() => stop.abort(), 30);
  assert.equal((await running).exitCode, -1);
  delete process.env.PI_SYNTHETIC_SECRET;
});
test("private task storage cannot be exposed inside the workspace", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: new TaskStore(
      join(f.workspace, "private"),
      "synthetic-state-key-32-characters",
    ),
    model: scripted([]),
  });
  await assert.rejects(
    runtime.start({ workspace: f.workspace, objective: "Learn" }),
  );
});

test("task metadata tampering cannot forge approval or completion", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({ store: f.store, model: scripted([]) });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Inspect",
  });
  const path = join(f.store.path(task.id), "task.json");
  const envelope = JSON.parse(await readFile(path, "utf8"));
  const forged = JSON.parse(envelope.body);
  forged.status = "completed";
  forged.approved = { revision: 1, hash: "fake" };
  envelope.body = JSON.stringify(forged);
  await writeFile(path, JSON.stringify(envelope));
  await assert.rejects(runtime.inspect(task.id), /integrity/);
});
test("identical text on a different task cannot reuse approval", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([[report("plan", "Same proposed plan.")]]),
  });
  const first = await runtime.start({
    workspace: f.workspace,
    objective: "Fix sum",
  });
  const a = await runtime.run(first.id);
  const other = new CodingRuntime({
    store: f.store,
    model: scripted([[report("plan", "Same proposed plan.")]]),
  });
  const second = await other.start({
    workspace: f.workspace,
    objective: "Fix sum",
  });
  const b = await other.run(second.id);
  assert.notEqual(a.plan?.hash, b.plan?.hash);
  await assert.rejects(other.approve(second.id, 1, a.plan!.hash));
});
test("learn is source-grounded and does not turn into a build approval", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([
      [{ name: "read", arguments: { path: "sum.js" } }],
      [report("learned", "sum.js currently subtracts instead of adding.")],
    ]),
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Explain the bug",
    intent: "learn",
  });
  const learned = await runtime.run(task.id);
  assert.equal(learned.status, "completed");
  assert.equal(learned.plan, undefined);
  await assert.rejects(runtime.approve(task.id, 1, "x"));
});

test("concurrent scope revision and approval are serialized", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([[report("plan", "Fix addition.")]]),
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Fix sum",
  });
  const plan = await runtime.run(task.id);
  const attempts = await Promise.allSettled([
    runtime.reply(task.id, 1, "Change the required behavior"),
    runtime.approve(task.id, 1, plan.plan!.hash),
  ]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  const latest = await runtime.inspect(task.id);
  assert(!(latest.revision === 2 && latest.approved));
});
test("indexed artifact rejects invalid UTF-8 rather than exporting replacement bytes", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, "bad.txt"), Buffer.from([0xff, 0xfe]));
  const w = await new Workspace(f.workspace).initialize();
  await assert.rejects(
    w.snapshot(
      localExecutor(f.workspace, join(f.root, "home")),
      new AbortController().signal,
    ),
    /UTF-8/,
  );
});

test("cancellation from another client stops the active command and preserves terminal state", async () => {
  const f = await fixture();
  const planner = new CodingRuntime({
    store: f.store,
    model: scripted([[report("plan", "Fix sum and verify it.")]]),
  });
  const task = await planner.start({
    workspace: f.workspace,
    objective: "Fix sum",
    checks: ["node test.mjs"],
  });
  const plan = await planner.run(task.id);
  await planner.approve(task.id, 1, plan.plan!.hash);
  const canceler = new CodingRuntime({ store: f.store, model: scripted([]) });
  const builder = new CodingRuntime({
    store: f.store,
    model: scripted([
      [{ name: "bash", arguments: { command: "sleep 10" } }],
      [report("done", "Claims success")],
    ]),
    executor: (t) => localExecutor(t.workspace, join(f.root, "home")),
    onEvent: async (t, e) => {
      if (e.type === "tool" && e.text === "tool_execution_start: bash")
        await canceler.cancel(t.id);
    },
  });
  const started = Date.now();
  const stopped = await builder.run(task.id);
  assert.equal(stopped.status, "cancelled");
  assert(Date.now() - started < 5000);
  assert.equal(stopped.checks.length, 0);
});
test("allocation exhaustion cannot promote a report from an unfinished model run", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([[report("plan", "Proposed plan")]]),
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Plan",
    limits: { ms: 10000, models: 1, tools: 10 },
  });
  const result = await runtime.run(task.id);
  assert.equal(result.status, "paused");
  assert.equal(result.plan, undefined);
  assert.equal(result.used.models, 1);
});

test("private directory whose name starts with dots is still inside the workspace", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: new TaskStore(
      join(f.workspace, "..private"),
      "synthetic-state-key-32-characters",
    ),
    model: scripted([]),
  });
  await assert.rejects(
    runtime.start({ workspace: f.workspace, objective: "Inspect" }),
  );
});

test("replacement workspace reopens the exact restored session and keeps its immutable prefix", async () => {
  const f = await fixture();
  const old = await fixture();
  const oldDirectory = join(old.root, "history");
  const manager = SessionManager.create(old.workspace, oldDirectory);
  manager.appendMessage({
    role: "user",
    content: "Synthetic uncertainty marker from the first worker",
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Prior observation retained." }],
    api: "synthetic",
    provider: "synthetic",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const original = await readFile(manager.getSessionFile()!, "utf8");
  let sawMarker = false;
  const factory = scripted([
    [report("plan", "Continue the complete proposed scope.")],
  ]);
  const runtime = new CodingRuntime({
    store: f.store,
    model: async (admit) => {
      const value = await factory(admit);
      const provider = value.runtime.getRegisteredProviderConfig("synthetic")!;
      const stream = provider.streamSimple!;
      value.runtime.registerProvider("synthetic", {
        ...provider,
        streamSimple: (model, context, options) => {
          sawMarker ||= JSON.stringify(context.messages).includes(
            "Synthetic uncertainty marker",
          );
          return stream(model, context, options);
        },
      });
      return value;
    },
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Continue inspection",
  });
  const dir = join(f.store.path(task.id), "sessions-1-plan");
  await mkdir(dir, { recursive: true });
  const restored = join(dir, "restored.jsonl");
  await writeFile(restored, original);
  const result = await runtime.run(task.id);
  assert.equal(result.status, "waiting_approval");
  assert(sawMarker);
  assert.equal(result.sessionFile, restored);
  assert((await readFile(restored, "utf8")).startsWith(original));
});
test("interrupted execution charges the saved time reservation rather than resetting it", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({ store: f.store, model: scripted([]) });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Inspect",
    limits: { ms: 2000, models: 10, tools: 10 },
  });
  task.status = "running";
  task.runnerPid = 999999999;
  task.activeRun = { startedAt: Date.now() - 1000, reservedMs: 2000 };
  await f.store.save(task);
  const paused = await runtime.inspect(task.id);
  assert.equal(paused.status, "paused");
  assert(paused.used.ms >= 1000 && paused.used.ms <= 2000);
  await runtime.resume(task.id);
  const ready = await runtime.inspect(task.id);
  assert(ready.used.ms >= 1000);
  assert.equal(ready.activeRun, undefined);
});
