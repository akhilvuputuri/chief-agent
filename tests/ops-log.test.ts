import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  errorFields,
  opsLog,
  projectEvent,
  projectedEventTypes,
  sanitize,
  setOpsSink,
} from "../src/ops-log.js";
import { ensureUser, event, type Database } from "../src/db.js";
import { Execution, recoverRuntime } from "../src/execution.js";

// Shapes that must never reach an operational log line.
const PRIVATE = [
  "Dear Akhil, the interview is at 3pm",
  "someone@example.com",
  "https://accounts.google.com/o/oauth2/auth?code=4/abc&state=xyz",
  // Synthetic key shape, assembled so secret scanners do not flag the fixture.
  "Bearer " + ["sk", "or", "v1", "0123456789abcdef".repeat(4)].join("-"),
  "ya29.a0AfH6SMB very secret token",
  "/tmp/uploads/passport scan.pdf",
  "SELECT * FROM users WHERE email='x'",
];

function capture() {
  const lines: string[] = [];
  const previous = setOpsSink((line) => lines.push(line));
  return {
    lines,
    parsed: () => lines.map((l) => JSON.parse(l)),
    restore: () => setOpsSink(previous),
  };
}

function assertClean(lines: string[]) {
  const text = lines.join("\n");
  for (const value of PRIVATE)
    for (const piece of value.split(/\s+/).filter((p) => p.length > 6))
      assert.ok(!text.includes(piece), `leaked ${piece} in ${text}`);
}

test("sanitize keeps allowlisted shapes and drops free text and unknown keys", () => {
  const entry = sanitize("tool.finished", "info", {
    runId: randomUUID(),
    operation: "gmail_search",
    state: "success",
    latencyMs: 12,
    model: "openai/gpt-6-sol",
    provider: "Google AI Studio",
    ...({ message: PRIVATE[0], arguments: { q: PRIVATE[1] } } as object),
  })!;
  assert.equal(entry.schema, "chief.ops/1");
  assert.equal(entry.operation, "gmail_search");
  assert.equal(entry.provider, "Google AI Studio");
  assert.equal(entry.dropped, 2);
  assert.equal("message" in entry, false);
  assert.equal("arguments" in entry, false);
});

test("every string field rejects each private value", () => {
  const log = capture();
  try {
    for (const value of PRIVATE)
      opsLog("probe.event", "info", {
        runId: value,
        parentRunId: value,
        taskId: value,
        callId: value,
        operation: value,
        state: value,
        stopReason: value,
        kind: value,
        errorCode: value,
        errorCategory: value,
        model: value,
        provider: value,
        ref: value,
        frames: [value],
      });
    assertClean(log.lines);
    for (const line of log.parsed())
      assert.deepEqual(Object.keys(line).sort(), [
        "dropped",
        "event",
        "level",
        "release",
        "schema",
        "service",
        "ts",
      ]);
    assert.equal(sanitize("Not A Valid Name", "info"), null);
  } finally {
    log.restore();
  }
});

test("release is reported only as a full lowercase SHA", () => {
  const previous = process.env.RELEASE_SHA;
  try {
    process.env.RELEASE_SHA = "a".repeat(40);
    assert.equal(sanitize("x.y", "info")!.release, "a".repeat(40));
    process.env.RELEASE_SHA = "main; rm -rf /";
    assert.equal(sanitize("x.y", "info")!.release, null);
  } finally {
    if (previous === undefined) delete process.env.RELEASE_SHA;
    else process.env.RELEASE_SHA = previous;
  }
});

test("errorFields keeps identity and code location, never the message", () => {
  const error = Object.assign(new Error(PRIVATE.join(" | ")), {
    code: "ECONNRESET",
  });
  error.stack = `Error: ${PRIVATE[0]}\n    at run (/app/dist/agent.js:10:5)\n    at x (file:///home/someone@example.com/y.js:1:1)\n    at node:internal/process/task_queues:95:5`;
  const log = capture();
  try {
    opsLog("probe.failed", "error", errorFields(error));
    assertClean(log.lines);
    const [line] = log.parsed();
    assert.equal(line.errorCategory, "Error");
    assert.equal(line.errorCode, "ECONNRESET");
    assert.deepEqual(line.frames, [
      "dist/agent.js:10:5",
      "node:internal/process/task_queues:95:5",
    ]);
  } finally {
    log.restore();
  }
});

