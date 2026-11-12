import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  symlink,
  mkdir,
  realpath,
} from "node:fs/promises";
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
import { tools } from "../src/tools.js";
import { documents } from "../src/documents.js";

function scripted(
  replies: Array<Array<{ name: string; arguments: Record<string, unknown> }>>,
  stopReason?: string | number,
  inspectPrompt?: (prompt: string) => void,
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
          inspectPrompt?.(
            _context.systemPrompt ??
              JSON.stringify(
                _context.messages.filter(
                  (message) => message.role === "system",
                ),
              ),
          );
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

test("a long approved scope is a task document, not a precondition for other tools", async () => {
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
  const prompts: string[] = [];
  const builder = new CodingRuntime({
    store: f.store,
    // Journal 182: unread pages of approved_plan no longer refuse edit, bash or report.
    model: scripted(
      [
        [
          {
            name: "edit",
            arguments: {
              path: "sum.js",
              edits: [{ oldText: "a - b", newText: "a + b" }],
            },
          },
        ],
        [report("done", "Complete approved change implemented.")],
      ],
      undefined,
      (prompt) => prompts.push(prompt),
    ),
    executor: (t) => localExecutor(t.workspace, join(f.root, "home")),
  });
  const result = await builder.run(task.id);
  assert.equal(result.status, "completed");
  assert.equal(result.checks[0]?.exitCode, 0);
  const session = (await readFile(result.sessionFile!, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  assert(
    !session.some((e) => e.message?.role === "toolResult" && e.message.isError),
  );
  assert(prompts[0]?.includes("Read every page of approved_plan"));
  assert.equal(result.plan!.text, detail);
});

// Regressions adapted from independent review counterexamples.
const docread = (page: number) => ({
  name: "read_document",
  arguments: { id: "approved_plan", page },
});
test("independent long-plan formatting recovery permits reference rereads and final report", async () => {
  const f = await fixture();
  const plan = "Repair sum only. ".padEnd(9357, "scope ");
  const planner = new CodingRuntime({
    store: f.store,
    model: scripted([[report("plan", plan)]]),
  });
  const task = await planner.start({
    workspace: f.workspace,
    objective: "Repair sum",
    checks: ["node --check sum.js"],
  });
  const p = await planner.run(task.id);
  await planner.approve(task.id, p.plan!.revision, p.plan!.hash);
  const bad = report("done", "x".repeat(32001));
  const builder = new CodingRuntime({
    store: f.store,
    model: scripted([[docread(0)], [bad], [bad]]),
    executor: (t) => localExecutor(t.workspace, join(f.root, "home")),
  });
  const failed = await builder.run(task.id);
  assert.equal(failed.status, "paused");
  assert(failed.reportFailure);
  const recoveryPrompts: string[] = [];
  const resumed = new CodingRuntime({
    store: f.store,
    model: scripted(
      [[docread(0)], [report("done", "Complete retained result")]],
      undefined,
      (prompt) => {
        recoveryPrompts.push(prompt);
      },
    ),
    executor: (t) => localExecutor(t.workspace, join(f.root, "home")),
  });
  await resumed.resume(task.id);
  const result = await resumed.run(task.id);
  assert.equal(result.status, "completed");
  assert.equal(result.checks[0]?.exitCode, 0);
  assert(
    recoveryPrompts.every((prompt) =>
      prompt.includes(
        "reading required immutable task documents with read_document are permitted",
      ),
    ),
    recoveryPrompts.map((p) => p.slice(-3000)).join("\n---\n"),
  );
});
test("independent truncated report is not classified as a definite formatting failure", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted(
      [
        [
          {
            name: "report",
            arguments: { kind: "plan", summary: "incomplete" },
          },
        ],
      ],
      "length",
    ),
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Repair sum",
  });
  const result = await runtime.run(task.id);
  assert.equal(result.status, "paused");
  assert.equal(result.reportFailure, undefined);
});

