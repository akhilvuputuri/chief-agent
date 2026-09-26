// Operational log projection: one allowlisted JSON object per stdout line.
// Postgres events remain the authoritative private record. These lines are
// shipped off-host (journald -> CloudWatch), so every field is validated against
// a narrow shape and anything else is dropped. Free text cannot pass: no field
// accepts arbitrary strings, and unknown keys are discarded.

export const OPS_LOG_SCHEMA = "chief.ops/1";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const NAME = /^[a-z][a-z0-9_.]{0,79}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/;
// Provider display names contain spaces ("Google AI Studio"): at most three
// short words from a small character set.
const PROVIDER =
  /^[A-Za-z0-9][A-Za-z0-9.()-]{0,24}(?: [A-Za-z0-9][A-Za-z0-9.()-]{0,24}){0,2}$/;
const FRAME = /^(dist\/[A-Za-z0-9_./-]+\.js|node:[A-Za-z0-9_./-]+):\d+:\d+$/;
const RELEASE = /^[0-9a-f]{40}$/;

type Level = "info" | "warn" | "error";
type Shape =
  "id" | "name" | "code" | "model" | "provider" | "count" | "number" | "bool";

const fields: Record<string, Shape> = {
  runId: "id",
  parentRunId: "id",
  childRunId: "id",
  taskId: "id",
  callId: "id",
  invocationId: "id",
  inputId: "id",
  approvalId: "id",
  ref: "id",
  operation: "name",
  state: "name",
  stopReason: "name",
  kind: "name",
  lane: "name",
  dependency: "name",
  phase: "name",
  errorCode: "code",
  errorCategory: "code",
  model: "model",
  provider: "provider",
  attempt: "count",
  latencyMs: "count",
  inputTokens: "count",
  outputTokens: "count",
  cachedTokens: "count",
  reasoningTokens: "count",
  messages: "count",
  characters: "count",
  httpStatus: "count",
  uptimeS: "count",
  rssMb: "count",
  fixedChars: "count",
  instructionsChars: "count",
  memoriesChars: "count",
  runtimeContextChars: "count",
  toolsChars: "count",
  toolCount: "count",
  summaryChars: "count",
  messageChars: "count",
  historyChars: "count",
  serializedChars: "count",
  omittedCount: "count",
  uncertainCalls: "count",
  interruptedCalls: "count",
  failedRuns: "count",
  pausedTasks: "count",
  failedInputs: "count",
  failedCount: "count",
  uncertainCount: "count",
  abortedCount: "count",
  costUsd: "number",
  transient: "bool",
  approved: "bool",
  write: "bool",
  interrupted: "bool",
};

// Written as null rather than omitted: an unknown charge stays visibly unknown.
const nullable = new Set(["costUsd"]);

export type OpsFields = Partial<Record<keyof typeof fields, unknown>> & {
  frames?: unknown;
};

function valid(shape: Shape, value: unknown) {
  switch (shape) {
    case "id":
      return typeof value === "string" && ID.test(value);
    case "name":
      return typeof value === "string" && NAME.test(value);
    case "code":
      return (
        (typeof value === "string" && CODE.test(value)) ||
        (typeof value === "number" && Number.isInteger(value))
      );
    case "model":
      return typeof value === "string" && MODEL.test(value);
    case "provider":
      return typeof value === "string" && PROVIDER.test(value);
    case "count":
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value < 1e12
      );
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
    case "bool":
      return typeof value === "boolean";
  }
}

let write: (line: string) => void = (line) => {
  process.stdout.write(line + "\n");
};

/** Replace the sink in tests. Returns the previous sink. */
export function setOpsSink(sink: (line: string) => void) {
  const previous = write;
  write = sink;
  return previous;
}

export function sanitize(event: string, level: Level, data: OpsFields = {}) {
  if (!NAME.test(event)) return null;
  const release = process.env.RELEASE_SHA;
  const entry: Record<string, unknown> = {
    schema: OPS_LOG_SCHEMA,
    ts: new Date().toISOString(),
    level,
    event,
    service: "chief-gateway",
    release: release && RELEASE.test(release) ? release : null,
  };
  let dropped = 0;
  for (const [key, value] of Object.entries(data)) {
    if (value === null && nullable.has(key)) {
      entry[key] = null;
      continue;
    }
    if (value === undefined || value === null) continue;
    if (key === "frames") {
      const frames = Array.isArray(value)
        ? value
            .filter((f) => typeof f === "string" && FRAME.test(f))
            .slice(0, 3)
        : [];
      if (frames.length) entry.frames = frames;
      else dropped++;
      continue;
    }
    const shape = fields[key];
    if (shape && valid(shape, value)) entry[key] = value;
    else dropped++;
  }
  if (dropped) entry.dropped = dropped;
  return entry;
}

/** Best effort: a logging failure never affects the caller. */
export function opsLog(event: string, level: Level, data: OpsFields = {}) {
  try {
    const entry = sanitize(event, level, data);
    if (entry) write(JSON.stringify(entry));
  } catch {
    /* Telemetry is not the action ledger. */
  }
}