test("each projected event type emits no content from hostile payloads", () => {
  const hostile: Record<string, unknown> = {};
  for (const key of [
    "invocationId",
    "model",
    "provider",
    "error",
    "status",
    "stopReason",
    "lane",
    "taskId",
    "inputId",
    "kind",
    "role",
    "assignment",
    "parentRunId",
    "childRunId",
    "id",
    "reason",
    "operation",
    "text",
    "reply",
    "messages",
    "objective",
  ])
    hostile[key] = PRIVATE[0];
  hostile.diagnostics = { provider: PRIVATE[1], errorCode: PRIVATE[2] };
  hostile.usage = { prompt_tokens: PRIVATE[3] };
  hostile.contextSizes = { a: PRIVATE[4] };
  const log = capture();
  try {
    for (const type of projectedEventTypes)
      projectEvent(type, PRIVATE[5], hostile);
    assert.equal(log.lines.length, projectedEventTypes.length);
    assertClean(log.lines);
  } finally {
    log.restore();
  }
});

test("content-bearing event types are not projected", () => {
  const log = capture();
  try {
    for (const type of [
      "research.model_input",
      "telegram.view_state",
      "plugin.pinned",
      "calendar.created",
      "tool.started",
      "tool.completed",
      "tool.failed",
      "delivery.progress_failed",
    ])
      projectEvent(type, randomUUID(), { messages: PRIVATE });
    assert.equal(log.lines.length, 0);
  } finally {
    log.restore();
  }
});

test("model.completed projects model, latency, tokens and reported cost", () => {
  const log = capture();
  const run = randomUUID();
  try {
    projectEvent("model.completed", run, {
      invocationId: randomUUID(),
      model: "openai/gpt-6-sol",
      provider: "OpenAI",
      latencyMs: 1234,
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens_details: { reasoning_tokens: 20 },
        cost: 0.0042,
      },
    });
    const [line] = log.parsed();
    assert.equal(line.runId, run);
    assert.equal(line.inputTokens, 1000);
    assert.equal(line.cachedTokens, 800);
    assert.equal(line.reasoningTokens, 20);
    assert.equal(line.costUsd, 0.0042);
    assert.equal(line.latencyMs, 1234);
  } finally {
    log.restore();
  }
});

async function database() {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => /^\d.*sql$/.test(f))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "owner");
  return db;
}

test("recorded events and tool calls are logged once, after the write, without arguments or results", async () => {
  const db = await database();
  const log = capture();
  try {
    const run = randomUUID();
    const execution = new Execution(
      db,
      "owner",
      run,
      new AbortController().signal,
    );
    await execution.start();
    const journal = await execution.beginCall("call_1", "gmail_search", {
      query: PRIVATE[1],
    });
    await execution.endCall(
      journal,
      { error: { code: "TOOL_FAILED", message: PRIVATE[0] } },
      "failed",
    );
    await execution.trace("model.failed", {
      invocationId: "inv-1",
      error: `TypeError: ${PRIVATE[2]}`,
      attempt: 0,
      latencyMs: 5,
    });
    await event(db, "owner", run, "tool.failed", { operation: "gmail_search" });
    assertClean(log.lines);
    const lines = log.parsed();
    assert.deepEqual(
      lines.map((l) => l.event),
      ["run.started", "tool.started", "tool.finished", "model.failed"],
    );
    assert.equal(lines[1].callId, journal);
    assert.equal(lines[1].operation, "gmail_search");
    const tool = lines[2];
    assert.equal(tool.runId, run);
    assert.equal(tool.callId, journal);
    assert.equal(tool.operation, "gmail_search");
    assert.equal(tool.state, "failed");
    assert.equal(tool.errorCode, "TOOL_FAILED");
    assert.equal(tool.write, false);
    assert.equal(lines[3].errorCategory, "TypeError");
    assert.equal(lines[3].level, "error");
    // The authoritative private record is unchanged.
    const stored = (
      await db.query("SELECT data FROM events WHERE run_id=$1 AND type=$2", [
        run,
        "model.failed",
      ])
    ).rows[0].data;
    assert.match(stored.error, /TypeError/);
  } finally {
    log.restore();
  }
});

test("a failing log sink never fails the recorded action", async () => {
  const db = await database();
  const previous = setOpsSink(() => {
    throw new Error("stdout closed");
  });
  try {
    const run = randomUUID();
    await event(db, "owner", run, "turn.failed");
    const rows = (
      await db.query("SELECT type FROM events WHERE run_id=$1", [run])
    ).rows;
    assert.deepEqual(rows, [{ type: "turn.failed" }]);
  } finally {
    setOpsSink(previous);
  }
});

