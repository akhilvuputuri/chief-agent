import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Database } from "../src/db.js";
import { MemoryStore } from "../src/memory.js";
import { recall } from "../src/recall.js";
import {
  memoryChanged,
  memoryContext,
  memoryRecordId,
  memorySearched,
  memoryStoreId,
  runEvent,
  runSpanId,
  runStarted,
  startTracing,
  stopTracing,
} from "../src/otel.js";
import { closeAfter, migratedPGlite } from "./helpers/pglite.js";

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
    bodies.flatMap(
      (body) =>
        JSON.parse(body).resourceSpans[0].scopeSpans[0].spans as OtlpSpan[],
    );
  return { post, bodies, spans };
}

function attr(span: OtlpSpan, key: string) {
  const value = span.attributes.find((a) => a.key === key)?.value;
  if (!value) return undefined;
  if ("intValue" in value) return Number(value.intValue);
  if ("boolValue" in value) return value.boolValue;
  if ("arrayValue" in value)
    return (
      value.arrayValue as { values: { stringValue: string }[] }
    ).values.map((v) => v.stringValue);
  return value.stringValue;
}

const records = (span: OtlpSpan) =>
  JSON.parse(attr(span, "gen_ai.memory.records") as string) as Array<{
    id: string;
    content: string | null;
    metadata: Record<string, unknown>;
  }>;

const OWNER = "user-7731";
// The store token and item ID come from revision IDs (MemoryStore.traceIdentities).
const STORE = "4f1c2b9d8e7a6b5c";
const ITEM_ID = randomUUID();
const item = {
  key: "wife_name",
  itemId: ITEM_ID,
  revisionId: randomUUID(),
  revision: 2,
  kind: "fact",
  learned: false,
  characters: 30,
  value: "Her name is Priya",
};

async function exported(capture: boolean, work: () => Promise<void> | void) {
  const sink = collector();
  startTracing({
    endpoint: "http://collector/v1/traces",
    fetch: sink.post,
    captureContent: capture,
    intervalMs: 60_000,
  });
  try {
    await work();
  } finally {
    await stopTracing(1000);
  }
  return sink;
}

test("a run's context is a search_memory span on the run, with each item's size", async () => {
  const run = randomUUID();
  const sink = await exported(true, () => {
    runStarted(run);
    memoryContext(run, STORE, [item], 3);
    runEvent(run, "runtime.stopped", { stopReason: "answer" });
  });
  const [read, root] = sink.spans();
  assert.equal(root!.name, "invoke_agent chief");
  // A run's span ID comes from its ID, so another trace can link to it.
  assert.equal(root!.spanId, runSpanId(run));
  assert.equal(read!.parentSpanId, root!.spanId);
  assert.equal(read!.name, `search_memory ${memoryStoreId(STORE)}`);
  assert.equal(attr(read!, "gen_ai.operation.name"), "search_memory");
  assert.equal(attr(read!, "gen_ai.memory.store.id"), memoryStoreId(STORE));
  assert.equal(attr(read!, "gen_ai.memory.record.count"), 1);
  assert.equal(attr(read!, "chief.memory.omitted"), 3);
  assert.deepEqual(records(read!), [
    {
      id: "wife_name",
      content: "Her name is Priya",
      metadata: {
        kind: "fact",
        revision: 2,
        revision_id: item.revisionId,
        learned: false,
        characters: 30,
      },
    },
  ]);
});

test("without content capture, keys and values do not leave", async () => {
  const run = randomUUID();
  const sink = await exported(false, () => {
    runStarted(run);
    memoryContext(run, STORE, [item], 0);
    memorySearched(run, STORE, [item], 1n, "what is my wife called");
    memoryChanged(STORE, {
      itemId: ITEM_ID,
      revisionId: item.revisionId,
      key: item.key,
      revision: 1,
      kind: "fact",
      status: "active",
      value: item.value,
      origin: "owner",
      trust: "owner",
      flags: [],
      learned: false,
      source: { runId: run },
    });
    runEvent(run, "runtime.stopped", { stopReason: "answer" });
  });
  const bytes = sink.bodies.join("");
  for (const text of ["wife", "Priya", OWNER])
    assert.ok(!bytes.includes(text), text);
  const memory = sink.spans().filter((s) => s.name.includes("memory"));
  assert.equal(memory.length, 3);
  // The item is named by a random revision ID, which says nothing about its key.
  assert.equal(memoryRecordId("wife_name", ITEM_ID, false), ITEM_ID);
  for (const span of memory) {
    // Still the same item everywhere, and what was in context is still known.
    assert.deepEqual(
      records(span).map((r) => [r.id, r.content]),
      [[ITEM_ID, null]],
    );
    assert.equal(attr(span, "gen_ai.memory.query.text"), undefined);
  }
});

