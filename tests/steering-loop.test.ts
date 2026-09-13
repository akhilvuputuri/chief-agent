import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { CustomAgent } from "../src/custom-agent.js";
import { Execution, Stop, type StopReason } from "../src/execution.js";
import { NotDispatchedError } from "../src/tool-errors.js";
import type { AgentRequest } from "../src/protocol.js";
import type { Message, ModelAdapter } from "../src/model.js";
import type { Database } from "../src/db.js";
import { runResearchSpecialist } from "../src/research.js";
import { researchReport } from "../src/research-schema.js";
import { HistoryStore } from "../src/history.js";

const text = (content: string) => ({
  message: { role: "assistant" as const, content },
});
const calls = (
  operations: Array<[string, unknown]>,
  content: string | null = null,
) => ({
  message: {
    role: "assistant" as const,
    content,
    tool_calls: operations.map(([name, args]) => ({
      id: randomUUID(),
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    })),
  },
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { resolve, promise };
}
function fixture(model: ModelAdapter) {
  const controller = new AbortController();
  const pending: Array<{ id: string; message: string }> = [];
  const checkpoints: Message[][] = [];
  const records: Array<{
    operation: string;
    result?: unknown;
    state?: string;
  }> = [];
  const progress: string[] = [];
  const dispatched: unknown[] = [];
  const finished: StopReason[] = [];
  const execution = {
    user: "owner",
    run: randomUUID(),
    db: {
      query: async (sql?: string, values?: unknown[]) => ({
        rows: sql?.includes("WITH selected_messages AS")
          ? [{ saved: (values?.[2] as number[]).length }]
          : [],
      }),
    },
    checkpoint: async (messages: Message[]) => {
      const prior = checkpoints.at(-1) ?? [];
      assert.deepEqual(messages.slice(0, prior.length), prior);
      checkpoints.push(structuredClone(messages));
    },
    consume: async () => 900000,
    trace: async () => {},
    elapsed: async () => {},
    attach: async () => {},
    beginCall: async (_id: string, operation: string) => {
      records.push({ operation });
      return String(records.length - 1);
    },
    endCall: async (id: string, result: unknown, state = "success") => {
      Object.assign(records[Number(id)]!, { result, state });
    },
    finish: async (reason: StopReason) => {
      finished.push(reason);
    },
  };
  const req: AgentRequest = {
    runId: execution.run,
    capability: "",
    message: "Original request",
    history: [],
    memories: [],
    runtime: {
      context: "",
      tools: ["memory_list", "memory_set", "item_list"].map((name) => ({
        name,
        description: name,
        parameters: { type: "object", properties: {} },
      })),
    },
    execution: execution as unknown as Execution,
    signal: controller.signal,
    shouldYield: () => pending.length > 0,
    steer: async () => pending.splice(0),
    execute: async (input) => {
      dispatched.push(input);
      return { saved: true };
    },
    progress: async (message) => {
      progress.push(message);
    },
  };
  const enqueue = (...messages: string[]) => {
    pending.push(...messages.map((message) => ({ id: randomUUID(), message })));
  };
  return {
    req,
    execution,
    controller,
    checkpoints,
    records,
    progress,
    dispatched,
    finished,
    enqueue,
    run: () => new CustomAgent(model).run(req),
  };
}

test("ordinary input waits for the model, closes its unstarted batch, and stays in the same run", async () => {
  const started = gate();
  const release = gate();
  let modelCalls = 0;
  let firstSignal: AbortSignal | undefined;
  const sessions: string[] = [];
  const stale = calls(
    [
      ["memory_set", { key: "style", value: "long" }],
      ["finish_turn", { reply: "Old answer", reason: "answer" }],
    ],
    "Stale progress",
  );
  const f = fixture({
    generate: async (input) => {
      sessions.push(input.sessionId!);
      if (++modelCalls === 1) {
        firstSignal = input.signal;
        started.resolve();
        await release.promise;
        assert.equal(input.signal.aborted, false);
        return stale;
      }
      assert.deepEqual(
        input.messages.filter((m) => m.role === "user").map((m) => m.content),
        ["Original request", "First correction", "Second correction"],
      );
      for (const call of stale.message.tool_calls) {
        const result = input.messages.find((m) => m.tool_call_id === call.id)!;
        assert.equal(JSON.parse(String(result.content)).code, "NOT_DISPATCHED");
      }
      return text("Updated answer");
    },
  });
  const run = f.run();
  await started.promise;
  f.enqueue("First correction", "Second correction");
  assert.equal(firstSignal!.aborted, false);
  release.resolve();
  const result = await run;
  assert.equal(result.reply, "Updated answer");
  assert.equal(result.stopReason, "answer");
  assert.deepEqual(sessions, [f.req.runId, f.req.runId]);
  assert.deepEqual(f.progress, []);
  assert.deepEqual(f.dispatched, []);
  assert.deepEqual(f.finished, ["answer"]);
  assert.deepEqual((result.history as Message[])[1], stale.message);
});

test("a completed write is retained once while the rest of its batch is skipped", async () => {
  const started = gate();
  const release = gate();
  let count = 0;
  const response = calls([
    ["memory_set", { key: "style", value: "short" }],
    ["memory_set", { key: "timezone", value: "UTC" }],
  ]);
  const f = fixture({
    generate: async (input) => {
      if (!count++) return response;
      const outputs = input.messages.filter((m) => m.role === "tool");
      assert.equal(JSON.parse(String(outputs[0]!.content)).result.saved, true);
      assert.equal(
        JSON.parse(String(outputs[1]!.content)).code,
        "NOT_DISPATCHED",
      );
      return text("The first save completed; the correction is understood.");
    },
  });
  f.req.execute = async (input) => {
    f.dispatched.push(input);
    started.resolve();
    await release.promise;
    return { saved: true };
  };
  const run = f.run();
  await started.promise;
  f.enqueue("Keep my existing timezone");
  release.resolve();
  const result = await run;
  assert.equal(result.stopReason, "answer");
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0]!.state, "success");
});