test("caller evidence survives clarification and four references coexist with an approved long plan", async () => {
  const f = await fixture();
  const referenceDocuments = [
    "approved_plan",
    "evidence_b",
    "evidence_c",
    "evidence_d",
  ].map((id) => ({ id, title: id, text: `Original evidence for ${id}` }));
  const reads = referenceDocuments.map(({ id }) => [
    { name: "read_document", arguments: { id, page: 0 } },
  ]);
  const first = new CodingRuntime({
    store: f.store,
    model: scripted([
      ...reads,
      [report("question", "Should sum handle zero?")],
    ]),
  });
  const task = await first.start({
    workspace: f.workspace,
    objective: "Fix sum",
    referenceDocuments,
    checks: ["node test.mjs"],
  });
  assert.equal((await first.run(task.id)).status, "waiting_input");
  const revised = await first.reply(task.id, 1, "Yes, sum must handle zero.");
  assert.deepEqual(revised.referenceDocuments, referenceDocuments);
  const detail = "Fix sum including zero. ".padEnd(9357, "Approved scope. ");
  const planner = new CodingRuntime({
    store: f.store,
    model: scripted([...reads, [report("plan", detail)]]),
  });
  const planned = await planner.run(task.id);
  assert.equal(planned.status, "waiting_approval");
  await planner.approve(task.id, planned.revision, planned.plan!.hash);
  const builder = new CodingRuntime({
    store: f.store,
    model: scripted([
      ...reads,
      ...[0, 1, 2].map((page) => [
        { name: "read_document", arguments: { id: "approved_plan_1", page } },
      ]),
      [
        {
          name: "edit",
          arguments: {
            path: "sum.js",
            edits: [{ oldText: "a - b", newText: "a + b" }],
          },
        },
      ],
      [
        report(
          "done",
          "Fixed sum against all original evidence and approved scope",
        ),
      ],
    ]),
    executor: (t) => localExecutor(t.workspace, join(f.root, "home")),
  });
  const result = await builder.run(task.id);
  assert.equal(result.status, "completed");
  assert.equal(result.checks[0]?.exitCode, 0);
  assert.deepEqual(result.referenceDocuments, referenceDocuments);
  assert.equal(result.plan!.text, detail);
});

test("configured checks use decreasing remaining task time beyond the interactive shell deadline", async () => {
  const f = await fixture();
  const commands = ["node --check sum.js", "node --check test.mjs"];
  const timeouts: number[] = [];
  const runtime = new CodingRuntime({
    store: f.store,
    model: scripted([
      [report("plan", "Inspect source syntax and run the configured checks.")],
      [report("done", "Source inspected; host checks remain authoritative.")],
    ]),
    executor: (task) => {
      const local = localExecutor(task.workspace, join(f.root, "home"));
      return async (command, signal, timeout, output) => {
        if (commands.includes(command)) timeouts.push(timeout);
        return local(command, signal, timeout, output);
      };
    },
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Verify syntax",
    checks: commands,
    limits: { ms: 900000, models: 10, tools: 10 },
  });
  const planned = await runtime.run(task.id);
  await runtime.approve(task.id, planned.plan!.revision, planned.plan!.hash);
  const approved = await f.store.get(task.id);
  approved.used.ms = 60000;
  await f.store.save(approved);
  const result = await runtime.run(task.id);
  assert.equal(result.status, "completed", result.summary);
  assert.equal(result.checks.length, 2);
  assert.equal(timeouts.length, 2);
  assert(timeouts[0]! > 120000 && timeouts[0]! < 840000);
  assert(timeouts[1]! < timeouts[0]!);
  assert(result.used.ms >= 60000);
});