/** Error identity without its message: class name, system code, code location. Never throws. */
export function errorFields(error: unknown): OpsFields {
  try {
    if (!(error instanceof Error)) return { errorCategory: "non_error" };
    const code = (error as { code?: unknown }).code;
    const stack = typeof error.stack === "string" ? error.stack : "";
    const frames = stack
      .split("\n")
      .slice(1)
      .map((line) => {
        const m = line.match(
          /((?:\/app\/)?dist\/[A-Za-z0-9_./-]+\.js:\d+:\d+)/,
        );
        if (m?.[1]) return m[1].replace(/^\/app\//, "");
        const n = line.match(/(node:[A-Za-z0-9_./-]+:\d+:\d+)/);
        return n?.[1];
      })
      .filter(Boolean);
    return {
      errorCategory: typeof error.name === "string" ? error.name : undefined,
      ...(typeof code === "string" || typeof code === "number"
        ? { errorCode: code }
        : {}),
      frames,
    };
  } catch {
    return { errorCategory: "unreadable_error" };
  }
}

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function usageFields(usage: unknown): OpsFields {
  if (!usage || typeof usage !== "object") return { costUsd: null };
  const u = usage as Record<string, any>;
  return {
    inputTokens: num(u.prompt_tokens),
    outputTokens: num(u.completion_tokens),
    cachedTokens: num(u.prompt_tokens_details?.cached_tokens),
    reasoningTokens: num(u.completion_tokens_details?.reasoning_tokens),
    costUsd: num(u.cost) ?? null,
  };
}

/** Prefix before ": " in the bounded model.failed error string, e.g. "TypeError". */
function errorName(value: unknown) {
  if (typeof value !== "string") return undefined;
  const name = value.split(":")[0] ?? "";
  return /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(name) ? name : undefined;
}

type Projection = (
  run: string,
  data: Record<string, any>,
) => [Level, OpsFields] | null;

// Only these recorded event types are projected, each to explicit fields.
// Tool outcomes are logged once from Execution.endCall, not from tool.* events.
const projections: Record<string, Projection> = {
  "model.completed": (run, d) => [
    "info",
    {
      runId: run,
      invocationId: d.invocationId,
      model: d.model,
      provider: d.provider,
      latencyMs: d.latencyMs,
      ...usageFields(d.usage),
    },
  ],
  "model.failed": (run, d) => [
    d.transient ? "warn" : "error",
    {
      runId: run,
      invocationId: d.invocationId,
      attempt: d.attempt,
      latencyMs: d.latencyMs,
      transient: d.transient,
      provider: d.diagnostics?.provider,
      errorCode: d.diagnostics?.errorCode,
      httpStatus: d.diagnostics?.httpStatus,
      state: d.diagnostics?.finishReason,
      phase: d.contextSizes ? "context" : "model",
      errorCategory: errorName(d.error),
    },
  ],
  "runtime.stopped": (run, d) => [
    d.stopReason === "failed" ? "error" : "info",
    { runId: run, stopReason: d.stopReason },
  ],
  "turn.failed": (run) => ["error", { runId: run }],
  // Sizes only, no content: lets the fixed envelope be measured per model call.
  "context.selected": (run, d) => [
    "info",
    {
      runId: run,
      fixedChars: d.fixedSize,
      instructionsChars: d.fixedParts?.instructions,
      memoriesChars: d.fixedParts?.memories,
      runtimeContextChars: d.fixedParts?.runtimeContext,
      toolsChars: d.fixedParts?.tools,
      toolCount: d.fixedParts?.toolCount,
      summaryChars: d.fixedParts?.summary,
      messageChars: d.fixedParts?.message,
      historyChars:
        typeof d.exchangeSize === "number" && typeof d.workingSize === "number"
          ? d.exchangeSize + d.workingSize + (d.reservedSize ?? 0)
          : undefined,
      serializedChars: d.serializedSize,
      omittedCount: d.omitted,
    },
  ],
  "context.over_budget": (run) => ["warn", { runId: run, phase: "context" }],
  "context.failed": (run) => ["error", { runId: run, phase: "context" }],
  "conversation.routed": (run, d) => [
    "info",
    { runId: run, lane: d.lane, taskId: d.taskId, inputId: d.inputId },
  ],
  "telegram.input_received": (run) => ["info", { inputId: run }],
  "telegram.delivered": (run, d) => [
    "info",
    { runId: run, kind: d.kind, messages: d.messages },
  ],
  "telegram.view_failed": (run) => ["warn", { ref: run }],
  "research.child_started": (run, d) => [
    "info",
    { runId: run, parentRunId: d.parentRunId, operation: d.role },
  ],
  "research.completed": (run, d) => [
    "info",
    {
      runId: run,
      childRunId: d.childRunId,
      state: d.status,
      stopReason: d.stopReason,
    },
  ],
  "research.failed": (run, d) => [
    "error",
    { runId: run, childRunId: d.childRunId },
  ],
  "media.processed": (run, d) => [
    "info",
    {
      runId: run,
      childRunId: d.childRunId,
      model: d.model,
      state: d.status,
      stopReason: d.stopReason,
    },
  ],
  "voice.transcribed": (run) => ["info", { ref: run }],
  "document.extracted": (run) => ["info", { ref: run }],
  "document.unreadable": (run) => ["warn", { ref: run }],
  "approval.decided": (_run, d) => [
    "info",
    { approvalId: d.id, state: d.status },
  ],
  "calendar.approval_decided": (run, d) => [
    "info",
    { runId: run, approvalId: d.id, approved: d.approved },
  ],
  "calendar.not_sent": (run, d) => [
    "warn",
    { runId: run, approvalId: d.id, errorCode: d.reason },
  ],
  "library.approval_decided": (run, d) => [
    "info",
    {
      runId: run,
      approvalId: d.id,
      operation: d.operation,
      approved: d.approved,
    },
  ],
};

/** Called after an events row is written. Unlisted types are not logged. */
export function projectEvent(
  type: string,
  run: string,
  data: Record<string, unknown>,
) {
  const projection = projections[type];
  if (!projection) return;
  try {
    const result = projection(run, data as Record<string, any>);
    if (result) opsLog(type, result[0], result[1]);
  } catch {
    /* Telemetry is not the action ledger. */
  }
}

export const projectedEventTypes = Object.keys(projections);