test("recall results and changes join the run; a learner's change links to its sources", async () => {
  const run = randomUUID();
  const learner = randomUUID();
  const turn = randomUUID();
  const sink = await exported(true, () => {
    runStarted(run);
    memorySearched(
      run,
      STORE,
      [{ ...item, meaningRank: 1, keywordRank: null }],
      5n,
      "wife",
    );
    memoryChanged(STORE, {
      itemId: ITEM_ID,
      revisionId: randomUUID(),
      key: "wife_name",
      revision: 3,
      kind: "fact",
      status: "retired",
      value: null,
      origin: "owner",
      trust: "owner",
      flags: ["conflict", "Not A Name"],
      learned: false,
      source: { runId: run },
    });
    runEvent(run, "runtime.stopped", { stopReason: "answer" });
    runStarted(learner);
    memoryChanged(STORE, {
      itemId: ITEM_ID,
      revisionId: randomUUID(),
      key: "lesson:calendar:check",
      revision: 1,
      kind: "lesson",
      status: "active",
      value: "Check twice.",
      origin: "learned",
      trust: "owner",
      flags: [],
      learned: true,
      source: {
        learnerRunId: learner,
        turnRunIds: [turn, "not-a-run"],
        runIds: [turn],
      },
    });
    // A change by nobody this process traces is a trace of its own.
    memoryChanged(STORE, {
      itemId: ITEM_ID,
      revisionId: randomUUID(),
      key: "imported",
      revision: 1,
      kind: "fact",
      status: "active",
      value: "x",
      origin: "legacy",
      trust: "unknown",
      flags: [],
      learned: false,
      source: { importedFrom: "memories" },
    });
  });
  const spans = sink.spans();
  const named = (prefix: string) =>
    spans.filter((s) => s.name.startsWith(prefix));
  const [search] = named("search_memory");
  assert.equal(search!.parentSpanId, runSpanId(run));
  assert.equal(attr(search!, "gen_ai.memory.query.text"), "wife");
  assert.equal(records(search!)[0]!.metadata.meaning_rank, 1);
  assert.equal("keyword_rank" in records(search!)[0]!.metadata, false);
  const [deleted] = named("delete_memory");
  assert.equal(deleted!.parentSpanId, runSpanId(run));
  assert.equal(attr(deleted!, "gen_ai.memory.record.id"), "wife_name");
  assert.equal(records(deleted!)[0]!.content, null);
  assert.deepEqual(attr(deleted!, "chief.memory.flags"), ["conflict"]);
  const [created, imported] = named("create_memory");
  assert.equal(created!.traceId, learner.replaceAll("-", ""));
  assert.equal(created!.parentSpanId, runSpanId(learner));
  assert.deepEqual(created!.links, [
    { traceId: turn.replaceAll("-", ""), spanId: runSpanId(turn) },
  ]);
  assert.equal(imported!.parentSpanId, undefined);
  assert.notEqual(imported!.traceId, created!.traceId);
  assert.equal(attr(imported!, "chief.memory.origin"), "legacy");
});

test("the memory store reports each committed change, and none that failed", async (t) => {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES($1)", [OWNER]);
  const store = new MemoryStore(db);
  const sink = await exported(true, async () => {
    await store.write(OWNER, {
      key: "timezone",
      value: "UTC+8",
      kind: "fact",
      origin: "owner",
      reason: "asked",
      source: {},
    });
    await store.write(OWNER, {
      key: "timezone",
      value: "UTC+9",
      kind: "fact",
      origin: "owner",
      reason: "asked",
      source: {},
    });
    // Refused: a fact key cannot become a lesson.
    await assert.rejects(
      store.write(OWNER, {
        key: "timezone",
        value: "x",
        kind: "lesson",
        origin: "owner",
        reason: "asked",
        source: {},
      }),
    );
    await store.retire(OWNER, "timezone", { origin: "owner", reason: "asked" });
    // Nothing active to retire: no change.
    await store.retire(OWNER, "timezone", { origin: "owner", reason: "asked" });
  });
  assert.deepEqual(
    sink
      .spans()
      .map((s) => [
        attr(s, "gen_ai.operation.name"),
        records(s)[0]!.content,
        records(s)[0]!.metadata.revision,
      ]),
    [
      ["create_memory", "UTC+8", 1],
      ["update_memory", "UTC+9", 2],
      ["delete_memory", null, 3],
    ],
  );
});

