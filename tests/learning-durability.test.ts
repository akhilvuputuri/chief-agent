import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Database } from "../src/db.js";
import {
  durabilityFlags,
  Learner,
  LEARNER_PROMPT_VERSION,
  LEARNING_LIMITS,
  labelTurn,
  mergeSupport,
} from "../src/learning.js";
import { isNote, MemoryStore } from "../src/memory.js";
import type { Generation, ModelAdapter } from "../src/model.js";
import { projectEventRecord } from "../src/ops-log.js";
import { closeAfter, migratedPGlite } from "./helpers/pglite.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
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

let ordinal = 0;
/** One ordinary conversation turn: what the owner wrote, when, and Chief's reply. */
async function turn(
  db: Database,
  o: { says: string; reply?: string; at: Date },
) {
  const run = randomUUID();
  await db.query(
    "INSERT INTO runtime_runs(id,user_id,task_id,state,stop_reason,started_at) VALUES($1,'owner',NULL,'stopped','answer',$2)",
    [run, o.at],
  );
  await db.query(
    "INSERT INTO work_turns(run_id,user_id,request,task_id,background) VALUES($1,'owner',$2,NULL,false)",
    [run, o.says],
  );
  await db.query(
    "INSERT INTO conversation_inputs(id,user_id,run_id,message,state,received_at) VALUES($1,'owner',$2,$3,'completed',$4)",
    [randomUUID(), run, o.says, o.at],
  );
  const payload = { role: "assistant", content: o.reply ?? "Done." };
  const hash = createHash("sha256")
    .update(JSON.stringify(payload) + ++ordinal)
    .digest("hex");
  await db.query(
    "INSERT INTO message_contents(user_id,hash,payload,characters) VALUES('owner',$1,$2::jsonb,$3)",
    [hash, JSON.stringify(payload), payload.content.length],
  );
  await db.query(
    "INSERT INTO conversation_messages(user_id,ordinal,hash,run_id) VALUES('owner',$1,$2,$3)",
    [ordinal, hash, run],
  );
  return run;
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

const run = (db: Database, adapter: ModelAdapter, now = NIGHT) =>
  new Learner(db, {
    model: adapter,
    modelName: "test/model",
    clock: () => now,
  }).run("owner", now) as Promise<Record<string, any>>;

const shown = (input: any) => JSON.parse(input.messages[1].content);
const results = (input: any) =>
  input.messages
    .filter((m: any) => m.role === "tool")
    .map((m: any) => JSON.parse(m.content));
const fact = (
  key: string,
  value: string,
  quote: string,
  durability: string,
  item: string,
  more: Record<string, unknown> = {},
): Call => [
  "learn_fact",
  { key, value, quote, durability, taskIds: [item], reason: "Test", ...more },
];
const head = async (db: Database, key: string) =>
  (await new MemoryStore(db).active("owner")).find((r) => r.key === key);

test("a habit resting on one request is flagged, and a general statement or a repeat is not", () => {
  // The first judge run's most common failure: a request worded as a preference.
  assert.deepEqual(
    durabilityFlags(
      "Book me an aisle seat",
      "Prefers aisle seats",
      "standing",
      1,
    ),
    ["habitual_framing"],
  );
  assert.deepEqual(
    durabilityFlags(
      "Is it raining in Tanjong Pagar?",
      "Usually asks about weather in Tanjong Pagar",
      "standing",
      1,
    ),
    ["quoted_question", "habitual_framing"],
  );
  // The owner speaking generally is the basis a preference needs.
  for (const quote of [
    "I prefer aisle seats",
    "I always take the aisle",
    "Next time book the aisle",
    "From now on, aisle seats",
    "I'm an aisle person",
    "I don’t like window seats",
  ])
    assert.deepEqual(
      durabilityFlags(quote, "Prefers aisle seats", "standing", 1),
      [],
      quote,
    );
  // "Wants" and "needs" claim a habit too; "would like" is a request, not a liking.
  assert.deepEqual(
    durabilityFlags(
      "Book me an aisle seat",
      "Wants aisle seats",
      "standing",
      1,
    ),
    ["habitual_framing"],
  );
  assert.deepEqual(
    durabilityFlags(
      "I would like a refund for this order",
      "Would like a refund for the order",
      "standing",
      1,
    ),
    [],
  );
  // No habit wording, nothing to flag: a plain fact.
  assert.deepEqual(
    durabilityFlags(
      "my wife Priya is joining",
      "Wife is named Priya",
      "standing",
      1,
    ),
    [],
  );
  // Seen on a second day, the repeat is the basis; notes and dated facts claim no habit.
  assert.deepEqual(
    durabilityFlags(
      "Book me an aisle seat",
      "Prefers aisle seats",
      "standing",
      2,
    ),
    [],
  );
  assert.deepEqual(
    durabilityFlags("Book me an aisle seat?", "Always asked", "one_off", 1),
    [],
  );
  assert.deepEqual(
    durabilityFlags("aisle seats this week", "Prefers aisle", "time_bound", 1),
    [],
  );
});

test("support joins earlier evidence, counts separate days, and stays bounded", () => {
  // A revision from before support was recorded counts as one sighting on its work day.
  const first = mergeSupport({ messageIds: ["a"], workDate: "2026-11-01" }, [
    { id: "b", date: "2026-11-03" },
  ]);
  assert.deepEqual(first.support, [
    { id: "a", date: "2026-11-01" },
    { id: "b", date: "2026-11-03" },
  ]);
  assert.deepEqual(first.seenDays, ["2026-11-01", "2026-11-03"]);
  // The same message cited again adds nothing; the same day counts once.
  const again = mergeSupport(first, [
    { id: "b", date: "2026-11-03" },
    { id: "c", date: "2026-11-03" },
  ]);
  assert.equal(again.support.length, 3);
  assert.equal(again.seenDays.length, 2);
  // The newest messages are kept, and the days go on counting.
  let grown: ReturnType<typeof mergeSupport> = mergeSupport(undefined, []);
  for (let i = 1; i <= LEARNING_LIMITS.supportMessages + 3; i++)
    grown = mergeSupport(grown, [
      { id: `m${i}`, date: `2026-10-${String(i).padStart(2, "0")}` },
    ]);
  assert.equal(grown.support.length, LEARNING_LIMITS.supportMessages);
  assert.equal(
    grown.support.at(-1)!.id,
    `m${LEARNING_LIMITS.supportMessages + 3}`,
  );
  assert.equal(grown.seenDays.length, LEARNING_LIMITS.supportMessages + 3);
  assert.deepEqual(mergeSupport(undefined, []), { support: [], seenDays: [] });
});

test("one request is saved as a note outside every turn, and a repeat on another day makes it a preference", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  const tokyo = await turn(db, {
    says: "Get me an aisle seat on the Tokyo flight",
    reply: "Booked 14C.",
    at: new Date(NIGHT.getTime() - 50 * HOUR),
  });
  const first = await run(
    db,
    model(() => [
      fact(
        "aisle_seat",
        "Asked for an aisle seat on the Tokyo flight",
        "Get me an aisle seat on the Tokyo flight",
        "one_off",
        tokyo,
      ),
      ["learn_finish", {}],
    ]).adapter,
  );
  assert.deepEqual([first.notes, first.facts, first.flagged], [1, 0, 0]);
  const note = (await head(db, "aisle_seat"))!;
  assert.equal(isNote(note), true);
  assert.equal(note.source.durability, "one_off");
  assert.equal(note.source.quote, "Get me an aisle seat on the Tokyo flight");
  assert.deepEqual(note.source.seenDays, ["2026-11-25"]);
  assert.equal(note.source.promptVersion, LEARNER_PROMPT_VERSION);
  // It is memory (listed, recalled, rolled back) but no turn gets it as context.
  const before = await store.select("owner");
  assert.deepEqual(before.learned, []);
  assert.ok(!before.selected.includes(note.id));
  assert.ok(!before.omitted.includes(note.id));

  // Two nights later the owner has asked for the same thing on another trip.
  const later = new Date(NIGHT.getTime() + 2 * DAY);
  const osaka = await turn(db, {
    says: "Aisle seat again for the Osaka trip please",
    reply: "Booked 9D.",
    at: new Date(later.getTime() - 30 * HOUR),
  });
  const second = model((input) => {
    // The learner sees the note with its day, which is what lets it spot the repeat.
    const current = shown(input).current.find(
      (c: any) => c.key === "aisle_seat",
    );
    assert.equal(current.once, "2026-11-25");
    assert.equal(current.learned, true);
    return [
      fact(
        "aisle_seat",
        "Prefers aisle seats",
        "Aisle seat again for the Osaka trip",
        "standing",
        osaka,
      ),
      ["learn_finish", {}],
    ];
  });
  const promoted = await run(db, second.adapter, later);
  assert.deepEqual(
    [promoted.facts, promoted.notes, promoted.flagged],
    [1, 0, 0],
  );
  const preference = (await head(db, "aisle_seat"))!;
  assert.equal(isNote(preference), false);
  // Two days of evidence: no habit flag, and the judge will read both messages.
  assert.deepEqual(preference.flags, []);
  assert.deepEqual(preference.source.seenDays, ["2026-11-25", "2026-11-28"]);
  assert.equal((preference.source.messageIds as string[]).length, 2);
  assert.deepEqual(
    (await store.select("owner")).learned.map((l) => [l.key, l.value]),
    [["aisle_seat", "Prefers aisle seats"]],
  );
  // Undoing that night brings the note back as a note, still out of context.
  await store.rollback("owner", { learnerRun: promoted.learnerRun }, "test");
  const restored = (await head(db, "aisle_seat"))!;
  assert.equal(restored.value, "Asked for an aisle seat on the Tokyo flight");
  assert.equal(isNote(restored), true);
  assert.deepEqual((await store.select("owner")).learned, []);
});

