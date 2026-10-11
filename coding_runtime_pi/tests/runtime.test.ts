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
  stopReason?: string | number,
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
            stopReason:
              typeof stopReason === "string"
                ? stopReason
                : index === stopReason
                  ? "length"
                  : calls.length
                    ? "toolUse"
                    : "stop",
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
test("truncated model output cannot promote its unexecuted report", async () => {
  for (const first of [
    [report("plan", "Proposed plan")],
    [{ name: "read", arguments: { path: "sum.js" } }],
  ]) {
    const f = await fixture();
    const runtime = new CodingRuntime({
      store: f.store,
      model: scripted([first, [report("plan", "Must never be requested")]], 1),
    });
    const task = await runtime.start({
      workspace: f.workspace,
      objective: "Plan",
      limits: { ms: 10000, models: 10, tools: 10 },
    });
    const result = await runtime.run(task.id);
    assert.equal(result.status, "paused");
    assert.equal(result.plan, undefined);
    assert.equal(result.used.models, 1);
    assert.equal(result.used.tools, 0);
  }
});

test("a valid plan with other reads in its batch ends after that settled batch", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([
      [
        report("plan", "Fix sum.js and check it."),
        { name: "read", arguments: { path: "sum.js" } },
      ],
      ...Array.from({ length: 40 }, () => [
        { name: "read", arguments: { path: "sum.js" } },
      ]),
    ]),
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Plan",
    limits: { ms: 10000, models: 1, tools: 100 },
  });
  const result = await runtime.run(task.id);
  assert.equal(result.status, "waiting_approval");
  assert.equal(result.used.models, 1);
  assert.equal(result.used.tools, 2);
  assert.equal(result.approved, undefined);
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

test("a clean prose-only ending gets one report-only finalization and an exact plan", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([
      [],
      [report("plan", "Fix sum.js and run the configured assertion.")],
      [],
    ]),
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Plan a fixture fix",
  });
  const result = await runtime.run(task.id);
  assert.equal(result.status, "waiting_approval");
  assert.equal(result.used.models, 2);
  assert(result.plan?.hash);
  assert.equal(
    result.events.filter(
      (e) => e.text === "Requesting one structured final report",
    ).length,
    1,
  );
});

test("planning stops sustained exploration at a settled boundary and reports from retained evidence", async () => {
  const f = await fixture();
  const reads = Array.from({ length: 32 }, () => [
    { name: "read", arguments: { path: "sum.js" } },
  ]);
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([
      ...reads,
      [report("plan", "Fix sum.js and check addition in test.mjs.")],
    ]),
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Plan the entire fixture repair",
  });
  const result = await runtime.run(task.id);
  assert.equal(result.status, "waiting_approval");
  assert.equal(result.used.models, 33);
  assert.equal(result.used.tools, 33);
  assert.equal(result.approved, undefined);
  const session = (await readFile(result.sessionFile!, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  const messages = session.map((e) => e.message).filter(Boolean);
  assert.equal(
    messages.filter((m) => m.role === "toolResult" && m.toolName === "read")
      .length,
    32,
  );
  assert(
    messages.some(
      (m) =>
        m.role === "user" &&
        JSON.stringify(m.content).includes("specific evidence gap"),
    ),
  );
});

test("a truncated report pauses even when retained history allows native compaction recovery", async () => {
  const f = await fixture();
  await writeFile(
    join(f.workspace, "sum.js"),
    "// retained source evidence\n".repeat(150),
  );
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted(
      [
        ...Array.from({ length: 32 }, () => [
          { name: "read", arguments: { path: "sum.js" } },
        ]),
        [report("plan", "Truncated report")],
        [report("plan", "Must never recover automatically")],
      ],
      33,
    ),
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Plan from substantial source history",
  });
  const result = await runtime.run(task.id);
  assert.equal(result.status, "paused");
  assert.equal(result.used.models, 33);
  assert.equal(result.plan, undefined);
  const entries = (await readFile(result.sessionFile!, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  assert.equal(entries.filter((e) => e.type === "compaction").length, 0);
});

test("one rejected navigation attempt can be corrected into a report without executing more source reads", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([
      ...Array.from({ length: 32 }, () => [
        { name: "read", arguments: { path: "sum.js" } },
      ]),
      [{ name: "read", arguments: { path: "sum.js" } }],
      [
        report(
          "question",
          "What non-numeric input behavior should be retained?",
        ),
      ],
    ]),
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Plan from bounded investigation",
  });
  const result = await runtime.run(task.id);
  assert.equal(result.status, "waiting_input");
  assert.equal(result.used.models, 34);
  assert.equal(result.used.tools, 33);
  const entries = (await readFile(result.sessionFile!, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  const reads = entries
    .map((e) => e.message)
    .filter((m) => m?.role === "toolResult" && m.toolName === "read");
  assert.equal(reads.length, 33);
  assert.equal(reads.filter((m) => !m.isError).length, 32);
  assert(reads.at(-1).isError);
  assert.equal(result.plan, undefined);
});

