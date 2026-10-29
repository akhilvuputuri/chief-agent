// Trace backfill (issue #323, docs/tracing.md#backfilling-history): rebuilds the traces of
// runs from before live export started, from rows that scripts/trace-backfill.sql reads out
// of Chief's Postgres, and posts them to agentwatch as OTLP/JSON. Spans are built with the
// live exporter's own builders (src/otel.ts), so a backfilled trace looks like a live one.
// IDs are derived from Chief's own IDs, so posting the same rows again replaces the spans
// and scores instead of adding copies. Content only with --content, scrubbed as live.
//
//   npx tsx src/trace-backfill.ts <rows.jsonl> --endpoint http://localhost:14318 [--content] [--dry-run]

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { threadId } from "./delivery-routing.js";
import { logOperation } from "./execution.js";
import type { ModelMessage } from "./model.js";
import {
  BATCH_SIZE,
  FEEDBACK_WINDOW_MS,
  MAX_BATCH_BYTES,
  REDIRECT_EVALUATION,
  agentName,
  encode,
  encodeEvaluations,
  modelSpan,
  nextBatch,
  runSpan,
  toolSpan,
  type ExportEvaluation,
  type ExportSpan,
} from "./otel.js";
import {
  chatMessage,
  contentText,
  messagesJson,
  toolArguments,
  userMessageJson,
} from "./otel-content.js";
import { redirectOf } from "./turn-feedback.js";

/** One line of scripts/trace-backfill.sql output. Timestamps are ISO text. */
export interface BackfillRow {
  run_id: string;
  user_id: string;
  task_id: string | null;
  state: string | null;
  stop_reason: string | null;
  started_at: string;
  updated_at: string;
  stopped_at: string | null;
  stop_event_reason: string | null;
  failed_at: string | null;
  child_event: string | null;
  parent_run_id: string | null;
  child_type: string | null;
  model_events: {
    type: string;
    created_at: string;
    data: Record<string, unknown>;
  }[];
  calls: {
    id: string;
    call_id: string;
    operation: string;
    is_write: boolean;
    state: string;
    /** jsonb as text, capped at 40,000 characters by the query. */
    arguments: string | null;
    result: string | null;
    error_code: string | null;
    started_at: string;
    finished_at: string | null;
  }[];
  inputs: {
    message: string;
    thread_id: unknown;
    received_at: string;
    ordinal: number | string;
  }[];
  reply: string | null;
}

export interface BackfillStats {
  runs: number;
  spans: number;
  modelCalls: number;
  toolCalls: number;
  /** Calls with no finished_at: the live exporter never sends those either. */
  unfinishedCalls: number;
  evaluationsTrue: number;
  evaluationsFalse: number;
}

export interface Backfill {
  spans: ExportSpan[];
  evaluations: ExportEvaluation[];
  stats: BackfillStats;
}

// ---------------------------------------------------------------------------
// Deterministic IDs: agentwatch upserts spans on trace_id+span_id, so a rerun replaces.

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const spanIdOf = (key: string) => sha256(key).slice(0, 16);
export const runSpanId = (run: string) => spanIdOf(`run:${run}`);
export const modelSpanId = (invocation: string) =>
  spanIdOf(`model:${invocation}`);
export const callSpanId = (call: string) => spanIdOf(`call:${call}`);

/** A root run's ID without dashes, as live export uses it. */
export function runTraceId(run: string) {
  const hex = run.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) && !/^0+$/.test(hex)
    ? hex
    : sha256(`trace:${run}`).slice(0, 32);
}

/** Nanoseconds since the epoch from Postgres JSON timestamps, which carry microseconds. */
export function isoNs(value: string) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("Invalid timestamp in rows");
  const fraction = /T[^.]*\.(\d+)/.exec(value)?.[1] ?? "";
  const sub =
    fraction.length > 3 ? BigInt(fraction.slice(3, 9).padEnd(6, "0")) : 0n;
  return BigInt(ms) * 1_000_000n + sub;
}

