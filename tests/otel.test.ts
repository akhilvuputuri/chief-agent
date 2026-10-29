import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedPGlite } from "./helpers/pglite.js";
import type { Database } from "../src/db.js";
import { Execution } from "../src/execution.js";
import { setOpsSink } from "../src/ops-log.js";
import {
  OtlpExporter,
  SpanKind,
  encode,
  encodeEvaluations,
  logsEndpoint,
  runConversation,
  runEvent,
  turnFeedback,
  startTracing,
  stopTracing,
  tracingEnabled,
  tracesEndpoint,
  type ExportSpan,
} from "../src/otel.js";

type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  status?: { code: number };
};

function collector() {
  const bodies: string[] = [];
  const logs: string[] = [];
  const post = (async (url: string | URL | Request, init?: RequestInit) => {
    (String(url).endsWith("/v1/logs") ? logs : bodies).push(String(init?.body));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const spans = () =>
    bodies.flatMap(
      (body) =>
        JSON.parse(body).resourceSpans[0].scopeSpans[0].spans as OtlpSpan[],
    );
  const evaluations = () =>
    logs.flatMap(
      (body) =>
        JSON.parse(body).resourceLogs[0].scopeLogs[0]
          .logRecords as OtlpLogRecord[],
    );
  return { post, bodies, logs, spans, evaluations };
}

type OtlpLogRecord = {
  timeUnixNano: string;
  eventName: string;
  traceId: string;
  spanId: string;
  attributes: { key: string; value: Record<string, unknown> }[];
};

function attr(span: OtlpSpan | OtlpLogRecord, key: string) {
  const value = span.attributes.find((a) => a.key === key)?.value;
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

const sample = (n: number): ExportSpan => ({
  traceId: "a".repeat(32),
  spanId: n.toString(16).padStart(16, "0"),
  name: `span ${n}`,
  kind: SpanKind.internal,
  startNs: 1_761_000_000_000_000_000n + BigInt(n),
  endNs: 1_761_000_000_000_000_100n + BigInt(n),
  attributes: {
    count: n,
    ratio: 0.5,
    flag: true,
    list: ["x"],
    gone: undefined,
  },
});

test("encode writes OTLP/JSON with hex IDs, string nanoseconds and typed values", () => {
  const document = encode(
    [{ ...sample(1), parentSpanId: "b".repeat(16), error: true }],
    "c".repeat(40),
  );
  const resource = document.resourceSpans[0]!.resource.attributes;
  assert.deepEqual(resource, [
    { key: "service.name", value: { stringValue: "chief" } },
    { key: "service.version", value: { stringValue: "c".repeat(40) } },
  ]);
  const span = document.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  assert.equal(span.traceId, "a".repeat(32));
  assert.equal(span.parentSpanId, "b".repeat(16));
  assert.equal(span.startTimeUnixNano, "1761000000000000001");
  assert.deepEqual(span.status, { code: 2 });
  assert.deepEqual(span.attributes, [
    { key: "count", value: { intValue: "1" } },
    { key: "ratio", value: { doubleValue: 0.5 } },
    { key: "flag", value: { boolValue: true } },
    { key: "list", value: { arrayValue: { values: [{ stringValue: "x" }] } } },
  ]);
});

test("tracesEndpoint reads the standard variables and refuses unsafe URLs", () => {
  assert.equal(tracesEndpoint({}), undefined);
  assert.equal(
    tracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/" }),
    "http://127.0.0.1:4318/v1/traces",
  );
  assert.equal(
    tracesEndpoint({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://ignored:1",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/custom",
    }),
    "http://collector:4318/custom",
  );
  assert.throws(() =>
    tracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "file:///tmp" }),
  );
  assert.throws(() =>
    tracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://user:pw@host:4318" }),
  );
});

test("the exporter batches, drops overflow and never throws when the collector is down", async () => {
  const lines: string[] = [];
  const restore = setOpsSink((line) => lines.push(line));
  try {
    const ok = collector();
    const exporter = new OtlpExporter({
      endpoint: "http://collector/v1/traces",
      batchSize: 2,
      maxQueue: 10,
      intervalMs: 60_000,
      fetch: ok.post,
    });
    for (let n = 1; n <= 5; n++) exporter.enqueue(sample(n));
    await exporter.flush();
    await exporter.shutdown();
    assert.deepEqual(
      ok.spans().map((s) => s.name),
      ["span 1", "span 2", "span 3", "span 4", "span 5"],
    );

    const down = new OtlpExporter({
      endpoint: "http://collector/v1/traces",
      maxQueue: 2,
      intervalMs: 60_000,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    for (let n = 1; n <= 4; n++) down.enqueue(sample(n));
    await down.flush();
    assert.equal(down.pending, 0);
    await down.shutdown();
    const reports = lines
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === "trace.export_dropped");
    // Reported at most once a minute, and once more at shutdown for what built up since.
    assert.equal(reports.length, 2);
    assert.equal(reports[0].abortedCount, 1);
    assert.equal(reports[1].abortedCount, 1);
    assert.equal(reports[1].failedCount, 2);
  } finally {
    setOpsSink(restore);
  }
});

test("shutdown gives up on a collector that never answers", async () => {
  const exporter = new OtlpExporter({
    endpoint: "http://collector/v1/traces",
    intervalMs: 60_000,
    timeoutMs: 60_000,
    fetch: (() => new Promise(() => undefined)) as typeof fetch,
  });
  exporter.enqueue(sample(1));
  const started = Date.now();
  await exporter.shutdown(50);
  assert.ok(Date.now() - started < 1000);
});

test("runs, model calls and tool calls become a span tree that matches the event journal", async () => {
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner')");
  const sink = collector();
  const restore = setOpsSink(() => undefined);
  startTracing({
    endpoint: "http://collector/v1/traces",
    intervalMs: 60_000,
    fetch: sink.post,
  });
  try {
    const rootId = randomUUID();
    const root = new Execution(
      db,
      "owner",
      rootId,
      new AbortController().signal,
    );
    await root.start();
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
    const call = await root.beginCall("call_1", "web_search", {
      raw: "private search words",
    });
    await root.endCall(
      call,
      { error: { code: "RATE_LIMITED", message: "private detail" } },
      "failed",
    );
    const invented = await root.beginCall("call_2", "model_invented_tool", {
      raw: "x",
    });
    await root.endCall(invented, { result: "private result" });
    await child.finish("answer");
    await root.finish("failed");
    await stopTracing(1000);

    const spans = sink.spans();
    const byName = new Map(spans.map((s) => [s.name, s]));
    const rootSpan = byName.get("invoke_agent chief")!;
    const childSpan = byName.get("invoke_agent email")!;
    const model = spans.find(
      (s) => attr(s, "chief.invocation_id") === invocation,
    )!;
    const tool = byName.get("execute_tool web_search")!;
    assert.ok(rootSpan && childSpan && model && tool);
    assert.ok(
      byName.get("execute_tool unknown"),
      "a model-invented tool name is not exported",
    );

    // One trace, rooted at the turn's run ID.
    assert.equal(rootSpan.traceId, rootId.replace(/-/g, ""));
    assert.ok(spans.every((s) => s.traceId === rootSpan.traceId));
    assert.equal(rootSpan.parentSpanId, undefined);
    assert.equal(childSpan.parentSpanId, rootSpan.spanId);
    assert.equal(model.parentSpanId, childSpan.spanId);
    assert.equal(tool.parentSpanId, rootSpan.spanId);
    assert.deepEqual(rootSpan.status, { code: 2 });
    assert.equal(attr(rootSpan, "chief.stop_reason"), "failed");
    assert.equal(attr(childSpan, "gen_ai.agent.name"), "email");

    // Model figures equal what the event journal recorded.
    const recorded = (
      await db.query(
        "SELECT data FROM events WHERE type='model.completed' AND data->>'invocationId'=$1",
        [invocation],
      )
    ).rows[0].data;
    assert.equal(
      attr(model, "gen_ai.usage.input_tokens"),
      recorded.usage.prompt_tokens,
    );
    assert.equal(
      attr(model, "gen_ai.usage.output_tokens"),
      recorded.usage.completion_tokens,
    );
    assert.equal(
      attr(model, "gen_ai.usage.cache_read.input_tokens"),
      recorded.usage.prompt_tokens_details.cached_tokens,
    );
    assert.equal(
      attr(model, "gen_ai.usage.cache_write.input_tokens"),
      recorded.usage.prompt_tokens_details.cache_write_tokens,
    );
    assert.equal(attr(model, "gen_ai.usage.reasoning.output_tokens"), 120);
    assert.equal(attr(model, "agentwatch.usage.cost_usd"), recorded.usage.cost);
    assert.equal(
      BigInt(model.endTimeUnixNano) - BigInt(model.startTimeUnixNano),
      BigInt(recorded.latencyMs) * 1_000_000n,
    );
    assert.deepEqual(attr(model, "gen_ai.response.finish_reasons"), [
      "tool_calls",
    ]);
    assert.equal(attr(model, "gen_ai.provider.name"), "openrouter");
    assert.equal(attr(model, "chief.upstream_provider"), "claude-aws");
    assert.equal(attr(model, "chief.attempt"), 1);
    assert.equal(model.kind, SpanKind.client);

    const failure = spans.find(
      (s) => attr(s, "chief.invocation_id") === failed,
    )!;
    assert.equal(failure.status?.code, 2);
    assert.equal(attr(failure, "error.type"), "disconnected");
    assert.equal(attr(failure, "chief.upstream_provider"), "other");
    assert.equal(attr(failure, "gen_ai.usage.input_tokens"), undefined);

    assert.equal(attr(tool, "error.type"), "RATE_LIMITED");
    assert.equal(attr(tool, "chief.tool.state"), "failed");
    assert.equal(attr(tool, "chief.tool.write"), false);

    // Metadata only: no arguments, results, error messages or provider text.
    const exported = sink.bodies.join("\n");
    for (const secret of ["private", "Some New Provider", "Claude Platform"])
      assert.ok(!exported.includes(secret), `exported spans contain ${secret}`);
  } finally {
    await stopTracing(0);
    setOpsSink(restore);
    await pg.close();
  }
});

test("with export stopped, hooks record and send nothing", async () => {
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner')");
  const restore = setOpsSink(() => undefined);
  const sink = collector();
  startTracing({
    endpoint: "http://collector/v1/traces",
    intervalMs: 60_000,
    fetch: sink.post,
  });
  await stopTracing(0);
  try {
    assert.equal(tracingEnabled(), false);
    const run = new Execution(
      db,
      "owner",
      randomUUID(),
      new AbortController().signal,
    );
    await run.start();
    const call = await run.beginCall("c", "web_search", {});
    await run.endCall(call, {});
    await run.finish("answer");
    assert.deepEqual(sink.bodies, []);
  } finally {
    setOpsSink(restore);
    await pg.close();
  }
});

test("nested children, HTTP failures and turns that fail before finishing", async () => {
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner')");
  const sink = collector();
  const restore = setOpsSink(() => undefined);
  startTracing({
    endpoint: "http://collector/v1/traces",
    intervalMs: 60_000,
    fetch: sink.post,
  });
  try {
    const rootId = randomUUID();
    const root = new Execution(
      db,
      "owner",
      rootId,
      new AbortController().signal,
    );
    await root.start();
    const limits = { ms: 120000, models: 8, tools: 20 };
    const research = new Execution(
      db,
      "owner",
      randomUUID(),
      root.signal,
      limits,
      root,
    );
    await research.start();
    await research.trace("research.child_started", { parentRunId: rootId });
    const nested = new Execution(
      db,
      "owner",
      randomUUID(),
      root.signal,
      limits,
      research,
    );
    await nested.start();
    await nested.trace("agent.child_started", {
      parentRunId: research.run,
      type: "public-research/researcher",
    });
    const invocation = randomUUID();
    await nested.trace("model.started", {
      invocationId: invocation,
      model: "m/x",
    });
    await nested.trace("model.failed", {
      invocationId: invocation,
      model: "m/x",
      diagnostics: { httpStatus: 429 },
      transient: true,
      latencyMs: 5,
    });
    await nested.finish("failed");
    await research.finish("answer");
    // The turn's catch path stops the root run without Execution.finish.
    runEvent(rootId, "runtime.stopped", { stopReason: "failed" });
    await stopTracing(1000);

    const spans = sink.spans();
    const named = (name: string) => spans.find((s) => s.name === name)!;
    const rootSpan = named("invoke_agent chief");
    const researchSpan = named("invoke_agent research");
    const nestedSpan = named("invoke_agent public-research/researcher");
    const model = named("chat m/x");
    assert.equal(researchSpan.parentSpanId, rootSpan.spanId);
    assert.equal(nestedSpan.parentSpanId, researchSpan.spanId);
    assert.equal(model.parentSpanId, nestedSpan.spanId);
    assert.ok(spans.every((s) => s.traceId === rootSpan.traceId));
    assert.equal(attr(model, "error.type"), "429");
    assert.deepEqual(rootSpan.status, { code: 2 });
    // Successful spans leave the status unset.
    assert.equal(researchSpan.status, undefined);
  } finally {
    await stopTracing(0);
    setOpsSink(restore);
    await pg.close();
  }
});

test("logsEndpoint follows the logs, base and traces variables", () => {
  assert.equal(logsEndpoint({}), undefined);
  assert.equal(
    logsEndpoint({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://a/logs",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://b",
    }),
    "http://a/logs",
  );
  assert.equal(
    logsEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://b:4318/" }),
    "http://b:4318/v1/logs",
  );
  assert.equal(
    logsEndpoint({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c/v1/traces" }),
    "http://c/v1/logs",
  );
  // A traces URL with another path says nothing about where logs go.
  assert.equal(
    logsEndpoint({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c/collect" }),
    undefined,
  );
  assert.throws(() =>
    logsEndpoint({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://u:p@a/v1/logs" }),
  );
});

test("encodeEvaluations writes gen_ai.evaluation.result log records", () => {
  const document = encodeEvaluations([
    {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      timeNs: 1_761_000_000_000_000_000n,
      name: "user_redirected",
      value: true,
      label: "retry",
    },
  ]);
  const record = document.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
  assert.equal(record.eventName, "gen_ai.evaluation.result");
  assert.equal(record.traceId, "a".repeat(32));
  assert.equal(record.spanId, "b".repeat(16));
  assert.equal(record.timeUnixNano, "1761000000000000000");
  const typed = record as unknown as OtlpLogRecord;
  assert.equal(attr(typed, "event.name"), "gen_ai.evaluation.result");
  assert.equal(attr(typed, "gen_ai.evaluation.name"), "user_redirected");
  assert.equal(attr(typed, "gen_ai.evaluation.score.value"), true);
  assert.equal(attr(typed, "gen_ai.evaluation.score.label"), "retry");
});

test("the owner's next message scores the turn it follows, once", async (t) => {
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner')");
  const sink = collector();
  const restore = setOpsSink(() => undefined);
  startTracing({
    endpoint: "http://collector/v1/traces",
    logsEndpoint: "http://collector/v1/logs",
    intervalMs: 60_000,
    fetch: sink.post,
  });
  try {
    const turn = async () => {
      const run = new Execution(
        db,
        "owner",
        randomUUID(),
        new AbortController().signal,
      );
      await run.start();
      runConversation(run.run, "thread.7");
      return run;
    };
    const first = await turn();
    const child = new Execution(
      db,
      "owner",
      randomUUID(),
      first.signal,
      { ms: 120000, models: 8, tools: 20 },
      first,
    );
    await child.start();
    await child.finish("answer");
    await first.finish("answer");
    const second = await turn();
    await second.finish("answer");
    const third = await turn();
    await third.finish("answer");
    const late = await turn();
    await late.finish("answer");
    const passed = await turn();
    await passed.finish("answer");
    const background = new Execution(
      db,
      "owner",
      randomUUID(),
      new AbortController().signal,
    );
    await background.start(); // no conversation: a job, not a turn
    await background.finish("answer");

    turnFeedback(first.run, () => undefined); // a forward says nothing; the turn waits
    turnFeedback(first.run, () => "retry");
    turnFeedback(first.run, () => null); // a second message about the same turn
    turnFeedback(child.run, () => "retry"); // child runs are not turns
    turnFeedback(background.run, () => "retry");
    turnFeedback(randomUUID(), () => "retry"); // a turn this process never saw
    turnFeedback(second.run, () => null);
    turnFeedback(third.run, () => "not a label!"); // unexpected labels never leave
    // A reply to an older message: `passed` loses its chance to be scored.
    turnFeedback(randomUUID(), () => "retry", passed.run);
    turnFeedback(passed.run, () => null);
    turnFeedback(late.run, () => {
      throw new Error("never reaches the turn");
    });
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.now() + 6 * 3600_000 + 1000,
    });
    turnFeedback(late.run, () => "retry"); // past the feedback window
    t.mock.timers.reset();
    await stopTracing(1000);

    const roots = sink.spans().filter((s) => s.name === "invoke_agent chief");
    const rootOf = (run: Execution) =>
      roots.find((s) => attr(s, "chief.run_id") === run.run)!;
    assert.equal(attr(rootOf(first), "gen_ai.conversation.id"), "thread.7");
    const evaluations = sink.evaluations();
    assert.equal(evaluations.length, 3);
    const [redirected, kept, unlabelled] = evaluations as [
      OtlpLogRecord,
      OtlpLogRecord,
      OtlpLogRecord,
    ];
    assert.equal(redirected.traceId, rootOf(first).traceId);
    assert.equal(redirected.spanId, rootOf(first).spanId);
    assert.equal(attr(redirected, "gen_ai.evaluation.name"), "user_redirected");
    assert.equal(attr(redirected, "gen_ai.evaluation.score.value"), true);
    assert.equal(attr(redirected, "gen_ai.evaluation.score.label"), "retry");
    assert.equal(kept.spanId, rootOf(second).spanId);
    assert.equal(attr(kept, "gen_ai.evaluation.score.value"), false);
    assert.equal(attr(kept, "gen_ai.evaluation.score.label"), undefined);
    assert.equal(unlabelled.spanId, rootOf(third).spanId);
    assert.equal(attr(unlabelled, "gen_ai.evaluation.score.value"), true);
    assert.equal(attr(unlabelled, "gen_ai.evaluation.score.label"), undefined);
  } finally {
    t.mock.timers.reset();
    setOpsSink(restore);
    await pg.close();
  }
});

test("without a logs endpoint, feedback is not sent", async () => {
  const sink = collector();
  const exporter = new OtlpExporter({
    endpoint: "http://collector/v1/traces",
    intervalMs: 60_000,
    fetch: sink.post,
  });
  exporter.enqueueEvaluation({
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    timeNs: 1n,
    name: "user_redirected",
    value: true,
  });
  assert.equal(exporter.pending, 0);
  await exporter.shutdown(100);
  assert.deepEqual(sink.logs, []);
});