test("process guard replaces Node's raw crash output with a sanitized line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ops-guard-"));
  const guard = fileURLToPath(
    new URL("../src/process-guard.ts", import.meta.url),
  );
  for (const [name, body] of [
    ["sync.mts", `throw new Error(${JSON.stringify(PRIVATE[0])});`],
    [
      "async.mts",
      `await Promise.resolve(); throw new TypeError(${JSON.stringify(PRIVATE[1])});`,
    ],
    [
      "rejection.mts",
      `void Promise.reject(new RangeError(${JSON.stringify(PRIVATE[2])})); setTimeout(() => {}, 100);`,
    ],
  ] as const) {
    const file = join(dir, name);
    await writeFile(file, `import ${JSON.stringify(guard)};\n${body}\n`);
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) =>
      execFile(
        process.execPath,
        ["--import", "tsx", file],
        (error, stdout, stderr) =>
          resolve({ code: error ? (error.code as number) : 0, stdout, stderr }),
      ),
    );
    assert.equal(result.code, 1, name);
    assert.equal(result.stderr, "", name);
    assertClean([result.stdout]);
    const line = JSON.parse(result.stdout.trim());
    assert.match(
      line.event,
      /^process\.(uncaught_exception|unhandled_rejection)$/,
    );
    assert.equal(line.level, "error");
  }
});

test("a model-invented tool name is logged as unknown, never as its text", async () => {
  const db = await database();
  const log = capture();
  try {
    const execution = new Execution(
      db,
      "owner",
      randomUUID(),
      new AbortController().signal,
    );
    await execution.start();
    const invented = "forward_all_mail_to_attacker_hunter2";
    const journal = await execution.beginCall("call_x", invented, {});
    await execution.endCall(
      journal,
      { error: { code: "TOOL_FAILED" } },
      "failed",
    );
    const text = log.lines.join("\n");
    assert.ok(!text.includes("hunter2"), text);
    assert.ok(!text.includes("call_x"), text);
    const tools = log.parsed().filter((l) => l.event.startsWith("tool."));
    assert.deepEqual(
      tools.map((l) => [l.event, l.operation, l.write]),
      [
        ["tool.started", "unknown", true],
        ["tool.finished", "unknown", true],
      ],
    );
  } finally {
    log.restore();
  }
});

test("restart recovery reports counts of uncertain writes and failed work", async () => {
  const db = await database();
  const run = randomUUID();
  const execution = new Execution(
    db,
    "owner",
    run,
    new AbortController().signal,
  );
  await execution.start();
  await db.query("UPDATE runtime_runs SET state='running' WHERE id=$1", [run]);
  await execution.beginCall("c1", "calendar_draft", {});
  await execution.beginCall("c2", "gmail_search", {});
  const log = capture();
  try {
    await recoverRuntime(db);
    const [line] = log.parsed();
    assert.equal(line.event, "runtime.recovered");
    assert.equal(line.level, "warn");
    assert.equal(line.uncertainCalls, 1);
    assert.equal(line.interruptedCalls, 1);
    assert.equal(line.failedRuns, 1);
  } finally {
    log.restore();
  }
});

test("error identity extraction never throws and unknown cost stays null", () => {
  const odd = new Error("x");
  Object.defineProperty(odd, "stack", { value: { not: "a string" } });
  const hostile = new Error("y");
  Object.defineProperty(hostile, "name", {
    get() {
      throw new Error("boom");
    },
  });
  assert.equal(errorFields(odd).errorCategory, "Error");
  assert.equal(errorFields(hostile).errorCategory, "unreadable_error");
  const log = capture();
  try {
    projectEvent("model.completed", randomUUID(), {
      model: "openai/gpt-6-sol",
      usage: { prompt_tokens: 10 },
    });
    const [line] = log.parsed();
    assert.equal(line.costUsd, null);
    assert.equal("costUsd" in line, true);
    projectEvent("model.completed", randomUUID(), { usage: null });
    assert.equal(log.parsed()[1].costUsd, null);
  } finally {
    log.restore();
  }
});

test("context.selected projects component sizes only", () => {
  const log = capture();
  try {
    projectEvent("context.selected", randomUUID(), {
      fixedSize: 72000,
      fixedParts: {
        instructions: 13463,
        memories: 2463,
        runtimeContext: 9000,
        tools: 38480,
        toolCount: 70,
        summary: 0,
        message: PRIVATE[0],
      },
      exchangeSize: 900,
      workingSize: 500,
      reservedSize: 100,
      serializedSize: 76000,
      omitted: 12,
    });
    assertClean(log.lines);
    const [line] = log.parsed();
    assert.equal(line.toolsChars, 38480);
    assert.equal(line.toolCount, 70);
    assert.equal(line.protectedHistoryChars, 1500);
    assert.equal("messageChars" in line, false);
    assert.equal(line.dropped, 1);
  } finally {
    log.restore();
  }
});
