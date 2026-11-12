import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { Database } from "../src/db.js";
import { Learner } from "../src/learning.js";
import { MemoryStore } from "../src/memory.js";
import {
  JUDGE_LIMITS,
  JUDGE_PROMPT_VERSION,
  type JudgeBatch,
  judgePrompt,
  judgeTools,
  newJudgements,
  recordJudgement,
  turnScore,
  unjudged,
} from "../src/memory-judge.js";
import type { Generation, ModelAdapter } from "../src/model.js";
import { projectEventRecord } from "../src/ops-log.js";
import { runSpanId, startTracing, stopTracing } from "../src/otel.js";
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
// The pass itself, without the item and procedure passes a night runs before it.
const judge = (db: Database, adapter: ModelAdapter, now = NIGHT) =>
  (learner(db, adapter, now) as any).runJudge("owner", now) as Promise<
    Record<string, any>
  >;

let ordinal = 0;
/** One owner turn with its reply, tool calls and the memory that was in its context. */
async function turn(
  db: Database,
  o: {
    says: string;
    reply?: string;
    ago?: number;
    calls?: Array<[string, string]>;
    selected: string[];
  },
) {
  const run = randomUUID();
  const at = new Date(NIGHT.getTime() - (o.ago ?? 2 * DAY));
  await db.query(
    "INSERT INTO runtime_runs(id,user_id,state,stop_reason,started_at) VALUES($1,'owner','stopped','answer',$2)",
    [run, at],
  );
  const input = randomUUID();
  await db.query(
    "INSERT INTO conversation_inputs(id,user_id,run_id,message,state,received_at) VALUES($1,'owner',$2,$3,'completed',$4)",
    [input, run, o.says, at],
  );
  for (const [operation, state] of o.calls ?? [])
    await db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state) VALUES($1,$2,$3,$4,'{}',false,$5)",
      [randomUUID(), run, randomUUID(), operation, state],
    );
  if (o.reply !== undefined) {
    const payload = { role: "assistant", content: o.reply };
    const hash = createHash("sha256")
      .update(JSON.stringify(payload) + ++ordinal)
      .digest("hex");
    await db.query(
      "INSERT INTO message_contents(user_id,hash,payload,characters) VALUES('owner',$1,$2::jsonb,$3)",
      [hash, JSON.stringify(payload), o.reply.length],
    );
    await db.query(
      "INSERT INTO conversation_messages(user_id,ordinal,hash,run_id) VALUES('owner',$1,$2,$3)",
      [ordinal, hash, run],
    );
  }
  await db.query(
    "INSERT INTO memory_context(run_id,user_id,selected,chars,created_at) VALUES($1,'owner',$2::uuid[],100,$3)",
    [run, o.selected, at],
  );
  return { run, input };
}

/** A learned fact that cites the owner message it was taken from. */
async function learned(
  db: Database,
  key: string,
  value: string,
  messageIds: string[],
) {
  return new MemoryStore(db).write("owner", {
    key,
    value,
    kind: "fact",
    origin: "learned",
    reason: "test",
    source: { messageIds },
    flags: ["paraphrased"],
  });
}

const events = async (db: Database, type: string) =>
  (
    await db.query("SELECT data FROM events WHERE type=$1 ORDER BY id", [type])
  ).rows.map((r) => r.data as Record<string, any>);

const batch: JudgeBatch = {
  facts: [
    {
      id: "f1",
      revisionId: "r1",
      key: "seat",
      value: "Aisle",
      messages: [{ text: "x" }],
    },
  ],
  memories: [
    {
      id: "m1",
      revisionId: "r1",
      key: "seat",
      kind: "fact",
      learned: true,
      value: "Prefers aisle seats",
    },
    {
      id: "m2",
      revisionId: "r2",
      key: "lesson:procedure:flights",
      kind: "lesson",
      learned: true,
      value: "Offer morning flights first",
    },
  ],
  turns: [
    {
      id: "t1",
      runId: "run",
      date: "2026-11-25",
      owner: "Book a flight",
      reply: "Booked",
      calls: ["flights_search:success"],
      memories: ["m1"],
    },
  ],
};

