// OpenTelemetry trace export (issue #323). Runs, model calls and tool calls become
// OTLP spans following the GenAI semantic conventions, sent as OTLP/HTTP JSON to a
// local collector such as agentwatch. Off unless an endpoint is configured.
//
// Spans carry metadata only: IDs, model and provider names, token counts, cost,
// latency, fixed outcome names and host-defined tool names. Never prompts, replies,
// tool arguments, tool results or error messages.
//
// Export never blocks or fails a turn: hooks only record in memory and enqueue, the
// queue is bounded (overflow is dropped and counted), and sending happens on a timer
// with a timeout. A collector that is down costs a log line a minute, nothing else.

import { randomBytes } from "node:crypto";
import { finishName, opsLog, providerName } from "./ops-log.js";

type AttributeValue = string | number | boolean | string[];
type Attributes = Record<string, AttributeValue | undefined>;

export interface ExportSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startNs: bigint;
  endNs: bigint;
  attributes: Attributes;
  error?: boolean;
}

// OTLP span kinds and status codes.
export const SpanKind = { internal: 1, client: 3 } as const;
type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];
const STATUS_ERROR = 2;

export interface ExporterOptions {
  endpoint: string;
  serviceVersion?: string;
  maxQueue?: number;
  batchSize?: number;
  intervalMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Batches spans and posts them as OTLP/HTTP JSON. Never throws to callers. */
export class OtlpExporter {
  private queue: ExportSpan[] = [];
  private sending?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private dropped = 0;
  private failed = 0;
  private lastReport = 0;
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly post: typeof fetch;

  constructor(private readonly options: ExporterOptions) {
    this.maxQueue = options.maxQueue ?? 4096;
    this.batchSize = options.batchSize ?? 256;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.post = options.fetch ?? fetch;
    this.timer = setInterval(
      () => void this.flush(),
      options.intervalMs ?? 2000,
    );
    this.timer.unref();
  }

  enqueue(span: ExportSpan) {
    if (this.queue.length >= this.maxQueue) {
      this.dropped++;
      this.report();
      return;
    }
    this.queue.push(span);
    // Deferred so encoding a batch never runs on the caller's (a turn's) stack.
    if (this.queue.length === this.batchSize)
      setImmediate(() => void this.flush());
  }

  /** Sends what is queued, one batch at a time. Resolves when the queue is empty or a send fails. */
  flush(): Promise<void> {
    if (this.sending) return this.sending;
    if (!this.queue.length) return Promise.resolve();
    this.sending = this.drain().finally(() => {
      this.sending = undefined;
    });
    return this.sending;
  }

  private async drain() {
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.batchSize);
      try {
        const response = await this.post(this.options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(encode(batch, this.options.serviceVersion)),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        // The body is unused; cancel it so the connection is released.
        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch {
        // Retrying would hold memory for a collector that may stay down; drop the batch.
        this.failed += batch.length;
        this.report();
        return;
      }
    }
  }

  private report(force = false) {
    if (!this.failed && !this.dropped) return;
    const now = Date.now();
    if (!force && now - this.lastReport < 60_000) return;
    this.lastReport = now;
    opsLog("trace.export_dropped", "warn", {
      failedCount: this.failed,
      abortedCount: this.dropped,
    });
    this.failed = 0;
    this.dropped = 0;
  }

  /** Stops the timer and sends what is queued, waiting at most `deadlineMs`. */
  async shutdown(deadlineMs = 1000) {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.flush(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      }),
    ]);
    clearTimeout(timer);
    this.report(true);
  }

  /** Spans waiting to be sent, for tests. */
  get pending() {
    return this.queue.length;
  }
}

/** OTLP/JSON: hex IDs, integer enums, 64-bit integers as decimal strings. */
export function encode(spans: ExportSpan[], serviceVersion?: string) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: keyValues({
            "service.name": "chief",
            "service.version": serviceVersion,
          }),
        },
        scopeSpans: [
          {
            scope: { name: "chief" },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: span.kind,
              startTimeUnixNano: String(span.startNs),
              endTimeUnixNano: String(span.endNs),
              attributes: keyValues(span.attributes),
              // Unset unless the span failed, as instrumentation should leave it.
              ...(span.error ? { status: { code: STATUS_ERROR } } : {}),
            })),
          },
        ],
      },
    ],
  };
}

function keyValues(attributes: Attributes) {
  return Object.entries(attributes).flatMap(([key, value]) =>
    value === undefined ? [] : [{ key, value: anyValue(value) }],
  );
}

function anyValue(value: AttributeValue): Record<string, unknown> {
  if (Array.isArray(value))
    return { arrayValue: { values: value.map((v) => ({ stringValue: v })) } };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return Number.isInteger(value)
    ? { intValue: String(value) }
    : { doubleValue: value };
}

