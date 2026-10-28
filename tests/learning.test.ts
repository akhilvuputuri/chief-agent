import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Database } from "../src/db.js";
import {
  labelTask,
  Learner,
  LEARNING_LIMITS,
  untrustedSources,
} from "../src/learning.js";
import { MemoryStore } from "../src/memory.js";
import type { Generation, ModelAdapter } from "../src/model.js";
import { closeAfter, migratedPGlite } from "./helpers/pglite.js";

const DAY = 24 * 3600_000;
// 04:00 Singapore on 28 October 2026.
const NIGHT = new Date("2026-10-27T20:00:00Z");

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner')");
  await db.query("INSERT INTO conversations(user_id) VALUES('owner')");
  return db;
}

let ordinal = 0;
async function task(
  db: Database,
  o: {
    status?: string;
    request?: string;
    ownerSays?: string[];
    receipts?: Array<[string, "success" | "failed"]>;
    source?: string;
    finishedAgo?: number;
    pauseReason?: string;
  } = {},
) {
  const id = randomUUID();
  const finished = new Date(NIGHT.getTime() - (o.finishedAgo ?? 2 * DAY));
  await db.query(
    `INSERT INTO work_tasks(id,user_id,objective,request,status,updated_at,delivery_context,pause_reason)
     VALUES($1,'owner','objective',$2,$3,$4,$5::jsonb,$6)`,
    [
      id,
      o.request ?? "Book my flight to Tokyo",
      o.status ?? "done",
      finished,
      JSON.stringify(o.source ? { source: o.source } : {}),
      o.pauseReason ?? null,
    ],
  );
  await db.query(
    "INSERT INTO work_steps(task_id,key,title,verification,status,result) VALUES($1,'a','Find flights','analysis','done','Found three options')",
    [id],
  );
  const run = randomUUID();
  await db.query(
    "INSERT INTO runtime_runs(id,user_id,task_id,state) VALUES($1,'owner',$2,'stopped')",
    [run, id],
  );
  for (const [operation, status] of o.receipts ?? [])
    await db.query(
      "INSERT INTO tool_receipts(id,user_id,run_id,task_id,operation,status) VALUES($1,'owner',$2,$3,$4,$5)",
      [randomUUID(), run, id, operation, status],
    );
  for (const [role, content] of [
    ...(o.ownerSays ?? []).map((text) => ["user", text]),
    ["assistant", "Booked the morning flight."],
  ]) {
    const payload = { role, content };
    const hash = createHash("sha256")
      .update(JSON.stringify(payload) + ordinal)
      .digest("hex");
    await db.query(
      "INSERT INTO message_contents(user_id,hash,payload,characters) VALUES('owner',$1,$2::jsonb,$3)",
      [hash, JSON.stringify(payload), content!.length],
    );
    await db.query(
      "INSERT INTO conversation_messages(user_id,ordinal,hash,run_id) VALUES('owner',$1,$2,$3)",
      [++ordinal, hash, run],
    );
  }
  return id;
}

type Call = [string, Record<string, unknown>];
function model(script: (input: any, n: number) => Call[] | Promise<Call[]>) {
  const inputs: any[] = [];
  const adapter: ModelAdapter = {
    generate: async (input): Promise<Generation> => {
      inputs.push(JSON.parse(JSON.stringify(input)));
      const calls = await script(input, inputs.length);
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map(([name, args]) => ({
            id: randomUUID(),
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          })),
        },
      };
    },
  };
  return { adapter, inputs };
}

const learner = (db: Database, adapter: ModelAdapter, now = NIGHT) =>
  new Learner(db, {
    model: adapter,
    modelName: "test/model",
    clock: () => now,
  });

