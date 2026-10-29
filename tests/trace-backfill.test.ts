import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratedPGlite } from "./helpers/pglite.js";
import type { Database } from "../src/db.js";
import { Execution } from "../src/execution.js";
import { setOpsSink } from "../src/ops-log.js";
import {
  encode,
  runContent,
  runConversation,
  spanBytes,
  startTracing,
  stopTracing,
  type ExportSpan,
} from "../src/otel.js";
import {
  backfillEndpoint,
  buildBackfill,
  isoNs,
  main,
  parseRows,
  post,
  requests,
  runSpanId,
  runTraceId,
  spanBatches,
  type BackfillRow,
} from "../src/trace-backfill.js";

// All fixture data here is synthetic.

type OtlpSpan = ReturnType<
  typeof encode
>["resourceSpans"][0]["scopeSpans"][0]["spans"][0];

function collector() {
  const bodies: string[] = [];
  const post = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const spans = () =>
    bodies.flatMap(
      (body) =>
        JSON.parse(body).resourceSpans[0].scopeSpans[0].spans as OtlpSpan[],
    );
  return { post, bodies, spans };
}

const encoded = (spans: ExportSpan[]) =>
  encode(spans).resourceSpans[0]!.scopeSpans[0]!.spans as OtlpSpan[];

function attr(span: { attributes: OtlpSpan["attributes"] }, key: string) {
  const value = span.attributes.find((a) => a.key === key)?.value as
    Record<string, unknown> | undefined;
  if (!value) return undefined;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("boolValue" in value) return value.boolValue;
  if ("arrayValue" in value)
    return (
      value.arrayValue as { values: { stringValue: string }[] }
    ).values.map((v) => v.stringValue);
  return value.stringValue;
}

/** A span's identity within a trace, independent of its random or derived span ID. */
const identity = (span: OtlpSpan) =>
  `${span.name}|${attr(span, "chief.run_id") ?? attr(span, "chief.invocation_id") ?? ""}`;

const sql = async () =>
  (
    await readFile(
      new URL("../scripts/trace-backfill.sql", import.meta.url),
      "utf8",
    )
  )
    .replace(":'since'", "'2000-01-01T00:00:00Z'")
    .replace(":'until'", "'2100-01-01T00:00:00Z'");