test("a preference claimed from one request or a question is saved with a flag that pruning can rank by", async (t) => {
  const db = await setup(t);
  const at = (hours: number) => new Date(NIGHT.getTime() - hours * HOUR);
  const seat = await turn(db, {
    says: "Book me an aisle seat please",
    at: at(50),
  });
  const meetings = await turn(db, {
    says: "I prefer morning meetings",
    at: at(49),
  });
  const rain = await turn(db, {
    says: "Is it raining in Tanjong Pagar?",
    at: at(48),
  });
  const result = await run(
    db,
    model(() => [
      fact(
        "seat",
        "Prefers aisle seats",
        "Book me an aisle seat",
        "standing",
        seat,
      ),
      fact(
        "meetings",
        "Prefers morning meetings",
        "I prefer morning meetings",
        "standing",
        meetings,
      ),
      fact(
        "rain",
        "Asks about rain in Tanjong Pagar",
        "Is it raining in Tanjong Pagar?",
        "standing",
        rain,
      ),
      ["learn_finish", {}],
    ]).adapter,
  );
  assert.equal(result.facts, 3);
  assert.deepEqual((await head(db, "seat"))!.flags, ["habitual_framing"]);
  assert.deepEqual((await head(db, "meetings"))!.flags, []);
  assert.ok((await head(db, "rain"))!.flags.includes("quoted_question"));
  // A doubt about scope, not a risk: a turn that carries them does not log a warning.
  assert.equal((await new MemoryStore(db).select("owner")).flagged, 0);
});

