import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import { ensureUser, type Database } from "../src/db.js";
import {
  EffortPicker,
  readEffortConfig,
  shouldEscalate,
  type EffortProgress,
} from "../src/effort.js";
import type { ReasoningEffort } from "../src/model.js";
import { projectEvent, setOpsSink } from "../src/ops-log.js";

const config = readEffortConfig();
const reply = (choice: string, probabilities: Record<string, number>) =>
  new Response(
    JSON.stringify({
      answers: { effort: { choice, probabilities } },
      usage: { cost: 0.00002 },
      model: "typesafe/jev-1.13-20260917",
    }),
  );
const previous = [
  { user: "first", assistant: "one", tools: [] },
  { user: "second", assistant: "two", tools: [] },
  { user: "third", assistant: "three", tools: [] },
];
const progress = (over: Partial<EffortProgress> = {}): EffortProgress => ({
  step: 3,
  toolCalls: 3,
  failedCalls: 0,
  tools: ["memory_set"],
  current: "medium",
  ...over,
});

test("Jev's pick becomes the effort only above its threshold", async () => {
  const bodies: any[] = [];
  const answers: [string, Record<string, number>, ReasoningEffort][] = [
    ["low", { low: 0.9, medium: 0.08, high: 0.02 }, "low"],
    ["low", { low: 0.6, medium: 0.4 }, "medium"],
    ["high", { high: 0.64321, medium: 0.35 }, "high"],
    ["high", { high: 0.5, medium: 0.5 }, "medium"],
    ["medium", { medium: 0.99 }, "medium"],
  ];
  let i = 0;
  const picker = new EffortPicker("key", config, (async (
    _url: string,
    init: RequestInit,
  ) => {
    bodies.push(JSON.parse(String(init.body)));
    const [choice, p] = answers[i++]!;
    return reply(choice, p);
  }) as typeof fetch);
  for (const [choice, , applied] of answers) {
    const d = await picker.decide({ message: "hi", previous });
    assert.equal(d.ok, true);
    assert.equal(d.choice, choice);
    assert.equal(d.applied, applied, choice);
  }
  // The question is the config's, the state is bounded and has no progress at the start.
  assert.deepEqual(Object.keys(bodies[0].questions.effort.criteria), [
    "low",
    "medium",
    "high",
  ]);
  assert.equal(bodies[0].questions.effort.type, "choice");
  assert.deepEqual(
    bodies[0].state.previous_turns.map((t: any) => t.user),
    ["second", "third"],
  );
  assert.equal(bodies[0].state.turn_progress, undefined);
  // Probabilities are rounded and kept only for the three efforts.
  const rounded = await new EffortPicker("key", config, (async () =>
    reply("high", {
      high: 0.98765,
      medium: 0.01,
      other: 0.5,
    })) as typeof fetch).decide({ message: "plan my week", previous: [] });
  assert.deepEqual(rounded.probabilities, { high: 0.9877, medium: 0.01 });
});

test("an escalation sends progress and never lowers effort", async () => {
  let body: any;
  const picker = new EffortPicker("key", config, (async (
    _url: string,
    init: RequestInit,
  ) => {
    body = JSON.parse(String(init.body));
    return reply("low", { low: 0.95 });
  }) as typeof fetch);
  const d = await picker.decide({
    message: "compare these",
    previous: [],
    progress: progress({ current: "medium", failedCalls: 1 }),
  });
  assert.equal(d.choice, "low");
  assert.equal(d.applied, "medium");
  assert.deepEqual(body.state.turn_progress, {
    model_steps: 3,
    tool_calls: 3,
    failed_tool_calls: 1,
    tools_used: ["memory_set"],
    current_effort: "medium",
  });
  const up = await new EffortPicker("key", config, (async () =>
    reply("high", { high: 0.9 })) as typeof fetch).decide({
    message: "compare these",
    previous: [],
    progress: progress({ current: "low" }),
  });
  assert.equal(up.applied, "high");
});

test("every failure keeps the current effort and never throws", async () => {
  const cases: [typeof fetch, string][] = [
    [
      (async () => new Response("no", { status: 500 })) as typeof fetch,
      "http_500",
    ],
    [
      (async () => reply("extreme", { extreme: 0.9 })) as typeof fetch,
      "invalid",
    ],
    [(async () => reply("high", { high: 1.4 })) as typeof fetch, "invalid"],
    [
      (async () => {
        throw new Error("network");
      }) as typeof fetch,
      "failed",
    ],
    [
      ((_: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener("abort", () =>
            reject(Object.assign(new Error("t"), { name: "TimeoutError" })),
          ),
        )) as typeof fetch,
      "timeout",
    ],
  ];
  const alive = setInterval(() => {}, 1000);
  for (const [transport, error] of cases) {
    const picker = new EffortPicker(
      "key",
      { ...config, timeoutMs: 20 },
      transport,
    );
    const start = await picker.decide({ message: "hi", previous: [] });
    assert.equal(start.ok, false);
    assert.equal(start.error, error);
    assert.equal(start.applied, "medium");
    const mid = await picker.decide({
      message: "hi",
      previous: [],
      progress: progress({ current: "high" }),
    });
    assert.equal(mid.applied, "high", error);
  }
  clearInterval(alive);
});