test("backfilled spans equal what the live exporter sent for the same runs", async () => {
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner')");
  await db.query("INSERT INTO conversations(user_id) VALUES('owner')");
  const sink = collector();
  const restore = setOpsSink(() => undefined);
  startTracing({
    endpoint: "http://collector/v1/traces",
    intervalMs: 60_000,
    fetch: sink.post,
    captureContent: true,
  });
  try {
    const rootId = randomUUID();
    const message = "find a table for 2 tonight";
    const root = new Execution(
      db,
      "owner",
      rootId,
      new AbortController().signal,
    );
    await root.start();
    await db.query(
      "INSERT INTO conversation_inputs(id,user_id,run_id,message,metadata,state) VALUES($1,'owner',$2,$3,$4::jsonb,'completed')",
      [randomUUID(), rootId, message, JSON.stringify({ threadId: 7 })],
    );
    runConversation(rootId, "thread.7");
    runContent(rootId, message);
    const child = new Execution(
      db,
      "owner",
      randomUUID(),
      root.signal,
      { ms: 120000, models: 8, tools: 20 },
      root,
    );
    await child.start();
    await child.trace("agent.child_started", {
      parentRunId: rootId,
      type: "email",
    });
    const invocation = randomUUID();
    await child.trace("model.started", {
      invocationId: invocation,
      model: "anthropic/claude-x",
      attempt: 1,
      effort: "low",
    });
    await child.trace("model.completed", {
      invocationId: invocation,
      model: "anthropic/claude-x",
      requestedModel: "anthropic/claude-x",
      provider: "Claude Platform on AWS",
      usage: {
        prompt_tokens: 12000,
        completion_tokens: 300,
        cost: 0.0123,
        prompt_tokens_details: { cached_tokens: 9000, cache_write_tokens: 500 },
        completion_tokens_details: { reasoning_tokens: 120 },
      },
      finishReason: "tool_calls",
      latencyMs: 2345,
      effort: "low",
    });
    const failed = randomUUID();
    await child.trace("model.started", {
      invocationId: failed,
      model: "anthropic/claude-x",
      attempt: 2,
    });
    await child.trace("model.failed", {
      invocationId: failed,
      model: "anthropic/claude-x",
      diagnostics: {
        failureCode: "disconnected",
        provider: "Some New Provider",
      },
      transient: true,
      attempt: 2,
      latencyMs: 40,
    });
    const limited = await root.beginCall("call_1", "web_search", {
      query: "tables",
    });
    await root.endCall(
      limited,
      { error: { code: "RATE_LIMITED", message: "slow down" } },
      "failed",
    );
    const invented = await root.beginCall("call_2", "model_invented_tool", {
      query: "x",
    });
    await root.endCall(invented, { results: ["Olive Bistro, 7pm"] });
    await child.finish("answer");
    // The delivered reply the backfill uses as the root's output.
    const reply = {
      role: "assistant",
      content: "Olive Bistro has a table at 7pm.",
    };
    const hash = createHash("sha256")
      .update(JSON.stringify(reply))
      .digest("hex");
    await db.query(
      "INSERT INTO message_contents(user_id,hash,payload,characters) VALUES('owner',$1,$2::jsonb,10)",
      [hash, JSON.stringify(reply)],
    );
    const request = { role: "user", content: message };
    const requestHash = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    await db.query(
      "INSERT INTO message_contents(user_id,hash,payload,characters) VALUES('owner',$1,$2::jsonb,10)",
      [requestHash, JSON.stringify(request)],
    );
    await db.query(
      "INSERT INTO conversation_messages(user_id,ordinal,hash,run_id,delivery_state) VALUES('owner',1,$1,$2,'recorded'),('owner',2,$3,$2,'sent')",
      [requestHash, rootId, hash],
    );
    await db.query(
      "INSERT INTO conversation_contexts(user_id,run_id) VALUES('owner',$1)",
      [rootId],
    );
    await root.finish("answer");
    await stopTracing(1000);

    const rows = (await db.query(await sql())).rows.map(
      (row) => JSON.parse(row.j as string) as BackfillRow,
    );
    assert.equal(rows.length, 2);
    // The exchange live scoring would compare the next message with; children have none.
    const byRun = new Map(rows.map((r) => [r.run_id, r]));
    assert.deepEqual(byRun.get(rootId)!.context, {
      request: message,
      reply: "Olive Bistro has a table at 7pm.",
    });
    assert.equal(byRun.get(child.run)!.context, null);
    const live = sink.spans();
    // Two runs, two model calls, two tool calls.
    assert.equal(live.length, 6);
    const rebuilt = encoded(buildBackfill(rows, { content: true }).spans);
    assert.equal(rebuilt.length, live.length);
    assert.deepEqual(rebuilt.map(identity).sort(), live.map(identity).sort());
    // Not rebuilt: per-call model messages, and the root's output (the delivered reply here,
    // the run's last model output live).
    const skipped = (span: OtlpSpan) => (key: string) =>
      span.name.startsWith("chat ")
        ? key === "gen_ai.input.messages" || key === "gen_ai.output.messages"
        : span.name === "invoke_agent chief" &&
          key === "gen_ai.output.messages";
    const liveById = new Map(live.map((s) => [identity(s), s]));
    const rebuiltById = new Map(rebuilt.map((s) => [identity(s), s]));
    for (const span of rebuilt) {
      const original = liveById.get(identity(span))!;
      assert.equal(span.traceId, original.traceId, identity(span));
      assert.equal(span.kind, original.kind);
      assert.deepEqual(span.status, original.status, identity(span));
      const keep = (s: OtlpSpan) =>
        s.attributes.filter((a) => !skipped(s)(a.key));
      assert.deepEqual(keep(span), keep(original), identity(span));
      // The same tree: parents map to the same spans.
      const parentOf = (s: OtlpSpan, all: OtlpSpan[]) => {
        const parent = all.find((p) => p.spanId === s.parentSpanId);
        return parent ? identity(parent) : undefined;
      };
      assert.equal(parentOf(span, rebuilt), parentOf(original, live));
    }
    assert.equal(rebuilt[0]!.traceId, rootId.replace(/-/g, ""));
    const rootSpan = rebuiltById.get(`invoke_agent chief|${rootId}`)!;
    assert.equal(attr(rootSpan, "gen_ai.conversation.id"), "thread.7");
    assert.deepEqual(
      JSON.parse(attr(rootSpan, "gen_ai.output.messages") as string),
      [
        {
          role: "assistant",
          parts: [
            { type: "text", content: "Olive Bistro has a table at 7pm." },
          ],
        },
      ],
    );
    // Real timestamps: the model span lasts its latency, the tool span its call.
    const model = rebuilt.find(
      (s) => attr(s, "chief.invocation_id") === invocation,
    )!;
    assert.equal(
      BigInt(model.endTimeUnixNano) - BigInt(model.startTimeUnixNano),
      2_345_000_000n,
    );
    const call = (
      await db.query(
        "SELECT to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS s FROM runtime_calls WHERE id=$1",
        [limited],
      )
    ).rows[0].s as string;
    const tool = rebuilt.find((s) => s.name === "execute_tool web_search")!;
    assert.equal(tool.startTimeUnixNano, String(isoNs(call)));
  } finally {
    await stopTracing(0);
    setOpsSink(restore);
    await pg.close();
  }
});