const jsonText = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Cut by the query's 40,000-character cap: scrubbed as plain text.
    return text;
  }
};

// ---------------------------------------------------------------------------
// Rows to spans and evaluations.

/** Runs to spans, as the live exporter would have built them, and the turns' feedback scores. */
export function buildBackfill(
  rows: BackfillRow[],
  options: { content?: boolean } = {},
): Backfill {
  const content = options.content === true;
  const byId = new Map(rows.map((row) => [row.run_id, row]));
  // A child joins its parent's trace, through every ancestor present in the export; a
  // child whose parent is missing becomes its own root.
  const rootOf = (row: BackfillRow) => {
    const seen = new Set<string>();
    let current = row;
    while (current.parent_run_id && !seen.has(current.run_id)) {
      seen.add(current.run_id);
      const parent = byId.get(current.parent_run_id);
      if (!parent) break;
      current = parent;
    }
    return current.run_id;
  };
  const stats: BackfillStats = {
    runs: rows.length,
    spans: 0,
    modelCalls: 0,
    toolCalls: 0,
    unfinishedCalls: 0,
    evaluationsTrue: 0,
    evaluationsFalse: 0,
  };
  const spans: ExportSpan[] = [];
  const turns: Turn[] = [];
  for (const row of rows) {
    const traceId = runTraceId(rootOf(row));
    const spanId = runSpanId(row.run_id);
    const parent =
      row.parent_run_id && byId.has(row.parent_run_id)
        ? runSpanId(row.parent_run_id)
        : undefined;
    const startNs = isoNs(row.started_at);
    const stopped = row.stopped_at ?? row.failed_at ?? row.updated_at;
    const endNs = maxNs(isoNs(stopped), startNs);
    const reason = row.stop_event_reason ?? row.stop_reason ?? "";
    const agent =
      row.child_event === "research.child_started"
        ? "research"
        : row.child_event === "agent.child_started"
          ? typeof row.child_type === "string"
            ? agentName(row.child_type)
            : "agent"
          : "chief";
    const inputs = [...row.inputs].sort(
      (a, b) => Number(a.ordinal) - Number(b.ordinal),
    );
    const first = inputs[0];
    // A conversation turn: a root run that consumed an owner message.
    const thread = first && !parent ? (threadId(first.thread_id) ?? 0) : null;
    const message = inputs.map((i) => i.message).join("\n\n");
    spans.push(
      runSpan({
        traceId,
        spanId,
        parentSpanId: parent,
        agent,
        conversation: thread === null ? undefined : `thread.${thread}`,
        startNs,
        endNs,
        run: row.run_id,
        taskId: row.task_id ?? undefined,
        reason,
        input:
          content && thread !== null ? userMessageJson(message) : undefined,
        output:
          content && thread !== null && row.reply
            ? messagesJson([
                chatMessage({
                  role: "assistant",
                  content: row.reply,
                } as ModelMessage),
              ]).json
            : undefined,
      }),
    );
    if (first && thread !== null)
      turns.push({
        user: row.user_id,
        thread,
        traceId,
        spanId,
        endNs,
        receivedNs: isoNs(first.received_at),
        ordinal: Number(first.ordinal),
        firstMessage: first.message,
        message,
        reply: row.reply,
      });

    // Model calls: model.started gives the attempt, the completion or failure the span.
    const attempts = new Map<string, number>();
    row.model_events.forEach((event, index) => {
      const data = event.data ?? {};
      const invocation =
        typeof data.invocationId === "string" ? data.invocationId : undefined;
      if (event.type === "model.started") {
        if (invocation && typeof data.attempt === "number")
          attempts.set(invocation, data.attempt);
        return;
      }
      if (event.type !== "model.completed" && event.type !== "model.failed")
        return;
      spans.push(
        modelSpan({
          traceId,
          spanId: modelSpanId(invocation ?? `${row.run_id}:${index}`),
          parentSpanId: spanId,
          endNs: isoNs(event.created_at),
          failed: event.type === "model.failed",
          data,
          startedAttempt: invocation ? attempts.get(invocation) : undefined,
          // Messages are not recorded per call, so model spans carry none.
        }),
      );
      stats.modelCalls++;
    });

    for (const call of row.calls) {
      if (!call.finished_at) {
        stats.unfinishedCalls++;
        continue;
      }
      const callStart = isoNs(call.started_at);
      spans.push(
        toolSpan({
          traceId,
          spanId: callSpanId(call.id),
          parentSpanId: spanId,
          operation: logOperation(call.operation),
          write: call.is_write,
          state: call.state,
          errorCode: call.error_code ?? undefined,
          startNs: callStart,
          endNs: maxNs(isoNs(call.finished_at), callStart),
          args:
            content && call.arguments !== null
              ? toolArguments(jsonText(call.arguments))
              : undefined,
          result:
            content && call.result !== null
              ? contentText(jsonText(call.result))
              : undefined,
        }),
      );
      stats.toolCalls++;
    }
  }
  stats.spans = spans.length;
  const evaluations = turnEvaluations(turns);
  for (const e of evaluations)
    e.value ? stats.evaluationsTrue++ : stats.evaluationsFalse++;
  return { spans, evaluations, stats };
}