test("periodic escalation asks from the configured step, every few steps, and after a new failure", () => {
  const periodic = {
    ...config,
    escalation: { ...config.escalation, periodic: true },
  };
  const ask = (
    over: Partial<EffortProgress>,
    last = { step: 0, failedCalls: 0 },
  ) => shouldEscalate(periodic, progress(over), last);
  const { firstStep, every } = config.escalation;
  assert.equal(ask({ step: firstStep - 1 }), false);
  assert.equal(ask({ step: firstStep }), true);
  assert.equal(ask({ step: firstStep + 1 }), false);
  assert.equal(ask({ step: firstStep + every }), true);
  // Not twice for the same step, never above high.
  assert.equal(
    ask({ step: firstStep }, { step: firstStep, failedCalls: 0 }),
    false,
  );
  assert.equal(ask({ step: firstStep, current: "high" }), false);
  // An absorbed follow-up always asks (below high).
  assert.equal(ask({ step: 1, followUp: true }), true);
  assert.equal(ask({ step: 1, followUp: true, current: "high" }), false);
  // A new failed tool call asks at once; an old one does not.
  assert.equal(ask({ step: 1, failedCalls: 1 }), true);
  assert.equal(
    ask({ step: 2, failedCalls: 1 }, { step: 1, failedCalls: 1 }),
    false,
  );
});

test("the committed policy asks again only after a new failure or an owner follow-up", () => {
  // A raise changes the thinking setting and invalidates the cached messages (journal 107).
  assert.equal(config.escalation.periodic, false);
  const ask = (
    over: Partial<EffortProgress>,
    last = { step: 0, failedCalls: 0 },
  ) => shouldEscalate(config, progress(over), last);
  const { firstStep, every } = config.escalation;
  assert.equal(ask({ step: firstStep }), false);
  assert.equal(ask({ step: firstStep + every }), false);
  assert.equal(ask({ step: 2, failedCalls: 1 }), true);
  assert.equal(ask({ step: 2, followUp: true }), true);
});

async function database() {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "owner");
  return { pg, db };
}