// ---------------------------------------------------------------------------
// Synthetic rows.

const T0 = Date.parse("2026-09-10T08:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function row(id: string, overrides: Partial<BackfillRow> = {}): BackfillRow {
  return {
    run_id: id,
    user_id: "owner",
    task_id: null,
    state: "stopped",
    stop_reason: "answer",
    started_at: at(0),
    updated_at: at(2),
    stopped_at: at(1),
    stop_event_reason: "answer",
    failed_at: null,
    child_event: null,
    parent_run_id: null,
    child_type: null,
    model_events: [],
    calls: [],
    inputs: [],
    reply: null,
    context: null,
    ...overrides,
  };
}

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("children join their parent's trace through every ancestor; an orphan is its own root", () => {
  const rows = [
    row(uuid(1)),
    row(uuid(2), {
      child_event: "research.child_started",
      parent_run_id: uuid(1),
    }),
    row(uuid(3), {
      child_event: "agent.child_started",
      parent_run_id: uuid(2),
      child_type: "public-research/researcher",
    }),
    row(uuid(4), {
      child_event: "agent.child_started",
      parent_run_id: uuid(99), // started before the window
      child_type: "Not An Agent Name!",
      stop_event_reason: "failed",
    }),
  ];
  const spans = buildBackfill(rows).spans;
  const run = (n: number) =>
    spans.find((s) => s.attributes["chief.run_id"] === uuid(n))!;
  const rootTrace = uuid(1).replace(/-/g, "");
  assert.deepEqual(
    [1, 2, 3].map((n) => run(n).traceId),
    [rootTrace, rootTrace, rootTrace],
  );
  assert.equal(run(1).parentSpanId, undefined);
  assert.equal(run(2).parentSpanId, run(1).spanId);
  assert.equal(run(3).parentSpanId, run(2).spanId);
  assert.equal(run(2).name, "invoke_agent research");
  assert.equal(run(3).name, "invoke_agent public-research/researcher");
  // The orphan: its own trace and no parent span.
  assert.equal(run(4).traceId, uuid(4).replace(/-/g, ""));
  assert.equal(run(4).parentSpanId, undefined);
  assert.equal(run(4).name, "invoke_agent agent");
  assert.equal(run(4).error, true);
  assert.equal(run(4).attributes["error.type"], "failed");
  // Children carry no conversation; a root without an owner input neither.
  assert.ok(
    spans.every((s) => s.attributes["gen_ai.conversation.id"] === undefined),
  );
});