test("a fact seen again on another day gains support as a revision, and the same day adds nothing", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  const propose = (item: string, quote: string) =>
    model(() => [
      fact("diet", "Is vegetarian", quote, "standing", item),
      ["learn_finish", {}],
    ]).adapter;
  const first = await turn(db, {
    says: "I'm vegetarian, remember",
    at: new Date(NIGHT.getTime() - 50 * HOUR),
  });
  assert.equal((await run(db, propose(first, "I'm vegetarian"))).facts, 1);
  const night2 = new Date(NIGHT.getTime() + 2 * DAY);
  const second = await turn(db, {
    says: "No meat for me, I'm vegetarian",
    at: new Date(night2.getTime() - 30 * HOUR),
  });
  const again = await run(db, propose(second, "I'm vegetarian"), night2);
  assert.deepEqual([again.reinforced, again.facts, again.unchanged], [1, 0, 0]);
  const history = await store.history("owner", "diet");
  assert.equal(history.length, 2);
  assert.deepEqual(history[1]!.source.seenDays, ["2026-11-25", "2026-11-28"]);
  assert.equal(history[1]!.value, "Is vegetarian");
  // A second message on a day already counted is not a new sighting.
  const night3 = new Date(NIGHT.getTime() + 3 * DAY);
  const sameDay = await turn(db, {
    says: "As I said, I'm vegetarian",
    at: new Date(night2.getTime() - 29 * HOUR),
  });
  const third = await run(db, propose(sameDay, "I'm vegetarian"), night3);
  assert.deepEqual([third.reinforced, third.unchanged], [0, 1]);
  assert.equal((await store.history("owner", "diet")).length, 2);
});