// Journal 182: Pi's prompt, tool execution mode and bash timeout are used as shipped. These fail
// if a replaced prompt, a forced execution mode or a default command timeout comes back.
async function approvedBuild(
  f: Awaited<ReturnType<typeof fixture>>,
  ms?: number,
  referenceDocuments?: Array<{ id: string; title: string; text: string }>,
) {
  const planner = new CodingRuntime({
    store: f.store,
    model: scripted([[report("plan", "Fix sum and test it.")]]),
  });
  const task = await planner.start({
    workspace: f.workspace,
    objective: "Fix sum",
    checks: ["node test.mjs"],
    ...(ms ? { limits: { ms } } : {}),
    ...(referenceDocuments ? { referenceDocuments } : {}),
  });
  const plan = await planner.run(task.id);
  await planner.approve(task.id, 1, plan.plan!.hash);
  return task.id;
}
test("a build session runs Pi's own prompt, execution mode and bash as shipped", async () => {
  const f = await fixture();
  const id = await approvedBuild(f);
  const prompts: string[] = [];
  const built = await new CodingRuntime({
    store: f.store,
    model: scripted(
      [[report("done", "Nothing to change.")]],
      undefined,
      (prompt) => prompts.push(prompt),
    ),
    executor: (t) => localExecutor(t.workspace, join(f.root, "home")),
  }).run(id);
  assert.equal(built.report?.kind, "done");
  // Pi skips its tool list and tool rules when a custom prompt replaces its own.
  assert.match(prompts[0]!, /Use read to examine files instead of cat or sed/);
  assert.match(prompts[0]!, /- edit: /);
  assert.match(prompts[0]!, /Protected owner objective:/);
  const timeouts: Array<number | undefined> = [];
  const list = tools(
    await new Workspace(f.workspace).initialize(),
    "build",
    async (_command, _signal, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { exitCode: 0, output: "" };
    },
    () => {},
    async () => {},
  );
  const docs = documents([{ id: "notes", title: "Notes", text: "Synthetic" }]);
  for (const tool of [...list, docs.tool])
    assert.equal(tool.executionMode, undefined, tool.name);
  const bash = list.find((t) => t.name === "bash")!;
  await bash.execute(
    "b",
    { command: "true" },
    undefined,
    undefined,
    undefined as any,
  );
  assert.deepEqual(timeouts, [undefined]);
});
test("parallel tool calls overlap and checkpoints wait for the whole batch", async () => {
  const f = await fixture();
  // A task document registers the runtime's read_document wrapper; one sequential tool in the
  // batch would make Pi run every call of the message one at a time.
  const id = await approvedBuild(f, undefined, [
    { id: "notes", title: "Notes", text: "Synthetic evidence" },
  ]);
  let running = 0;
  let most = 0;
  const atCheckpoint: number[] = [];
  const built = await new CodingRuntime({
    store: f.store,
    model: scripted([
      [
        { name: "bash", arguments: { command: "sleep 0.4" } },
        { name: "read_document", arguments: { id: "notes", page: 0 } },
        { name: "bash", arguments: { command: "sleep 0.4" } },
      ],
      [report("done", "Ran two commands.")],
    ]),
    executor: (t) => {
      const execute = localExecutor(t.workspace, join(f.root, "home"));
      return async (...args) => {
        most = Math.max(most, ++running);
        try {
          return await execute(...args);
        } finally {
          running--;
        }
      };
    },
    onCheckpoint: async () => {
      atCheckpoint.push(running);
    },
  }).run(id);
  assert.equal(built.report?.kind, "done");
  assert.equal(most, 2);
  // One checkpoint before the batch, one after it, one at the end of the run.
  assert(atCheckpoint.length >= 3);
  assert(
    atCheckpoint.every((n) => n === 0),
    JSON.stringify(atCheckpoint),
  );
});
test("the run deadline kills a command that has no timeout", async () => {
  const f = await fixture();
  const id = await approvedBuild(f, 3000);
  const started = Date.now();
  const built = await new CodingRuntime({
    store: f.store,
    model: scripted([[{ name: "bash", arguments: { command: "sleep 60" } }]]),
    executor: (t) => localExecutor(t.workspace, join(f.root, "home")),
  }).run(id);
  assert.equal(built.status, "paused");
  assert(Date.now() - started < 15000);
});
test("grep is confined to the workspace and truncates like stock grep", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, ".env"), "NEEDLE=secret\n");
  await writeFile(join(f.workspace, ".env.local"), "NEEDLE=secret\n");
  await writeFile(join(f.workspace, ".git", "description"), "NEEDLE\n");
  await writeFile(
    join(f.workspace, "many.txt"),
    Array.from(
      { length: 300 },
      (_, i) => `NEEDLE ${i} ${"x".repeat(400)}`,
    ).join("\n"),
  );
  const grep = tools(
    await new Workspace(f.workspace).initialize(),
    "plan",
    undefined,
    () => {},
    async () => {},
  ).find((t) => t.name === "grep")!;
  const run = async (input: Record<string, unknown>) =>
    (
      await grep.execute(
        "g",
        { pattern: "NEEDLE", ...input },
        undefined,
        undefined,
        undefined as any,
      )
    ).content[0].text as string;
  const limited = await run({});
  assert.match(limited, /^many\.txt:1: NEEDLE 0 /);
  assert.match(limited, /100 matches limit reached/);
  assert(!/\.env|\.git/.test(limited));
  assert.match(await run({ limit: 1000 }), /50\.0KB limit reached/);
  await assert.rejects(run({ path: ".env" }));
  await assert.rejects(run({ path: "../" }));
});
test("the final-report phase adds a section to Pi's own prompt instead of replacing it", async () => {
  const f = await fixture();
  const prompts: string[] = [];
  const runtime = new CodingRuntime({
    store: f.store,
    // Prose instead of a report moves the run into the final-report phase.
    model: scripted(
      [[], [report("plan", "Fix sum and test it.")]],
      undefined,
      (prompt) => prompts.push(prompt),
    ),
  });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Fix sum",
  });
  const planned = await runtime.run(task.id);
  assert.equal(planned.status, "waiting_approval");
  const final = prompts.at(-1)!;
  // A forced replacement prompt is sent as one opaque text, without Pi's sections.
  assert.match(
    final,
    /"host_phase":"<host_phase>\\nHost workflow phase: final report/,
  );
  assert.match(final, /Use read to examine files instead of cat or sed/);
});
test("the command executor arms no timer when no timeout is given", async () => {
  const f = await fixture();
  const execute = localExecutor(f.workspace, join(f.root, "home"));
  const delays: Array<number | undefined> = [];
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: any, delay?: number, ...rest: any[]) => {
    delays.push(delay);
    return original(handler, delay, ...rest);
  }) as typeof setTimeout;
  try {
    const done = await execute("true", new AbortController().signal);
    assert.equal(done.exitCode, 0);
    assert.equal(done.timedOut, false);
  } finally {
    globalThis.setTimeout = original;
  }
  assert.deepEqual(
    delays.filter((d) => (d ?? 0) >= 1000),
    [],
  );
  const timed = await execute("sleep 5", new AbortController().signal, 50);
  assert.equal(timed.timedOut, true);
});
test("read returns an image as an image, not its bytes as text", async () => {
  const f = await fixture();
  // A valid 1x1 PNG.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(join(f.workspace, "pixel.png"), png);
  const read = tools(
    await new Workspace(await realpath(f.workspace)).initialize(),
    "plan",
    undefined,
    () => {},
    async () => {},
  ).find((t) => t.name === "read")!;
  const result = await read.execute(
    "r",
    { path: "pixel.png" },
    undefined,
    undefined,
    undefined as any,
  );
  const text = result.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");
  assert.match(text, /Read image file \[image\/png\]/);
  assert(!text.includes("PNG\r\n"));
  assert(!text.includes("IHDR"));
});
test("truncated bash output is readable from the run's output directory and removed after the run", async () => {
  const f = await fixture();
  const outputs = join(f.root, "outputs");
  await mkdir(outputs);
  await writeFile(join(f.root, "outside"), "not readable");
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = outputs;
  try {
    const list = tools(
      await new Workspace(await realpath(f.workspace)).initialize(),
      "build",
      localExecutor(f.workspace, join(f.root, "home")),
      () => {},
      async () => {},
      outputs,
    );
    const bash = list.find((t) => t.name === "bash")!;
    const read = list.find((t) => t.name === "read")!;
    const ran = await bash.execute(
      "b",
      { command: "seq 1 30000" },
      undefined,
      undefined,
      undefined as any,
    );
    const path = /Full output: ([^\]]+)\]/.exec(ran.content[0].text)![1]!;
    assert(path.startsWith(outputs + "/"));
    const full = await read.execute(
      "r",
      { path, offset: 29999 },
      undefined,
      undefined,
      undefined as any,
    );
    assert.match(full.content[0].text, /^29999\n30000/);
    for (const denied of [
      join(f.root, "outside"),
      join(outputs, "..", "outside"),
    ])
      await assert.rejects(
        read.execute(
          "r",
          { path: denied },
          undefined,
          undefined,
          undefined as any,
        ),
      );
    // Only read reaches the directory.
    const grep = list.find((t) => t.name === "grep")!;
    await assert.rejects(
      grep.execute(
        "g",
        { pattern: "1", path },
        undefined,
        undefined,
        undefined as any,
      ),
    );
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
  const id = await approvedBuild(f);
  const before = process.env.TMPDIR;
  const built = await new CodingRuntime({
    store: f.store,
    model: scripted([
      [{ name: "bash", arguments: { command: "seq 1 30000" } }],
      [report("done", "Printed a long sequence.")],
    ]),
    executor: (t) => localExecutor(t.workspace, join(f.root, "home")),
  }).run(id);
  assert.equal(built.report?.kind, "done");
  assert.equal(process.env.TMPDIR, before);
  await assert.rejects(readFile(join(f.store.path(id), "outputs", ".")));
  assert(!built.artifact?.files.some((file) => file.path.includes("pi-bash")));
});
test("concurrent saves of one task land in call order", async () => {
  const f = await fixture();
  const runtime = new CodingRuntime({ store: f.store, model: scripted([]) });
  const task = await runtime.start({
    workspace: f.workspace,
    objective: "Fix sum",
  });
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      f.store.save({ ...task, summary: `save ${i}` }),
    ),
  );
  assert.equal((await f.store.get(task.id)).summary, "save 39");
});