test("one completed prose conclusion can be formatted into a plan without reopening investigation", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([
      ...Array.from({ length: 32 }, () => [
        { name: "read", arguments: { path: "sum.js" } },
      ]),
      [],
      [report("plan", "Fix sum.js and verify addition using test.mjs.")],
    ]),
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Plan the fixture repair",
  });
  const result = await runtime.run(task.id);
  assert.equal(result.status, "waiting_approval");
  assert.equal(result.used.models, 34);
  assert.equal(result.used.tools, 33);
  assert.equal(result.approved, undefined);
  const entries = (await readFile(result.sessionFile!, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  assert(
    entries.some(
      (e) =>
        e.message?.role === "user" &&
        JSON.stringify(e.message.content).includes(
          "Host report-format correction",
        ),
    ),
  );
});

test("planning finalization cannot keep reading or invent a plan when evidence is missing", async () => {
  for (const final of [
    [
      report(
        "question",
        "Which behavior should the addition API implement for non-numeric input?",
      ),
    ],
    [{ name: "read", arguments: { path: "sum.js" } }],
  ]) {
    const f = await fixture();
    const runtime = new CodingRuntime({
      store: f.store,
      model: scripted([
        ...Array.from({ length: 32 }, () => [
          { name: "read", arguments: { path: "sum.js" } },
        ]),
        final,
        [{ name: "read", arguments: { path: "sum.js" } }],
        [report("plan", "Must never run")],
      ]),
    });
    const task = await runtime.start({
      workspace: f.workspace,
      objective: "Plan with missing requirements",
    });
    const result = await runtime.run(task.id);
    assert.equal(result.used.models, final[0]?.name === "report" ? 33 : 34);
    assert.equal(
      result.status,
      final[0]?.name === "report" ? "waiting_input" : "paused",
    );
    assert.equal(result.plan, undefined);
    assert.equal(result.approved, undefined);
    assert.equal(
      result.events.filter((e) => e.text === "tool_execution_end: read").length,
      final[0]?.name === "report" ? 32 : 34,
    );
  }
});

test("planning reserves time for reporting and saves the completed investigation before handoff", async () => {
  const f = await fixture();
  let delayed = false;
  let observedCheckpoint = false;
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([
      [{ name: "read", arguments: { path: "sum.js" } }],
      [report("question", "Which additional input semantics are required?")],
    ]),
    onCheckpoint: async (task) => {
      if (!delayed && task.events.at(-1)?.text === "tool_execution_end: read") {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 7600));
        observedCheckpoint = true;
      }
    },
    onEvent: async (_task, event) => {
      if (event.text === "Requesting one structured final report")
        assert(observedCheckpoint);
    },
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Plan under a short allocation",
    limits: { ms: 10000, models: 40, tools: 100 },
  });
  const result = await runtime.run(task.id);
  assert.equal(result.status, "waiting_input");
  assert.equal(result.used.models, 2);
  assert.equal(result.used.tools, 2);
  assert(result.used.ms < 10000);
  assert.equal(result.plan, undefined);
});

test("owner cancellation at the planning handoff prevents any reporting call", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([
      ...Array.from({ length: 32 }, () => [
        { name: "read", arguments: { path: "sum.js" } },
      ]),
      [report("plan", "Unreachable")],
    ]),
    onEvent: async (task, event) => {
      if (event.text === "Requesting one structured final report")
        await runtime.cancel(task.id);
    },
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Plan then cancel",
  });
  const result = await runtime.run(task.id);
  assert.equal(result.status, "cancelled");
  assert.equal(result.used.models, 32);
  assert.equal(result.plan, undefined);
});

test("repeated prose-only endings pause after one finalization without granting approval", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([[], [], [], [report("plan", "Unreachable report")], []]),
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Plan a fixture fix",
  });
  const result = await runtime.run(task.id);
  assert.equal(result.status, "paused");
  assert.equal(result.used.models, 3);
  assert.equal(result.plan, undefined);
  assert.equal(result.approved, undefined);
});

test("exhausted model or tool allocations do not initiate a finalization call", async () => {
  for (const limits of [
    { models: 1, tools: 10 },
    { models: 10, tools: 1 },
  ]) {
    const f = await fixture();
    const runtime = new CodingRuntime({
      store: f.store,
      model: scripted(
        limits.models === 1
          ? [[]]
          : [[{ name: "read", arguments: { path: "sum.js" } }], []],
      ),
    });
    const task = await runtime.start({
      workspace: f.workspace,
      objective: "Plan a fixture fix",
      limits,
    });
    const result = await runtime.run(task.id);
    assert.equal(result.status, "paused");
    assert(
      !result.events.some(
        (e) => e.text === "Requesting one structured final report",
      ),
    );
  }
});