const modelEvents = (invocation: string) => [
  {
    type: "model.started",
    created_at: at(0.1),
    data: {
      invocationId: invocation,
      model: "m/x",
      attempt: 3,
      effort: "high",
    },
  },
  {
    type: "model.completed",
    created_at: "2026-09-10T08:00:20.123456+00:00",
    data: {
      invocationId: invocation,
      model: "m/x",
      requestedModel: "m/x",
      usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.5 },
      finishReason: "stop",
      latencyMs: 1500,
    },
  },
];

test("IDs are derived from Chief's IDs, so a rerun replaces instead of duplicating", () => {
  const rows = [
    row(uuid(1), {
      inputs: [
        { message: "hello", thread_id: null, received_at: at(0), ordinal: 1 },
      ],
      context: { request: "hello", reply: "Hi." },
      model_events: modelEvents("inv-1"),
      calls: [
        {
          id: uuid(50),
          call_id: "call_1",
          operation: "web_search",
          is_write: false,
          state: "success",
          arguments: { query: "x" },
          result: { ok: true },
          error_code: null,
          started_at: at(0.5),
          finished_at: at(0.6),
        },
      ],
    }),
    row(uuid(2), {
      started_at: at(5),
      stopped_at: at(6),
      inputs: [
        {
          message: "try again",
          thread_id: null,
          received_at: at(5),
          ordinal: 2,
        },
      ],
    }),
  ];
  const first = buildBackfill(rows);
  const second = buildBackfill(structuredClone(rows));
  assert.deepEqual(first, second);
  const hex = (key: string) =>
    createHash("sha256").update(key).digest("hex").slice(0, 16);
  const [run, model, tool] = first.spans;
  assert.equal(run!.traceId, "00000000000040008000000000000001");
  assert.equal(runTraceId(uuid(1)), run!.traceId);
  assert.equal(run!.spanId, hex(`run:${uuid(1)}`));
  assert.equal(model!.spanId, hex("model:inv-1"));
  assert.equal(tool!.spanId, hex(`call:${uuid(50)}`));
  assert.ok([model, tool].every((s) => s!.parentSpanId === run!.spanId));
  // Model span: ends at its event (microseconds kept), starts latencyMs earlier, with the
  // started event's attempt.
  assert.equal(model!.endNs, 1_789_027_220_123_456_000n);
  assert.equal(model!.endNs - model!.startNs, 1_500_000_000n);
  assert.equal(model!.attributes["chief.attempt"], 3);
  assert.equal(model!.attributes["agentwatch.usage.cost_usd"], 0.5);
  assert.equal(run!.attributes["gen_ai.conversation.id"], "thread.0");
  // The evaluation's time is the next message's arrival: stable across reruns.
  assert.equal(first.evaluations.length, 1);
  assert.equal(first.evaluations[0]!.timeNs, isoNs(at(5)));
  assert.equal(first.evaluations[0]!.spanId, run!.spanId);
});

const SECRET_KEY = "sk-abcdefghijklmnopqrstuvwx";
const contentRows = () => [
  row(uuid(1), {
    inputs: [
      {
        message: `log in to the portal, my key is ${SECRET_KEY}`,
        thread_id: 12,
        received_at: at(0),
        ordinal: 1,
      },
    ],
    reply: "Logged in to the portal.",
    context: {
      request: "log in to the portal",
      reply: "Logged in to the portal.",
    },
    model_events: modelEvents("inv-1"),
    calls: [
      {
        id: uuid(50),
        call_id: "call_1",
        operation: "web_read",
        is_write: false,
        state: "success",
        arguments: {
          raw: JSON.stringify({
            url: "https://portal.example",
            login: { user: "owner", password: "hunter2-plain" },
          }),
        },
        result: { page: `welcome back, token ${SECRET_KEY}` },
        error_code: null,
        started_at: at(0.5),
        finished_at: at(0.6),
      },
    ],
  }),
];