test("a judgement must name an item of the batch once, and a turn may cite only its own memories", () => {
  const done = newJudgements();
  const fact = { verdict: "supported", reason: "Says so" };
  assert.match(
    recordJudgement("judge_fact", { fact: "f9", ...fact }, batch, done)!,
    /no fact f9/,
  );
  assert.equal(
    recordJudgement("judge_fact", { fact: "f1", ...fact }, batch, done),
    undefined,
  );
  assert.match(
    recordJudgement("judge_fact", { fact: "f1", ...fact }, batch, done)!,
    /already judged/,
  );
  const use = { use: "followed", reason: "Aisle seat booked" };
  assert.match(
    recordJudgement("judge_turn", { turn: "t2", relevant: [] }, batch, done)!,
    /no turn t2/,
  );
  // m2 is in the batch, but was not in this turn's context.
  assert.match(
    recordJudgement(
      "judge_turn",
      { turn: "t1", relevant: [{ memory: "m2", ...use }] },
      batch,
      done,
    )!,
    /m2 was not in the context of t1/,
  );
  assert.match(
    recordJudgement(
      "judge_turn",
      {
        turn: "t1",
        relevant: [
          { memory: "m1", ...use },
          { memory: "m1", ...use },
        ],
      },
      batch,
      done,
    )!,
    /twice/,
  );
  assert.deepEqual(unjudged(batch, done), ["t1"]);
  assert.equal(
    recordJudgement(
      "judge_turn",
      { turn: "t1", relevant: [{ memory: "m1", ...use }] },
      batch,
      done,
    ),
    undefined,
  );
  assert.deepEqual(unjudged(batch, done), []);
  // The tools refuse verdicts outside the fixed lists and IDs of another shape.
  assert.equal(
    judgeTools.judge_fact.safeParse({ fact: "f1", ...fact, verdict: "fine" })
      .success,
    false,
  );
  assert.equal(
    judgeTools.judge_turn.safeParse({ turn: "run-1", relevant: [] }).success,
    false,
  );
});

test("a turn's score is its worst use, and nothing is claimed from unclear ones alone", () => {
  assert.deepEqual(turnScore([]), { relevant: 0 });
  assert.deepEqual(turnScore([{ use: "unclear" }]), { relevant: 1 });
  assert.deepEqual(turnScore([{ use: "followed" }, { use: "unclear" }]), {
    relevant: 2,
    followed: true,
    label: "followed",
  });
  assert.deepEqual(turnScore([{ use: "followed" }, { use: "ignored" }]), {
    relevant: 2,
    followed: false,
    label: "ignored",
  });
  assert.deepEqual(turnScore([{ use: "ignored" }, { use: "contradicted" }]), {
    relevant: 2,
    followed: false,
    label: "contradicted",
  });
});

test("the prompt shows a fact with its messages, and a turn with only the IDs of its memories", () => {
  const shown = JSON.parse(judgePrompt(batch));
  assert.deepEqual(shown.facts, [
    { id: "f1", fact: "Aisle", ownerMessages: [{ text: "x" }] },
  ]);
  assert.deepEqual(shown.turns[0].memories, ["m1"]);
  assert.equal(shown.memories[1].kind, "procedure or lesson");
  // Revision and run IDs stay with the host.
  assert.doesNotMatch(judgePrompt(batch), /"r1"|"run"/);
  assert.deepEqual(
    Object.keys(JSON.parse(judgePrompt({ ...batch, turns: [] }))),
    ["facts"],
  );
});