test("build finalization cannot dispatch a repeated write and cannot substitute for failing checks", async () => {
  const f = await fixture();
  const planning = new CodingRuntime({
    store: f.store,
    model: scripted([[report("plan", "Fix the fixture and verify it.")], []]),
  });
  const task = await planning.start({
    workspace: f.workspace,
    objective: "Fix a fixture",
    checks: ["node test.mjs"],
  });
  const plan = await planning.run(task.id);
  await planning.approve(task.id, plan.plan!.revision, plan.plan!.hash);
  const before = await readFile(join(f.workspace, "sum.js"), "utf8");
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([
      [],
      [
        {
          name: "write",
          arguments: {
            path: "sum.js",
            content: "export const sum = (a,b) => a+b;\n",
          },
        },
      ],
      [report("done", "A prose claim")],
      [],
    ]),
    executor: (t) => localExecutor(t.workspace, join(f.root, "tool-home")),
  });
  const result = await runtime.run(task.id);
  assert.equal(await readFile(join(f.workspace, "sum.js"), "utf8"), before);
  assert.equal(result.status, "paused");
  assert.equal(result.checks[0]?.exitCode, 1);
  assert.equal(
    result.events.filter(
      (e) => e.text === "Requesting one structured final report",
    ).length,
    1,
  );
});

for (const length of [7426, 9357, 32000])
  test(`full ${length}-character plan is durably accepted without a formatting retry`, async () => {
    const f = await fixture();
    const detail =
      "Complete required change: fix sum. ".padEnd(length - 20, "x") +
      "END OF COMPLETE PLAN";
    const runtime = new CodingRuntime({
      store: f.store,
      model: scripted([
        [
          {
            name: "report",
            arguments: { kind: "plan", summary: "s".repeat(401), detail },
          },
        ],
      ]),
    });
    const task = await runtime.start({
      workspace: f.workspace,
      objective: "Fix sum",
    });
    const result = await runtime.run(task.id);
    assert.equal(result.status, "waiting_approval");
    assert.equal(result.used.models, 1);
    assert.equal(result.plan?.text, detail);
    assert.equal(result.report?.version, 1);
    assert.match(result.report!.hash, /^[a-f0-9]{64}$/);
    assert.equal((await runtime.inspect(task.id)).report?.detail, detail);
    assert.equal(result.approved, undefined);
  });
test("oversize report failure is precise, retained, bounded and explicitly resumes formatting only", async () => {
  const f = await fixture();
  const tooLong = report("plan", "x".repeat(32001));
  const first = new CodingRuntime({
    store: f.store,
    model: scripted([[tooLong], [tooLong]]),
  });
  const task = await first.start({
    workspace: f.workspace,
    objective: "Fix sum",
  });
  const paused = await first.run(task.id);
  assert.equal(paused.status, "paused");
  assert.match(paused.summary, /32001.*32000/);
  assert.equal(paused.used.models, 2);
  assert.equal(paused.plan, undefined);
  const replacement = new CodingRuntime({
    store: f.store,
    model: scripted([
      [{ name: "read", arguments: { path: "sum.js" } }],
      [
        report(
          "plan",
          "Retained complete scope: fix sum and verify the existing test.",
        ),
      ],
    ]),
  });
  await replacement.resume(task.id);
  const recovered = await replacement.run(task.id);
  assert.equal(recovered.status, "waiting_approval");
  assert.equal(recovered.used.models, 4);
  assert.equal(recovered.reportFailure, undefined);
  assert.equal(recovered.approved, undefined);
});

test("approved long scope must be read completely before edits or completion", async () => {
  const f = await fixture();
  const detail = "Fix sum and pass the real test. ".padEnd(
    9357,
    "Complete owner requirement. ",
  );
  const planner = new CodingRuntime({
    store: f.store,
    model: scripted([[report("plan", detail)]]),
  });
  const task = await planner.start({
    workspace: f.workspace,
    objective: "Fix sum",
    checks: ["node test.mjs"],
  });
  const planned = await planner.run(task.id);
  await planner.approve(task.id, 1, planned.plan!.hash);
  const edit = {
    name: "edit",
    arguments: {
      path: "sum.js",
      edits: [{ oldText: "a - b", newText: "a + b" }],
    },
  };
  const builder = new CodingRuntime({
    store: f.store,
    model: scripted([
      [edit],
      [{ name: "read_document", arguments: { id: "approved_plan", page: 0 } }],
      [report("done", "Premature completion")],
      [{ name: "read_document", arguments: { id: "approved_plan", page: 1 } }],
      [{ name: "read_document", arguments: { id: "approved_plan", page: 2 } }],
      [edit],
      [report("done", "Complete approved change implemented.")],
    ]),
    executor: (t) => localExecutor(t.workspace, join(f.root, "home")),
  });
  const result = await builder.run(task.id);
  assert.equal(result.status, "completed");
  assert.equal(result.checks[0]?.exitCode, 0);
  const session = (await readFile(result.sessionFile!, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  const denied = session.filter(
    (e) => e.message?.role === "toolResult" && e.message.isError,
  );
  assert.equal(denied.length, 2);
  assert(
    denied.every((e) =>
      JSON.stringify(e.message.content).includes("Read all pages"),
    ),
  );
  assert.equal(result.plan!.text, detail);
});