test("new input during journal creation prevents dispatch and records the call as interrupted", async () => {
  let count = 0;
  const f = fixture({
    generate: async () =>
      !count++
        ? calls([["memory_set", { key: "style", value: "long" }]])
        : text("Correction applied"),
  });
  const beginCall = f.execution.beginCall;
  f.execution.beginCall = async (...args) => {
    const id = await beginCall(...args);
    f.enqueue("Make it concise");
    return id;
  };
  assert.equal((await f.run()).reply, "Correction applied");
  assert.equal(f.records[0]!.state, "interrupted");
  assert.deepEqual(f.dispatched, []);
});

test("an authorization checkpoint rejection skips the group and absorbs the input", async () => {
  let count = 0;
  const f = fixture({
    generate: async () =>
      !count++
        ? calls([
            ["memory_set", { key: "style", value: "long" }],
            ["item_list", {}],
          ])
        : text("Updated after authorization checkpoint"),
  });
  f.req.execute = async () => {
    f.enqueue("Changed request");
    throw new NotDispatchedError("interrupted");
  };
  const result = await f.run();
  assert.equal(result.reply, "Updated after authorization checkpoint");
  const results = (result.history as Message[]).filter(
    (m) => m.role === "tool",
  );
  assert.equal(results.length, 2);
  assert.ok(
    results.every((m) => JSON.parse(m.content!).code === "NOT_DISPATCHED"),
  );
  assert.equal(f.records[0]!.state, "interrupted");
});

test("suppressed plain final replies stay in the run journal with projection indices", async () => {
  let count = 0;
  const f = fixture({
    generate: async (input) => {
      if (!count++) {
        f.enqueue("Use the revised question");
        return text("Undelivered old reply");
      }
      assert.doesNotMatch(
        JSON.stringify(input.messages),
        /Undelivered old reply/,
      );
      return text("Delivered new reply");
    },
  });
  const result = await f.run();
  assert.equal(result.reply, "Delivered new reply");
  assert.deepEqual(result.undeliveredMessageIndices, [1]);
  assert.equal((result.history[1] as Message).content, "Undelivered old reply");
  assert.ok(
    f.checkpoints.some(
      (messages) => messages[1]?.content === "Undelivered old reply",
    ),
  );
});

test("new input during final answer checkpoint suppresses both reply and saved-detail marker", async () => {
  let count = 0;
  const f = fixture({
    generate: async () =>
      !count++
        ? calls([
            [
              "finish_turn",
              {
                reply: "Stale detailed reply",
                reason: "answer",
                sections: [{ title: "Details", body: "Old details" }],
              },
            ],
          ])
        : text("Fresh reply"),
  });
  const checkpoint = f.execution.checkpoint;
  let queued = false;
  f.execution.checkpoint = async (messages) => {
    await checkpoint(messages);
    if (!queued && messages.some((m) => m.content === "Stale detailed reply")) {
      queued = true;
      f.enqueue("Change the scope");
    }
  };
  const result = await f.run();
  assert.equal(result.reply, "Fresh reply");
  assert.equal(result.sections, undefined);
  assert.deepEqual(result.undeliveredMessageIndices, [3, 4]);
});