test("the judge checks a new fact against the message it cites, and a turn against its memories", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  const source = await turn(db, {
    says: "For this trip only, get me an aisle seat",
    reply: "Done",
    selected: [],
  });
  const seat = await learned(db, "seat", "Prefers aisle seats", [source.input]);
  const gone = await learned(db, "gym", "Goes to the gym on Mondays", [
    randomUUID(),
  ]);
  const own = await store.write("owner", {
    key: "home",
    value: "Lives in Singapore",
    kind: "fact",
    origin: "owner",
    reason: "test",
    source: {},
  });
  const flight = await turn(db, {
    // Attachment text after the owner's words is not theirs, and is left out.
    says: "Book me a flight to Tokyo\n\n[Attached: itinerary.pdf]",
    reply: "Booked a window seat on the 9am flight.",
    calls: [
      ["flights_search", "success"],
      ["finish_turn", "success"],
    ],
    selected: [seat.id, own.id],
  });
  // A turn that never answered has nothing to judge.
  const silent = await turn(db, {
    says: "Hello?",
    ago: 1.8 * DAY,
    selected: [seat.id],
  });
  const thanks = await turn(db, {
    says: "thanks",
    reply: "Any time.",
    ago: 1.5 * DAY,
    selected: [seat.id, own.id],
  });
  // Inside the success window: left for tomorrow night.
  await turn(db, {
    says: "And a hotel",
    reply: "Which area?",
    ago: DAY / 2,
    selected: [seat.id],
  });
  const before = (
    await db.query("SELECT count(*)::int n FROM memory_revisions")
  ).rows[0].n;
  const { adapter, inputs } = model((input) => {
    const shown = JSON.parse(input.messages[1].content);
    if (shown.facts)
      return [
        [
          "judge_fact",
          {
            fact: "f1",
            verdict: "overstated",
            reason: "A one-off request for this trip",
          },
        ],
        ["judge_finish", {}],
      ];
    const seatId = shown.memories.find((m: any) => m.key === "seat").id;
    return [
      [
        "judge_turn",
        {
          turn: "t1",
          relevant: [
            {
              memory: seatId,
              use: "contradicted",
              reason: "Booked a window seat",
            },
          ],
        },
      ],
      ["judge_turn", { turn: "t3", relevant: [] }],
      ["judge_finish", {}],
    ];
  });
  const result = await judge(db, adapter);
  assert.equal(result.state, "completed");
  assert.equal(inputs.length, 2);
  // Facts: only the one whose message still exists goes to the model, as the owner's words.
  const facts = JSON.parse(inputs[0].messages[1].content);
  assert.deepEqual(facts, {
    facts: [
      {
        id: "f1",
        fact: "Prefers aisle seats",
        ownerMessages: [{ text: "For this trip only, get me an aisle seat" }],
      },
    ],
  });
  // Turns: the reply, the tool names in order without the turn's bookkeeping calls, and the
  // memories that were in context, the owner's own fact included.
  const turns = JSON.parse(inputs[1].messages[1].content);
  assert.deepEqual(
    turns.memories.map((m: any) => [m.id, m.key, m.kind]),
    [
      ["m1", "home", "fact"],
      ["m2", "seat", "fact"],
    ],
  );
  // The turn the fact came from had no memory in context, so it is not read at all.
  assert.deepEqual(
    turns.turns.map((turn: any) => turn.id),
    ["t1", "t3"],
  );
  assert.deepEqual(turns.turns[0], {
    id: "t1",
    date: "2026-11-25",
    owner: "Book me a flight to Tokyo",
    reply: "Booked a window seat on the 9am flight.",
    calls: ["flights_search:success"],
    memories: ["m1", "m2"],
  });
  assert.deepEqual(
    inputs[1].tools.map((tool: any) => tool.name),
    ["judge_fact", "judge_turn", "judge_finish"],
  );
  // Each judge call asks for its own allowance (owner, 11 November 2026), not the default.
  assert.equal(JUDGE_LIMITS.outputTokens, 32000);
  assert.deepEqual(
    inputs.map((i) => i.maxOutputTokens),
    [32000, 32000],
  );
  assert.deepEqual(
    (await events(db, "judge.fact")).map((e) => [
      e.key,
      e.verdict,
      e.revisionId,
    ]),
    [
      ["seat", "overstated", seat.id],
      ["gym", "no_source", gone.id],
    ],
  );
  const judged = await events(db, "judge.turn");
  assert.deepEqual(
    judged.map((e) => [e.turnRunId, e.state, e.inContext, e.relevant.length]),
    [
      [flight.run, "judged", 2, 1],
      [silent.run, "skipped", 1, 0],
      [thanks.run, "judged", 2, 0],
    ],
  );
  assert.deepEqual(judged[0]!.relevant, [
    {
      revisionId: seat.id,
      key: "seat",
      kind: "fact",
      learned: true,
      use: "contradicted",
      reason: "Booked a window seat",
    },
  ]);
  for (const [key, value] of Object.entries({
    judgedFacts: 1,
    overstated: 1,
    supported: 0,
    noSource: 1,
    turns: 2,
    skippedTurns: 1,
    relevant: 1,
    contradicted: 1,
    followed: 0,
    missed: 0,
    modelCalls: 2,
  }))
    assert.equal(result[key], value, key);
  // The report script reads the same events: verdicts by fact, and use by memory key.
  const report = (await readFile("scripts/judge-report.sql", "utf8"))
    .replace(/^--.*$/gm, "")
    .split(";")
    .filter((sql) => sql.trim());
  const rows = [];
  for (const sql of report)
    rows.push(...(await db.query(sql)).rows.map((r) => Object.values(r)));
  assert.deepEqual(
    rows.filter((r) => r[0] !== "run").map((r) => r.map(String)),
    [
      ["facts", "no_source", "1"],
      ["facts", "overstated", "1"],
      ["fact", "gym", "no_source", "null"],
      ["fact", "seat", "overstated", "A one-off request for this trip"],
      ["use", "seat", "2", "1", "0", "0", "1", "0"],
      ["use", "home", "2", "0", "0", "0", "0", "0"],
    ],
  );
  // It measures only: no revision is written, flagged or retired.
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM memory_revisions")).rows[0].n,
    before,
  );
  assert.equal(
    (
      await db.query("SELECT prompt_version FROM learner_runs WHERE id=$1", [
        result.learnerRun,
      ])
    ).rows[0].prompt_version,
    JUDGE_PROMPT_VERSION,
  );
  // The next night reads only what is new: the turn that has now passed the success window.
  const next = model(() => [
    ["judge_turn", { turn: "t1", relevant: [] }],
    ["judge_finish", {}],
  ]);
  const later = await judge(db, next.adapter, new Date(NIGHT.getTime() + DAY));
  assert.equal(next.inputs.length, 1);
  assert.equal(later.turns, 1);
  assert.equal(later.judgedFacts, 0);
  assert.equal(
    JSON.parse(next.inputs[0].messages[1].content).turns[0].owner,
    "And a hotel",
  );
});