test("content is off by default; with --content it is attached and scrubbed", () => {
  const contentKeys = [
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
  ];
  const off = buildBackfill(contentRows());
  const offBody = JSON.stringify(encode(off.spans));
  for (const word of ["portal", "hunter2", SECRET_KEY, "Logged in"])
    assert.ok(!offBody.includes(word), word);
  for (const span of off.spans)
    for (const key of contentKeys)
      assert.equal(span.attributes[key], undefined);

  const on = buildBackfill(contentRows(), { content: true });
  const body = JSON.stringify(encode(on.spans));
  assert.ok(!body.includes("sk-abcdefghij"), "planted key exported");
  assert.ok(!body.includes("hunter2"), "nested password exported");
  const [run, model, tool] = on.spans;
  assert.deepEqual(
    JSON.parse(run!.attributes["gen_ai.input.messages"] as string),
    [
      {
        role: "user",
        parts: [
          {
            type: "text",
            content: "log in to the portal, my key is [REDACTED_CREDENTIAL]",
          },
        ],
      },
    ],
  );
  assert.deepEqual(
    JSON.parse(run!.attributes["gen_ai.output.messages"] as string),
    [
      {
        role: "assistant",
        parts: [{ type: "text", content: "Logged in to the portal." }],
      },
    ],
  );
  assert.deepEqual(
    JSON.parse(tool!.attributes["gen_ai.tool.call.arguments"] as string),
    {
      url: "https://portal.example",
      login: { user: "owner", password: "[REDACTED_CREDENTIAL]" },
    },
  );
  assert.ok(
    (tool!.attributes["gen_ai.tool.call.result"] as string).includes(
      "[REDACTED_CREDENTIAL]",
    ),
  );
  // Model calls' messages were never recorded, so model spans carry none.
  assert.equal(model!.attributes["gen_ai.input.messages"], undefined);
  assert.equal(model!.attributes["gen_ai.output.messages"], undefined);
});

test("turns are scored by the next owner message in the same thread within 6 hours", () => {
  let n = 0;
  const turn = (
    startMinutes: number,
    message: string,
    thread: number | null,
    reply = "Done.",
  ) =>
    row(uuid(++n), {
      started_at: at(startMinutes),
      stopped_at: at(startMinutes + 1),
      updated_at: at(startMinutes + 1),
      reply,
      context: { request: message, reply },
      inputs: [
        {
          message,
          thread_id: thread,
          received_at: at(startMinutes),
          ordinal: n,
        },
      ],
    });
  const rows = [
    turn(0, "book a table for 2 at Olive Bistro tonight", 7), // 1: redirected (retry)
    turn(30, "try again", 7), // 2: not redirected
    turn(60, "what is the weather in Lisbon tomorrow", 7), // 3: forward follows, no score
    turn(90, "[Forwarded message] try again", 7), // 4: next arrives after 7 hours
    turn(90 + 7 * 60, "remind me to call the dentist", 7), // 5: next is in another thread
    turn(90 + 7 * 60 + 5, "try again", 0), // 6: nothing follows in thread 0
    // A child and a background run have no owner input and are never scored.
    row(uuid(20), {
      child_event: "agent.child_started",
      parent_run_id: uuid(1),
    }),
    row(uuid(21), { started_at: at(31) }),
  ];
  const { evaluations, stats } = buildBackfill(rows);
  const runSpan = (k: number) =>
    buildBackfill(rows).spans.find(
      (s) => s.attributes["chief.run_id"] === uuid(k),
    )!;
  assert.deepEqual(
    evaluations.map((e) => ({ ...e })),
    [
      {
        traceId: runTraceId(uuid(1)),
        spanId: runSpan(1).spanId,
        timeNs: isoNs(at(30)),
        name: "user_redirected",
        value: true,
        label: "retry",
      },
      {
        traceId: runTraceId(uuid(2)),
        spanId: runSpan(2).spanId,
        timeNs: isoNs(at(60)),
        name: "user_redirected",
        value: false,
      },
    ],
  );
  assert.equal(stats.evaluationsTrue, 1);
  assert.equal(stats.evaluationsFalse, 1);
  assert.equal(runSpan(6).attributes["gen_ai.conversation.id"], "thread.0");
  assert.equal(runSpan(5).attributes["gen_ai.conversation.id"], "thread.7");
  assert.equal(runSpan(21).attributes["gen_ai.conversation.id"], undefined);
});

