import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  symlink,
  mkdir,
  realpath,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  type Context,
} from "@earendil-works/pi-ai";
import {
  CodingRuntime,
  TaskStore,
  Workspace,
  localExecutor,
  noReportAsk,
  reportDocument,
  reportReminder,
  type Executor,
  type ModelFactory,
} from "../src/index.js";
import { tools } from "../src/tools.js";

type Call = { name: string; arguments: Record<string, unknown> };
/**
 * A synthetic provider: each model call returns the next scripted batch of tool calls (an
 * empty batch is a prose answer). `seen` gets each request's system prompt and messages.
 */
function scripted(
  replies: Call[][],
  options: {
    stopReason?: string | number;
    seen?: (context: Context) => void;
  } = {},
): ModelFactory & { calls: () => number } {
  let index = 0;
  const factory = async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
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
      streamSimple(model, context) {
        const stream = createAssistantMessageEventStream();
        options.seen?.(structuredClone(context));
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
            typeof options.stopReason === "string"
              ? options.stopReason
              : index === options.stopReason
                ? "length"
                : calls.length
                  ? "toolUse"
                  : "stop",
          timestamp: Date.now(),
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
        });
        return stream;
      },
    });
    return { runtime, model: runtime.getModel("synthetic", "test")! };
  };
  return Object.assign(factory, { calls: () => index });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspace, ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(
    join(workspace, "sum.js"),
    "export const sum = (a, b) => a - b;\n",
  );
  await writeFile(
    join(workspace, "test.mjs"),
    "import assert from 'node:assert/strict';import {sum} from './sum.js';assert.equal(sum(2,3),5);\n",
  );
  await writeFile(join(workspace, "package.json"), '{"type":"module"}');
  git("add", ".");
  git("commit", "-qm", "Fixture");
  const base = git("rev-parse", "HEAD");
  const store = new TaskStore(
    join(root, "state"),
    "synthetic-state-key-32-characters",
  );
  const commands: string[] = [];
  const executor = (task: { workspace: string }): Executor => {
    const execute = localExecutor(task.workspace, join(root, "home"));
    return (command, ...rest) => {
      commands.push(command);
      return execute(command, ...rest);
    };
  };
  const runtime = (
    model: ModelFactory,
    extra: Partial<ConstructorParameters<typeof CodingRuntime>[0]> = {},
  ) => new CodingRuntime({ store, model, executor, ...extra });
  const coder = async (r: CodingRuntime) =>
    (await r.start({ workspace, role: "coder", base })).id;
  return { root, workspace, base, store, git, commands, runtime, coder };
}
const report = (kind: string, detail: string, extra = {}) => ({
  name: "report",
  arguments: { kind, summary: "Synthetic result", detail, ...extra },
});
const fix = {
  name: "edit",
  arguments: {
    path: "sum.js",
    edits: [{ oldText: "a - b", newText: "a + b" }],
  },
};
const texts = (context: Context) =>
  context.messages
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
    );

test("a coder session edits with Pi's tools; done carries the artifact and Chief runs no check", async () => {
  const f = await fixture();
  const model = scripted([[fix], [report("done", "Fixed and tested.")]]);
  const r = f.runtime(model);
  const done = await r.run(await f.coder(r), "Fix sum");
  assert.equal(done.status, "completed");
  assert.equal(done.report?.kind, "done");
  assert.equal(done.artifact?.base, f.base);
  assert.deepEqual(
    done.artifact?.files.map((file) => file.path),
    ["sum.js"],
  );
  assert(done.artifact?.patch.includes("a + b"));
  // The report ended the run through Pi's early termination: two calls, no third.
  assert.equal(model.calls(), 2);
  // Only git ran for the snapshot; no test, build or install command was run for the coder.
  assert(
    f.commands.every((c) => c.startsWith("'git'")),
    f.commands.join(),
  );
});

test("the candidate is the working tree against the base, even after the coder commits", async () => {
  const f = await fixture();
  const r = f.runtime(
    scripted([
      [fix],
      [
        {
          name: "bash",
          arguments: { command: "git commit -qam 'coder commit'" },
        },
      ],
      [report("done", "Committed the fix.")],
    ]),
  );
  const done = await r.run(await f.coder(r), "Fix sum");
  assert.notEqual(f.git("rev-parse", "HEAD"), f.base);
  assert.equal(done.artifact?.base, f.base);
  assert(done.artifact?.patch.includes("a + b"));
});