test("a refused or missing judgement gets one reminder, and what is still missing is counted, not repeated", async (t) => {
  const db = await setup(t);
  const seat = await learned(db, "seat", "Prefers aisle seats", []);
  const diet = await learned(db, "diet", "Is vegetarian", []);
  await turn(db, {
    says: "Book a flight",
    reply: "Booked",
    selected: [seat.id],
  });
  await turn(db, {
    says: "Order lunch",
    reply: "Ordered",
    ago: 1.5 * DAY,
    selected: [diet.id],
  });
  const { adapter, inputs } = model((_input, n) =>
    n === 1
      ? // m1 is diet, which was not in the first turn's context; the second turn is left out.
        [
          [
            "judge_turn",
            {
              turn: "t1",
              relevant: [
                { memory: "m1", use: "followed", reason: "Vegetarian meal" },
              ],
            },
          ],
          ["judge_finish", {}],
        ]
      : [
          [
            "judge_turn",
            {
              turn: "t1",
              relevant: [
                { memory: "m2", use: "unclear", reason: "Seat not shown" },
              ],
            },
          ],
        ],
  );
  const result = await judge(db, adapter);
  assert.equal(inputs.length, JUDGE_LIMITS.modelCalls);
  const reminder = inputs[1].messages.at(-1);
  assert.equal(reminder.role, "user");
  assert.match(reminder.content, /t1, t2/);
  assert.match(
    inputs[1].messages.find((m: any) => m.role === "tool").content,
    /m1 was not in the context of t1/,
  );
  assert.equal(result.state, "completed");
  assert.deepEqual(
    [result.turns, result.missed, result.unclear, result.refused],
    [1, 1, 1, 1],
  );
  assert.deepEqual(
    (await events(db, "judge.turn")).map((e) => e.state),
    ["judged", "missed"],
  );
  // Both facts had no message to check, and both turns are behind the mark.
  assert.equal(result.noSource, 2);
  assert.equal(
    await learner(db, adapter)
      .tick("owner")
      .then(() => 1),
    1,
  );
  const again = model(() => [["judge_finish", {}]]);
  await judge(db, again.adapter);
  assert.equal(again.inputs.length, 0);
});