const maxNs = (a: bigint, b: bigint) => (a > b ? a : b);

interface Turn {
  user: string;
  thread: number;
  traceId: string;
  spanId: string;
  endNs: bigint;
  receivedNs: bigint;
  ordinal: number;
  firstMessage: string;
  message: string;
  reply: string | null;
}

/**
 * `user_redirected` scores, as live export records them: each turn is judged by the next
 * turn's owner message in the same thread, if it arrived within the feedback window after
 * the turn stopped. A message with none of the owner's words gives no score. The score's
 * time is the next message's arrival, so its ID in agentwatch is stable across reruns.
 */
function turnEvaluations(turns: Turn[]): ExportEvaluation[] {
  const threads = new Map<string, Turn[]>();
  for (const turn of turns) {
    const key = `${turn.user}\u0000${turn.thread}`;
    threads.set(key, [...(threads.get(key) ?? []), turn]);
  }
  const window = BigInt(FEEDBACK_WINDOW_MS) * 1_000_000n;
  const evaluations: ExportEvaluation[] = [];
  for (const list of threads.values()) {
    list.sort((a, b) =>
      a.receivedNs === b.receivedNs
        ? a.ordinal - b.ordinal
        : a.receivedNs < b.receivedNs
          ? -1
          : 1,
    );
    for (let i = 0; i + 1 < list.length; i++) {
      const turn = list[i]!;
      const next = list[i + 1]!;
      if (next.receivedNs - turn.endNs > window) continue;
      const redirect = redirectOf(next.firstMessage, turn.message, turn.reply);
      if (redirect === undefined) continue;
      evaluations.push({
        traceId: turn.traceId,
        spanId: turn.spanId,
        timeNs: next.receivedNs,
        name: REDIRECT_EVALUATION,
        value: redirect !== null,
        ...(redirect === null ? {} : { label: redirect }),
      });
    }
  }
  return evaluations;
}

// ---------------------------------------------------------------------------
// Sending.

/** Spans split into requests by the live exporter's limits: 256 spans and about 4 MB. */
export function spanBatches(
  spans: ExportSpan[],
  maxBatchBytes = MAX_BATCH_BYTES,
  batchSize = BATCH_SIZE,
) {
  const batches: ExportSpan[][] = [];
  for (let at = 0; at < spans.length;) {
    const { count } = nextBatch(spans.slice(at), batchSize, maxBatchBytes);
    batches.push(spans.slice(at, at + count));
    at += count;
  }
  return batches;
}

