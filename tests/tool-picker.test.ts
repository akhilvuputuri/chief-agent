import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import type { Message, ModelAdapter, ToolDefinition } from "../src/model.js";
import { JobTools } from "../src/tools.js";
import { TOOL_DOMAINS } from "../src/tool-domains.js";
import {
  pickDomains,
  pickerQuestions,
  pickerState,
  readPickerConfig,
  recentTurns,
  ToolPicker,
  type PickerConfig,
} from "../src/tool-picker.js";
import { ensureUser, type Database } from "../src/db.js";
import { projectEvent, setOpsSink } from "../src/ops-log.js";
import type { Spending } from "../src/spending.js";

const config = readPickerConfig();
const json = async (path: string) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("bundled picker config is valid and pins a Jev snapshot", () => {
  assert.match(config.model, /^typesafe\/jev-[\d.]+-\d{8}$/);
  assert.deepEqual(Object.keys(config.domains), [...TOOL_DOMAINS]);
  assert.ok(config.fallbackMin < config.threshold);
});

test("pick rule matches the cases shared with the Python eval", async () => {
  for (const c of await json("../evals/picker/pick-cases.json"))
    assert.deepEqual(pickDomains(c.probabilities, config), c.expected, c.name);
});

test("picker requests match the golden requests shared with the Python eval", async () => {
  const scenarios: any[] = await json("../evals/picker/scenarios.json");
  for (const golden of await json("../evals/picker/request-golden.json")) {
    const s = scenarios.find((x) => x.id === golden.id);
    const sig = s.signals ?? {};
    const state = pickerState(config, {
      message: s.message,
      previous: s.prior ?? [],
      pendingApprovals: sig.pending_approvals ?? [],
      activeTask: sig.active_background_task ?? null,
      recentTools: sig.tools_used_last_hour ?? [],
    });
    // Key order is part of the request, so compare serialised text.
    assert.equal(JSON.stringify(state), JSON.stringify(golden.state), s.id);
    assert.equal(
      JSON.stringify(pickerQuestions(config, golden.domains)),
      JSON.stringify(golden.questions),
      s.id,
    );
  }
});

test("picker state keeps recent turns clipped and never tool outputs", () => {
  const history: Message[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "did Sarah reply?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "gmail_search", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "PRIVATE MAIL BODY" },
    { role: "assistant", content: "x".repeat(1000) },
    {
      role: "assistant",
      content:
        "[Saved answer details: observationId=o1. Use observation_read.]",
    },
    { role: "user", content: "🙂".repeat(600) },
  ];
  const turns = recentTurns(history);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns[1]!.tools, ["gmail_search"]);
  const state = pickerState(config, {
    message: "and the other one?",
    previous: turns,
    pendingApprovals: [],
    activeTask: null,
    recentTools: ["gmail_search", "gmail_search"],
  });
  assert.equal(state.previous_turns.length, config.state.previousTurns);
  assert.equal(state.previous_turns[0]!.user, "did Sarah reply?");
  // The saved-details pointer does not replace the answer.
  assert.equal(state.previous_turns[0]!.assistant, "x".repeat(300));
  assert.equal([...state.previous_turns[1]!.user].length, 500);
  assert.deepEqual(state.tools_used_last_hour, ["gmail_search"]);
  assert.ok(!JSON.stringify(state).includes("PRIVATE MAIL BODY"));
});

const input = {
  message: "is Dune on Libby?",
  previous: [],
  pendingApprovals: [],
  activeTask: null,
  recentTools: [],
};
const answers = (p: Record<string, number>) =>
  new Response(
    JSON.stringify({
      model: config.model,
      answers: Object.fromEntries(
        TOOL_DOMAINS.map((d) => [d, { noul: p[d] ?? 0.01 }]),
      ),
      usage: { cost: 0.00007 },
    }),
  );

