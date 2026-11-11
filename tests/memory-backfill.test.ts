import { setTimeout } from "node:timers/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { Database } from "../src/db.js";
import { Execution } from "../src/execution.js";
import { MemoryStore } from "../src/memory.js";
import {
  agentwatchLookup,
  buildMemoryBackfill,
  main,
  parseMemoryRows,
  type RunSpanLookup,
} from "../src/memory-backfill.js";
import { setOpsSink } from "../src/ops-log.js";
import {
  encode,
  memoryContext,
  runSpanId,
  startTracing,
  stopTracing,
  type ExportSpan,
} from "../src/otel.js";
import { closeAfter, migratedPGlite } from "./helpers/pglite.js";

const sql = async () =>
  (
    await readFile(
      new URL("../scripts/memory-backfill.sql", import.meta.url),
      "utf8",
    )
  )
    .replaceAll(":'since'", "'2000-01-01T00:00:00Z'")
    .replaceAll(":'until'", "'2100-01-01T00:00:00Z'");

type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  links?: { traceId: string; spanId: string }[];
};

function collector() {
  const bodies: string[] = [];
  const post = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const spans = () =>
    bodies.flatMap((body) =>
      JSON.parse(body).resourceSpans.flatMap(
        (r: any) => r.scopeSpans[0].spans as OtlpSpan[],
      ),
    );
  return { post, spans };
}

/** A span's attributes as plain values, records parsed, for comparing live with rebuilt. */
function shape(span: OtlpSpan | ExportSpan) {
  const attributes: Record<string, unknown> = {};
  if ("startNs" in span) {
    for (const [key, value] of Object.entries(span.attributes))
      if (value !== undefined) attributes[key] = value;
  } else
    for (const { key, value } of span.attributes)
      attributes[key] =
        "intValue" in value
          ? Number(value.intValue)
          : "boolValue" in value
            ? value.boolValue
            : "arrayValue" in value
              ? ((value.arrayValue as any).values?.map(
                  (v: any) => v.stringValue,
                ) ?? [])
              : value.stringValue;
  if (
    Array.isArray(attributes["chief.memory.flags"]) &&
    (attributes["chief.memory.flags"] as unknown[]).length === 0
  )
    delete attributes["chief.memory.flags"];
  attributes["gen_ai.memory.records"] = JSON.parse(
    attributes["gen_ai.memory.records"] as string,
  );
  return { name: span.name, parent: span.parentSpanId, attributes };
}