test("a later run continues the same session with its new message", async () => {
  const f = await fixture();
  const seen: Context[] = [];
  const r = f.runtime(
    scripted(
      [
        [report("done", "First attempt.")],
        [fix],
        [report("done", "Fixed after review.")],
      ],
      { seen: (c) => seen.push(c) },
    ),
  );
  const id = await f.coder(r);
  const first = await r.run(id, "Fix sum");
  assert.equal(first.status, "completed");
  const second = await r.run(
    id,
    "Independent review requested changes. Findings: sum still subtracts.",
  );
  assert.equal(second.status, "completed");
  assert.equal(second.sessionFile, first.sessionFile);
  assert.deepEqual(
    (await readdir(join(f.store.path(id), "session"))).filter((n) =>
      n.endsWith(".jsonl"),
    ).length,
    1,
  );
  assert.deepEqual(texts(seen.at(-1)!), [
    "Fix sum",
    "Independent review requested changes. Findings: sum still subtracts.",
  ]);
});

test("a run that ends without a report gets one reminder in the same session, then asks the owner", async () => {
  const f = await fixture();
  const seen: Context[] = [];
  const model = scripted([[], []], { seen: (c) => seen.push(c) });
  const r = f.runtime(model);
  const stopped = await r.run(await f.coder(r), "Fix sum");
  assert.equal(model.calls(), 2);
  assert.equal(texts(seen[1]!).at(-1), reportReminder);
  assert.equal(stopped.status, "waiting_input");
  assert.equal(stopped.question, noReportAsk("coder"));
  assert.equal(stopped.report, undefined);
  // After the reminder, a report completes normally.
  const g = await fixture();
  const reminded = g.runtime(scripted([[], [report("done", "Reported.")]]));
  assert.equal(
    (await reminded.run(await g.coder(reminded), "Fix sum")).status,
    "completed",
  );
});

test("truncated model output never counts as a report", async () => {
  const f = await fixture();
  const r = f.runtime(
    scripted([[report("done", "Cut off")], [], []], { stopReason: 1 }),
  );
  const result = await r.run(await f.coder(r), "Fix sum");
  assert.equal(result.status, "waiting_input");
  assert.equal(result.report, undefined);
});

test("an ask is one short question with up to three options; the error names what to shorten", async () => {
  const f = await fixture();
  const r = f.runtime(
    scripted([
      [
        {
          name: "report",
          arguments: {
            kind: "ask",
            summary: "Need a choice",
            ask: "x".repeat(301),
          },
        },
      ],
      [
        {
          name: "report",
          arguments: {
            kind: "ask",
            summary: "Need a choice",
            ask: "Which list should change?",
            options: ["Reading", "Watching", "Both", "Neither"],
          },
        },
      ],
      [
        {
          name: "report",
          arguments: {
            kind: "ask",
            summary: "Need a choice",
            ask: "Which list should change?",
            options: ["Reading", "Watching", "Both"],
            detail: "Both lists use the same component.",
          },
        },
      ],
    ]),
  );
  const asked = await r.run(await f.coder(r), "Fix the list");
  assert.equal(asked.status, "waiting_input");
  assert.equal(asked.question, "Which list should change?");
  assert.deepEqual(asked.options, ["Reading", "Watching", "Both"]);
  assert.throws(
    () => reportDocument({ kind: "ask", summary: "s", ask: "x".repeat(301) }),
    /ask has 301 characters; shorten it to at most 300/,
  );
  assert.throws(
    () =>
      reportDocument({
        kind: "ask",
        summary: "s",
        ask: "Which?",
        options: ["a", "b", "c", "d"],
      }),
    /at most 3/,
  );
  assert.throws(
    () =>
      reportDocument({
        kind: "ask",
        summary: "s",
        ask: "Which?",
        options: ["Short", "x".repeat(41)],
      }),
    /option 2 has 41 characters; each option is one line of at most 40 characters/,
  );
  assert.throws(
    () =>
      reportDocument({
        kind: "ask",
        summary: "s",
        ask: "Which?",
        options: ["two\nlines"],
      }),
    /one line/,
  );
  assert.throws(
    () =>
      reportDocument({ kind: "done", summary: "s".repeat(4001), detail: "d" }),
    /summary has 4001 characters; shorten it to at most 4000/,
  );
  assert.throws(
    () => reportDocument({ kind: "review", summary: "s", detail: "d" } as any),
    /verdict/,
  );
});