test("labels: only the owner's requests, done with proof is success, recovered or failed is pitfall", () => {
  const base = {
    status: "done",
    pauseReason: null,
    source: null,
    routine: false,
    failedReceipts: 0,
    uncertainCalls: 0,
    blockedSteps: 0,
  };
  assert.deepEqual(labelTask(base), {
    label: "success",
    reasons: ["done_with_proof"],
  });
  assert.equal(labelTask({ ...base, source: "owner" })?.label, "success");
  assert.equal(labelTask({ ...base, failedReceipts: 1 })?.label, "pitfall");
  assert.deepEqual(labelTask({ ...base, uncertainCalls: 1 })?.reasons, [
    "uncertain_write",
  ]);
  assert.deepEqual(labelTask({ ...base, routine: true })?.reasons, [
    "not_owner_request",
  ]);
  assert.equal(
    labelTask({ ...base, source: "responsibility" })?.label,
    "skipped",
  );
  assert.equal(labelTask({ ...base, status: "cancelled" })?.label, "skipped");
  assert.equal(
    labelTask({ ...base, status: "paused", blockedSteps: 1 })?.label,
    "pitfall",
  );
  // A paused task that may still finish is looked at again later.
  assert.equal(labelTask({ ...base, status: "paused" }), null);
  assert.equal(
    labelTask({
      ...base,
      status: "paused",
      pauseReason: "runtime_cutover",
      failedReceipts: 2,
    }),
    null,
  );
});

test("untrusted sources are named from the operations a task ran", () => {
  assert.deepEqual(
    untrustedSources([
      "gmail_search",
      "web_read",
      "agent_run",
      "calendar_list",
      "source_read",
      "job_list",
    ]),
    ["agent_report", "calendar", "document", "email", "web"],
  );
  assert.deepEqual(untrustedSources(["memory_list", "work_start"]), []);
});

test("a night's run starts from 03:30 Singapore, once, and not outside its window", async (t) => {
  const db = await setup(t);
  const { adapter, inputs } = model(() => [["learn_finish", { summary: "" }]]);
  await task(db, { ownerSays: ["Find me a flight"] });
  const at = (iso: string) => learner(db, adapter, new Date(iso));
  assert.equal(await at("2026-10-27T19:20:00Z").tick("owner"), null); // 03:20 SGT
  // 03:20 belongs to the previous night, whose window has passed.
  assert.equal(await at("2026-10-27T19:31:00Z").tick("nobody"), null);
  assert.equal(
    (await at("2026-10-27T19:31:00Z").tick("owner"))?.state,
    "completed",
  );
  assert.equal(inputs.length, 1);
  assert.equal(await at("2026-10-27T21:00:00Z").tick("owner"), null);
  // 10:00 SGT the next day is outside that night's window.
  assert.equal(await at("2026-10-29T02:00:00Z").tick("owner"), null);
  assert.equal(
    Learner.nightStart(new Date("2026-10-27T19:20:00Z")).toISOString(),
    "2026-10-26T19:30:00.000Z",
  );
});