/** Resolves the traces endpoint from the standard OTLP environment variables. */
export function tracesEndpoint(env: NodeJS.ProcessEnv = process.env) {
  const specific = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (specific) return httpUrl(specific);
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (base) return httpUrl(`${base.replace(/\/+$/, "")}/v1/traces`);
  return undefined;
}

function httpUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("OTLP traces endpoint must be an http(s) URL");
  if (url.username || url.password)
    throw new Error("OTLP traces endpoint must not contain credentials");
  return url.toString();
}

// ---------------------------------------------------------------------------
// Span assembly from Chief's run lifecycle. Execution calls these hooks.

interface RunState {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startNs: bigint;
  agent: string;
}
interface CallState {
  run: string;
  operation: string;
  write: boolean;
  startNs: bigint;
}
interface ModelState {
  run: string;
  attempt?: number;
}

// Runs that never stop (a crash, a lost process) must not grow these without bound.
const MAX_OPEN = 2000;
let exporter: OtlpExporter | undefined;
const runs = new Map<string, RunState>();
const calls = new Map<string, CallState>();
const models = new Map<string, ModelState>();

/** Starts exporting to `options.endpoint`. Returns the exporter for shutdown. */
export function startTracing(options: ExporterOptions) {
  exporter = new OtlpExporter(options);
  return exporter;
}

/** Stops exporting and forgets open spans. For shutdown and tests. */
export async function stopTracing(deadlineMs = 1000) {
  const current = exporter;
  exporter = undefined;
  runs.clear();
  calls.clear();
  models.clear();
  await current?.shutdown(deadlineMs);
}

export const tracingEnabled = () => exporter !== undefined;

const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const spanId = () => randomBytes(8).toString("hex");

function remember<T>(map: Map<string, T>, key: string, value: T) {
  if (map.size >= MAX_OPEN) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Run IDs are UUIDs; a root run's ID, without dashes, is its trace ID. */
function traceIdFor(run: string) {
  const hex = run.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) && !/^0+$/.test(hex)
    ? hex
    : randomBytes(16).toString("hex");
}

export function runStarted(run: string, parentRun?: string) {
  if (!exporter) return;
  try {
    startRun(run, parentRun);
  } catch {
    /* Tracing is not the action ledger. */
  }
}

function startRun(run: string, parentRun?: string) {
  const parent = parentRun ? runs.get(parentRun) : undefined;
  remember(runs, run, {
    traceId: parent?.traceId ?? traceIdFor(parentRun ?? run),
    spanId: spanId(),
    // A child whose parent span is unknown (process restarted) still joins the parent's trace.
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    startNs: nowNs(),
    agent: parentRun ? "agent" : "chief",
  });
}

export function runEvent(
  run: string,
  type: string,
  data: Record<string, unknown>,
  taskId?: string,
) {
  if (!exporter) return;
  try {
    switch (type) {
      case "agent.child_started": {
        const state = runs.get(run);
        if (state && typeof data.type === "string")
          state.agent = agentName(data.type);
        return;
      }
      case "research.child_started": {
        const state = runs.get(run);
        if (state) state.agent = "research";
        return;
      }
      case "model.started":
        if (typeof data.invocationId === "string")
          remember(models, data.invocationId, {
            run,
            ...(typeof data.attempt === "number"
              ? { attempt: data.attempt }
              : {}),
          });
        return;
      case "model.completed":
      case "model.failed":
        modelFinished(run, type === "model.failed", data);
        return;
      case "runtime.stopped":
        runStopped(
          run,
          typeof data.stopReason === "string" ? data.stopReason : "",
          taskId,
        );
        return;
    }
  } catch {
    /* Tracing is not the action ledger. */
  }
}

function modelFinished(
  run: string,
  failed: boolean,
  data: Record<string, unknown>,
) {
  const state = runs.get(run);
  if (!state || !exporter) return;
  const invocation =
    typeof data.invocationId === "string" ? data.invocationId : undefined;
  const started = invocation ? models.get(invocation) : undefined;
  if (invocation) models.delete(invocation);
  const end = nowNs();
  const latency = finiteCount(data.latencyMs);
  const start =
    latency === undefined ? end : end - BigInt(latency) * 1_000_000n;
  const requested = modelName(failed ? data.model : data.requestedModel);
  const served = failed ? undefined : modelName(data.model);
  const usage = failed
    ? undefined
    : (data.usage as Record<string, any> | null | undefined);
  const diagnostics = data.diagnostics as Record<string, unknown> | undefined;
  const finish = finishName(
    failed ? diagnostics?.finishReason : data.finishReason,
  );
  exporter.enqueue({
    traceId: state.traceId,
    spanId: spanId(),
    parentSpanId: state.spanId,
    name: `chat ${requested ?? served ?? "unknown"}`,
    kind: SpanKind.client,
    startNs: start,
    endNs: end,
    error: failed,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openrouter",
      "gen_ai.request.model": requested ?? served,
      "gen_ai.response.model": served,
      "gen_ai.usage.input_tokens": finiteCount(usage?.prompt_tokens),
      "gen_ai.usage.output_tokens": finiteCount(usage?.completion_tokens),
      "gen_ai.usage.cache_read.input_tokens": finiteCount(
        usage?.prompt_tokens_details?.cached_tokens,
      ),
      "gen_ai.usage.cache_write.input_tokens": finiteCount(
        usage?.prompt_tokens_details?.cache_write_tokens,
      ),
      "gen_ai.usage.reasoning.output_tokens": finiteCount(
        usage?.completion_tokens_details?.reasoning_tokens,
      ),
      "gen_ai.response.finish_reasons": finish ? [finish] : undefined,
      "agentwatch.usage.cost_usd": finiteNumber(usage?.cost),
      "error.type": failed ? failureType(data) : undefined,
      // OpenRouter's upstream provider, mapped to a fixed slug.
      "chief.upstream_provider": providerName(
        failed ? diagnostics?.provider : data.provider,
      ),
      "chief.attempt": started?.attempt ?? finiteCount(data.attempt),
      "chief.effort": nameValue(data.effort),
      "chief.invocation_id": invocation,
    },
  });
}