test("the reviewer cannot edit, and its review needs a verdict", async () => {
  const f = await fixture();
  const r = f.runtime(
    scripted([
      [
        {
          name: "write",
          arguments: { path: "sum.js", content: "tampered" },
        },
      ],
      [report("review", "Looks fine.")],
      [
        report("review", "Subtraction is a bug.", {
          verdict: "REQUEST_CHANGES",
        }),
      ],
    ]),
  );
  const id = (
    await r.start({ workspace: f.workspace, role: "reviewer", base: f.base })
  ).id;
  const reviewed = await r.run(id, "Review the candidate");
  assert.equal(reviewed.status, "completed");
  assert.equal(reviewed.report?.verdict, "REQUEST_CHANGES");
  assert.equal(reviewed.artifact, undefined);
  assert.match(await readFile(join(f.workspace, "sum.js"), "utf8"), /a - b/);
});

test("a message steered into a running session arrives at the next turn boundary", async () => {
  const f = await fixture();
  const seen: Context[] = [];
  let r!: CodingRuntime;
  let id = "";
  const steered: boolean[] = [];
  r = f.runtime(
    scripted(
      [
        [{ name: "bash", arguments: { command: "sleep 0.3" } }],
        [report("done", "Handled the follow-up.")],
      ],
      { seen: (c) => seen.push(c) },
    ),
    {
      executor: (task) => {
        const execute = localExecutor(task.workspace, join(f.root, "home"));
        return async (command, ...rest) => {
          if (command === "sleep 0.3")
            steered.push(
              await r.steer(id, "[inbox:1] From the owner: also handle zero"),
            );
          return execute(command, ...rest);
        };
      },
    },
  );
  id = await f.coder(r);
  assert.equal(await r.steer(id, "Not running"), false);
  const done = await r.run(id, "Fix sum");
  assert.deepEqual(steered, [true]);
  assert.equal(done.status, "completed");
  // Delivered after the tool batch, before the second model call.
  assert.equal(texts(seen[0]!).length, 1);
  assert.equal(
    texts(seen[1]!).at(-1),
    "[inbox:1] From the owner: also handle zero",
  );
  assert(
    (await readFile(done.sessionFile!, "utf8")).includes("also handle zero"),
  );
});

test("a follow-up steered in after a report reopens the work instead of keeping that report", async () => {
  const f = await fixture();
  let r!: CodingRuntime;
  let id = "";
  r = f.runtime(
    scripted([
      [
        report("done", "Done before the follow-up."),
        { name: "bash", arguments: { command: "sleep 0.3" } },
      ],
      [],
      [],
    ]),
    {
      executor: (task) => {
        const execute = localExecutor(task.workspace, join(f.root, "home"));
        return async (command, ...rest) => {
          if (command === "sleep 0.3")
            await r.steer(id, "From the owner: also handle zero");
          return execute(command, ...rest);
        };
      },
    },
  );
  id = await f.coder(r);
  const result = await r.run(id, "Fix sum");
  assert.equal(result.status, "waiting_input");
  assert.equal(result.report, undefined);
});

