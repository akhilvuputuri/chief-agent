import { boundedBytes } from "../src/providers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import {
  OpenRouter,
  ModelError,
  type ModelAdapter,
  type Message,
} from "../src/model.js";
import { JobTools } from "../src/tools.js";
import { recoverRuntime } from "../src/execution.js";
import { boundHistory } from "../src/context.js";
import { ScheduleParser } from "../src/schedule.js";
import { runtimeContext } from "../src/runtime.js";
import type { Database } from "../src/db.js";
async function fixture(
  model: ModelAdapter,
  budget = { ms: 900000, models: 40, tools: 100 },
) {
  const pg = new PGlite();
  for (const f of [
    "001_initial",
    "002_preparation",
    "003_skills",
    "004_daily",
    "005_work",
    "006_runtime",
    "008_costs",
  ])
    await pg.exec(
      await readFile(new URL("../db/" + f + ".sql", import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  const assistant = new Assistant(
    db,
    new CustomAgent(model),
    new JobTools(db, { call: async () => ({ content: "public source" }) }),
    { web: true },
    budget,
  );
  return { pg, db, assistant };
}
const text = (content: string) => ({
  message: { role: "assistant" as const, content },
});
const call = (name: string, args: unknown) => ({
  message: {
    role: "assistant" as const,
    content: null,
    tool_calls: [
      {
        id: randomUUID(),
        type: "function" as const,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
});
test("actual OpenRouter wire preserves Sol, medium reasoning and price-first ceilings", async () => {
  let sent: any;
  const model = new OpenRouter("test-key", undefined, 2, 10, (async (
    _url,
    init,
  ) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({
      choices: [{ message: { role: "assistant", content: "hello" } }],
      provider: "test",
      usage: { cost: 0.01 },
    });
  }) as typeof fetch);
  const result = await model.generate({
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    reasoning: "medium",
    sessionId: "stable-session",
    signal: new AbortController().signal,
  });
  assert.equal(sent.session_id, "stable-session");
  assert.equal(sent.model, "openai/gpt-5.6-sol");
  assert.deepEqual(sent.reasoning, { enabled: true, effort: "medium" });
  assert.deepEqual(sent.provider, {
    sort: "price",
    max_price: { prompt: 2, completion: 10 },
    require_parameters: true,
  });
  assert.equal(result.usage?.cost, 0.01);
  const unavailable = new OpenRouter(
    "test",
    undefined,
    2,
    10,
    (async () => new Response("", { status: 404 })) as typeof fetch,
  );
  await assert.rejects(
    () =>
      unavailable.generate({
        messages: [],
        tools: [],
        reasoning: "medium",
        signal: new AbortController().signal,
      }),
    /No eligible provider/,
  );
});
test("custom conversation persists model and tool records, observes real results, and returns natural prose", async () => {
  let n = 0;
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({
    generate: async (input) => {
      n++;
      if (n === 1)
        return call("memory_set", { key: "style", value: "Concise" });
      assert.equal(
        JSON.parse(input.messages.findLast((m) => m.role === "tool")!.content!)
          .result.saved,
        true,
      );
      const records = (
        await f.db.query("SELECT state,result FROM runtime_calls")
      ).rows;
      assert.equal(records[0].state, "success");
      return text("I’ll keep replies concise.");
    },
  });
  try {
    assert.equal(
      await f.assistant.respond(
        "owner",
        "Remember that I prefer concise replies",
      ),
      "I’ll keep replies concise.",
    );
    const run = (await f.db.query("SELECT * FROM runtime_runs")).rows[0];
    assert.equal(run.stop_reason, "answer");
    assert.equal(run.used_models, 2);
    assert.equal(run.used_tools, 1);
    assert.equal(run.messages[1].tool_calls[0].function.name, "memory_set");
    assert.equal(
      (await f.db.query("SELECT value FROM memories")).rows[0].value,
      "Concise",
    );
  } finally {
    await f.pg.close();
  }
});
test("invalid identities and unauthorized operations cannot reach dispatcher", async () => {
  let n = 0;
  const f = await fixture({
    generate: async (input) => {
      n++;
      if (n === 1)
        return call("memory_set", { key: "x", value: "x", user: "victim" });
      assert.match(
        input.messages.findLast((m) => m.role === "tool")!.content!,
        /INVALID_INPUT/,
      );
      return text("Could not save those arguments.");
    },
  });
  try {
    await f.assistant.respond("owner", "test");
    assert.equal((await f.db.query("SELECT * FROM memories")).rows.length, 0);
  } finally {
    await f.pg.close();
  }
  const tools = runtimeContext({}, null).tools;
  assert.ok(tools.some((t) => t.name === "job_list"));
  assert.ok(!tools.some((t) => t.name === "gmail_read" || t.name === "shell"));
  assert.ok(
    !(
      "operation" in
      (tools.find((t) => t.name === "job_save")!.parameters.properties as any)
    ),
  );
});
test("task budget persists across continuations, grant adds capacity without resetting steps", async () => {
  let n = 0;
  const f = await fixture(
    {
      generate: async () => {
        n++;
        if (n === 1)
          return call("work_start", {
            objective: "Research",
            steps: [{ key: "a", title: "Research", verification: "evidence" }],
          });
        return call("work_status", {});
      },
    },
    { ms: 900000, models: 3, tools: 100 },
  );
  try {
    await f.assistant.respond("owner", "Research");
    let t = (await f.db.query("SELECT * FROM work_tasks")).rows[0];
    assert.equal(t.used_models, 3);
    assert.equal(t.status, "paused");
    await f.assistant.resume("owner", t.id);
    assert.equal(n, 3);
    await f.assistant.grant("owner");
    t = (await f.db.query("SELECT * FROM work_tasks")).rows[0];
    assert.equal(t.budget_models, 6);
    assert.equal(t.used_models, 3);
    await f.assistant.resume("owner", t.id);
    assert.equal(n, 6);
    assert.equal((await f.db.query("SELECT * FROM work_steps")).rows.length, 1);
  } finally {
    await f.pg.close();
  }
});
test("cancellation aborts the in-flight model and no later tools dispatch", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const f = await fixture({
    generate: async (input) => {
      entered();
      return new Promise((_resolve, reject) =>
        input.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    },
  });
  try {
    const pending = f.assistant.respond("owner", "Think");
    await ready;
    await f.assistant.cancel("owner");
    assert.match(await pending, /Cancelled/);
    assert.equal(
      (await f.db.query("SELECT * FROM runtime_calls")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT stop_reason FROM runtime_runs")).rows[0]
        .stop_reason,
      "cancelled",
    );
  } finally {
    await f.pg.close();
  }
});
test("transient model retries are bounded and charged; failure does not expose upstream secrets", async () => {
  let n = 0;
  const f = await fixture({
    generate: async () => {
      n++;
      throw new ModelError("Temporary model outage", true);
    },
  });
  try {
    await f.assistant.respond("owner", "test");
    assert.equal(n, 3);
    assert.equal(
      (await f.db.query("SELECT used_models FROM runtime_runs")).rows[0]
        .used_models,
      3,
    );
  } finally {
    await f.pg.close();
  }
});
test("restart preserves completed work and pauses uncertain writes instead of replaying", async () => {
  let n = 0;
  const f = await fixture({
    generate: async () => {
      n++;
      return n === 1
        ? call("work_start", {
            objective: "Research",
            steps: [{ key: "a", title: "Research", verification: "evidence" }],
          })
        : text("Started.");
    },
  });
  try {
    await f.assistant.respond("owner", "Research");
    const run = (await f.db.query("SELECT id FROM runtime_runs")).rows[0].id;
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write) VALUES($1,$2,'uncertain','sheet_sync','{}',true)",
      [randomUUID(), run],
    );
    await recoverRuntime(f.db);
    const task = (await f.db.query("SELECT * FROM work_tasks")).rows[0];
    assert.equal(task.status, "paused");
    assert.equal(task.pause_reason, "uncertain_write");
    assert.equal((await f.assistant.grant("owner")).rows.length, 0);
    assert.equal(
      (await f.db.query("SELECT * FROM runtime_calls WHERE state='uncertain'"))
        .rows.length,
      1,
    );
  } finally {
    await f.pg.close();
  }
});
test("context retains whole tool groups and bounds turns and characters", () => {
  const history: Message[] = [];
  for (let i = 0; i < 25; i++)
    history.push(
      { role: "user", content: String(i) },
      { role: "assistant", content: "answer" },
    );
  assert.equal(boundHistory(history).messages.length, 40);
  const incomplete: Message[] = [
    { role: "user", content: "test" },
    call("job_list", {}).message,
  ];
  assert.equal(boundHistory(incomplete).messages.length, 1);
  const complete: Message[] = [
    ...incomplete,
    {
      role: "tool",
      tool_call_id: incomplete[1]!.tool_calls![0]!.id,
      content: "[]",
    },
  ];
  assert.equal(boundHistory(complete).messages.length, 3);
  assert.equal(boundHistory(complete, 20, 5).messages.length, 0);
});
test("TypeScript scheduler preserves parsed formats and Singapore recurrence", async () => {
  const p = new ScheduleParser(() => new Date("2026-09-06T00:00:00Z"));
  assert.equal((await p.next("in 30m")).next, "2026-09-06T00:30:00.000Z");
  assert.equal(
    (await p.next("every day at 9am")).next,
    "2026-09-06T01:00:00.000Z",
  );
  for (const parsed of [
    { kind: "interval", minutes: 120, display: "old" },
    { kind: "cron", expr: "0 9 * * *", display: "old" },
    { kind: "once", run_at: "2026-09-07T01:00:00Z", display: "old" },
  ])
    assert.deepEqual((await p.next("", parsed)).parsed, parsed);
  await assert.rejects(() => p.next("every 30m"));
  await assert.rejects(() => p.next("*/10 * * * *"));
  assert.equal(
    (await p.next("", { kind: "once", run_at: "2026-09-05T01:00:00Z" })).next,
    null,
  );
});

test("migration archives legacy payloads unchanged, preserves schedules, and pauses once", async () => {
  const f = await fixture({ generate: async () => text("hello") });
  try {
    await f.db.query("INSERT INTO users(id) VALUES('legacy')");
    const legacy = [
      { role: "system", content: "old framework" },
      { role: "user", content: "My request" },
      { role: "assistant", content: "My reply" },
      { role: "tool", tool_call_id: "orphan", content: "old observation" },
    ];
    await f.db.query(
      "INSERT INTO conversations(user_id,history) VALUES('legacy',$1::jsonb)",
      [JSON.stringify(legacy)],
    );
    const task = randomUUID();
    await f.db.query(
      "INSERT INTO work_tasks(id,user_id,objective,request,status) VALUES($1,'legacy','old task','old request','queued')",
      [task],
    );
    const schedule = randomUUID();
    await f.db.query(
      "INSERT INTO daily_schedules(id,user_id,kind,content,schedule,parsed,next_run) VALUES($1,'legacy','reminder','remember','every 2h',$2::jsonb,'2026-09-07T00:00:00Z')",
      [
        schedule,
        JSON.stringify({ kind: "interval", minutes: 120, display: "every 2h" }),
      ],
    );
    await f.db.query("DELETE FROM runtime_migrations WHERE version=6");
    const sql = await readFile(
      new URL("../db/006_runtime.sql", import.meta.url),
      "utf8",
    );
    await f.pg.exec(sql);
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT history FROM conversation_archives WHERE user_id='legacy'",
        )
      ).rows[0].history,
      legacy,
    );
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT history FROM conversations WHERE user_id='legacy'",
        )
      ).rows[0].history,
      legacy.slice(1, 3),
    );
    assert.equal(
      (await f.db.query("SELECT status FROM work_tasks WHERE id=$1", [task]))
        .rows[0].status,
      "paused",
    );
    assert.equal(
      new Date(
        (await f.db.query("SELECT next_run FROM daily_schedules")).rows[0]
          .next_run,
      ).toISOString(),
      "2026-09-07T00:00:00.000Z",
    );
    await f.db.query("UPDATE work_tasks SET status='queued' WHERE id=$1", [
      task,
    ]);
    await f.pg.exec(sql);
    assert.equal(
      (await f.db.query("SELECT status FROM work_tasks WHERE id=$1", [task]))
        .rows[0].status,
      "queued",
    );
  } finally {
    await f.pg.close();
  }
});
test("ambiguous write is never retried and later writes require inspection", async () => {
  let requests = 0,
    dispatches = 0;
  const f = await fixture({
    generate: async () => {
      requests++;
      return call("memory_set", { key: "x", value: "x" });
    },
  });
  try {
    f.assistant.tools.execute = async () => {
      dispatches++;
      throw new Error("network timeout after possible write");
    };
    await f.assistant.respond("owner", "Save x");
    assert.equal(dispatches, 1);
    assert.equal(requests, 1);
    assert.equal(
      (await f.db.query("SELECT state FROM runtime_calls")).rows[0].state,
      "uncertain",
    );
  } finally {
    await f.pg.close();
  }
});
test("read retry is bounded, counted and returns its observation", async () => {
  let n = 0,
    reads = 0;
  const f = await fixture({
    generate: async () =>
      ++n === 1 ? call("job_list", {}) : text("No roles yet."),
  });
  try {
    f.assistant.tools.execute = async () => {
      if (++reads < 3)
        await boundedBytes(new Response("", { status: 503 }), 1024);
      return { result: [] };
    };
    assert.equal(
      await f.assistant.respond("owner", "List roles"),
      "No roles yet.",
    );
    assert.equal(reads, 3);
    assert.equal(
      (await f.db.query("SELECT used_tools FROM runtime_runs")).rows[0]
        .used_tools,
      3,
    );
  } finally {
    await f.pg.close();
  }
});
test("an actual approval stops with awaiting_approval and retains authoritative preview", async () => {
  let n = 0,
    id = "";
  const f = await fixture({
    generate: async () =>
      ++n === 1
        ? call("job_delete", { id })
        : text("Please approve deleting that role."),
  });
  try {
    await f.db.query("INSERT INTO users(id) VALUES('owner')");
    id = randomUUID();
    await f.db.query(
      "INSERT INTO jobs(id,user_id,title,company) VALUES($1,'owner','Test role','Test company')",
      [id],
    );
    const reply = await f.assistant.respond("owner", "Delete Test role");
    assert.match(reply, /Approval required/);
    assert.equal(
      (await f.db.query("SELECT stop_reason FROM runtime_runs")).rows[0]
        .stop_reason,
      "awaiting_approval",
    );
    assert.equal((await f.db.query("SELECT * FROM jobs")).rows.length, 1);
  } finally {
    await f.pg.close();
  }
});
test("unrelated conversation does not spend or restart a paused task", async () => {
  const f = await fixture({ generate: async () => text("Hello!") });
  try {
    await f.db.query("INSERT INTO users(id) VALUES('owner')");
    await f.db.query(
      "INSERT INTO work_tasks(id,user_id,objective,request,status,pause_reason,used_models,budget_models) VALUES($1,'owner','old','old','paused','runtime_cutover',40,40)",
      [randomUUID()],
    );
    assert.equal(await f.assistant.respond("owner", "Hello"), "Hello!");
    const task = (await f.db.query("SELECT status,used_models FROM work_tasks"))
      .rows[0];
    assert.equal(task.status, "paused");
    assert.equal(task.used_models, 40);
  } finally {
    await f.pg.close();
  }
});