test("a time-bound fact needs a sound end date, shows it to turns, and is retired the night after it ends", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  const briefings = await turn(db, {
    says: "Until Saturday, send my briefings at 7am",
    at: new Date(NIGHT.getTime() - 50 * HOUR),
  });
  const quote = "Until Saturday, send my briefings at 7am";
  const { adapter, inputs } = model((_input, n) =>
    n === 1
      ? [
          fact("a", "Wants briefings at 7am", quote, "time_bound", briefings),
          fact("b", "Wants briefings at 7am", quote, "standing", briefings, {
            until: "2026-11-28",
          }),
          fact("c", "Wants briefings at 7am", quote, "time_bound", briefings, {
            until: "2026-11-24",
          }),
          fact("d", "Wants briefings at 7am", quote, "time_bound", briefings, {
            until: "2026-11-27",
          }),
          fact("e", "Wants briefings at 7am", quote, "time_bound", briefings, {
            until: "2028-01-01",
          }),
          fact("f", "Wants briefings at 7am", quote, "time_bound", briefings, {
            until: "2026-02-30",
          }),
          fact(
            "briefing_time",
            "Wants briefings at 7am until Saturday",
            quote,
            "time_bound",
            briefings,
            { until: "2026-11-28" },
          ),
          ["learn_finish", {}],
        ]
      : [["learn_finish", {}]],
  );
  const result = await run(db, adapter);
  assert.deepEqual(
    results(inputs[1])
      .map((r: any) => r.refused ?? "accepted")
      .slice(0, 7),
    [
      "until goes with time_bound, and only with it",
      "until goes with time_bound, and only with it",
      "until is before the cited work; nothing is left to hold",
      // Saturday 28 November is today in Singapore; Friday has already gone.
      "That has already ended; save a one_off note of it if it is worth keeping",
      "until is more than a year away; save it as standing or leave it",
      "until is not a real date",
      "accepted",
    ],
  );
  assert.equal(result.facts, 1);
  assert.deepEqual(
    (await store.select("owner")).learned.map((l) => [l.key, l.until]),
    [["briefing_time", "2026-11-28"]],
  );
  // Still in force on its last day's night; gone the night after.
  const sunday = await run(
    db,
    model(() => [["learn_finish", {}]]).adapter,
    new Date(NIGHT.getTime() + DAY),
  );
  assert.equal(sunday.expired, 1);
  assert.equal(await head(db, "briefing_time"), undefined);
  assert.deepEqual((await store.select("owner")).learned, []);
  const last = (await store.history("owner", "briefing_time")).at(-1)!;
  assert.deepEqual(
    [last.status, last.reason, last.learner_run],
    ["retired", "Held until 2026-11-28", sunday.learnerRun],
  );
  // The learner's own retirement leaves the key open. Undoing that night brings the fact
  // back without its end date, so it is not retired again the night after.
  assert.deepEqual(await store.removed("owner"), []);
  await store.rollback("owner", { learnerRun: sunday.learnerRun }, "test");
  const back = (await head(db, "briefing_time"))!;
  assert.equal(back.value, "Wants briefings at 7am until Saturday");
  assert.equal(back.source.until, undefined);
  const monday = await run(
    db,
    model(() => [["learn_finish", {}]]).adapter,
    new Date(NIGHT.getTime() + 2 * DAY),
  );
  assert.equal(monday.expired, undefined);
  assert.ok(await head(db, "briefing_time"));
  const line: any = projectEventRecord("learner.finished", "run", {
    state: "completed",
    notes: 2,
    reinforced: 1,
    ...sunday,
  });
  assert.deepEqual(
    [line.expiredCount, line.noteCount, line.reinforcedCount],
    [1, 2, 1],
  );
});