function runStopped(run: string, reason: string, taskId?: string) {
  const state = runs.get(run);
  if (!state || !exporter) return;
  runs.delete(run);
  exporter.enqueue({
    traceId: state.traceId,
    spanId: state.spanId,
    ...(state.parentSpanId ? { parentSpanId: state.parentSpanId } : {}),
    name: `invoke_agent ${state.agent}`,
    kind: SpanKind.internal,
    startNs: state.startNs,
    endNs: nowNs(),
    error: reason === "failed",
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": state.agent,
      "chief.run_id": run,
      "chief.task_id": taskId,
      "chief.stop_reason": nameValue(reason),
      "error.type": reason === "failed" ? "failed" : undefined,
    },
  });
}

export function callStarted(
  run: string,
  callId: string,
  operation: string,
  write: boolean,
) {
  if (!exporter) return;
  try {
    remember(calls, callId, { run, operation, write, startNs: nowNs() });
  } catch {
    /* Tracing is not the action ledger. */
  }
}

export function callFinished(
  callId: string,
  state: string,
  errorCode?: string,
) {
  if (!exporter) return;
  try {
    finishCall(callId, state, errorCode);
  } catch {
    /* Tracing is not the action ledger. */
  }
}

function finishCall(callId: string, state: string, errorCode?: string) {
  if (!exporter) return;
  const call = calls.get(callId);
  calls.delete(callId);
  const run = call ? runs.get(call.run) : undefined;
  if (!call || !run) return;
  const failed = state !== "success";
  exporter.enqueue({
    traceId: run.traceId,
    spanId: spanId(),
    parentSpanId: run.spanId,
    name: `execute_tool ${call.operation}`,
    kind: SpanKind.internal,
    startNs: call.startNs,
    endNs: nowNs(),
    error: failed,
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": call.operation,
      "gen_ai.tool.type": "function",
      "chief.tool.write": call.write,
      "chief.tool.state": nameValue(state),
      "error.type": failed
        ? (codeValue(errorCode) ?? nameValue(state))
        : undefined,
    },
  });
}

// Values that reach a span are host-defined or validated to a narrow shape, like the
// operational log (src/ops-log.ts), so no model- or user-written text is exported.
const NAME = /^[a-z][a-z0-9_.]{0,79}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/;
const AGENT = /^[a-z0-9][a-z0-9_.\/-]{0,79}$/;

const nameValue = (v: unknown) =>
  typeof v === "string" && NAME.test(v) ? v : undefined;
const codeValue = (v: unknown) =>
  typeof v === "string" && CODE.test(v) ? v : undefined;
const modelName = (v: unknown) =>
  typeof v === "string" && MODEL.test(v) ? v : undefined;
const agentName = (v: string) => (AGENT.test(v) ? v : "agent");
const finiteNumber = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const finiteCount = (v: unknown) => {
  const n = finiteNumber(v);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
};

function failureType(data: Record<string, unknown>) {
  const diagnostics = data.diagnostics as Record<string, unknown> | undefined;
  if (diagnostics) {
    // The semantic conventions use the HTTP status code, as a string, when that is all there is.
    const numeric = [diagnostics.errorCode, diagnostics.httpStatus].find(
      (v) => typeof v === "number" && Number.isInteger(v),
    );
    return (
      codeValue(diagnostics.failureCode) ??
      codeValue(diagnostics.errorCode) ??
      (numeric === undefined ? undefined : String(numeric)) ??
      "_OTHER"
    );
  }
  if (data.contextSizes) return "context_limit";
  const name =
    typeof data.error === "string" ? data.error.split(":")[0] : undefined;
  return codeValue(name) ?? "_OTHER";
}