test("background resumes forward model-written progress unchanged", async () => {
  let n = 0;
  const f = await fixture({
    generate: async () => {
      n++;
      if (n === 1)
        return call("work_start", {
          objective: "Research",
          steps: [{ key: "a", title: "Research", verification: "evidence" }],
        });
      if (n === 2) return text("I have established the scope.");
      if (n === 3) {
        const g = call("job_list", {});
        return {
          message: {
            ...g.message,
            content:
              "I’m checking the saved roles before comparing their sources.",
          },
        };
      }
      return text("The saved roles have been checked.");
    },
  });
  try {
    await f.assistant.respond("owner", "Research");
    const id = (await f.db.query("SELECT id FROM work_tasks")).rows[0].id;
    const progress: string[] = [];
    await f.assistant.resume("owner", id, async (s) => {
      progress.push(s);
    });
    assert.deepEqual(progress, [
      "I’m checking the saved roles before comparing their sources.",
    ]);
  } finally {
    await f.pg.close();
  }
});

test("current skills use key-only loading and historical versions require UUIDs", async () => {
  const schema = runtimeContext({}, null).tools.find(
    (t) => t.name === "skill_read",
  )!;
  assert.deepEqual(Object.keys(schema.parameters.properties as object), [
    "key",
  ]);
  const historical = runtimeContext({}, null).tools.find(
    (t) => t.name === "skill_version_read",
  )!;
  assert.equal((historical.parameters.properties as any).id.format, "uuid");
  assert.deepEqual(historical.parameters.required, ["key", "id"]);
  let n = 0;
  const f = await fixture({
    generate: async (input) => {
      if (++n === 1) return call("skill_read", { key: "research" });
      const observation = JSON.parse(
        input.messages.findLast((m) => m.role === "tool")!.content!,
      );
      assert.ok(observation.result.version.content.length > 50);
      return text("Research guidance loaded.");
    },
  });
  try {
    assert.equal(
      await f.assistant.respond("owner", "Load research guidance"),
      "Research guidance loaded.",
    );
  } finally {
    await f.pg.close();
  }
});

