// Memory backfill (issue #323 phase 6, docs/tracing.md#backfilling-memory): rebuilds the memory
// spans live export sends since journal 153 (every revision, and each run's recorded context)
// for memory from before then, from rows that scripts/memory-backfill.sql reads out of Chief's
// Postgres, and posts them to agentwatch as OTLP/JSON. Spans are built with the live
// exporter's builder (memorySpan in src/otel.ts), so they read as live ones. Span IDs are
// derived from Chief's own IDs, so posting the same rows again replaces them.
//
// A run's context belongs under the run's span. Runs exported live before the memory export
// have random span IDs, so the span is looked up in agentwatch by its chief.run_id; backfilled
// runs have derived ones. Context for a run agentwatch no longer holds is skipped.
//
//   npx tsx src/memory-backfill.ts <rows.jsonl> --endpoint http://localhost:14318 [--content] [--dry-run]

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { contextSize, isLearned } from "./memory.js";
import {
  encode,
  memoryLinks,
  memoryRecordId,
  memorySpan,
  runSpanId,
  type ExportSpan,
  type MemoryItemInput,
} from "./otel.js";
import {
  backfillEndpoint,
  isoNs,
  post,
  runTraceId,
  spanBatches,
} from "./trace-backfill.js";

interface Common {
  user_id: string;
  /** The owner's first revision ID. */
  store: string;
  created_at: string;
  root_run_id: string | null;
}

/** One memory revision. */
export interface RevisionRow extends Common {
  row: "revision";
  item_id: string;
  id: string;
  key: string;
  revision: number;
  kind: string;
  status: "active" | "retired";
  value: string | null;
  origin: string;
  trust: string;
  flags: string[];
  source: Record<string, unknown>;
  /** The run that made it: a learner run or an owner's turn; null for a rollback or import. */
  run_id: string | null;
}

/** What one run had in its prompt, as `memory_context` recorded it. */
export interface ContextRow extends Common {
  row: "context";
  run_id: string;
  omitted: number;
  items: {
    id: string;
    item_id: string;
    key: string;
    revision: number;
    kind: "fact" | "lesson";
    value: string | null;
    outcome: "success" | "pitfall" | null;
    domain: string | null;
    origin: "owner" | "learned" | "legacy" | "rollback";
    source: Record<string, unknown>;
  }[];
}

export type MemoryRow = RevisionRow | ContextRow;

export interface MemoryBackfillStats {
  revisions: number;
  contexts: number;
  /** Changes whose run agentwatch does not hold: sent as traces of their own. */
  revisionsOnTheirOwn: number;
  /** Contexts whose run agentwatch does not hold: not sent. */
  contextsSkipped: number;
  spans: number;
}

/**
 * The span ID of a run's span in agentwatch: the stored one when the trace is there (live
 * runs before journal 153 had random IDs), null when agentwatch does not hold the trace.
 */
export type RunSpanLookup = (
  traceId: string,
  runId: string,
) => Promise<string | null>;

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const token = (store: string) => store.replaceAll("-", "").slice(0, 16);