test("cancellation from another client stops the active command", async () => {
  const f = await fixture();
  const canceler = f.runtime(scripted([]));
  const r = f.runtime(
    scripted([
      [{ name: "bash", arguments: { command: "sleep 10" } }],
      [report("done", "Claims success")],
    ]),
    {
      onEvent: async (t, e) => {
        if (e.type === "tool" && e.text === "tool_execution_start: bash")
          await canceler.cancel(t.id);
      },
    },
  );
  const started = Date.now();
  const stopped = await r.run(await f.coder(r), "Fix sum");
  assert.equal(stopped.status, "cancelled");
  assert(Date.now() - started < 5000);
  await assert.rejects(r.run(stopped.id, "Again"), /cancelled/);
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

test("a restarted process finds an interrupted run paused, and a later run continues it", async () => {
  const f = await fixture();
  const r = f.runtime(scripted([[report("done", "Continued.")]]));
  const task = await r.start({
    workspace: f.workspace,
    role: "coder",
    base: f.base,
  });
  task.status = "running";
  task.runnerPid = 2 ** 22 + 12345;
  await f.store.save(task);
  const restored = await r.inspect(task.id);
  assert.equal(restored.status, "paused");
  assert.equal((await r.run(task.id, "Continue")).status, "completed");
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

test("private task storage cannot be inside the workspace, and the base must be a commit there", async () => {
  const f = await fixture();
  for (const dir of ["private", "..private"])
    await assert.rejects(
      new CodingRuntime({
        store: new TaskStore(
          join(f.workspace, dir),
          "synthetic-state-key-32-characters",
        ),
        model: scripted([]),
        executor: () => localExecutor(f.workspace, join(f.root, "home")),
      }).start({ workspace: f.workspace, role: "coder", base: f.base }),
      /disjoint/,
    );
  const r = f.runtime(scripted([]));
  await assert.rejects(
    r.start({ workspace: f.workspace, role: "coder", base: "f".repeat(40) }),
    /not in the workspace/,
  );
  await assert.rejects(
    r.start({ workspace: f.workspace, role: "coder", base: "HEAD" }),
    /full commit SHA/,
  );
});

test("task metadata tampering is refused", async () => {
  const f = await fixture();
  const r = f.runtime(scripted([]));
  const id = await f.coder(r);
  const path = join(f.store.path(id), "task.json");
  const envelope = JSON.parse(await readFile(path, "utf8"));
  const forged = JSON.parse(envelope.body);
  forged.status = "completed";
  envelope.body = JSON.stringify(forged);
  await writeFile(path, JSON.stringify(envelope));
  await assert.rejects(r.inspect(id), /integrity/);
});

test("indexed artifact rejects invalid UTF-8 rather than exporting replacement bytes", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, "bad.txt"), Buffer.from([0xff, 0xfe]));
  const w = await new Workspace(f.workspace).initialize();
  await assert.rejects(
    w.snapshot(
      localExecutor(f.workspace, join(f.root, "home")),
      new AbortController().signal,
      f.base,
    ),
    /UTF-8/,
  );
});

test("a coder session runs Pi's own prompt, execution mode and bash as shipped", async () => {
  const f = await fixture();
  const seen: Context[] = [];
  const r = f.runtime(
    scripted([[report("done", "Nothing to change.")]], {
      seen: (c) => seen.push(c),
    }),
  );
  const done = await r.run(await f.coder(r), "Fix sum");
  assert.equal(done.report?.kind, "done");
  const prompt =
    seen[0]!.systemPrompt ??
    JSON.stringify(seen[0]!.messages.filter((m) => m.role === "system"));
  // Pi skips its tool list and tool rules when a custom prompt replaces its own.
  assert.match(prompt, /Use read to examine files instead of cat or sed/);
  assert.match(prompt, /- edit: /);
  assert.match(prompt, /You are the coder of a Chief coding job/);
  // The request is a message, not part of the system prompt.
  assert(!prompt.includes("Fix sum"));
  const timeouts: Array<number | undefined> = [];
  const list = tools(
    await new Workspace(f.workspace).initialize(),
    "coder",
    async (_command, _signal, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { exitCode: 0, output: "" };
    },
    () => {},
  );
  for (const tool of list)
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
  let running = 0;
  let most = 0;
  const atCheckpoint: number[] = [];
  const r = f.runtime(
    scripted([
      [
        { name: "bash", arguments: { command: "sleep 0.4" } },
        { name: "read", arguments: { path: "sum.js" } },
        { name: "bash", arguments: { command: "sleep 0.4" } },
      ],
      [report("done", "Ran two commands.")],
    ]),
    {
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
    },
  );
  const done = await r.run(await f.coder(r), "Run things");
  assert.equal(done.report?.kind, "done");
  assert.equal(most, 2);
  // At each turn end (after the whole batch, and after the report) and at the end of the run.
  assert(atCheckpoint.length >= 3);
  assert(
    atCheckpoint.every((n) => n === 0),
    JSON.stringify(atCheckpoint),
  );
});

test("cancellation kills a command that has no timeout", async () => {
  const f = await fixture();
  let r!: CodingRuntime;
  r = f.runtime(
    scripted([[{ name: "bash", arguments: { command: "sleep 60" } }]]),
    {
      onEvent: async (t, e) => {
        if (e.text === "tool_execution_start: bash")
          setTimeout(() => void r.cancel(t.id), 200);
      },
    },
  );
  const started = Date.now();
  const stopped = await r.run(await f.coder(r), "Wait");
  assert.equal(stopped.status, "cancelled");
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
    "reviewer",
    localExecutor(f.workspace, join(f.root, "home")),
    () => {},
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
    "reviewer",
    localExecutor(f.workspace, join(f.root, "home")),
    () => {},
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
      "coder",
      localExecutor(f.workspace, join(f.root, "home")),
      () => {},
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
  const r = f.runtime(
    scripted([
      [{ name: "bash", arguments: { command: "seq 1 30000" } }],
      [report("done", "Printed a long sequence.")],
    ]),
  );
  const id = await f.coder(r);
  const before = process.env.TMPDIR;
  const done = await r.run(id, "Print");
  assert.equal(done.report?.kind, "done");
  assert.equal(process.env.TMPDIR, before);
  // stat, not readFile: reading a directory fails too, so only ENOENT proves it is gone.
  await assert.rejects(stat(join(f.store.path(id), "outputs")), {
    code: "ENOENT",
  });
  assert(!done.artifact?.files.some((file) => file.path.includes("pi-bash")));
});

test("the output directory is removed even when the final save fails", async () => {
  const f = await fixture();
  const r = f.runtime(
    scripted([
      [{ name: "bash", arguments: { command: "seq 1 30000" } }],
      [report("done", "Printed.")],
    ]),
  );
  const id = await f.coder(r);
  const save = f.store.save.bind(f.store);
  f.store.save = async (task) => {
    if (task.status === "completed" && task.runnerPid === undefined)
      throw new Error("Synthetic disk full");
    return save(task);
  };
  await assert.rejects(r.run(id, "Print"), /disk full/);
  await assert.rejects(stat(join(f.store.path(id), "outputs")), {
    code: "ENOENT",
  });
  // The lock was released, so the next run can start.
  f.store.save = save;
  assert.equal((await r.run(id, "Again")).status, "waiting_input");
});

test("concurrent saves of one task land in call order", async () => {
  const f = await fixture();
  const r = f.runtime(scripted([]));
  const task = await f.store.get(await f.coder(r));
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      f.store.save({ ...task, summary: `save ${i}` }),
    ),
  );
  assert.equal((await f.store.get(task.id)).summary, "save 39");
});