test("picker sends the pinned model and one question per asked domain", async () => {
  let body: any;
  const picker = new ToolPicker("key", config, (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return answers({ library: 0.97, watchlist: 0.2 });
  }) as typeof fetch);
  const result = await picker.pick(input, ["library", "watchlist", "gmail"]);
  assert.equal(body.model, config.model);
  assert.deepEqual(Object.keys(body.questions), [
    "gmail",
    "library",
    "watchlist",
  ]);
  assert.equal(body.state.latest_user_message, "is Dune on Libby?");
  assert.ok(result.ok);
  assert.deepEqual(result.ok && result.domains, ["library"]);
  assert.equal(result.ok && result.costUsd, 0.00007);
});

test("picker failures are classified and a rate limit pauses it", async () => {
  let now = 1000;
  let status = 429;
  let calls = 0;
  const picker = new ToolPicker(
    "key",
    config,
    (async () => {
      calls++;
      return new Response("{}", { status });
    }) as typeof fetch,
    () => now,
  );
  const limited = await picker.pick(input, ["library"]);
  assert.deepEqual(limited.ok ? null : limited.outcome, "rate_limited");
  const paused = await picker.pick(input, ["library"]);
  assert.deepEqual(paused.ok ? null : paused.outcome, "paused");
  assert.equal(calls, 1);
  now += config.pauseAfterRateLimitMs;
  status = 401;
  const rejected = await picker.pick(input, ["library"]);
  assert.deepEqual(rejected.ok ? null : rejected.outcome, "rejected");
  status = 503;
  const failed = await picker.pick(input, ["library"]);
  assert.deepEqual(failed.ok ? null : failed.outcome, "failed");
});

test("picker times out and rejects partial answers", async () => {
  const quick: PickerConfig = { ...config, timeoutMs: 20 };
  const slow = new ToolPicker(
    "key",
    quick,
    ((_url, init) =>
      new Promise((_resolve, reject) => {
        // AbortSignal.timeout does not keep the event loop alive on its own.
        const alive = setTimeout(() => {}, 5000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(alive);
          reject(init.signal!.reason);
        });
      })) as typeof fetch,
  );
  const timedOut = await slow.pick(input, ["library"]);
  assert.deepEqual(timedOut.ok ? null : timedOut.outcome, "timeout");
  const partial = new ToolPicker(
    "key",
    config,
    (async () =>
      new Response(
        JSON.stringify({ answers: { library: { noul: 0.9 } } }),
      )) as typeof fetch,
  );
  const invalid = await partial.pick(input, ["library", "gmail"]);
  assert.deepEqual(invalid.ok ? null : invalid.outcome, "invalid");
});