test("an owner turn pre-empts the judge: the batch is not recorded and is read again", async (t) => {
  const db = await setup(t);
  const seat = await learned(db, "seat", "Prefers aisle seats", []);
  const first = await turn(db, {
    says: "Book a flight",
    reply: "Booked",
    selected: [seat.id],
  });
  const waiting = randomUUID();
  const { adapter } = model(async () => {
    await db.query(
      "INSERT INTO conversation_inputs(id,user_id,message) VALUES($1,'owner','hi')",
      [waiting],
    );
    return [["judge_turn", { turn: "t1", relevant: [] }]];
  });
  // The first response leaves nothing unjudged, so the run ends before the owner is seen;
  // a batch of two turns needs a second call, and that is where it stops.
  await turn(db, {
    says: "And a hotel",
    reply: "Which area?",
    ago: 1.5 * DAY,
    selected: [seat.id],
  });
  const result = await judge(db, adapter);
  assert.equal(result.state, "deferred");
  assert.equal(result.reason, "owner_active");
  assert.deepEqual(await events(db, "judge.turn"), []);
  assert.equal(result.through, undefined);
  await db.query(
    "UPDATE conversation_inputs SET state='completed' WHERE id=$1",
    [waiting],
  );
  const retry = model(() => [
    ["judge_turn", { turn: "t1", relevant: [] }],
    ["judge_turn", { turn: "t2", relevant: [] }],
  ]);
  const done = await judge(db, retry.adapter);
  assert.equal(done.state, "completed");
  assert.equal(done.turns, 2);
  assert.equal((await events(db, "judge.turn"))[0]!.turnRunId, first.run);
});

test("a failed model call fails the run and keeps the batches before it", async (t) => {
  const db = await setup(t);
  const source = await turn(db, { says: "I am vegetarian", selected: [] });
  const diet = await learned(db, "diet", "Is vegetarian", [source.input]);
  await turn(db, {
    says: "Order lunch",
    reply: "Ordered",
    selected: [diet.id],
  });
  const { adapter } = model((_input, n) => {
    if (n === 2) throw new Error("provider down");
    return [
      ["judge_fact", { fact: "f1", verdict: "supported", reason: "Says so" }],
    ];
  });
  const result = await judge(db, adapter);
  assert.equal(result.state, "failed");
  assert.equal(result.error, "judge_failed");
  assert.equal(result.supported, 1);
  assert.ok(result.factsThrough && result.factsThroughId);
  assert.equal(result.through, undefined);
  // The fact is not judged twice; the turns are read again.
  const retry = model(() => [["judge_turn", { turn: "t1", relevant: [] }]]);
  const done = await judge(db, retry.adapter);
  assert.equal(retry.inputs.length, 1);
  assert.equal(done.judgedFacts, 0);
  assert.equal(done.turns, 1);
  assert.equal((await events(db, "judge.fact")).length, 1);
});

test("the judge runs last in a night, once, and a night with nothing new opens no run", async (t) => {
  const db = await setup(t);
  const { adapter, inputs } = model(() => [
    ["judge_turn", { turn: "t1", relevant: [] }],
  ]);
  const versions = async () =>
    (
      await db.query(
        "SELECT prompt_version FROM learner_runs ORDER BY started_at,finished_at",
      )
    ).rows.map((r) => r.prompt_version.split("-")[0]);
  // Every tick of one night, until there is nothing left to run.
  const night = async (now: Date) => {
    const states: string[] = [];
    for (let i = 0; i < 8; i++) {
      const result = await learner(db, adapter, now).tick("owner");
      if (!result) break;
      states.push((result as { state: string }).state);
    }
    return states;
  };
  // Nothing to judge: the item pass and any procedure windows, and no judge run.
  assert.ok((await night(NIGHT)).every((s) => s === "completed"));
  assert.ok(!(await versions()).includes("judge"));
  const seat = await learned(db, "seat", "Prefers aisle seats", []);
  await turn(db, {
    says: "Book a flight",
    reply: "Booked",
    selected: [seat.id],
  });
  const next = new Date(NIGHT.getTime() + DAY);
  assert.ok((await night(next)).every((s) => s === "completed"));
  assert.equal((await versions()).at(-1), "judge");
  assert.equal((await versions()).filter((v) => v === "judge").length, 1);
  assert.equal(inputs.length, 1);
  assert.equal(await learner(db, adapter, next).tick("owner"), null);
  // While the owner is active it waits, as the other passes do.
  const third = new Date(NIGHT.getTime() + 2 * DAY);
  await turn(db, {
    says: "And a hotel",
    reply: "Which area?",
    ago: -DAY / 2,
    selected: [seat.id],
  });
  await learner(db, adapter, third).tick("owner");
  await db.query(
    "INSERT INTO conversation_inputs(id,user_id,message) VALUES($1,'owner','hi')",
    [randomUUID()],
  );
  let last: any;
  for (let i = 0; i < 6; i++)
    last = (await learner(db, adapter, third).tick("owner")) ?? last;
  assert.equal(last.state, "deferred");
  assert.equal(inputs.length, 1);
});