test("a run writes checked facts and lessons with provenance and trust, refuses the rest, and labels each task once", async (t) => {
  const db = await setup(t);
  const success = await task(db, {
    ownerSays: ["I always prefer aisle seats on long flights, please."],
    receipts: [
      ["web_search", "success"],
      ["gmail_search", "success"],
    ],
  });
  const plain = await task(db, {
    request: "Summarise my week",
    ownerSays: ["Keep summaries to five bullets"],
  });
  const pitfall = await task(db, {
    request: "Check my parcel",
    receipts: [
      ["parcel_record", "failed"],
      ["parcel_record", "success"],
    ],
  });
  const skipped = await task(db, { source: "responsibility" });
  const recent = await task(db, { finishedAgo: 3600_000 });
  const { adapter, inputs } = model((input, n) => {
    if (n === 1) {
      const shown = JSON.parse(input.messages[1].content);
      assert.deepEqual(
        shown.tasks.map((x: any) => [x.id, x.label]).sort(),
        [
          [success, "success"],
          [plain, "success"],
          [pitfall, "pitfall"],
        ].sort(),
      );
      assert.equal(
        shown.tasks.find((x: any) => x.id === success).untrusted.join(),
        "email,web",
      );
      return [
        [
          "learn_fact",
          {
            key: "seat_preference",
            value: "Prefers aisle seats on long flights",
            quote: "prefer aisle seats on long flights",
            taskIds: [success],
            reason: "Stated by the owner",
          },
        ],
        [
          "learn_fact",
          {
            key: "home_city",
            value: "Lives in Penang",
            quote: "I live in Penang",
            taskIds: [success],
            reason: "Invented",
          },
        ],
        [
          "learn_lesson",
          {
            domain: "parcels",
            slug: "retry-record",
            outcome: "pitfall",
            value:
              "Retry a failed parcel record once, because the first write can race the tracker.",
            taskIds: [success],
            reason: "Mislabelled",
          },
        ],
        [
          "learn_lesson",
          {
            domain: "summaries",
            slug: "five-bullets",
            outcome: "success",
            value:
              "Keep weekly summaries to five bullets, because the owner reads them on a phone.",
            taskIds: [plain],
            reason: "Worked",
          },
        ],
        ["learn_fact", { key: "x" }],
        ["memory_set", { key: "x", value: "y" }],
      ];
    }
    const results = input.messages
      .filter((m: any) => m.role === "tool")
      .map((m: any) => JSON.parse(m.content));
    assert.deepEqual(results, [
      { accepted: true },
      { refused: "The quote must be the owner's exact words in a cited task" },
      { refused: "A pitfall lesson must cite only pitfall tasks" },
      { accepted: true },
      { refused: "Invalid arguments" },
      { refused: "Unknown tool" },
    ]);
    return [["learn_finish", { summary: "Saved two items" }]];
  });
  const result: any = await learner(db, adapter).tick("owner");
  assert.equal(inputs.length, 2);
  assert.deepEqual(
    [
      result.state,
      result.reviewed,
      result.success,
      result.pitfall,
      result.facts,
      result.lessons,
      result.refused,
    ],
    ["completed", 4, 2, 1, 1, 1, 4],
  );
  // The model was offered learning tools only.
  assert.deepEqual(inputs[0].tools.map((x: any) => x.name).sort(), [
    "learn_fact",
    "learn_finish",
    "learn_lesson",
    "learn_retire",
  ]);
  const store = new MemoryStore(db);
  const [fact] = await store.history("owner", "seat_preference");
  assert.deepEqual(
    [fact!.origin, fact!.trust, fact!.untrusted_sources, fact!.learner_run],
    ["learned", "untrusted", ["email", "web"], result.learnerRun],
  );
  assert.deepEqual(fact!.source.taskIds, [success]);
  assert.equal((fact!.source.messageIds as string[]).length, 1);
  const [lesson] = await store.history(
    "owner",
    "lesson:summaries:five-bullets",
  );
  assert.deepEqual(
    [lesson!.kind, lesson!.outcome, lesson!.domain, lesson!.trust],
    ["lesson", "success", "summaries", "owner"],
  );
  assert.deepEqual(await store.history("owner", "home_city"), []);
  const reviews = (
    await db.query("SELECT task_id,label FROM learning_reviews ORDER BY label")
  ).rows;
  assert.deepEqual(
    reviews.map((r) => [r.task_id, r.label]).sort(),
    [
      [success, "success"],
      [plain, "success"],
      [pitfall, "pitfall"],
      [skipped, "skipped"],
    ].sort(),
  );
  assert.ok(!reviews.some((r) => r.task_id === recent));
  const runs = (
    await db.query(
      "SELECT l.state,r.state AS run_state,r.stop_reason FROM learner_runs l JOIN runtime_runs r ON r.id=l.run_id",
    )
  ).rows;
  assert.deepEqual(runs, [
    { state: "completed", run_state: "stopped", stop_reason: "answer" },
  ]);
  // The next night reviews only the task that was too recent, and calls no model for it
  // until it carries evidence.
  const next = model(() => [["learn_finish", { summary: "" }]]);
  await learner(db, next.adapter, new Date(NIGHT.getTime() + DAY)).tick(
    "owner",
  );
  assert.equal(next.inputs.length, 1);
  assert.deepEqual(
    JSON.parse(next.inputs[0].messages[1].content).tasks.map((x: any) => x.id),
    [recent],
  );
  assert.deepEqual(
    JSON.parse(next.inputs[0].messages[1].content).current.map((c: any) => [
      c.key,
      c.learned,
    ]),
    [
      ["lesson:summaries:five-bullets", true],
      ["seat_preference", true],
    ],
  );
});