test("spans are sent in batches under the byte limit, at most 256 a request", () => {
  const big = (n: number): ExportSpan => ({
    traceId: "a".repeat(32),
    spanId: n.toString(16).padStart(16, "0"),
    name: `span ${n}`,
    kind: 1,
    startNs: 1n,
    endNs: 2n,
    attributes: { "gen_ai.tool.call.result": "x".repeat(30_000) },
  });
  const spans = Array.from({ length: 10 }, (_, i) => big(i + 1));
  const batches = spanBatches(spans, 100_000);
  assert.deepEqual(
    batches.map((b) => b.length),
    [3, 3, 3, 1],
  );
  assert.deepEqual(batches.flat(), spans);
  for (const batch of batches)
    assert.ok(batch.reduce((sum, s) => sum + spanBytes(s), 0) <= 100_000);
  // One span larger than the limit still goes, on its own.
  assert.deepEqual(
    spanBatches([big(1)], 1000).map((b) => b.length),
    [1],
  );
  const small = Array.from({ length: 600 }, (_, i) => ({
    ...big(i),
    attributes: {},
  }));
  assert.deepEqual(
    spanBatches(small).map((b) => b.length),
    [256, 256, 88],
  );

  const backfill = { ...buildBackfill([]), spans: small };
  const list = requests(backfill, {
    traces: "http://localhost:1/v1/traces",
    logs: "http://localhost:1/v1/logs",
  });
  assert.equal(list.length, 3);
  assert.ok(list.every((r) => r.url.endsWith("/v1/traces")));
});

