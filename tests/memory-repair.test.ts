import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { Database } from "../src/db.js";
import { Learner } from "../src/learning.js";
import { isNote, MemoryChanged, MemoryStore } from "../src/memory.js";
import { JUDGE_PROMPT_VERSION, shownInTurn } from "../src/memory-judge.js";
import {
  gateOpen,
  REPAIR_LIMITS,
  REPAIR_PROMPT_VERSION,
} from "../src/memory-repair.js";
import type { Generation, ModelAdapter } from "../src/model.js";
import { projectEventRecord } from "../src/ops-log.js";
import { action } from "../src/protocol.js";
import { JobTools } from "../src/tools.js";
import { closeAfter, migratedPGlite } from "./helpers/pglite.js";

const DAY = 24 * 3600_000;
// 04:00 Singapore on 28 November 2026.
const NIGHT = new Date("2026-11-27T20:00:00Z");

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner')");
  await db.query("INSERT INTO conversations(user_id) VALUES('owner')");
  return db;
}

type Call = [string, Record<string, unknown>];
function model(script: (input: any, n: number) => Call[]) {
  const inputs: any[] = [];
  const adapter: ModelAdapter = {
    generate: async (input): Promise<Generation> => {
      inputs.push(JSON.parse(JSON.stringify(input)));
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: script(input, inputs.length).map(([name, args]) => ({
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
    judgeChecks: false,
  });
const repair = (db: Database, adapter: ModelAdapter, now = NIGHT) =>
  (learner(db, adapter, now) as any).runRepair("owner", now) as Promise<
    Record<string, any>
  >;
const due = (db: Database, now = NIGHT) =>
  (learner(db, model(() => []).adapter, now) as any).repairDue(
    "owner",
    now,
  ) as Promise<boolean>;

/** A message of the owner's, as a turn's input. */
async function said(db: Database, message: string, ago = 3 * DAY) {
  const run = randomUUID();
  const at = new Date(NIGHT.getTime() - ago);
  await db.query(
    "INSERT INTO runtime_runs(id,user_id,state,stop_reason,started_at) VALUES($1,'owner','stopped','answer',$2)",
    [run, at],
  );
  const id = randomUUID();
  await db.query(
    "INSERT INTO conversation_inputs(id,user_id,run_id,message,state,received_at) VALUES($1,'owner',$2,$3,'completed',$4)",
    [id, run, message, at],
  );
  return id;
}

let ordinal = 1000;
/** Chief's reply in the turn of one of the owner's messages. */
async function replied(db: Database, input: string, reply: string) {
  const run = (
    await db.query("SELECT run_id FROM conversation_inputs WHERE id=$1", [
      input,
    ])
  ).rows[0].run_id as string;
  const payload = { role: "assistant", content: reply };
  const hash = createHash("sha256")
    .update(JSON.stringify(payload) + ++ordinal)
    .digest("hex");
  await db.query(
    "INSERT INTO message_contents(user_id,hash,payload,characters) VALUES('owner',$1,$2::jsonb,$3)",
    [hash, JSON.stringify(payload), reply.length],
  );
  await db.query(
    "INSERT INTO conversation_messages(user_id,ordinal,hash,run_id) VALUES('owner',$1,$2,$3)",
    [ordinal, hash, run],
  );
}

/** A learned fact resting on one message. */
async function learned(
  db: Database,
  key: string,
  value: string,
  message: string,
  source: Record<string, unknown> = {},
) {
  const input = await said(db, message);
  return new MemoryStore(db).write("owner", {
    key,
    value,
    kind: "fact",
    origin: "learned",
    reason: "test",
    source: {
      messageIds: [input],
      support: [{ id: input, date: "2026-11-24" }],
      seenDays: ["2026-11-24"],
      durability: "standing",
      ...source,
    },
    untrustedSources: ["web"],
  });
}

/** A past judge run, with the events it left. */
async function judged(
  db: Database,
  events: Array<[string, Record<string, unknown>]>,
  ago = DAY,
  version: string = JUDGE_PROMPT_VERSION,
) {
  const run = randomUUID();
  const at = new Date(NIGHT.getTime() - ago);
  await db.query(
    "INSERT INTO runtime_runs(id,user_id,state,stop_reason,started_at) VALUES($1,'owner','stopped','answer',$2)",
    [run, at],
  );
  await db.query(
    `INSERT INTO learner_runs(id,user_id,run_id,state,model,prompt_version,started_at,finished_at)
     VALUES($1,'owner',$2,'completed','test/model',$4,$3,$3)`,
    [randomUUID(), run, at, version],
  );
  for (const [type, data] of events)
    await db.query(
      "INSERT INTO events(run_id,user_id,type,data,created_at) VALUES($1,'owner',$2,$3::jsonb,$4)",
      [run, type, JSON.stringify(data), at],
    );
}

const verdict = (
  fact: { id: string },
  v: string,
  reason = "One request, not a habit",
): [string, Record<string, unknown>] => [
  "judge.fact",
  { revisionId: fact.id, verdict: v, reason },
];

/** The judge's record against planted errors: broken copies caught, controls passed. */
const record = (
  caught: number,
  missed: number,
  passed: number,
  faulted: number,
): Array<[string, Record<string, unknown>]> => [
  ...Array.from(
    { length: caught },
    () =>
      ["judge.probe", { mutation: "negated", verdict: "contradicted" }] as [
        string,
        Record<string, unknown>,
      ],
  ),
  ...Array.from(
    { length: missed },
    () =>
      ["judge.probe", { mutation: "detail", verdict: "supported" }] as [
        string,
        Record<string, unknown>,
      ],
  ),
  ...Array.from(
    { length: passed },
    () =>
      ["judge.probe", { mutation: "control", verdict: "supported" }] as [
        string,
        Record<string, unknown>,
      ],
  ),
  ...Array.from(
    { length: faulted },
    () =>
      ["judge.probe", { mutation: "control", verdict: "overstated" }] as [
        string,
        Record<string, unknown>,
      ],
  ),
];
const good = record(8, 0, 8, 0);

const shown = (input: any) => JSON.parse(input.messages[1].content);
const results = (input: any) =>
  input.messages
    .filter((m: any) => m.role === "tool")
    .map((m: any) => JSON.parse(m.content));
const head = async (db: Database, key: string) =>
  (await new MemoryStore(db).active("owner")).find((r) => r.key === key);
const events = async (db: Database, type: string) =>
  (
    await db.query("SELECT data FROM events WHERE type=$1 ORDER BY id", [type])
  ).rows.map((r) => r.data as Record<string, any>);

test("the gate opens only on a judge that catches planted errors and passes the controls", () => {
  assert.equal(
    gateOpen({ probes: 8, caught: 8, controls: 8, falseAlarms: 0 }),
    true,
  );
  assert.equal(
    gateOpen({ probes: 8, caught: 6, controls: 8, falseAlarms: 2 }),
    true,
  );
  // Too few tests yet to say anything.
  assert.equal(
    gateOpen({ probes: 7, caught: 7, controls: 8, falseAlarms: 0 }),
    false,
  );
  assert.equal(
    gateOpen({ probes: 8, caught: 8, controls: 7, falseAlarms: 0 }),
    false,
  );
  // It misses too many broken copies.
  assert.equal(
    gateOpen({ probes: 8, caught: 5, controls: 8, falseAlarms: 0 }),
    false,
  );
  // It faults everything, so catching the broken ones proves nothing.
  assert.equal(
    gateOpen({ probes: 8, caught: 8, controls: 8, falseAlarms: 3 }),
    false,
  );
  assert.equal(
    gateOpen({ probes: 0, caught: 0, controls: 0, falseAlarms: 0 }),
    false,
  );
});

test("an overstated preference is rewritten as a note of the occasion, in one run that a rollback undoes", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  const seat = await learned(
    db,
    "seat",
    "Prefers aisle seats",
    "Get me an aisle seat on the Tokyo flight",
  );
  await judged(db, [verdict(seat, "overstated"), ...good]);
  assert.equal(await due(db), true);
  assert.deepEqual(
    (await store.select("owner")).learned.map((l) => l.key),
    ["seat"],
  );
  const { adapter, inputs } = model(() => [
    [
      "repair_fact",
      {
        fact: "r1",
        value: "Asked for an aisle seat on the Tokyo flight",
        quote: "Get me an aisle seat on the Tokyo flight",
        durability: "one_off",
        reason: "One request for one flight",
      },
    ],
    ["repair_finish", {}],
  ]);
  const result = await repair(db, adapter);
  // The model reads the fact, the judge's verdict and reason, and the owner's message.
  assert.deepEqual(shown(inputs[0]), {
    facts: [
      {
        id: "r1",
        fact: "Prefers aisle seats",
        judge: { verdict: "overstated", reason: "One request, not a habit" },
        ownerMessages: [
          {
            day: "2026-11-24",
            text: "Get me an aisle seat on the Tokyo flight",
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    inputs[0].tools.map((tool: any) => tool.name),
    ["repair_fact", "repair_retire", "repair_keep", "repair_finish"],
  );
  assert.deepEqual(
    [
      result.state,
      result.candidates,
      result.narrowed,
      result.retired,
      result.kept,
    ],
    ["completed", 1, 1, 0, 0],
  );
  const note = (await head(db, "seat"))!;
  assert.equal(note.value, "Asked for an aisle seat on the Tokyo flight");
  assert.equal(isNote(note), true);
  assert.deepEqual(
    [note.origin, note.learner_run, note.untrusted_sources],
    ["learned", result.learnerRun, ["web"]],
  );
  // What it rested on is kept; how it came to change is recorded.
  assert.deepEqual(
    [
      note.source.repairedFrom,
      note.source.judged,
      note.source.repairs,
      note.source.promptVersion,
      (note.source.messageIds as string[]).length,
    ],
    [seat.id, "overstated", 1, REPAIR_PROMPT_VERSION, 1],
  );
  // A note is out of every turn, which is the point: the misfire stops.
  assert.deepEqual((await store.select("owner")).learned, []);
  assert.deepEqual(
    (await events(db, "repair.applied")).map((e) => [
      e.key,
      e.action,
      e.judged,
    ]),
    [["seat", "narrowed", "overstated"]],
  );
  // Nothing is left to repair, so the next tick opens no run.
  assert.equal(await due(db), false);
  // One rollback of the run puts the night back as it was.
  await store.rollback("owner", { learnerRun: result.learnerRun }, "test");
  assert.equal((await head(db, "seat"))!.value, "Prefers aisle seats");
  assert.deepEqual(
    (await store.select("owner")).learned.map((l) => l.key),
    ["seat"],
  );
  const line: any = projectEventRecord("learner.finished", "run", {
    state: result.state,
    ...result,
  });
  assert.deepEqual(
    [
      line.candidateCount,
      line.narrowedCount,
      line.retiredCount,
      line.keptCount,
    ],
    [1, 1, 0, 0],
  );
  assert.doesNotMatch(JSON.stringify(line), /aisle|Tokyo/);
});

test("a rewrite must stay inside the owner's words; a refused one gets one correction", async (t) => {
  const db = await setup(t);
  const seat = await learned(
    db,
    "seat",
    "Prefers aisle seats",
    "Get me an aisle seat on the Tokyo flight",
  );
  const diet = await learned(db, "diet", "Is vegan", "I am vegetarian, mostly");
  await judged(db, [
    verdict(seat, "overstated"),
    verdict(diet, "overstated", "Vegetarian, not vegan"),
    ...good,
  ]);
  const quote = "Get me an aisle seat on the Tokyo flight";
  const fact = (extra: Record<string, unknown>): Call => [
    "repair_fact",
    { fact: "r1", quote, durability: "one_off", reason: "Test", ...extra },
  ];
  const { adapter, inputs } = model((_input, n) =>
    n === 1
      ? [
          // Still a habit; a note that claims one; words that are not the owner's; a quote
          // from nowhere; no change at all; and an overstated fact cannot be retired.
          fact({
            value: "Prefers aisle seats on flights",
            durability: "standing",
          }),
          fact({ value: "Always asked for an aisle seat" }),
          fact({
            value: "Wants an aisle seat near the front",
            durability: "standing",
          }),
          fact({
            value: "Asked for an aisle seat",
            quote: "I love aisle seats",
          }),
          fact({
            value: "Asked for an aisle seat",
            durability: "time_bound",
            until: "2026-11-01",
          }),
          ["repair_retire", { fact: "r1", reason: "Not a preference" }],
          [
            "repair_fact",
            {
              fact: "r2",
              value: "Is vegan",
              quote: "I am vegetarian, mostly",
              durability: "standing",
              reason: "Same",
            },
          ],
          [
            "repair_fact",
            {
              fact: "r9",
              value: "x y z",
              quote,
              durability: "one_off",
              reason: "Test",
            },
          ],
        ]
      : [
          fact({ value: "Asked for an aisle seat on the Tokyo flight" }),
          // A general statement, in the owner's own words: it may stay standing.
          [
            "repair_fact",
            {
              fact: "r2",
              value: "Is mostly vegetarian",
              quote: "I am vegetarian, mostly",
              durability: "standing",
              reason: "What was said",
            },
          ],
          ["repair_finish", {}],
        ],
  );
  const result = await repair(db, adapter);
  assert.equal(inputs.length, REPAIR_LIMITS.modelCalls);
  const refusals = results(inputs[1]).map((r: any) => r.refused ?? "accepted");
  assert.match(refusals[0], /a quote in which the owner speaks generally/);
  assert.match(refusals[1], /claims no habit/);
  assert.match(refusals[2], /only the owner's words/);
  assert.match(refusals[3], /exact words in this fact's messages/);
  assert.match(refusals[4], /already ended/);
  assert.match(refusals[5], /Only a contradicted fact is retired/);
  // "Vegan" is not a word of the owner's at all.
  assert.match(refusals[6], /must come from the quote/);
  assert.match(refusals[7], /no fact r9/);
  assert.match(inputs[1].messages.at(-1).content, /r1, r2/);
  assert.deepEqual([result.narrowed, result.refused], [2, 8]);
  assert.equal(isNote((await head(db, "seat"))!), true);
  const fixed = (await head(db, "diet"))!;
  assert.deepEqual(
    [fixed.value, isNote(fixed), fixed.source.durability],
    ["Is mostly vegetarian", false, "standing"],
  );
  // Every proposal is kept for reading, as the model sent it.
  assert.equal((await events(db, "repair.proposal")).length, 11);
});

test("a contradicted fact may be retired, a fact the repair keeps is not sent again, and the owner's key is left alone", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  const gym = await learned(
    db,
    "gym",
    "Goes to the gym on Mondays",
    "Is the gym open on Monday?",
  );
  const tea = await learned(
    db,
    "tea",
    "Drinks green tea",
    "I drink green tea every morning",
  );
  const changed = await learned(
    db,
    "city",
    "Lives in Penang",
    "I am in Penang this week",
  );
  await judged(db, [
    verdict(gym, "contradicted", "The owner says the opposite"),
    verdict(tea, "overstated", "Adds nothing; the judge was wrong"),
    verdict(changed, "overstated"),
    ...good,
  ]);
  const { adapter } = model(() => {
    return [
      [
        "repair_retire",
        { fact: "r1", reason: "The owner only asked a question" },
      ],
      ["repair_keep", { fact: "r2", reason: "The owner said exactly this" }],
      [
        "repair_fact",
        {
          fact: "r3",
          value: "Was in Penang for a week",
          quote: "I am in Penang this week",
          durability: "one_off",
          reason: "One week",
        },
      ],
    ];
  });
  // The owner corrects the third fact while the repair is thinking about it.
  const racing: ModelAdapter = {
    generate: async (input) => {
      await store.write("owner", {
        key: "city",
        value: "Lives in Singapore",
        kind: "fact",
        origin: "owner",
        reason: "test",
        source: {},
      });
      return adapter.generate(input);
    },
  };
  const result = await repair(db, racing);
  assert.deepEqual(
    [result.retired, result.kept, result.narrowed, result.untouched],
    [1, 1, 0, 1],
  );
  assert.equal(await head(db, "gym"), undefined);
  const last = (await store.history("owner", "gym")).at(-1)!;
  assert.deepEqual([last.status, last.origin], ["retired", "learned"]);
  assert.match(
    last.reason,
    /^The judge found it contradicted\. The owner only asked/,
  );
  // The learner's retirement leaves the key open to newer evidence.
  assert.deepEqual(await store.removed("owner"), []);
  assert.equal((await head(db, "tea"))!.id, tea.id);
  assert.equal((await head(db, "city"))!.value, "Lives in Singapore");
  assert.deepEqual(
    (await events(db, "repair.applied")).map((e) => [e.key, e.action]),
    [
      ["gym", "retired"],
      ["tea", "kept"],
      ["city", "skipped_changed"],
    ],
  );
  // Kept is final for that revision; the owner's fact is no longer a learned one.
  assert.equal(await due(db), false);
});

test("the repair waits for a judge that has earned it, and leaves contested verdicts and repeat offenders alone", async (t) => {
  const db = await setup(t);
  const seat = await learned(
    db,
    "seat",
    "Prefers aisle seats",
    "Get me an aisle seat on the Tokyo flight",
  );
  const { adapter, inputs } = model(() => [["repair_finish", {}]]);
  const versions = async () =>
    (
      await db.query(
        "SELECT prompt_version FROM learner_runs WHERE prompt_version NOT LIKE 'judge-%' ORDER BY started_at,finished_at",
      )
    ).rows.map((r) => r.prompt_version.split("-")[0]);
  const night = async (now: Date) => {
    for (let i = 0; i < 8; i++)
      if (!(await learner(db, adapter, now).tick("owner"))) break;
  };
  // A faulted fact, but the judge has not been tested: nothing runs.
  await judged(db, [verdict(seat, "overstated")]);
  assert.equal(await due(db), false);
  // Tested, and it misses half the planted errors.
  await judged(db, record(4, 4, 8, 0));
  assert.equal(await due(db), false);
  await night(NIGHT);
  assert.ok(!(await versions()).includes("repair"));
  // The night's other passes may call the model; the repair did not.
  const repairCalls = () =>
    inputs.filter((i) => i.messages[0].content.startsWith("You repair")).length;
  assert.equal(repairCalls(), 0);
  // Old results fall out of the window; a good recent record opens the gate.
  const later = new Date(NIGHT.getTime() + 20 * DAY);
  await judged(db, good, -19 * DAY);
  assert.equal(await due(db, later), true);
  // The repair is the night's last pass, once.
  await night(later);
  assert.equal((await versions()).at(-1), "repair");
  assert.equal((await versions()).filter((v) => v === "repair").length, 1);
  assert.equal(repairCalls(), REPAIR_LIMITS.modelCalls);
  // A verdict the second model or a repeat contested is not acted on.
  await judged(
    db,
    [
      [
        "judge.check",
        {
          kind: "fact",
          revisionId: seat.id,
          first: "overstated",
          repeats: ["overstated", "overstated"],
          second: "supported",
        },
      ],
    ],
    -19 * DAY,
  );
  assert.equal(await due(db, later), false);
  const diet = await learned(db, "diet", "Is vegan", "I am vegetarian", {
    repairs: REPAIR_LIMITS.attempts,
  });
  await judged(db, [verdict(diet, "overstated")], -19 * DAY);
  // Repaired as often as allowed already: left for the owner.
  assert.equal(await due(db, later), false);
});

test("the owner forgets or narrows a memory by saying so, and the learner does not bring it back", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  const tools = new JobTools(db, { call: async () => ({}) });
  await learned(db, "seat", "Prefers aisle seats", "Get me an aisle seat");
  await store.write("owner", {
    key: "lesson:procedure:flights",
    value: "Offer morning flights first",
    kind: "lesson",
    origin: "learned",
    reason: "test",
    source: {},
  });
  const run = randomUUID();
  // "No, I prefer the window": the same key, corrected in the owner's words, and theirs now.
  await tools.execute("owner", run, {
    operation: "memory_set",
    key: "seat",
    value: "Prefers window seats",
  });
  const corrected = (await head(db, "seat"))!;
  assert.deepEqual(
    [corrected.origin, corrected.value],
    ["owner", "Prefers window seats"],
  );
  // "Forget that", for a fact and for a learned procedure.
  assert.deepEqual(
    await tools.execute("owner", run, {
      operation: "memory_forget",
      key: "seat",
      reason: "The owner said to forget it",
    }),
    { forgotten: true, key: "seat" },
  );
  assert.deepEqual(
    await tools.execute("owner", run, {
      operation: "memory_forget",
      key: "lesson:procedure:flights",
    }),
    { forgotten: true, key: "lesson:procedure:flights" },
  );
  assert.deepEqual(
    await tools.execute("owner", run, {
      operation: "memory_forget",
      key: "never_saved",
    }),
    { forgotten: false, reason: "No memory is saved under that key" },
  );
  assert.deepEqual(await store.active("owner"), []);
  const last = (await store.history("owner", "seat")).at(-1)!;
  assert.deepEqual(
    [last.status, last.origin, last.reason, last.source.runId],
    ["retired", "owner", "The owner said to forget it", run],
  );
  // Both are now keys the learner may not propose again.
  assert.deepEqual(
    (await store.removed("owner")).map((r) => r.key),
    ["lesson:procedure:flights", "seat"],
  );
  // The tool takes any saved key's shape and nothing else, and only the coordinator has it.
  assert.equal(
    action.safeParse({ operation: "memory_forget", key: "Seat Preference!" })
      .success,
    false,
  );
  assert.equal(
    action.safeParse({ operation: "memory_forget", key: "seat", extra: 1 })
      .success,
    false,
  );
});

test("the ledger ranks learned memory for pruning: faulted first, then acted against, then never relevant", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  const seat = await learned(
    db,
    "seat",
    "Prefers aisle seats",
    "Get me an aisle seat",
  );
  const diet = await learned(db, "diet", "Is vegetarian", "I am vegetarian");
  const idle = await learned(db, "idle", "Has a boat", "I have a boat");
  await learned(db, "note", "Asked for a taxi", "Get me a taxi", {
    durability: "one_off",
  });
  await store.write("owner", {
    key: "home",
    value: "Lives in Singapore",
    kind: "fact",
    origin: "owner",
    reason: "test",
    source: {},
  });
  const turnRun = randomUUID();
  await db.query(
    "INSERT INTO runtime_runs(id,user_id,state) VALUES($1,'owner','stopped')",
    [turnRun],
  );
  await db.query(
    "INSERT INTO memory_context(run_id,user_id,selected,chars) VALUES($1,'owner',$2::uuid[],10)",
    [turnRun, [seat.id, diet.id, idle.id]],
  );
  await judged(db, [
    verdict(seat, "overstated"),
    verdict(diet, "supported"),
    [
      "judge.turn",
      {
        turnRunId: turnRun,
        state: "judged",
        relevant: [
          { key: "diet", use: "unclear", claimed: "contradicted" },
          { key: "seat", use: "followed" },
        ],
        restated: [{ key: "diet" }],
      },
    ],
  ]);
  const sql = (await readFile("scripts/memory-ledger.sql", "utf8")).replace(
    /^--.*$/gm,
    "",
  );
  const rows = (await db.query(sql)).rows.map((r) =>
    Object.values(r).map(String),
  );
  assert.deepEqual(
    rows.map((r) => [
      r[1],
      r[2],
      r[5],
      r[6],
      r[8],
      r[9],
      r[10],
      r[11],
      r[12],
      r[13],
    ]),
    [
      // key, kind, days seen, verdict, in context, relevant, followed, ignored, against, restated
      ["seat", "fact", "1", "overstated", "1", "1", "1", "0", "0", "0"],
      ["diet", "fact", "1", "supported", "1", "1", "0", "0", "1", "1"],
      ["idle", "fact", "1", "", "1", "0", "0", "0", "0", "0"],
      ["note", "note", "1", "", "0", "0", "0", "0", "0", "0"],
    ],
  );
  // The owner's own facts are theirs and are not in it.
  assert.ok(!rows.some((r) => r[1] === "home"));
});

test("evidence is whole words of the turn, so a fragment quotes nothing", () => {
  const turn = {
    id: "t1",
    runId: "run",
    date: "2026-11-25",
    owner: "Send the report",
    reply: "Sent the weekly report to Priya.",
    calls: [],
    memories: [],
  };
  assert.equal(shownInTurn(turn, "weekly report"), true);
  assert.equal(shownInTurn(turn, "the weekly report to Priya"), true);
  assert.equal(shownInTurn(turn, "nt the wee"), false);
  assert.equal(shownInTurn(turn, "eekly repor"), false);
});

test("a rewrite cannot widen a fact by calling it dated, fill out a note, or turn a note back into a fact", async (t) => {
  const db = await setup(t);
  const seat = await learned(
    db,
    "seat",
    "Prefers aisle seats",
    "Get me an aisle seat on the Tokyo flight",
  );
  const tea = await learned(
    db,
    "tea",
    "Asked for a green tea",
    "Order a green tea for me",
    { durability: "one_off" },
  );
  const gym = await learned(
    db,
    "gym",
    "Goes to the gym on Mondays",
    "Is the gym open on Monday?",
  );
  await judged(db, [
    verdict(seat, "overstated"),
    verdict(tea, "overstated", "Adds nothing"),
    verdict(gym, "unsupported", "A question"),
    ...good,
  ]);
  const quote = "Get me an aisle seat on the Tokyo flight";
  const { adapter, inputs } = model((_input, n) =>
    n === 1
      ? [
          // Broader than the fault it repairs, and still in every turn, under another name.
          [
            "repair_fact",
            {
              fact: "r1",
              value: "Aisle seat on all flights",
              quote,
              durability: "time_bound",
              until: "2027-06-01",
              reason: "Test",
            },
          ],
          [
            "repair_fact",
            {
              fact: "r1",
              value: "Aisle seat on the Tokyo flight",
              quote,
              durability: "time_bound",
              until: "2099-12-31",
              reason: "Test",
            },
          ],
          // A note filled out with things the owner never said.
          [
            "repair_fact",
            {
              fact: "r1",
              value:
                "Asked Chief to email the accountant about aisle seat invoices",
              quote,
              durability: "one_off",
              reason: "Test",
            },
          ],
          // A note stays a note.
          [
            "repair_fact",
            {
              fact: "r2",
              value: "Green tea for me",
              quote: "Order a green tea for me",
              durability: "standing",
              reason: "Test",
            },
          ],
          [
            "repair_fact",
            {
              fact: "r2",
              value: "Green tea for me",
              quote: "Order a green tea for me",
              durability: "time_bound",
              until: "2026-12-05",
              reason: "Test",
            },
          ],
          // The owner may have backed it with something the repair cannot see.
          ["repair_retire", { fact: "r3", reason: "Only a question" }],
        ]
      : [["repair_finish", {}]],
  );
  const result = await repair(db, adapter);
  const refusals = results(inputs[1]).map((r: any) => r.refused ?? "accepted");
  assert.match(refusals[0], /must use only the owner's words from the quote/);
  assert.match(refusals[1], /more than a year away/);
  assert.match(refusals[2], /adds to what the owner said/);
  assert.match(refusals[3], /stays one/);
  assert.match(refusals[4], /stays one/);
  assert.match(refusals[5], /Only a contradicted fact is retired/);
  // Nothing was accepted, so nothing changed.
  assert.deepEqual(
    [result.narrowed, result.retired, result.untouched],
    [0, 0, 3],
  );
  assert.equal((await head(db, "seat"))!.id, seat.id);
  assert.equal((await head(db, "tea"))!.id, tea.id);
  assert.equal((await head(db, "gym"))!.id, gym.id);
});

test("a change decided against one revision is not written over another: the owner's save wins", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  const seat = await learned(
    db,
    "seat",
    "Prefers aisle seats",
    "Get me an aisle seat",
  );
  const theirs = await store.write("owner", {
    key: "seat",
    value: "Prefers window seats",
    kind: "fact",
    origin: "owner",
    reason: "test",
    source: {},
  });
  // The repair read the learned revision; by the time it writes, the owner has saved theirs.
  await assert.rejects(
    store.write("owner", {
      key: "seat",
      value: "Asked for an aisle seat",
      kind: "fact",
      origin: "learned",
      reason: "test",
      source: {},
      expect: seat.id,
    }),
    MemoryChanged,
  );
  await assert.rejects(
    store.retire(
      "owner",
      "seat",
      { origin: "learned", reason: "test", expect: seat.id },
      {},
    ),
    MemoryChanged,
  );
  const current = (await head(db, "seat"))!;
  assert.deepEqual(
    [current.id, current.value],
    [theirs.id, "Prefers window seats"],
  );
  assert.equal((await store.history("owner", "seat")).length, 2);
  // Against the revision that is current, it goes through.
  const ok = await store.write("owner", {
    key: "seat",
    value: "Prefers window seats on long flights",
    kind: "fact",
    origin: "owner",
    reason: "test",
    source: {},
    expect: theirs.id,
  });
  assert.equal((await head(db, "seat"))!.id, ok.id);
});

test("facts with no messages left do not hold the queue, and only the current judge's verdicts and record count", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  // More faulted facts than a night takes, none with a message to rewrite from.
  const orphans = [];
  for (let i = 0; i < REPAIR_LIMITS.perNight * 4 + 2; i++)
    orphans.push(
      await store.write("owner", {
        key: `orphan_${String.fromCharCode(97 + i)}`,
        value: `Orphan fact ${i}`,
        kind: "fact",
        origin: "learned",
        reason: "test",
        // Half cite nothing; half cite a message that no longer exists.
        source: i % 2 ? { messageIds: [randomUUID()] } : {},
      }),
    );
  const seat = await learned(
    db,
    "seat",
    "Prefers aisle seats",
    "Get me an aisle seat on the Tokyo flight",
  );
  // An earlier judge prompt faulted them all, and has a perfect record of its own.
  await judged(
    db,
    [
      ...orphans.map((o) => verdict(o, "overstated")),
      verdict(seat, "overstated"),
      ...good,
    ],
    2 * DAY,
    "judge-v1",
  );
  // Neither its verdicts nor its record open the repair.
  assert.equal(await due(db), false);
  // The judge reads those faults again under the current prompt, beside anything new.
  const rows = await (
    learner(db, model(() => []).adapter) as any
  ).judgeFactRows(
    "owner",
    { at: new Date(NIGHT.getTime() + DAY).toISOString(), id: seat.id },
    100,
  );
  assert.equal(rows.length, orphans.length + 1);
  // Faulted again by the current judge, with a record that passes the gate.
  await judged(db, [
    ...orphans.map((o) => verdict(o, "overstated")),
    verdict(seat, "overstated"),
    ...good,
  ]);
  assert.equal(await due(db), true);
  const { adapter, inputs } = model(() => [
    [
      "repair_fact",
      {
        fact: "r1",
        value: "Asked for an aisle seat on the Tokyo flight",
        quote: "Get me an aisle seat on the Tokyo flight",
        durability: "one_off",
        reason: "One flight",
      },
    ],
  ]);
  const result = await repair(db, adapter);
  // The one fact that can be repaired is reached past all those that cannot.
  assert.deepEqual(
    shown(inputs[0]).facts.map((f: any) => f.fact),
    ["Prefers aisle seats"],
  );
  assert.deepEqual([result.candidates, result.narrowed], [1, 1]);
  // Once the current judge's verdict on a fact is "supported", the older fault is spent.
  const rejudged = await (
    learner(db, model(() => []).adapter) as any
  ).judgeFactRows(
    "owner",
    { at: new Date(NIGHT.getTime() + DAY).toISOString(), id: seat.id },
    100,
  );
  assert.equal(rejudged.length, 0);
});

test("how often a key was repaired stays with it through new evidence and a rollback", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  const seat = await learned(
    db,
    "seat",
    "Prefers aisle seats",
    "Get me an aisle seat on the Tokyo flight",
    { repairs: 1 },
  );
  await judged(db, [verdict(seat, "overstated"), ...good]);
  const result = await repair(
    db,
    model(() => [
      [
        "repair_fact",
        {
          fact: "r1",
          value: "Asked for an aisle seat on the Tokyo flight",
          quote: "Get me an aisle seat on the Tokyo flight",
          durability: "one_off",
          reason: "One flight",
        },
      ],
    ]).adapter,
  );
  assert.equal((await head(db, "seat"))!.source.repairs, 2);
  // Undoing a later learner run restores a copy that still carries the count.
  const laterRun = randomUUID();
  await db.query(
    `INSERT INTO learner_runs(id,user_id,state,model,prompt_version)
     VALUES($1,'owner','completed','test/model','learner-v6')`,
    [laterRun],
  );
  await store.write("owner", {
    key: "seat",
    value: "Asked for an aisle seat twice",
    kind: "fact",
    origin: "learned",
    reason: "test",
    source: {},
    learnerRun: laterRun,
  });
  assert.equal((await head(db, "seat"))!.source.repairs, undefined);
  await store.rollback("owner", { learnerRun: laterRun }, "test");
  const restored = (await head(db, "seat"))!;
  assert.deepEqual(
    [restored.value, restored.source.repairs, result.narrowed],
    ["Asked for an aisle seat on the Tokyo flight", 2, 1],
  );
});

test("the repair keeps what the owner was pointing at, in brackets backed by Chief's words, and refuses a want carried in them", async (t) => {
  const db = await setup(t);
  const fact = await learned(
    db,
    "browser_check",
    "Checks the library renewal form on the tablet",
    "Can you check if this opens on the tablet",
  );
  const reply =
    "I opened the library renewal form for the two overdue books on the tablet and it loaded.";
  await replied(
    db,
    ((await head(db, "browser_check"))!.source.messageIds as string[])[0]!,
    reply,
  );
  await judged(db, [verdict(fact, "overstated"), ...good]);
  const quote = "check if this opens on the tablet";
  const page = {
    detail: "the library renewal form",
    quote: "the library renewal form for the two overdue books",
  };
  const { adapter, inputs } = model((_input, n) =>
    n === 1
      ? [
          [
            "repair_fact",
            {
              fact: "r1",
              value: "Asked for a tablet check [and prefers the tablet]",
              quote,
              durability: "one_off",
              context: [
                {
                  detail: "and prefers the tablet",
                  quote: "on the tablet and it loaded",
                },
              ],
              reason: "One request",
            },
          ],
          ["repair_finish", {}],
        ]
      : [
          [
            "repair_fact",
            {
              fact: "r1",
              value: `Asked for a tablet check of [${page.detail}]`,
              quote,
              durability: "one_off",
              context: [page],
              reason: "One request, about the form Chief had opened",
            },
          ],
          ["repair_finish", {}],
        ],
  );
  const result = await repair(db, adapter);
  assert.deepEqual(
    [result.state, result.narrowed, result.refused],
    ["completed", 1, 1],
  );
  // The repair reads Chief's reply beside the owner's message, at high effort.
  assert.deepEqual(shown(inputs[0]).facts[0].ownerMessages, [
    {
      day: "2026-11-24",
      text: "Can you check if this opens on the tablet",
      chiefReply: reply,
    },
  ]);
  assert.equal(inputs[0].reasoning, "high");
  assert.match(inputs[0].messages[0].content, /stays, in \[square brackets\]/);
  assert.match(
    results(inputs[1])[0].refused,
    /only names what the owner was referring to/,
  );
  const note = (await head(db, "browser_check"))!;
  assert.equal(isNote(note), true);
  assert.equal(note.value, `Asked for a tablet check of [${page.detail}]`);
  assert.deepEqual(note.source.context, [{ ...page, from: "chief" }]);
  assert.deepEqual(note.flags, ["chief_context"]);
  assert.equal(note.source.promptVersion, "repair-v2");
  assert.equal(REPAIR_PROMPT_VERSION, "repair-v2");
});

test("a choice seen on separate days may stay standing after a repair, and one day's request may not", async (t) => {
  const db = await setup(t);
  const value =
    "For coding jobs, wants a plan first and a clear request for approval";
  const twice = await learned(
    db,
    "plan_first",
    value,
    "Start a fresh coding job. Plan first.",
    {
      seenDays: ["2026-10-11", "2026-11-24"],
    },
  );
  const once = await learned(
    db,
    "plan_once",
    value,
    "Start another coding job. Plan first.",
  );
  await judged(db, [
    verdict(twice, "overstated"),
    verdict(once, "overstated"),
    ...good,
  ]);
  const narrowed = (fact: string) =>
    [
      "repair_fact",
      {
        fact,
        value: "Wants a plan first",
        quote: "Plan first.",
        durability: "standing",
        reason: "Only the plan was asked for",
      },
    ] as Call;
  const { adapter, inputs } = model((_input, n) =>
    n === 1
      ? [narrowed("r1"), narrowed("r2"), ["repair_finish", {}]]
      : [
          ["repair_keep", { fact: "r2", reason: "Left for the owner" }],
          ["repair_finish", {}],
        ],
  );
  const result = await repair(db, adapter);
  assert.deepEqual([result.narrowed, result.kept, result.refused], [1, 1, 1]);
  assert.deepEqual(results(inputs[1])[0], { accepted: true });
  assert.match(
    results(inputs[1])[1].refused,
    /speaks generally, or messages from separate days/,
  );
  const kept = (await head(db, "plan_first"))!;
  assert.equal(kept.value, "Wants a plan first");
  assert.equal(isNote(kept), false);
  assert.equal((await head(db, "plan_once"))!.value, value);
});