test("without evidence there is no model call, and skipped tasks are still labelled", async (t) => {
  const db = await setup(t);
  await task(db, { source: "responsibility" });
  await task(db, { status: "cancelled" });
  const { adapter, inputs } = model(() => {
    throw new Error("no model call expected");
  });
  const result: any = await learner(db, adapter).tick("owner");
  assert.deepEqual(
    [result.state, result.reviewed, result.modelCalls],
    ["completed", 2, 0],
  );
  assert.equal(inputs.length, 0);
});

test("the learner waits while the owner is active and gives up for the night after three tries", async (t) => {
  const db = await setup(t);
  await task(db, { ownerSays: ["Find me a flight"] });
  await db.query(
    "INSERT INTO conversation_inputs(id,user_id,message) VALUES($1,'owner','hi')",
    [randomUUID()],
  );
  const { adapter, inputs } = model(() => [["learn_finish", { summary: "" }]]);
  for (let i = 0; i < LEARNING_LIMITS.deferrals; i++)
    assert.equal((await learner(db, adapter).tick("owner"))?.state, "deferred");
  await db.query("UPDATE conversation_inputs SET state='completed'");
  assert.equal(await learner(db, adapter).tick("owner"), null);
  assert.equal(inputs.length, 0);
});

test("an owner turn during a run pre-empts it: nothing is applied or labelled, and the next tick retries", async (t) => {
  const db = await setup(t);
  const id = await task(db, { ownerSays: ["I prefer window seats always"] });
  const { adapter } = model(async (_input, n) => {
    if (n === 1) {
      await db.query(
        "INSERT INTO conversation_inputs(id,user_id,message) VALUES($1,'owner','hi')",
        [randomUUID()],
      );
      return [
        [
          "learn_fact",
          {
            key: "seat_preference",
            value: "Prefers window seats",
            quote: "I prefer window seats",
            taskIds: [id],
            reason: "Stated",
          },
        ],
      ];
    }
    throw new Error("pre-empted before a second call");
  });
  assert.equal((await learner(db, adapter).tick("owner"))?.state, "deferred");
  assert.deepEqual(await new MemoryStore(db).active("owner"), []);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM learning_reviews")).rows[0].n,
    0,
  );
  await db.query("UPDATE conversation_inputs SET state='completed'");
  const retry = model(() => [
    [
      "learn_fact",
      {
        key: "seat_preference",
        value: "Prefers window seats",
        quote: "I prefer window seats",
        taskIds: [id],
        reason: "Stated",
      },
    ],
    ["learn_finish", { summary: "" }],
  ]);
  assert.equal(
    (await learner(db, retry.adapter).tick("owner"))?.state,
    "completed",
  );
  assert.equal(
    (await new MemoryStore(db).active("owner"))[0]?.value,
    "Prefers window seats",
  );
});

test("the learner retires only learned items, never the owner's own facts", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  await store.write("owner", {
    key: "style",
    value: "Concise",
    kind: "fact",
    origin: "owner",
    reason: "r",
    source: {},
  });
  const id = await task(db, { ownerSays: ["Find me a flight"] });
  const { adapter } = model(() => [
    ["learn_retire", { key: "style", reason: "stale", taskIds: [id] }],
    ["learn_finish", { summary: "" }],
  ]);
  const result: any = await learner(db, adapter).tick("owner");
  assert.equal(result.retired, 0);
  assert.equal((await store.active("owner"))[0]?.value, "Concise");
});

test("a run interrupted by a restart is marked failed, and a disabled learner never runs", async (t) => {
  const db = await setup(t);
  await db.query(
    "INSERT INTO learner_runs(id,user_id,state,prompt_version) VALUES($1,'owner','running','v')",
    [randomUUID()],
  );
  const { adapter, inputs } = model(() => [["learn_finish", { summary: "" }]]);
  await learner(db, adapter).recover();
  assert.equal(
    (await db.query("SELECT state FROM learner_runs")).rows[0].state,
    "failed",
  );
  await task(db, { ownerSays: ["Find me a flight"] });
  const off = new Learner(db, {
    model: adapter,
    modelName: "m",
    clock: () => NIGHT,
    enabled: false,
  });
  assert.equal(await off.tick("owner"), null);
  assert.equal(inputs.length, 0);
});