test("only a local endpoint is accepted", async () => {
  assert.deepEqual(backfillEndpoint("http://localhost:14318"), {
    traces: "http://localhost:14318/v1/traces",
    logs: "http://localhost:14318/v1/logs",
  });
  assert.equal(
    backfillEndpoint("https://127.0.0.1:4318/").traces,
    "https://127.0.0.1:4318/v1/traces",
  );
  for (const bad of [
    "http://chief.example.com:4318",
    "http://10.0.0.5:4318",
    "http://localhost.example.com",
    "http://user:pw@localhost:4318",
    "ftp://localhost",
    "file:///tmp/x",
    "localhost:4318",
  ])
    assert.throws(() => backfillEndpoint(bad), /SSH tunnel/, bad);
  const dir = await mkdtemp(join(tmpdir(), "backfill-"));
  try {
    const file = join(dir, "rows.jsonl");
    await writeFile(
      file,
      "j\n" +
        contentRows()
          .map((r) => JSON.stringify(r))
          .join("\n"),
    );
    const never = (async () => {
      throw new Error("must not post");
    }) as typeof fetch;
    await assert.rejects(
      main(
        [file, "--endpoint", "http://203.0.113.9:4318"],
        () => undefined,
        never,
      ),
      /localhost/,
    );
    await assert.rejects(
      main(
        [file, "--endpoint", "http://203.0.113.9:4318", "--dry-run"],
        () => undefined,
        never,
      ),
      /localhost/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dry run prints counts only and posts nothing; a real run posts traces, then logs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backfill-"));
  try {
    const file = join(dir, "rows.jsonl");
    const rows = [
      ...contentRows(),
      row(uuid(2), {
        started_at: at(10),
        stopped_at: at(11),
        inputs: [
          {
            message: "try again with the portal",
            thread_id: 12,
            received_at: at(10),
            ordinal: 2,
          },
        ],
      }),
    ];
    // psql's unaligned output: a header line, then one JSON object per line.
    await writeFile(
      file,
      "j\n" + rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const printed: string[] = [];
    const never = (async () => {
      throw new Error("must not post");
    }) as typeof fetch;
    const summary = await main(
      [file, "--endpoint", "http://localhost:14318", "--content", "--dry-run"],
      (line) => printed.push(line),
      never,
    );
    assert.equal(printed.length, 1);
    for (const word of ["portal", "hunter2", "sk-", "Logged", "try again"])
      assert.ok(!printed[0]!.includes(word), word);
    assert.deepEqual(JSON.parse(printed[0]!), summary);
    assert.equal(summary.runs, 2);
    assert.equal(summary.spans, 4);
    assert.equal(summary.modelCalls, 1);
    assert.equal(summary.toolCalls, 1);
    assert.equal(summary.evaluationsTrue, 1);
    assert.equal(summary.evaluationsFalse, 0);
    assert.equal(summary.posted, false);
    assert.ok(summary.bytes > 0);

    const urls: string[] = [];
    const ok = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const posted = await main(
      [file, "--endpoint", "http://127.0.0.1:14318/", "--until", at(5)],
      () => undefined,
      ok,
    );
    // --until drops the second run, and with it the evaluation.
    assert.equal(posted.runs, 1);
    assert.deepEqual(urls, ["http://127.0.0.1:14318/v1/traces"]);
    urls.length = 0;
    await main(
      [file, "--endpoint", "http://127.0.0.1:14318"],
      () => undefined,
      ok,
    );
    assert.deepEqual(urls, [
      "http://127.0.0.1:14318/v1/traces",
      "http://127.0.0.1:14318/v1/logs",
    ]);
    const failing = (async () =>
      new Response("no", { status: 500 })) as typeof fetch;
    await assert.rejects(
      main(
        [file, "--endpoint", "http://localhost:1"],
        () => undefined,
        failing,
      ),
      /HTTP 500/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rows are read from psql output, and anything else is refused", () => {
  const one = JSON.stringify(row(uuid(1)));
  assert.equal(parseRows(`j\n${one}\n\n`).length, 1);
  assert.throws(
    () => parseRows(`j\nERROR:  relation does not exist\n`),
    /not a row/,
  );
  assert.throws(() => parseRows(`{"run_id":`), /not valid JSON/);
  assert.equal(
    isoNs("2026-10-29T15:00:00.000001+00:00"),
    1_793_286_000_000_001_000n,
  );
  assert.equal(isoNs("2026-10-29T23:00:00+08:00"), 1_793_286_000_000_000_000n);
});

test("the query caps the scored exchange, drops huge payloads and skips turns with pending messages", async () => {
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  try {
    await db.query("INSERT INTO users(id) VALUES('owner')");
    await db.query("INSERT INTO conversations(user_id) VALUES('owner')");
    let ordinal = 0;
    const message = async (run: string, payload: object, state = "sent") => {
      const text = JSON.stringify(payload);
      const hash = createHash("sha256").update(text).digest("hex");
      await db.query(
        "INSERT INTO message_contents(user_id,hash,payload,characters) VALUES('owner',$1,$2::jsonb,$3) ON CONFLICT DO NOTHING",
        [hash, text, text.length],
      );
      await db.query(
        "INSERT INTO conversation_messages(user_id,ordinal,hash,run_id,delivery_state) VALUES('owner',$1,$2,$3,$4)",
        [++ordinal, hash, run, state],
      );
    };
    const turn = async (minutes: number, input: string) => {
      const id = randomUUID();
      await db.query(
        "INSERT INTO runtime_runs(id,user_id,state,stop_reason,started_at,updated_at) VALUES($1,'owner','stopped','answer',$2,$3)",
        [id, at(minutes), at(minutes + 1)],
      );
      await db.query(
        "INSERT INTO conversation_inputs(id,user_id,run_id,message,metadata,state,received_at) VALUES($1,'owner',$2,$3,'{\"threadId\":7}','completed',$4)",
        [randomUUID(), id, input, at(minutes)],
      );
      await db.query(
        "INSERT INTO conversation_contexts(user_id,run_id) VALUES('owner',$1)",
        [id],
      );
      return id;
    };
    const longRequest = "please find a quiet table near the river ".repeat(80);
    const longReply = "Booked the table by the window. ".repeat(200);
    const first = await turn(0, longRequest);
    await message(first, { role: "user", content: longRequest }, "recorded");
    await message(first, { role: "assistant", content: longReply });
    const huge = { page: "x".repeat(1_100_000) };
    await db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result,finished_at) VALUES($1,$2,'c1','web_read','{\"url\":\"https://a.example\"}',false,'success',$3::jsonb,now())",
      [randomUUID(), first, JSON.stringify(huge)],
    );
    const second = await turn(10, "try again");
    await message(second, { role: "user", content: "try again" }, "recorded");
    // Not yet delivered: live would not use this exchange, so the next message scores nothing.
    await message(
      second,
      { role: "assistant", content: "Retrying." },
      "pending",
    );
    await turn(20, "try again");

    const rows = (await db.query(await sql())).rows.map(
      (r) => JSON.parse(r.j as string) as BackfillRow,
    );
    assert.equal(rows.length, 3);
    const [a, b, c] = rows as [BackfillRow, BackfillRow, BackfillRow];
    assert.equal(a.context!.request, longRequest.slice(0, 1500));
    assert.equal(a.context!.reply, longReply.slice(0, 2000));
    assert.equal(a.reply, longReply); // the root's output keeps more
    assert.equal(b.context, null);
    assert.deepEqual(c.context, { request: null, reply: null });
    assert.equal(a.calls[0]!.result, "[content omitted: too large]");
    assert.deepEqual(a.calls[0]!.arguments, { url: "https://a.example" });

    const backfill = buildBackfill(rows, { content: true });
    const tool = backfill.spans.find(
      (s) => s.name === "execute_tool web_read",
    )!;
    assert.equal(
      tool.attributes["gen_ai.tool.call.result"],
      "[content omitted: too large]",
    );
    // The first turn is redirected; the second, with a pending message, is not scored.
    assert.deepEqual(
      backfill.evaluations.map((e) => [e.spanId, e.value, e.label]),
      [[runSpanId(first), true, "retry"]],
    );
  } finally {
    await pg.close();
  }
});

test("a large result is scrubbed by key before it is cut", () => {
  const rows = contentRows();
  rows[0]!.calls[0]!.result = {
    session: { token: "plain-session-value-1234" },
    page: "lorem ipsum dolor sit amet ".repeat(2300), // about 62,000 characters
  };
  const tool = buildBackfill(rows, { content: true }).spans.find(
    (s) => s.name === "execute_tool web_read",
  )!;
  const result = tool.attributes["gen_ai.tool.call.result"] as string;
  assert.ok(!result.includes("plain-session-value"), "token exported");
  assert.ok(result.includes('"token":"[REDACTED_CREDENTIAL]"'));
  assert.ok(result.endsWith("… [cut]"));
});

test("a turn without a saved context is not scored; the next is judged by its own context", () => {
  const turn = (
    n: number,
    minutes: number,
    message: string,
    context: BackfillRow["context"],
  ) =>
    row(uuid(n), {
      started_at: at(minutes),
      stopped_at: at(minutes + 1),
      context,
      inputs: [{ message, thread_id: 3, received_at: at(minutes), ordinal: n }],
    });
  const rows = [
    turn(1, 0, "what's on today", null),
    // The input is short; the stored request it is compared with is the full one.
    turn(2, 10, "try again", {
      request: "book a table for 2 at Olive Bistro tonight please",
      reply: "Done.",
    }),
    turn(3, 20, "book table for 2 at Olive Bistro tonight", null),
  ];
  const { evaluations } = buildBackfill(rows);
  assert.deepEqual(
    evaluations.map((e) => [e.spanId, e.value, e.label]),
    [[runSpanId(uuid(2)), true, "rephrase"]],
  );
});

test("a redirect is refused, so content never follows it to another port", async () => {
  const received: string[] = [];
  const listen = (server: Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () =>
        resolve((server.address() as AddressInfo).port),
      ),
    );
  const target = createServer((req, res) => {
    received.push(req.url ?? "");
    res.end("{}");
  });
  const targetPort = await listen(target);
  let redirected = 0;
  const redirector = createServer((req, res) => {
    redirected++;
    req.resume();
    res.writeHead(307, {
      location: `http://127.0.0.1:${targetPort}${req.url}`,
    });
    res.end();
  });
  const port = await listen(redirector);
  try {
    const urls = backfillEndpoint(`http://127.0.0.1:${port}`);
    await assert.rejects(
      post([{ url: urls.traces, body: '{"resourceSpans":[]}' }]),
    );
    assert.equal(redirected, 1);
    assert.deepEqual(received, []);
  } finally {
    redirector.closeAllConnections();
    target.closeAllConnections();
    await new Promise((r) => redirector.close(r));
    await new Promise((r) => target.close(r));
  }
});