test("rebuilt memory spans equal what live export sent", async (t) => {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner')");
  await db.query("INSERT INTO conversations(user_id) VALUES('owner')");
  const store = new MemoryStore(db);
  const sink = collector();
  const restore = setOpsSink(() => undefined);
  const turn = randomUUID();
  startTracing({
    endpoint: "http://collector/v1/traces",
    intervalMs: 60_000,
    fetch: sink.post,
    captureContent: true,
  });
  try {
    const run = new Execution(db, "owner", turn, new AbortController().signal);
    await run.start();
    await store.write("owner", {
      key: "timezone",
      value: "UTC+8",
      kind: "fact",
      origin: "owner",
      reason: "asked",
      source: { runId: turn },
    });
    await store.write("owner", {
      key: "lesson:mail:quote",
      value: "Quote the sender.",
      kind: "lesson",
      origin: "learned",
      reason: "seen",
      source: { turnRunIds: [turn] },
      outcome: "success",
      domain: "mail",
    });
    const selection = await store.select("owner");
    // Rows are ordered by created_at, which PGlite keeps to the millisecond: without a
    // gap, the context and the revision after it can share one and swap places.
    await setTimeout(2);
    await store.recordContext("owner", turn, selection);
    const ids = await store.traceIdentities(
      "owner",
      selection.context.map((c) => c.key),
    );
    memoryContext(
      turn,
      ids.store,
      selection.context.map((c) => ({
        ...c,
        itemId: ids.items.get(c.key)!,
      })),
      selection.omitted.length,
    );
    await setTimeout(2);
    await store.retire("owner", "timezone", {
      origin: "owner",
      reason: "asked",
    });
    await run.finish("answer");
  } finally {
    await stopTracing(1000);
    setOpsSink(restore);
  }
  const live = sink.spans().filter((s) => s.name.includes("memory"));
  const rows = parseMemoryRows(
    `j\n${(await db.query(await sql())).rows.map((r: any) => JSON.stringify(r.j)).join("\n")}\n`,
  );
  assert.deepEqual(
    rows.map((r) => r.row),
    ["revision", "revision", "context", "revision"],
  );
  // agentwatch holds the turn's trace, under the run's derived span ID.
  const lookup: RunSpanLookup = async (traceId, runId) =>
    traceId === turn.replaceAll("-", "") ? runSpanId(runId) : null;
  const rebuilt = await buildMemoryBackfill(rows, { content: true }, lookup);
  assert.deepEqual(rebuilt.stats, {
    revisions: 3,
    contexts: 1,
    // The learned lesson and the retirement name no traced run.
    revisionsOnTheirOwn: 2,
    contextsSkipped: 0,
    spans: 4,
  });
  const byName = (spans: (OtlpSpan | ExportSpan)[]) =>
    spans
      .map(shape)
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
  assert.deepEqual(byName(rebuilt.spans), byName(live));
  // Changes that joined the turn are in its trace; the others are traces of their own.
  const turnTrace = turn.replaceAll("-", "");
  assert.deepEqual(
    rebuilt.spans.map((s) => s.traceId === turnTrace),
    [true, false, true, false],
  );
  // A turn exported live before 5 November had a random span ID: the read hangs under it.
  const random = "0123456789abcdef";
  const live5Nov = await buildMemoryBackfill(
    rows,
    { content: true },
    async (traceId, runId) =>
      traceId === turnTrace && runId === turn ? random : null,
  );
  assert.deepEqual(
    live5Nov.spans
      .filter((s) => s.traceId === turnTrace)
      .map((s) => [s.name.split(" ")[0], s.parentSpanId]),
    [
      ["create_memory", random],
      ["search_memory", random],
    ],
  );
  // Without --content, no key or value is sent.
  const plain = await buildMemoryBackfill(rows, { content: false }, lookup);
  const bytes = JSON.stringify(encode(plain.spans));
  for (const text of ["timezone", "UTC+8", "Quote the sender", "lesson:mail"])
    assert.ok(!bytes.includes(text), text);
  // Posting the same rows again gives the same span IDs.
  const again = await buildMemoryBackfill(rows, { content: true }, lookup);
  assert.deepEqual(
    again.spans.map((s) => s.spanId),
    rebuilt.spans.map((s) => s.spanId),
  );
  // Without the turn's trace in agentwatch, its context is not sent.
  const none = await buildMemoryBackfill(
    rows,
    { content: true },
    async () => null,
  );
  assert.equal(none.stats.contextsSkipped, 1);
  assert.equal(none.stats.revisionsOnTheirOwn, 3);
});

test("a run's span is found in agentwatch by its run ID, else null", async () => {
  const run = randomUUID();
  const asked: string[] = [];
  const send = (async (url: string | URL | Request) => {
    asked.push(String(url));
    if (String(url).endsWith("/missing"))
      return new Response("trace not found", { status: 404 });
    return Response.json({
      spans: [
        { span_id: "aaaaaaaaaaaaaaaa", attributes: { "chief.run_id": run } },
        { span_id: "bbbbbbbbbbbbbbbb", attributes: {} },
      ],
    });
  }) as typeof fetch;
  const lookup = agentwatchLookup("http://localhost:14318", send);
  assert.equal(await lookup("t1", run), "aaaaaaaaaaaaaaaa");
  // A run the trace does not show has no span to hang one on; the trace is read once.
  assert.equal(await lookup("t1", randomUUID()), null);
  assert.equal(await lookup("missing", run), null);
  assert.deepEqual(asked, [
    "http://localhost:14318/api/traces/t1",
    "http://localhost:14318/api/traces/missing",
  ]);
});

test("the CLI needs a local endpoint, reads only, and prints counts without content", async () => {
  await assert.rejects(main(["rows.jsonl"]), /Usage/);
  await assert.rejects(
    main(["rows.jsonl", "--endpoint", "https://example.com"]),
    /Refusing the endpoint/,
  );
  assert.throws(() => parseMemoryRows('{"row":"other"}\n'), /not a memory row/);
});