test("a long owner request is sent whole as the first message", async () => {
  const f = await fixture();
  const seen: Context[] = [];
  const r = f.runtime(
    scripted([[report("done", "Read it all.")]], {
      seen: (c) => seen.push(c),
    }),
  );
  const request = "Fix the fixture. " + "o".repeat(70000);
  await r.run(await f.coder(r), request);
  assert.deepEqual(texts(seen[0]!), [request]);
  await assert.rejects(r.run(await f.coder(r), " "), /needs a message/);
});

test("a save the host refuses at a turn end stops the run instead of working on unsaved", async () => {
  const f = await fixture();
  const model = scripted([[fix], [fix], [report("done", "Never reached.")]]);
  const r = f.runtime(model, {
    onCheckpoint: async () => {
      throw new Error("Worker attempt superseded");
    },
  });
  const stopped = await r.run(await f.coder(r), "Fix sum");
  assert.equal(stopped.status, "failed");
  assert.match(stopped.summary, /superseded/);
  assert.equal(model.calls(), 1);
});

test("a message handed over before the session exists arrives with the first prompt", async () => {
  const f = await fixture();
  const seen: Context[] = [];
  let r!: CodingRuntime;
  let id = "";
  const handed: boolean[] = [];
  r = f.runtime(
    scripted([[report("done", "Saw both.")]], { seen: (c) => seen.push(c) }),
    {
      onEvent: async (_t, e) => {
        if (e.type === "state" && e.text === "Running")
          handed.push(await r.steer(id, "Early owner note"));
      },
    },
  );
  id = await f.coder(r);
  await r.run(id, "Fix sum");
  assert.deepEqual(handed, [true]);
  assert.deepEqual(texts(seen[0]!), ["Fix sum", "Early owner note"]);
});
