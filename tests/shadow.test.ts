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
  readDecisionConfig,
  recordPickerCheck,
  ShadowDecisions,
} from "../src/shadow.js";
import { Execution } from "../src/execution.js";
import { domainOf } from "../src/tool-domains.js";
import { projectEvent, setOpsSink } from "../src/ops-log.js";

const config = readDecisionConfig();
const reply = (answers: unknown) =>
  new Response(
    JSON.stringify({
      answers,
      usage: { cost: 0.00002 },
      model: "typesafe/jev-1.13-20260917",
    }),
  );
const input = (message = "what about friday?") => ({
  message,
  previous: [
    {
      user: "am I free thursday afternoon?",
      assistant: "Free 1–4:30 pm.",
      tools: [],
    },
  ],
  agents: [
    { type: "calendar", description: "Calendar" },
    { type: "email", description: "Email" },
  ],
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

test("shadow predictions use the eval's questions and thresholds", async () => {
  const bodies: any[] = [];
  const shadow = new ShadowDecisions("key", config, (async (
    _url: string,
    init: RequestInit,
  ) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return body.questions.needs_previous
      ? reply({ needs_previous: { noul: 0.1 } })
      : reply({
          agent: {
            choice: "calendar",
            probabilities: { calendar: 0.98, email: 0.01, chief: 0.01 },
          },
        });
  }) as typeof fetch);
  const predictions = await shadow.start(input());
  const byConsumer = Object.fromEntries(
    predictions.map((p) => [p.consumer, p]),
  );
  assert.equal(byConsumer.continuity.decision, "drop");
  assert.equal(byConsumer.routing.decision, "calendar");
  const continuity = bodies.find((b) => b.questions.needs_previous);
  assert.deepEqual(
    continuity.questions.needs_previous,
    config.continuity.question,
  );
  assert.deepEqual(Object.keys(continuity.state), [
    "previous_user_message",
    "previous_assistant_reply",
    "latest_user_message",
  ]);
  const routing = bodies.find((b) => b.questions.agent);
  assert.deepEqual(Object.keys(routing.questions.agent.criteria), [
    "calendar",
    "email",
    "chief",
  ]);
  // Below the routing threshold the fast path is not taken.
  const low = new ShadowDecisions("key", config, (async () =>
    reply({
      agent: {
        choice: "calendar",
        probabilities: { calendar: 0.9, chief: 0.1 },
      },
    })) as typeof fetch);
  const [, lowRouting] = await low.start(input());
  assert.equal(lowRouting!.decision, "chief");
});

test("shadow failures resolve as failed predictions and never throw", async () => {
  const cases: [typeof fetch, string][] = [
    [
      (async () => new Response("no", { status: 500 })) as typeof fetch,
      "http_500",
    ],
    [(async () => reply({})) as typeof fetch, "invalid"],
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
  // AbortSignal.timeout does not keep the process alive; the running server does.
  const alive = setInterval(() => {}, 1000);
  for (const [transport, error] of cases) {
    const shadow = new ShadowDecisions(
      "key",
      { ...config, timeoutMs: 20 },
      transport,
    );
    const predictions = await shadow.start(input());
    assert.equal(predictions.length, 2);
    assert(
      predictions.every((p) => !p.ok && p.error === error),
      error,
    );
  }
  clearInterval(alive);
  // No previous exchange: continuity is not asked.
  const shadow = new ShadowDecisions("key", config, (async () =>
    reply({})) as typeof fetch);
  const only = await shadow.start({ ...input(), previous: [] });
  assert.deepEqual(
    only.map((p) => p.consumer),
    ["routing"],
  );
});

test("the turn never waits for shadow calls, and the record joins what Chief did", async () => {
  const { pg, db } = await database();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const shadow = new ShadowDecisions(
    "key",
    { ...config, timeoutMs: 60_000 },
    (async (_url: string, init: RequestInit) => {
      await gate;
      const body = JSON.parse(String(init.body));
      return body.questions.needs_previous
        ? reply({ needs_previous: { noul: 0.9 } })
        : reply({
            agent: {
              choice: "jobs",
              probabilities: { jobs: 0.99, chief: 0.01 },
            },
          });
    }) as typeof fetch,
  );
  const assistant = new Assistant(
    db,
    new CustomAgent({
      generate: async () => ({
        message: { role: "assistant", content: "Hello!" },
      }),
    }),
    new JobTools(db, { call: async () => ({}) }),
    { web: true },
    undefined,
    undefined,
    shadow,
  );
  try {
    await assistant.respond("owner", "hi");
    // The second message has a previous exchange, so both questions are asked.
    const started = Date.now();
    assert.equal(await assistant.respond("owner", "list my roles"), "Hello!");
    assert(Date.now() - started < 5000);
    const count = async () =>
      (
        await db.query(
          "SELECT count(*)::int n FROM events WHERE type='decision.shadow' AND data->>'consumer' IN ('continuity','routing')",
        )
      ).rows[0].n;
    assert.equal(await count(), 0);
    release();
    for (let i = 0; i < 50 && (await count()) < 3; i++)
      await new Promise((r) => setTimeout(r, 20));
    const rows = (
      await db.query(
        "SELECT data FROM events WHERE type='decision.shadow' ORDER BY id",
      )
    ).rows.map((r) => r.data);
    const routing = rows.filter((r) => r.consumer === "routing").at(-1);
    assert.equal(routing.prediction, "jobs");
    // Chief answered itself, so the would-be fast path disagrees with what happened.
    assert.equal(routing.actual, "chief");
    assert.equal(routing.agree, false);
    const continuity = rows.find((r) => r.consumer === "continuity");
    assert.equal(continuity.prediction, "keep");
    assert(rows.some((r) => r.consumer === "picker"));
  } finally {
    release();
    await pg.close();
  }
});

test("shadow log lines carry decisions and scores, never message text", () => {
  const lines: string[] = [];
  const previous = setOpsSink((line) => lines.push(line));
  try {
    projectEvent("decision.shadow", randomUUID(), {
      consumer: "routing",
      ok: true,
      prediction: "email",
      score: 0.98,
      actual: "email",
      agree: true,
      latencyMs: 310,
      costUsd: 0.00003,
      model: "typesafe/jev-1.13-20260917",
      message: "any reply from the landlord about the deposit?",
    });
    const line = JSON.parse(lines[0]!);
    assert.equal(line.kind, "routing");
    assert.equal(line.state, "email");
    assert.equal(line.agree, true);
    assert.equal(line.score, 0.98);
    assert.doesNotMatch(lines[0]!, /landlord/);
  } finally {
    setOpsSink(previous);
  }
});

test("the record counts only delegations that ran, by catalogue name, and marks the turn", async () => {
  const { pg, db } = await database();
  const shadow = new ShadowDecisions("key", config, (async () =>
    reply({})) as typeof fetch);
  const routing = (decision: string) => ({
    consumer: "routing" as const,
    ok: true,
    decision,
    score: 0.99,
    latencyMs: 300,
    costUsd: 0.00003,
    model: "typesafe/jev-1.13-20260917",
  });
  const turn = async (calls: [string, string][]) => {
    const run = randomUUID();
    const execution = new Execution(
      db,
      "owner",
      run,
      new AbortController().signal,
    );
    await execution.start();
    for (const [type, state] of calls) {
      const id = await execution.beginCall(randomUUID(), "agent_run", {
        raw: JSON.stringify({ type, objective: "x" }),
      });
      await execution.endCall(id, {}, state);
    }
    return run;
  };
  const recorded = async (run: string) =>
    (
      await db.query(
        "SELECT data FROM events WHERE run_id=$1 AND type='decision.shadow'",
        [run],
      )
    ).rows[0].data;
  try {
    // A full agent ID is the same delegation as its alias.
    const one = await turn([["core/email", "success"]]);
    await shadow.record(db, "owner", one, [routing("email")]);
    assert.equal((await recorded(one)).actual, "email");
    assert.equal((await recorded(one)).agree, true);
    // A refused type and a never-dispatched call do not count; the retry that ran does.
    const retried = await turn([
      ["emial", "failed"],
      ["calendar", "interrupted"],
      ["email", "success"],
    ]);
    await shadow.record(db, "owner", retried, [routing("calendar")], {
      interrupted: true,
      stopReason: "interrupted",
      messages: 2,
    });
    const r = await recorded(retried);
    assert.deepEqual(r.delegated, ["email"]);
    assert.equal(r.agree, false);
    assert.equal(r.interrupted, true);
    assert.equal(r.messages, 2);
    // Two delegations that ran are "several"; a chief prediction never disagrees.
    const two = await turn([
      ["email", "success"],
      ["parcels", "success"],
    ]);
    await shadow.record(db, "owner", two, [routing("chief")]);
    assert.equal((await recorded(two)).actual, "several");
    assert.equal((await recorded(two)).agree, true);
    // Picker check: offered against used, and domains loaded mid-turn.
    const picked = await turn([]);
    await db.query(
      "INSERT INTO events(run_id,user_id,type,data) VALUES($1,'owner','tools.selected',$2),($1,'owner','tools.loaded',$3)",
      [
        picked,
        JSON.stringify({ domains: ["canvas", "work"] }),
        JSON.stringify({ domains: ["canvas", "skills", "work"] }),
      ],
    );
    const exec = new Execution(
      db,
      "owner",
      picked,
      new AbortController().signal,
    );
    const call = await exec.beginCall(randomUUID(), "canvas_list", {});
    await exec.endCall(call, {}, "success");
    await recordPickerCheck(db, "owner", picked, domainOf);
    const p = await recorded(picked);
    assert.deepEqual(p.offered, ["canvas", "work"]);
    assert.deepEqual(p.used, ["canvas"]);
    assert.deepEqual(p.unused, ["work"]);
    assert.deepEqual(p.loadedLater, ["skills"]);
  } finally {
    await pg.close();
  }
});