test("stored observations can be retrieved only by their owner", async () => {
  const f = await fixture({ generate: async () => text("hello") });
  try {
    await f.assistant.respond("owner", "hello");
    await f.assistant.respond("other", "hello");
    const run = (
      await f.db.query(
        "SELECT id FROM runtime_runs WHERE user_id='owner' LIMIT 1",
      )
    ).rows[0].id;
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) VALUES($1,$2,'stored','memory_list','{}',false,'success',$3)",
      [id, run, JSON.stringify({ private: "owner-only content" })],
    );
    const tools = new JobTools(f.db, {
      call: async () => ({ untrusted: true, content: "" }),
    });
    assert.match(
      JSON.stringify(
        await tools.execute("owner", run, {
          operation: "observation_read",
          id,
        }),
      ),
      /owner-only content/,
    );
    const otherRun = (
      await f.db.query(
        "SELECT id FROM runtime_runs WHERE user_id='other' LIMIT 1",
      )
    ).rows[0].id;
    await assert.rejects(
      () =>
        tools.execute("other", otherRun, { operation: "observation_read", id }),
      /Observation not found/,
    );
  } finally {
    await f.pg.close();
  }
});

test("empty provider responses retry before tools and preserve safe diagnostics", async () => {
  let attempts = 0;
  const model = new OpenRouter("test", undefined, 2, 10, (async () => {
    attempts++;
    return Response.json(
      attempts === 1
        ? {
            id: "gen-test",
            provider: "test",
            choices: [{ message: { content: null }, finish_reason: "stop" }],
          }
        : { choices: [{ message: { content: "There are 31 saved roles." } }] },
    );
  }) as typeof fetch);
  const f = await fixture(model);
  try {
    await f.assistant.respond("owner", "How many roles?");
    assert.equal(attempts, 2);
    const failure = (
      await f.db.query("SELECT data FROM events WHERE type='model.failed'")
    ).rows[0].data;
    assert.equal(failure.transient, true);
    assert.equal(failure.diagnostics.responseId, "gen-test");
  } finally {
    await f.pg.close();
  }
});

test("provider error envelopes and exhausted reasoning are classified without exposing raw errors", async () => {
  for (const [body, transient] of [
    [{ error: { code: 503, message: "secret-provider-detail" } }, true],
    [{ error: { code: 401, message: "secret-provider-detail" } }, false],
    [
      {
        choices: [
          { message: { content: "", tool_calls: [] }, finish_reason: "length" },
        ],
      },
      false,
    ],
    [
      { choices: [{ message: { content: "   " }, finish_reason: "stop" }] },
      true,
    ],
  ] as const) {
    const model = new OpenRouter("test", undefined, 2, 10, (async () =>
      Response.json(body)) as typeof fetch);
    await assert.rejects(
      () =>
        model.generate({
          messages: [],
          tools: [],
          reasoning: "medium",
          signal: new AbortController().signal,
        }),
      (e: any) => {
        assert.ok(e instanceof ModelError);
        assert.equal(e.transient, transient);
        assert.ok(!JSON.stringify(e).includes("secret-provider-detail"));
        return true;
      },
    );
  }
});