export async function buildMemoryBackfill(
  rows: MemoryRow[],
  options: { content: boolean },
  lookup: RunSpanLookup,
) {
  const spans: ExportSpan[] = [];
  const stats: MemoryBackfillStats = {
    revisions: 0,
    contexts: 0,
    revisionsOnTheirOwn: 0,
    contextsSkipped: 0,
    spans: 0,
  };
  for (const row of rows) {
    const at = isoNs(row.created_at);
    const traceId = row.root_run_id ? runTraceId(row.root_run_id) : undefined;
    const runId = row.run_id;
    const parent =
      traceId && runId ? await lookup(traceId, runId) : (null as null);
    if (row.row === "context") {
      stats.contexts++;
      if (!parent || !traceId) {
        stats.contextsSkipped++;
        continue;
      }
      spans.push(
        memorySpan({
          traceId,
          spanId: sha256(`memory-context:${row.run_id}`).slice(0, 16),
          parentSpanId: parent,
          operation: "search_memory",
          store: token(row.store),
          items: row.items.map((i): MemoryItemInput => ({
            key: i.key,
            itemId: i.item_id,
            revisionId: i.id,
            revision: i.revision,
            kind: i.kind,
            learned: isLearned(i),
            characters: contextSize(i),
            value: i.value,
          })),
          content: options.content,
          startNs: at,
          endNs: at,
          attributes: {
            "chief.memory.selection": true,
            "chief.memory.omitted": row.omitted,
          },
        }),
      );
      continue;
    }
    stats.revisions++;
    if (!parent) stats.revisionsOnTheirOwn++;
    spans.push(
      memorySpan({
        traceId:
          parent && traceId ? traceId : sha256(`memory:${row.id}`).slice(0, 32),
        spanId: sha256(`memory:${row.id}`).slice(0, 16),
        ...(parent && traceId ? { parentSpanId: parent } : {}),
        operation:
          row.status === "retired"
            ? "delete_memory"
            : row.revision === 1
              ? "create_memory"
              : "update_memory",
        store: token(row.store),
        ...(row.source.learnerRunId ? { service: "chief-learner" } : {}),
        items: [
          {
            key: row.key,
            itemId: row.item_id,
            revisionId: row.id,
            revision: row.revision,
            kind: row.kind,
            learned: isLearned({
              origin: row.origin as any,
              source: row.source,
            }),
            value: row.value,
          },
        ],
        content: options.content,
        startNs: at,
        endNs: at,
        links: memoryLinks(row.source),
        attributes: {
          "gen_ai.memory.record.id": memoryRecordId(
            row.key,
            row.item_id,
            options.content,
          ),
          "chief.memory.origin": /^[a-z]+$/.test(row.origin)
            ? row.origin
            : undefined,
          "chief.memory.trust": /^[a-z]+$/.test(row.trust)
            ? row.trust
            : undefined,
          "chief.memory.flags": row.flags.filter((f) =>
            /^[a-z][a-z0-9_.]{0,79}$/.test(f),
          ),
        },
      }),
    );
  }
  stats.spans = spans.length;
  return { spans, stats };
}

/** Finds a run's span in agentwatch's copy of its trace; cached per trace. */
export function agentwatchLookup(
  base: string,
  send: typeof fetch = fetch,
): RunSpanLookup {
  const traces = new Map<string, Map<string, string> | null>();
  return async (traceId, runId) => {
    if (!traces.has(traceId)) {
      const response = await send(`${base}/api/traces/${traceId}`, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        traces.set(traceId, null);
      } else if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Reading a trace failed: HTTP ${response.status}`);
      } else {
        const body = (await response.json()) as {
          spans: { span_id: string; attributes: Record<string, unknown> }[];
        };
        const runs = new Map<string, string>();
        for (const span of body.spans) {
          const run = span.attributes["chief.run_id"];
          if (typeof run === "string") runs.set(run, span.span_id);
        }
        traces.set(traceId, runs);
      }
    }
    const runs = traces.get(traceId);
    if (!runs) return null;
    // A run the trace does not show (a child that never finished): its derived ID.
    return runs.get(runId) ?? runSpanId(runId);
  };
}

/** Rows from the query output: JSON lines, ignoring psql's header and blank lines. */
export function parseMemoryRows(text: string): MemoryRow[] {
  const rows: MemoryRow[] = [];
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "j") return;
    if (!trimmed.startsWith("{"))
      throw new Error(`Line ${index + 1} is not a row (psql error output?)`);
    try {
      const row = JSON.parse(trimmed) as MemoryRow;
      if (row.row !== "revision" && row.row !== "context") throw new Error();
      rows.push(row);
    } catch {
      throw new Error(`Line ${index + 1} is not a memory row`);
    }
  });
  return rows;
}

const usage =
  "Usage: npx tsx src/memory-backfill.ts <rows.jsonl> --endpoint <base url> [--content] [--dry-run]";

/** Runs the CLI; returns what it printed. Never prints content. */
export async function main(
  argv: string[],
  print: (line: string) => void = console.log,
  send: typeof fetch = fetch,
) {
  let file: string | undefined;
  let endpoint: string | undefined;
  let content = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--content") content = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--endpoint") endpoint = argv[++i];
    else if (!arg.startsWith("--") && !file) file = arg;
    else throw new Error(usage);
  }
  // The endpoint is needed even for a dry run: runs' spans are looked up there.
  if (!file || !endpoint) throw new Error(usage);
  const urls = backfillEndpoint(endpoint);
  const base = urls.traces.replace(/\/v1\/traces$/, "");
  const rows = parseMemoryRows(await readFile(file, "utf8"));
  const backfill = await buildMemoryBackfill(
    rows,
    { content },
    agentwatchLookup(base, send),
  );
  const list = spanBatches(backfill.spans).map((batch) => ({
    url: urls.traces,
    body: JSON.stringify(encode(batch)),
  }));
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

if (process.argv[1] && /memory-backfill\.(ts|js)$/.test(process.argv[1]))
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Backfill failed");
    process.exitCode = 1;
  });