test("a redirected answer is a pitfall, and the owner's next message is shown beside the turn", async (t) => {
  const db = await setup(t);
  const at = (hours: number) => new Date(NIGHT.getTime() - hours * HOUR);
  const calendar = await turn(db, {
    says: "What's on my calendar tomorrow?",
    reply: "You have three meetings: standup, design review and a 1:1.",
    at: at(50),
  });
  const reaction = await turn(db, {
    says: "Next time just list the times",
    reply: "Will do.",
    at: at(49.9),
  });
  const news = await turn(db, {
    says: "Summarise today's tech news for me",
    reply: "Here is a long summary.",
    at: at(40),
  });
  await turn(db, {
    says: "Summarise the tech news for me today",
    reply: "Three bullets.",
    at: at(39.9),
  });
  // What the turn loop stored when the owner asked again in other words.
  await db.query(
    "INSERT INTO events(run_id,user_id,type,data) VALUES($1,'owner','turn.redirect',$2::jsonb)",
    [news, JSON.stringify({ kind: "rephrase", by: randomUUID() })],
  );
  const { adapter, inputs } = model(() => [["learn_finish", {}]]);
  const result = await run(db, adapter);
  const items = new Map<string, any>(
    shown(inputs[0]).tasks.map((x: any) => [x.id, x]),
  );
  assert.deepEqual(
    [items.get(calendar).label, items.get(calendar).ownerNext],
    ["success", "Next time just list the times"],
  );
  assert.deepEqual(
    [items.get(news).label, items.get(news).reasons],
    ["pitfall", ["turn", "owner_redirected", "redirect_rephrase"]],
  );
  // The reaction is also its own item, where its words can be quoted.
  assert.equal(items.get(reaction).request, "Next time just list the times");
  assert.equal(result.pitfall, 1);
  assert.deepEqual(
    labelTurn({
      stopReason: "answer",
      failedCalls: 0,
      uncertainCalls: 0,
      ownerChars: 40,
      calls: 0,
      corrected: false,
      redirected: "pushback",
    }),
    {
      label: "pitfall",
      reasons: ["turn", "owner_redirected", "redirect_pushback"],
    },
  );
});