test("a foreground turn starts at Jev's effort and raises it mid-turn, logged step by step", async () => {
  const { pg, db } = await database();
  const asked: any[] = [];
  // This test exercises the periodic schedule; the committed policy keeps it off.
  const picker = new EffortPicker(
    "key",
    { ...config, escalation: { ...config.escalation, periodic: true } },
    (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      asked.push(body.state.turn_progress ?? null);
      // Start low; the first escalation says high; a later one says low (ignored).
      return asked.length === 1
        ? reply("low", { low: 0.9 })
        : asked.length === 2
          ? reply("high", { high: 0.9 })
          : reply("low", { low: 0.99 });
    }) as typeof fetch,
  );
  const efforts: ReasoningEffort[] = [];
  let n = 0;
  const steps = config.escalation.firstStep + config.escalation.every + 1;
  const assistant = new Assistant(
    db,
    new CustomAgent({
      generate: async (input) => {
        efforts.push(input.reasoning);
        n++;
        if (n > steps)
          return {
            message: { role: "assistant", content: "Done." },
            finishReason: "stop",
          };
        return {
          finishReason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: randomUUID(),
                type: "function",
                function: {
                  name: "memory_set",
                  arguments: JSON.stringify({
                    key: `note_${"abcdefghij"[n]}`,
                    value: "v",
                  }),
                },
              },
            ],
          },
        };
      },
    }),
    new JobTools(db, { call: async () => ({}) }),
    { web: true },
    undefined,
    undefined,
    undefined,
    picker,
  );
  const lines: string[] = [];
  const previousSink = setOpsSink((line) => lines.push(line));
  try {
    assert.equal(
      await assistant.respond(
        "owner",
        "remember a few things about the landlord",
      ),
      "Done.",
    );
    const { firstStep } = config.escalation;
    // Steps before the first escalation run low; every later call runs high.
    assert.deepEqual(efforts.slice(0, firstStep), Array(firstStep).fill("low"));
    assert(
      efforts.slice(firstStep).every((e) => e === "high"),
      String(efforts),
    );
    // The escalation saw progress with counts and tool names only.
    assert.equal(asked[0], null);
    assert.equal(asked[1].model_steps, firstStep);
    assert.equal(asked[1].current_effort, "low");
    assert.deepEqual(asked[1].tools_used, ["memory_set"]);
    // Once high, nothing more is asked.
    assert.equal(asked.length, 2);
    // Every call succeeded, so only the step schedule triggered the escalation.
    assert.equal(asked[1].failed_tool_calls, 0);
    const decided = (
      await db.query(
        "SELECT data FROM events WHERE type='effort.decided' ORDER BY id",
      )
    ).rows.map((r) => r.data);
    assert.deepEqual(
      decided.map((d) => [d.phase, d.step, d.previous, d.choice, d.applied]),
      [
        ["initial", 0, null, "low", "low"],
        ["escalation", firstStep, "low", "high", "high"],
      ],
    );
    // Each model call records the effort it ran at.
    const completed = (
      await db.query(
        "SELECT data->>'effort' e FROM events WHERE type='model.completed' ORDER BY id",
      )
    ).rows.map((r) => r.e);
    assert.deepEqual(completed, efforts);
    // Each records why the model stopped, privately and on its log line (journal 118).
    const finishes = (
      await db.query(
        "SELECT data->>'finishReason' f FROM events WHERE type='model.completed' ORDER BY id",
      )
    ).rows.map((r) => r.f);
    assert.equal(finishes.at(-1), "stop");
    assert.ok(finishes.slice(0, -1).every((f) => f === "tool_calls"));
    assert.deepEqual(
      lines
        .map((l) => JSON.parse(l))
        .filter((l) => l.event === "model.completed")
        .map((l) => l.finishReason),
      finishes,
    );
    // context.selected records the older history admitted, as sizes only.
    const selected = (
      await db.query(
        "SELECT data FROM events WHERE type='context.selected' ORDER BY id",
      )
    ).rows.map((r) => r.data);
    assert.ok(selected.length > 0);
    for (const d of selected) {
      assert.equal(typeof d.historySize, "number");
      assert.equal(typeof d.historyMessages, "number");
      assert.equal(typeof d.historyAllowance, "number");
    }
    const effortLines = lines
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === "effort.decided");
    assert.deepEqual(
      effortLines.map((l) => [l.kind, l.step, l.state, l.choice]),
      [
        ["initial", 0, "low", "low"],
        ["escalation", firstStep, "high", "high"],
      ],
    );
    assert.equal(effortLines[1].previousEffort, "low");
    assert(lines.every((l) => !/landlord/.test(l)));
  } finally {
    setOpsSink(previousSink);
    await pg.close();
  }
});

function scripted(
  db: Database,
  picker: EffortPicker,
  steps: (n: number) => { name: string; args: unknown } | string,
  efforts: ReasoningEffort[],
) {
  let n = 0;
  return new Assistant(
    db,
    new CustomAgent({
      generate: async (input) => {
        efforts.push(input.reasoning);
        const next = steps(++n);
        if (typeof next === "string")
          return { message: { role: "assistant", content: next } };
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: randomUUID(),
                type: "function",
                function: {
                  name: next.name,
                  arguments: JSON.stringify(next.args),
                },
              },
            ],
          },
        };
      },
    }),
    new JobTools(db, { call: async () => ({}) }),
    { web: true },
    undefined,
    undefined,
    undefined,
    picker,
  );
}

test("a failed tool call raises effort for the very next model call", async () => {
  const { pg, db } = await database();
  const asked: any[] = [];
  const picker = new EffortPicker("key", config, (async (
    _url: string,
    init: RequestInit,
  ) => {
    asked.push(JSON.parse(String(init.body)).state.turn_progress ?? null);
    return asked.length === 1
      ? reply("medium", { medium: 0.9 })
      : reply("high", { high: 0.9 });
  }) as typeof fetch);
  const efforts: ReasoningEffort[] = [];
  // Step 1 fails validation (an invalid memory key); step 2 recovers.
  const assistant = scripted(
    db,
    picker,
    (n) =>
      n === 1
        ? { name: "memory_set", args: { key: "Bad Key", value: "v" } }
        : n === 2
          ? { name: "memory_set", args: { key: "good_key", value: "v" } }
          : "Done.",
    efforts,
  );
  try {
    assert.equal(await assistant.respond("owner", "save that"), "Done.");
    assert.deepEqual(efforts, ["medium", "high", "high"]);
    // Asked once at the start and once right after the failure, with it counted.
    assert.equal(asked.length, 2);
    assert.equal(asked[1].model_steps, 1);
    assert.equal(asked[1].failed_tool_calls, 1);
  } finally {
    await pg.close();
  }
});