test("a judged turn is exported as evaluations on the turn's own trace, and the log line carries counts only", async (t) => {
  const db = await setup(t);
  const seat = await learned(db, "seat", "Prefers aisle seats", []);
  const flight = await turn(db, {
    says: "Book a flight",
    reply: "Booked an aisle seat",
    selected: [seat.id],
  });
  const logs: string[] = [];
  startTracing({
    endpoint: "http://collector/v1/traces",
    logsEndpoint: "http://collector/v1/logs",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v1/logs")) logs.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    intervalMs: 60_000,
  });
  let result: Record<string, any>;
  // The judge's own model answers, not the learner's, and the run is recorded under it.
  const own = model(() => [
    [
      "judge_turn",
      {
        turn: "t1",
        relevant: [
          { memory: "m1", use: "followed", reason: "Aisle seat booked" },
        ],
      },
    ],
  ]);
  const writer = model(() => []);
  try {
    result = await (
      new Learner(db, {
        model: writer.adapter,
        modelName: "writer/model",
        judge: { model: own.adapter, modelName: "judge/model" },
        clock: () => NIGHT,
      }) as any
    ).runJudge("owner", NIGHT);
    assert.equal(writer.inputs.length, 0);
    assert.equal(own.inputs.length, 1);
    assert.equal(
      (
        await db.query("SELECT model FROM learner_runs WHERE id=$1", [
          result!.learnerRun,
        ])
      ).rows[0].model,
      "judge/model",
    );
  } finally {
    await stopTracing(1000);
  }
  const records = logs.flatMap(
    (body) =>
      JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords as Array<{
        traceId: string;
        spanId: string;
        attributes: Array<{ key: string; value: Record<string, unknown> }>;
      }>,
  );
  const value = (record: (typeof records)[number], key: string) =>
    Object.values(record.attributes.find((a) => a.key === key)?.value ?? {})[0];
  assert.deepEqual(
    records.map((r) => [
      value(r, "gen_ai.evaluation.name"),
      String(value(r, "gen_ai.evaluation.score.value")),
      value(r, "gen_ai.evaluation.score.label"),
    ]),
    [
      ["memory_relevant", "1", undefined],
      ["memory_followed", "true", "followed"],
    ],
  );
  for (const record of records) {
    assert.equal(record.traceId, flight.run.replace(/-/g, ""));
    assert.equal(record.spanId, runSpanId(flight.run));
  }
  assert.doesNotMatch(logs.join(""), /aisle|seat/i);
  const line: any = projectEventRecord("learner.finished", "run", {
    state: result!.state,
    ...result!,
  });
  assert.deepEqual(
    [line.turnCount, line.relevantCount, line.followedCount, line.missedCount],
    [1, 1, 1, 0],
  );
  assert.doesNotMatch(JSON.stringify(line), /aisle|seat/i);
});

test("a batch with no verdict at all fails the run and is read again, instead of being marked read", async (t) => {
  const db = await setup(t);
  const seat = await learned(db, "seat", "Prefers aisle seats", []);
  await turn(db, {
    says: "Book a flight",
    reply: "Booked",
    selected: [seat.id],
  });
  // No tool calls, then a malformed one: nothing the host can record.
  const silent = model((_input, n) =>
    n === 1 ? [] : [["judge_turn", { turn: "the first one" }]],
  );
  const result = await judge(db, silent.adapter);
  assert.equal(result.state, "failed");
  assert.equal(result.through, undefined);
  assert.deepEqual(await events(db, "judge.turn"), []);
  const retry = model(() => [["judge_turn", { turn: "t1", relevant: [] }]]);
  assert.equal((await judge(db, retry.adapter)).turns, 1);
});