test("a standing fact is never demoted to a note, and a note is not promoted on the day it was written", async (t) => {
  const db = await setup(t);
  const store = new MemoryStore(db);
  const at = (hours: number) => new Date(NIGHT.getTime() - hours * HOUR);
  const general = await turn(db, {
    says: "I always want an aisle seat",
    at: at(50),
  });
  const tokyo = await turn(db, {
    says: "Get me an early flight to Tokyo",
    at: at(49),
  });
  await run(
    db,
    model(() => [
      fact(
        "seat",
        "Prefers aisle seats",
        "I always want an aisle seat",
        "standing",
        general,
      ),
      fact(
        "early",
        "Asked for an early flight to Tokyo",
        "Get me an early flight to Tokyo",
        "one_off",
        tokyo,
      ),
      ["learn_finish", {}],
    ]).adapter,
  );
  // The same night's second batch: later messages of the same two days.
  const night2 = new Date(NIGHT.getTime() + 2 * DAY);
  const osaka = await turn(db, {
    says: "Aisle seat for the Osaka trip",
    at: new Date(night2.getTime() - 30 * HOUR),
  });
  const sameDay = await turn(db, {
    says: "Early flight please, as before",
    at: at(48),
  });
  const generalLater = await turn(db, {
    says: "I prefer early flights in general",
    at: at(47),
  });
  const { adapter, inputs } = model((_input, n) =>
    n === 1
      ? [
          // One more occasion of a standing fact, wrongly sent as a note under its key.
          fact(
            "seat",
            "Asked for an aisle seat for Osaka",
            "Aisle seat for the Osaka trip",
            "one_off",
            osaka,
          ),
          fact(
            "seat",
            "Prefers aisle seats",
            "Aisle seat for the Osaka trip",
            "one_off",
            osaka,
          ),
          // A second message on the note's own day is still one occasion.
          fact(
            "early",
            "Prefers early flights",
            "Early flight please",
            "standing",
            sameDay,
          ),
          ["learn_finish", {}],
        ]
      : [
          // Said generally, even on the same day, it is a preference.
          fact(
            "early",
            "Prefers early flights",
            "I prefer early flights in general",
            "standing",
            generalLater,
          ),
          ["learn_finish", {}],
        ],
  );
  const result = await run(db, adapter, night2);
  const refusals = results(inputs[1]).map((r: any) => r.refused ?? "accepted");
  assert.match(refusals[0], /holds a standing fact/);
  assert.match(refusals[1], /holds a standing fact/);
  assert.match(
    refusals[2],
    /only when another day repeats it or the owner says it generally/,
  );
  assert.equal(result.facts, 1);
  // The preference is still a preference, in context, and the note became one properly.
  assert.deepEqual(
    (await store.select("owner")).learned.map((l) => [l.key, l.value]),
    [
      ["early", "Prefers early flights"],
      ["seat", "Prefers aisle seats"],
    ],
  );
  assert.equal(isNote((await head(db, "seat"))!), false);
  assert.deepEqual((await head(db, "early"))!.flags, []);
});

test("a changed value starts its own evidence, so the old claim's days do not vouch for the new one", async (t) => {
  const db = await setup(t);
  const window = await turn(db, {
    says: "Book me a window seat",
    at: new Date(NIGHT.getTime() - 50 * HOUR),
  });
  await run(
    db,
    model(() => [
      fact(
        "seat",
        "Prefers window seats",
        "Book me a window seat",
        "standing",
        window,
      ),
      ["learn_finish", {}],
    ]).adapter,
  );
  const night2 = new Date(NIGHT.getTime() + 2 * DAY);
  const aisle = await turn(db, {
    says: "Book me an aisle seat",
    at: new Date(night2.getTime() - 30 * HOUR),
  });
  await run(
    db,
    model(() => [
      fact(
        "seat",
        "Prefers aisle seats",
        "Book me an aisle seat",
        "standing",
        aisle,
      ),
      ["learn_finish", {}],
    ]).adapter,
    night2,
  );
  const changed = (await head(db, "seat"))!;
  assert.equal(changed.value, "Prefers aisle seats");
  // One day behind the new claim, so it is still a habit on one day's evidence, and the
  // judge is shown only the message that says it.
  assert.deepEqual(changed.source.seenDays, ["2026-11-28"]);
  assert.equal((changed.source.messageIds as string[]).length, 1);
  assert.deepEqual(changed.flags, ["habitual_framing"]);
});