test("a step that only finishes the turn does not ask again", async () => {
  const { pg, db } = await database();
  let questions = 0;
  // With the periodic schedule on, so the assertion is not met by the committed policy alone.
  const picker = new EffortPicker(
    "key",
    { ...config, escalation: { ...config.escalation, periodic: true } },
    (async () => {
      questions++;
      return reply("medium", { medium: 0.9 });
    }) as typeof fetch,
  );
  const efforts: ReasoningEffort[] = [];
  const { firstStep } = config.escalation;
  // The step that reaches the escalation schedule only calls finish_turn.
  const assistant = scripted(
    db,
    picker,
    (n) =>
      n < firstStep
        ? {
            name: "memory_set",
            args: { key: `note_${"abcdefghij"[n]}`, value: "v" },
          }
        : { name: "finish_turn", args: { reply: "Saved.", reason: "answer" } },
    efforts,
  );
  try {
    assert.equal(await assistant.respond("owner", "save these"), "Saved.");
    assert.equal(efforts.length, firstStep);
    assert.equal(questions, 1);
  } finally {
    await pg.close();
  }
});

test("a follow-up absorbed mid-turn gets its own effort question", async () => {
  const { pg, db } = await database();
  const asked: any[] = [];
  const picker = new EffortPicker("key", config, (async (
    _url: string,
    init: RequestInit,
  ) => {
    const body = JSON.parse(String(init.body));
    asked.push({
      message: body.state.latest_user_message,
      progress: body.state.turn_progress ?? null,
    });
    return asked.length === 1
      ? reply("low", { low: 0.9 })
      : reply("high", { high: 0.9 });
  }) as typeof fetch);
  let entered!: () => void;
  const inFirstCall = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const efforts: ReasoningEffort[] = [];
  const assistant = new Assistant(
    db,
    new CustomAgent({
      generate: async (input) => {
        efforts.push(input.reasoning);
        if (efforts.length === 1) {
          entered();
          await held;
          return { message: { role: "assistant", content: "Stale." } };
        }
        return { message: { role: "assistant", content: "Planned." } };
      },
    }),
    new JobTools(db, { call: async () => ({}) }),
    { web: true },
    undefined,
    undefined,
    undefined,
    picker,
  );
  try {
    const first = assistant.respondDetailed("owner", "thanks");
    await inFirstCall;
    const id = await assistant.recordInput(
      "owner",
      "and also plan my week across work, gym and the two trips",
    );
    const second = assistant.respondDetailed(
      "owner",
      "and also plan my week across work, gym and the two trips",
      undefined,
      undefined,
      { id },
    );
    release();
    const [reply1] = await Promise.all([first, second]);
    assert.equal(reply1.reply, "Planned.");
    assert.deepEqual(efforts, ["low", "high"]);
    assert.equal(asked.length, 2);
    assert.equal(asked[1].message.startsWith("and also plan"), true);
    assert.equal(asked[1].progress.absorbed_follow_up, true);
    assert.equal(asked[1].progress.current_effort, "low");
  } finally {
    assistant.shutdown();
    await pg.close();
  }
});

test("without a picker every turn stays at medium", async () => {
  const { pg, db } = await database();
  const efforts: ReasoningEffort[] = [];
  const assistant = new Assistant(
    db,
    new CustomAgent({
      generate: async (input) => {
        efforts.push(input.reasoning);
        return { message: { role: "assistant", content: "Hi." } };
      },
    }),
    new JobTools(db, { call: async () => ({}) }),
    { web: true },
  );
  try {
    await assistant.respond("owner", "hi");
    assert.deepEqual(efforts, ["medium"]);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM events WHERE type='effort.decided'",
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await pg.close();
  }
});

test("effort log lines carry the decision, never text", () => {
  const lines: string[] = [];
  const previousSink = setOpsSink((line) => lines.push(line));
  try {
    projectEvent("effort.decided", randomUUID(), {
      phase: "escalation",
      step: 3,
      previous: "medium",
      ok: true,
      choice: "high",
      probabilities: { high: 0.9, medium: 0.1 },
      applied: "high",
      latencyMs: 410,
      costUsd: 0.00002,
      model: "typesafe/jev-1.13-20260917",
      message: "the landlord's deposit",
    });
    const line = JSON.parse(lines[0]!);
    assert.equal(line.kind, "escalation");
    assert.equal(line.step, 3);
    assert.equal(line.state, "high");
    assert.equal(line.previousEffort, "medium");
    assert.equal(line.choice, "high");
    assert.equal(line.score, 0.9);
    assert.equal(line.probabilities, undefined);
    assert.doesNotMatch(lines[0]!, /landlord/);
  } finally {
    setOpsSink(previousSink);
  }
});