test("transport and usage-accounting failures fall back instead of throwing", async () => {
  const thrown = new ToolPicker("key", config, (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch);
  const network = await thrown.pick(input, ["library"]);
  assert.deepEqual(network.ok ? null : network.outcome, "failed");
  const ledger = {
    begin: async () => {
      throw new Error("Usage owner unavailable");
    },
  } as unknown as Spending;
  const noLedger = await new ToolPicker("key", config, (async () =>
    answers({ library: 0.9 })) as typeof fetch).pick(
    input,
    ["library"],
    ledger,
  );
  assert.deepEqual(noLedger.ok ? null : noLedger.outcome, "failed");
  // A settle failure after a valid answer keeps the answer.
  const settleFails = {
    begin: async () => "charge",
    settle: async () => {
      throw new Error("db down");
    },
  } as unknown as Spending;
  const kept = await new ToolPicker("key", config, (async () =>
    answers({ library: 0.9 })) as typeof fetch).pick(
    input,
    ["library"],
    settleFails,
  );
  assert.deepEqual(kept.ok && kept.domains, ["library"]);
});

test("the operational log never carries picker probabilities or domain names", () => {
  const lines: string[] = [];
  const previous = setOpsSink((line) => lines.push(line));
  try {
    projectEvent("tools.picked", "run-1", {
      outcome: "picked",
      domains: ["gmail", "library"],
      probabilities: { gmail: 0.91, library: 0.6 },
      latencyMs: 280,
      costUsd: 0.00007,
      model: config.model,
    });
    projectEvent("tools.picked", "run-2", {
      outcome: "rejected",
      latencyMs: 90,
      httpStatus: 401,
    });
  } finally {
    setOpsSink(previous);
  }
  const [picked, rejected] = lines.map((l) => JSON.parse(l));
  assert.equal(picked.state, "picked");
  assert.equal(picked.domainCount, 2);
  assert.equal(picked.level, "info");
  assert.equal(rejected.level, "error");
  assert.equal(rejected.httpStatus, 401);
  for (const line of lines) {
    const { ts: _timestamp, ...payload } = JSON.parse(line);
    const encoded = JSON.stringify(payload);
    assert.ok(!encoded.includes("gmail") && !encoded.includes("library"), line);
    assert.ok(!encoded.includes("0.91"), line);
    assert.ok(!("domains" in payload) && !("probabilities" in payload), line);
  }
});

async function fixture(model: ModelAdapter, transport: typeof fetch) {
  const pg = new PGlite();
  for (const f of [
    "001_initial",
    "002_preparation",
    "003_skills",
    "004_daily",
    "005_work",
    "006_runtime",
    "008_costs",
    "012_message_storage",
    "013_conversation_control",
    "014_checkpoint_steering",
  ])
    await pg.exec(
      await readFile(new URL("../db/" + f + ".sql", import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  const assistant = new Assistant(
    db,
    new CustomAgent(model),
    new JobTools(db, { call: async () => ({ content: "public source" }) }),
    { web: true, delegation: false },
    { ms: 900000, models: 40, tools: 100 },
    new ToolPicker("key", config, transport),
  );
  return { pg, db, assistant };
}
const names = (tools: ToolDefinition[]) => tools.map((t) => t.name);
const call = (name: string, args: unknown) => ({
  message: {
    role: "assistant" as const,
    content: null,
    tool_calls: [
      {
        id: `call-${name}-${Math.random()}`,
        type: "function" as const,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
});
const reply = (content: string) => ({
  message: { role: "assistant" as const, content },
});

test("picked domains are offered, recorded, costed and held for the next message", async () => {
  const seen: string[][] = [];
  const responses = [answers({ jobs: 0.92 }), answers({})];
  let asked: string[] = [];
  const f = await fixture(
    {
      generate: async (i) => {
        seen.push(names(i.tools));
        return reply("done");
      },
    },
    (async (_url, init) => {
      asked = Object.keys(JSON.parse(String(init?.body)).questions);
      return responses.shift()!;
    }) as typeof fetch,
  );
  try {
    await f.assistant.respond("owner", "which saved roles fit me best?");
    // Only domains available in this deployment are asked about.
    assert.ok(!asked.includes("gmail"));
    assert.ok(asked.includes("jobs"));
    assert.ok(seen[0]!.includes("job_list"));
    const picked = (
      await f.db.query(
        "SELECT data FROM events WHERE type='tools.picked' ORDER BY id",
      )
    ).rows;
    assert.equal(picked[0].data.outcome, "picked");
    assert.deepEqual(picked[0].data.domains, ["jobs"]);
    assert.equal(picked[0].data.probabilities.jobs, 0.92);
    const charge = (
      await f.db.query(
        "SELECT actual_usd FROM provider_charges WHERE provider='openrouter-jev'",
      )
    ).rows;
    assert.equal(Number(charge[0].actual_usd), 0.00007);
    // The next message picks nothing new, but jobs stays offered.
    await f.assistant.respond("owner", "thanks!");
    assert.ok(seen[1]!.includes("job_list"));
  } finally {
    await f.pg.close();
  }
});

test("a picker failure falls back to the deterministic cues", async () => {
  const seen: string[][] = [];
  const f = await fixture(
    {
      generate: async (i) => {
        seen.push(names(i.tools));
        return reply("done");
      },
    },
    (async () => new Response("{}", { status: 503 })) as typeof fetch,
  );
  try {
    await f.assistant.respond("owner", "which saved roles fit me best?");
    assert.ok(seen[0]!.includes("job_list"));
    const picked = (
      await f.db.query("SELECT data FROM events WHERE type='tools.picked'")
    ).rows;
    assert.equal(picked[0].data.outcome, "failed");
    assert.equal(picked[0].data.httpStatus, 503);
    // A server error may have been billed, so its estimate stays unsettled.
    const charge = (
      await f.db.query(
        "SELECT actual_usd FROM provider_charges WHERE provider='openrouter-jev'",
      )
    ).rows;
    assert.equal(charge[0].actual_usd, null);
  } finally {
    await f.pg.close();
  }
});

test("no picker call is made when no domain is available", async () => {
  let calls = 0;
  const picker = new ToolPicker("key", config, (async () => {
    calls++;
    return answers({});
  }) as typeof fetch);
  const result = await picker.pick(input, []);
  assert.ok(result.ok && result.domains.length === 0);
  assert.equal(calls, 0);
});

test("the same domains give the same tool order whichever way they were chosen", async () => {
  const seen: string[][] = [];
  const responses = [
    answers({ jobs: 0.9, daily: 0.8 }),
    answers({ daily: 0.9, jobs: 0.8 }),
  ];
  const f = await fixture(
    {
      generate: async (i) => {
        seen.push(names(i.tools));
        return reply("done");
      },
    },
    (async () => responses.shift()!) as typeof fetch,
  );
  try {
    await f.assistant.respond("owner", "which roles and reminders?");
    await f.assistant.respond("owner", "reminders and roles again?");
    assert.deepEqual(seen[0], seen[1]);
  } finally {
    await f.pg.close();
  }
});

test("a follow-up absorbed mid-turn gets its own pick", async () => {
  const seen: string[][] = [];
  const messages: string[] = [];
  const responses = [answers({}), answers({ jobs: 0.9 })];
  let second: Promise<unknown> | undefined;
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(
    {
      generate: async (i) => {
        seen.push(names(i.tools));
        if (seen.length === 1) {
          const id = await f.assistant.recordInput(
            "owner",
            "also which roles fit me?",
          );
          second = f.assistant.respondDetailed(
            "owner",
            "also which roles fit me?",
            undefined,
            undefined,
            { id },
          );
          return call("memory_list", {});
        }
        return reply("done");
      },
    },
    (async (_url, init) => {
      messages.push(JSON.parse(String(init?.body)).state.latest_user_message);
      return responses.shift()!;
    }) as typeof fetch,
  );
  try {
    await f.assistant.respond("owner", "hello");
    await second;
    assert.deepEqual(messages, ["hello", "also which roles fit me?"]);
    assert.ok(!seen[0]!.includes("job_list"));
    assert.ok(seen.at(-1)!.includes("job_list"));
  } finally {
    f.assistant.shutdown();
    await f.pg.close();
  }
});

test("background task steps do not call the picker", async () => {
  let calls = 0;
  const f = await fixture(
    { generate: async () => reply("step done") },
    (async () => {
      calls++;
      return answers({});
    }) as typeof fetch,
  );
  try {
    await ensureUser(f.db, "owner");
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO work_tasks(id,user_id,objective,request) VALUES($1,'owner','compare laptops','compare laptops')",
      [id],
    );
    await f.assistant.resume("owner", id).catch(() => undefined);
    assert.ok(
      (await f.db.query("SELECT 1 FROM runtime_runs WHERE user_id='owner'"))
        .rows.length,
    );
    assert.equal(calls, 0);
    // Selection did run, so the absence of picker calls is meaningful.
    assert.ok(
      (await f.db.query("SELECT 1 FROM events WHERE type='tools.selected'"))
        .rows.length,
    );
    assert.equal(
      (await f.db.query("SELECT 1 FROM events WHERE type='tools.picked'")).rows
        .length,
      0,
    );
  } finally {
    await f.pg.close();
  }
});

test("a message longer than the picker sees keeps its word cues", async () => {
  const seen: string[][] = [];
  const f = await fixture(
    {
      generate: async (i) => {
        seen.push(names(i.tools));
        return reply("done");
      },
    },
    (async () => answers({})) as typeof fetch,
  );
  try {
    await f.assistant.respond(
      "owner",
      "background. ".repeat(200) + "Which saved roles fit me?",
    );
    assert.ok(seen[0]!.includes("job_list"));
  } finally {
    await f.pg.close();
  }
});