test("explicit cancellation still aborts the active model and never invokes steering", async () => {
  const started = gate();
  const f = fixture({
    generate: async (input) => {
      started.resolve();
      return new Promise((_, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    },
  });
  f.req.steer = async () => {
    assert.fail("Cancellation must not consume ordinary input");
  };
  const run = f.run();
  await started.promise;
  f.controller.abort();
  const result = await run;
  assert.equal(result.stopReason, "cancelled");
  assert.deepEqual(f.dispatched, []);
});

test("specialist requests without a steering drain yield cooperatively after their response", async () => {
  const f = fixture({
    generate: async () => {
      f.enqueue("New parent instruction");
      return calls([["memory_list", {}]]);
    },
  });
  delete f.req.steer;
  const result = await f.run();
  assert.equal(result.stopReason, "interrupted");
  assert.equal(result.reply, "");
  assert.deepEqual(f.dispatched, []);
  assert.equal(
    JSON.parse((result.history.at(-1) as Message).content!).code,
    "NOT_DISPATCHED",
  );
});

test("a task-bound steering handoff closes the old batch without consuming its new input", async () => {
  const f = fixture({
    generate: async () => {
      f.enqueue("New foreground task");
      return calls([["memory_list", {}]]);
    },
  });
  f.req.steer = async () => {
    throw new Stop("interrupted");
  };
  const result = await f.run();
  assert.equal(result.stopReason, "interrupted");
  assert.deepEqual(
    (result.history as Message[])
      .filter((m) => m.role === "user")
      .map((m) => m.content),
    ["Original request"],
  );
  assert.deepEqual(f.dispatched, []);
});

test("research yields after a completed read and returns the exact owner-scoped source reference", async () => {
  const pg = new PGlite();
  for (const file of [
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
      await readFile(new URL(`../db/${file}.sql`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  const signal = new AbortController().signal;
  const parent = new Execution(db, "owner", randomUUID(), signal);
  const sourceId = randomUUID();
  let pending = false;
  try {
    await db.query("INSERT INTO users(id) VALUES('owner')");
    await parent.start();
    await db.query(
      "INSERT INTO research_sources(id,user_id,url,content) VALUES($1,'owner','https://example.com/platform','Supports Linux')",
      [sourceId],
    );
    let modelCalls = 0;
    const agent = new CustomAgent({
      generate: async (input) => {
        modelCalls++;
        assert.equal(input.signal.aborted, false);
        return calls([
          ["web_read", { url: "https://example.com/platform" }],
          ["web_read", { url: "https://example.com/unneeded" }],
        ]);
      },
    });
    const result = await runResearchSpecialist(
      {
        runId: parent.run,
        capability: "",
        message: "Read the platform",
        history: [],
        memories: [],
        execution: parent,
        signal,
        shouldYield: () => pending,
        runtime: {
          context: "",
          tools: [
            {
              name: "web_read",
              description: "Read",
              parameters: { type: "object" },
            },
          ],
        },
        executeResearch: async () => {
          pending = true;
          return {
            sourceId,
            content: "Supports Linux",
            url: "https://example.com/platform",
          };
        },
      },
      (req) => agent.run(req),
      {
        a: { objective: "Read the platform", context: "" },
        targets: [{ targetId: "https://example.com/platform" }],
        profile: {
          role: "job_alignment",
          instructions: "Read-only research specialist.",
          reportSchema: researchReport,
          reportName: "research_report",
          reads: new Set(["web_read"]),
          limits: { ms: 900000, models: 10, tools: 20 },
          metadata: {},
          validate: async () => {},
        },
      },
    );
    assert.equal(result.status, "incomplete");
    assert.equal(result.stopReason, "interrupted");
    assert.equal(modelCalls, 1);
    assert.equal(result.observedSources?.length, 1);
    assert.equal(result.observedSources?.[0].sourceId, sourceId);
    assert.equal(
      result.observedSources?.[0].url,
      "https://example.com/platform",
    );
    const rows = (
      await db.query(
        "SELECT id,operation,state FROM runtime_calls WHERE run_id=$1",
        [result.childRunId],
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "success");
    assert.equal(rows[0].id, result.observedSources?.[0].observationId);
    const history = (
      await new HistoryStore(db).recent("owner", result.childRunId)
    ).messages;
    assert.equal(history.filter((m) => m.role === "tool").length, 2);
    assert.equal(JSON.parse(history.at(-1)!.content!).code, "NOT_DISPATCHED");
  } finally {
    await pg.close();
  }
});

test("input arriving during final approval lookup is handled before finalizing the run", async () => {
  let count = 0;
  const f = fixture({
    generate: async () =>
      text(!count++ ? "Old lookup reply" : "Updated lookup reply"),
  });
  const query = f.execution.db.query;
  let queued = false;
  f.execution.db.query = async (...args) => {
    if (!queued) {
      queued = true;
      f.enqueue("Update while checking approvals");
    }
    return query(...args);
  };
  const result = await f.run();
  assert.equal(result.reply, "Updated lookup reply");
  assert.deepEqual(result.undeliveredMessageIndices, [1]);
  assert.deepEqual(f.finished, ["answer"]);
});

test("steered runtime tools and images are refreshed before the next model call", async () => {
  let count = 0;
  const f = fixture({
    generate: async (input) => {
      if (!count++) {
        f.enqueue("Use the new attachment too");
        return text("Old attachment answer");
      }
      assert.ok(input.tools.some((tool) => tool.name === "source_read"));
      assert.equal(f.req.images?.length, 2);
      assert.equal(f.req.images?.[0]?.id, "old");
      assert.equal(f.req.images?.[1]?.id, "new");
      assert.match(JSON.stringify(input.messages), /refreshed context/);
      return text("Both attachments remain available");
    },
  });
  f.req.images = [
    {
      id: "old",
      name: "old.png",
      mimeType: "image/png",
      bytes: 3,
      data: "YWJj",
    },
  ];
  const drain = f.req.steer!;
  f.req.steer = async () => {
    const inputs = await drain();
    f.req.runtime = {
      context: "refreshed context",
      tools: [
        {
          name: "source_read",
          description: "Read source",
          parameters: { type: "object" },
        },
      ],
    };
    f.req.images!.push({
      id: "new",
      name: "new.png",
      mimeType: "image/png",
      bytes: 3,
      data: "ZGVm",
    });
    return inputs;
  };
  assert.equal((await f.run()).reply, "Both attachments remain available");
});

test("waiting for prepared input does not spend active model or tool time", async (t) => {
  for (const boundary of [
    "before-model",
    "model-failure",
    "tool-rejection",
  ] as const) {
    let now = 0;
    const dateNow = t.mock.method(Date, "now", () => now);
    let generations = 0;
    let interrupted = false;
    const elapsed: number[] = [];
    const f = fixture({
      generate: async () => {
        generations++;
        if (!interrupted && boundary === "model-failure") {
          interrupted = true;
          now += 11;
          f.enqueue("Waiting for transcription");
          throw new TypeError("Transient model failure");
        }
        if (!interrupted && boundary === "tool-rejection")
          return calls([["memory_list", {}]]);
        return text("Prepared input handled");
      },
    });
    const trace = f.execution.trace;
    f.execution.trace = async (...args) => {
      await trace(...args);
      if (!interrupted && boundary === "before-model") {
        interrupted = true;
        now += 7;
        f.enqueue("Waiting for PDF preparation");
      }
    };
    f.req.execute = async () => {
      interrupted = true;
      now += 13;
      f.enqueue("Waiting for image preparation");
      throw new NotDispatchedError("interrupted");
    };
    const drain = f.req.steer!;
    f.req.steer = async () => {
      now += 5000;
      return drain();
    };
    f.execution.elapsed = async (milliseconds: number) => {
      elapsed.push(milliseconds);
    };
    try {
      const result = await f.run();
      assert.equal(result.reply, "Prepared input handled");
      assert.equal(
        elapsed.reduce((sum, milliseconds) => sum + milliseconds, 0),
        boundary === "before-model"
          ? 7
          : boundary === "model-failure"
            ? 11
            : 13,
      );
      assert.equal(generations, boundary === "before-model" ? 1 : 2);
    } finally {
      dateNow.mock.restore();
    }
  }
});