/** The OTLP/JSON request bodies: spans first, then evaluations, as the exporter sends them. */
export function requests(
  backfill: Backfill,
  endpoint: { traces: string; logs: string },
  maxBatchBytes = MAX_BATCH_BYTES,
) {
  const out: { url: string; body: string }[] = [];
  for (const batch of spanBatches(backfill.spans, maxBatchBytes))
    out.push({ url: endpoint.traces, body: JSON.stringify(encode(batch)) });
  for (let at = 0; at < backfill.evaluations.length; at += BATCH_SIZE)
    out.push({
      url: endpoint.logs,
      body: JSON.stringify(
        encodeEvaluations(backfill.evaluations.slice(at, at + BATCH_SIZE)),
      ),
    });
  return out;
}

/**
 * The traces and logs URLs for a base URL, which must be http(s) on localhost or 127.0.0.1:
 * the local agentwatch, or the host's agentwatch through an SSH tunnel.
 */
export function backfillEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(refusal);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
    url.username ||
    url.password
  )
    throw new Error(refusal);
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return { traces: `${base}/v1/traces`, logs: `${base}/v1/logs` };
}
const refusal =
  "Refusing the endpoint: the backfill posts only to http(s)://localhost or http(s)://127.0.0.1 " +
  "(any port, no credentials), meaning a local agentwatch or an SSH tunnel to the host's " +
  "agentwatch (ssh -L 14318:127.0.0.1:4318 ..., then --endpoint http://localhost:14318)";

/** Posts each request in order; throws on the first failure, naming only its position. */
export async function post(
  list: { url: string; body: string }[],
  send: typeof fetch = fetch,
) {
  for (const [index, request] of list.entries()) {
    const response = await send(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: request.body,
      signal: AbortSignal.timeout(60_000),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok)
      throw new Error(
        `Request ${index + 1} of ${list.length} failed: HTTP ${response.status}`,
      );
  }
}

/** Rows from the query output: JSON lines, ignoring psql's header and blank lines. */
export function parseRows(text: string): BackfillRow[] {
  const rows: BackfillRow[] = [];
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "j") return;
    if (!trimmed.startsWith("{"))
      throw new Error(`Line ${index + 1} is not a row (psql error output?)`);
    try {
      rows.push(JSON.parse(trimmed) as BackfillRow);
    } catch {
      throw new Error(`Line ${index + 1} is not valid JSON`);
    }
  });
  return rows;
}

// ---------------------------------------------------------------------------
// CLI.

const usage =
  "Usage: npx tsx src/trace-backfill.ts <rows.jsonl> --endpoint <base url> [--content] [--dry-run] [--since <iso>] [--until <iso>]";

/** Runs the CLI; returns what it printed. Never prints content. */
export async function main(
  argv: string[],
  print: (line: string) => void = console.log,
  send: typeof fetch = fetch,
) {
  let file: string | undefined;
  let endpoint: string | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let content = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--content") content = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--endpoint") endpoint = argv[++i];
    else if (arg === "--since") since = argv[++i];
    else if (arg === "--until") until = argv[++i];
    else if (!arg.startsWith("--") && !file) file = arg;
    else throw new Error(usage);
  }
  if (!file || (!endpoint && !dryRun)) throw new Error(usage);
  // Checked before reading anything, also on a dry run.
  const urls = endpoint
    ? backfillEndpoint(endpoint)
    : {
        traces: "http://localhost/v1/traces",
        logs: "http://localhost/v1/logs",
      };
  const from = since === undefined ? undefined : isoNs(since);
  const to = until === undefined ? undefined : isoNs(until);
  const rows = parseRows(await readFile(file, "utf8")).filter((row) => {
    const started = isoNs(row.started_at);
    return (
      (from === undefined || started >= from) &&
      (to === undefined || started < to)
    );
  });
  const backfill = buildBackfill(rows, { content });
  const list = requests(backfill, urls);
  const summary = {
    ...backfill.stats,
    requests: list.length,
    bytes: list.reduce((sum, r) => sum + Buffer.byteLength(r.body), 0),
    content,
    posted: !dryRun,
  };
  if (!dryRun) await post(list, send);
  print(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && /trace-backfill\.(ts|js)$/.test(process.argv[1]))
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Backfill failed");
    process.exitCode = 1;
  });