test("facts written in the same instant across a batch boundary are each judged once", async (t) => {
  const db = await setup(t);
  for (let i = 0; i < JUDGE_LIMITS.facts + 1; i++)
    await learned(
      db,
      `fact_${String.fromCharCode(97 + (i % 26))}_${i}`,
      `Fact ${i}`,
      [],
    );
  await db.query(
    "UPDATE memory_revisions SET created_at='2026-11-20T00:00:00Z' WHERE origin='learned'",
  );
  const { adapter } = model(() => [["judge_finish", {}]]);
  assert.equal((await judge(db, adapter)).noSource, JUDGE_LIMITS.facts);
  assert.equal((await judge(db, adapter)).noSource, 1);
  assert.equal((await judge(db, adapter)).noSource, 0);
  const judged = (await events(db, "judge.fact")).map((e) => e.revisionId);
  assert.equal(judged.length, JUDGE_LIMITS.facts + 1);
  assert.equal(new Set(judged).size, judged.length);
});

test("a turn still running a day later is read as it stands, not passed over", async (t) => {
  const db = await setup(t);
  const seat = await learned(db, "seat", "Prefers aisle seats", []);
  const stuck = await turn(db, { says: "Book a flight", selected: [seat.id] });
  await db.query("UPDATE runtime_runs SET state='running' WHERE id=$1", [
    stuck.run,
  ]);
  const { adapter, inputs } = model(() => [["judge_finish", {}]]);
  const result = await judge(db, adapter);
  assert.equal(inputs.length, 0);
  assert.equal(result.skippedTurns, 1);
  assert.deepEqual(
    (await events(db, "judge.turn")).map((e) => [e.turnRunId, e.state]),
    [[stuck.run, "skipped"]],
  );
});

test("the judge is told a fact's kind and each message's day, so a note or a repeat is judged as what it is", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  const tokyo = await turn(db, {
    says: "Get me an aisle seat on the Tokyo flight",
    reply: "Booked",
    selected: [],
    ago: 4 * DAY,
  });
  const osaka = await turn(db, {
    says: "Aisle seat again for Osaka",
    reply: "Booked",
    selected: [],
    ago: 2 * DAY,
  });
  const write = (key: string, value: string, source: Record<string, unknown>) =>
    store.write("owner", {
      key,
      value,
      kind: "fact",
      origin: "learned",
      reason: "test",
      source,
    });
  await write("a_note", "Asked for an aisle seat on the Tokyo flight", {
    durability: "one_off",
    messageIds: [tokyo.input],
    support: [{ id: tokyo.input, date: "2026-11-23" }],
  });
  await write("b_repeat", "Prefers aisle seats", {
    durability: "standing",
    messageIds: [osaka.input, tokyo.input],
    support: [
      { id: tokyo.input, date: "2026-11-23" },
      { id: osaka.input, date: "2026-11-25" },
    ],
  });
  await write("c_dated", "Wants aisle seats this month", {
    durability: "time_bound",
    until: "2026-11-30",
    messageIds: [osaka.input],
    support: [{ id: osaka.input, date: "2026-11-25" }],
  });
  const { adapter, inputs } = model(() =>
    ["f1", "f2", "f3"].map((fact) => [
      "judge_fact",
      { fact, verdict: "supported", reason: "Says so" },
    ]),
  );
  const result = await judge(db, adapter);
  assert.equal(result.supported, 3);
  assert.deepEqual(JSON.parse(inputs[0].messages[1].content).facts, [
    {
      id: "f1",
      fact: "Asked for an aisle seat on the Tokyo flight",
      note: true,
      ownerMessages: [
        { day: "2026-11-23", text: "Get me an aisle seat on the Tokyo flight" },
      ],
    },
    {
      id: "f2",
      fact: "Prefers aisle seats",
      // Both days, oldest first: the repeat is what supports a preference.
      ownerMessages: [
        { day: "2026-11-23", text: "Get me an aisle seat on the Tokyo flight" },
        { day: "2026-11-25", text: "Aisle seat again for Osaka" },
      ],
    },
    {
      id: "f3",
      fact: "Wants aisle seats this month",
      until: "2026-11-30",
      ownerMessages: [
        { day: "2026-11-25", text: "Aisle seat again for Osaka" },
      ],
    },
  ]);
  assert.match(inputs[0].messages[0].content, /messages from separate days/);
});