test("a selection describes every item in context, sorted by key, with its size", async (t) => {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES($1)", [OWNER]);
  const store = new MemoryStore(db);
  await store.write(OWNER, {
    key: "zone",
    value: "UTC+8",
    kind: "fact",
    origin: "owner",
    reason: "asked",
    source: {},
  });
  await store.write(OWNER, {
    key: "lesson:mail:quote",
    value: "Quote the sender.",
    kind: "lesson",
    origin: "learned",
    reason: "seen",
    source: {},
    outcome: "success",
    domain: "mail",
  });
  const selection = await store.select(OWNER);
  assert.deepEqual(
    selection.context.map((c) => [c.key, c.kind, c.learned, c.revision]),
    [
      ["lesson:mail:quote", "lesson", true, 1],
      ["zone", "fact", false, 1],
    ],
  );
  assert.deepEqual(
    selection.selected.sort(),
    selection.context.map((c) => c.revisionId).sort(),
  );
  // The sizes add up to what the selection counts.
  assert.equal(
    selection.context.reduce((n, c) => n + (c.characters ?? 0), 0) + 1,
    selection.chars,
  );
});

async function memoryDb(t: { after(fn: () => Promise<void>): void }) {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES($1)", [OWNER]);
  await db.query("INSERT INTO conversations(user_id) VALUES($1)", [OWNER]);
  return db;
}

const fact = (key: string, value: string) => ({
  key,
  value,
  kind: "fact" as const,
  origin: "owner" as const,
  reason: "asked",
  source: {},
});

test("without capture, a store's export names the owner and items only by revision IDs", async (t) => {
  const db = await memoryDb(t);
  const store = new MemoryStore(db);
  const run = randomUUID();
  const sink = await exported(false, async () => {
    runStarted(run);
    const first = await store.write(OWNER, fact("wife_name", "Priya"));
    await store.write(OWNER, fact("wife_name", "Priya Sharma"));
    const selection = await store.select(OWNER);
    const ids = await store.traceIdentities(
      OWNER,
      selection.context.map((c) => c.key),
    );
    assert.equal(ids.store, first.id.replaceAll("-", "").slice(0, 16));
    assert.equal(ids.items.get("wife_name"), first.id);
    await recall(db, OWNER, run, "Sharma");
    runEvent(run, "runtime.stopped", { stopReason: "answer" });
  });
  const bytes = sink.bodies.join("");
  for (const text of ["wife", "Priya", "Sharma", OWNER])
    assert.ok(!bytes.includes(text), text);
  const memory = sink.spans().filter((s) => s.name.includes("memory"));
  assert.deepEqual(
    memory.map((s) => attr(s, "gen_ai.operation.name")),
    ["create_memory", "update_memory", "search_memory"],
  );
  // Every span names the same item and store, from the key's first revision.
  assert.equal(new Set(memory.map((s) => records(s)[0]!.id)).size, 1);
  assert.equal(
    new Set(memory.map((s) => attr(s, "gen_ai.memory.store.id"))).size,
    1,
  );
  // The recall read is on the run, so the run's later model calls see it.
  assert.equal(memory[2]!.parentSpanId, runSpanId(run));
});

test("a rollback and the legacy import are exported once they commit", async (t) => {
  const db = await memoryDb(t);
  const store = new MemoryStore(db);
  const learnerRun = randomUUID();
  await db.query(
    "INSERT INTO learner_runs(id,user_id,state,prompt_version) VALUES($1,$2,'completed','test-1')",
    [learnerRun, OWNER],
  );
  await store.write(OWNER, {
    ...fact("seat", "Aisle"),
    origin: "learned",
    learnerRun,
  });
  await db.query(
    "INSERT INTO memories(user_id,key,value) VALUES($1,'legacy_key','Old value')",
    [OWNER],
  );
  const sink = await exported(true, async () => {
    await store.rollback(OWNER, { learnerRun }, "Owner undo");
    await store.importLegacy();
  });
  assert.deepEqual(
    sink
      .spans()
      .map((s) => [
        attr(s, "gen_ai.operation.name"),
        records(s)[0]!.id,
        attr(s, "chief.memory.origin"),
      ]),
    [
      ["delete_memory", "seat", "rollback"],
      ["create_memory", "legacy_key", "legacy"],
    ],
  );
});

test("export is skipped without tracing, and never fails a write", async (t) => {
  const db = await memoryDb(t);
  const store = new MemoryStore(db);
  // Tracing is off: nothing to look up, and the write goes through.
  const saved = await store.write(OWNER, fact("zone", "UTC+8"));
  assert.equal(saved.revision, 1);
});
