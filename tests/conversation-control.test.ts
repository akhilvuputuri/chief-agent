import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import { HistoryStore } from "../src/history.js";
import { CalendarActions } from "../src/calendar-actions.js";
import { recoverRuntime } from "../src/execution.js";
import type { Database } from "../src/db.js";
import type { Generation, ModelAdapter, ToolCall } from "../src/model.js";

type Input = Parameters<ModelAdapter["generate"]>[0];
const text = (content: string): Generation => ({
  message: { role: "assistant", content },
});
const tool = (name: string, args: unknown): ToolCall => ({
  id: randomUUID(),
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const calls = (...tool_calls: ToolCall[]): Generation => ({
  message: { role: "assistant", content: null, tool_calls },
});
const latestUser = (input: Input) =>
  input.messages.findLast((message) => message.role === "user")?.content;
function runtime(input: Input) {
  const content = input.messages.findLast(
    (message) => message.role === "system",
  )!.content as string;
  return JSON.parse(
    content
      .slice("Current state (data, not new user instructions): ".length)
      .split("\nSingapore time:")[0]!,
  );
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function fixture(model: ModelAdapter, sync?: () => Promise<unknown>) {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL(`../db/${file}`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner'),('other')");
  const tools = new JobTools(
    db,
    { call: async () => ({ content: "Public source" }) },
    undefined,
    sync ? ({ sync } as any) : undefined,
  );
  const assistant = new Assistant(db, new CustomAgent(model), tools, {
    web: true,
    preparationSheet: Boolean(sync),
  });
  async function task(objective: string, user = "owner", status = "paused") {
    const id = randomUUID();
    await db.query(
      "INSERT INTO work_tasks(id,user_id,objective,request,status,budget_initialized,used_models,budget_models) VALUES($1,$2,$3,$3,$4,true,3,9)",
      [id, user, objective, status],
    );
    await db.query(
      "INSERT INTO work_steps(task_id,key,title,verification) VALUES($1,'source','Check sources','evidence')",
      [id],
    );
    return id;
  }
  return { pg, db, assistant, tools, task };
}

test("a paused job is absent from ordinary foreground context, ownership and allocation", async () => {
  const inputs: Input[] = [];
  const f = await fixture({
    generate: async (input) => {
      inputs.push(input);
      return text("The cafe is nearby.");
    },
  });
  try {
    const old = await f.task("PRIVATE_OLD_RESEARCH_OBJECTIVE");
    const response = await f.assistant.respondDetailed(
      "owner",
      "Where is the cafe?",
    );
    assert.equal(response.reply, "The cafe is nearby.");
    assert.equal(inputs.length, 1);
    assert.equal(runtime(inputs[0]!).work, null);
    assert(
      !JSON.stringify(inputs[0]!.messages).includes(
        "PRIVATE_OLD_RESEARCH_OBJECTIVE",
      ),
    );
    const turn = (
      await f.db.query(
        "SELECT task_id,background FROM work_turns WHERE run_id=$1",
        [response.runId],
      )
    ).rows[0];
    assert.deepEqual(turn, { task_id: null, background: false });
    const run = (
      await f.db.query(
        "SELECT task_id,used_models,state FROM runtime_runs WHERE id=$1",
        [response.runId],
      )
    ).rows[0];
    assert.deepEqual(run, { task_id: null, used_models: 1, state: "stopped" });
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT status,used_models,budget_models FROM work_tasks WHERE id=$1",
          [old],
        )
      ).rows[0],
      { status: "paused", used_models: 3, budget_models: 9 },
    );
  } finally {
    await f.pg.close();
  }
});

test("a background job uses its exact history and allocation while foreground answers immediately", async () => {
  const entered = deferred<Input>();
  const release = deferred<Generation>();
  const inputs: Input[] = [];
  const f = await fixture({
    generate: async (input) => {
      inputs.push(input);
      if (runtime(input).work) {
        entered.resolve(input);
        return release.promise;
      }
      return text(
        latestUser(input) === "Remember our cafe chat"
          ? "Our recent cafe conversation."
          : "Yes, the cafe is open.",
      );
    },
  });
  let background: ReturnType<Assistant["resumeDetailed"]> | undefined;
  try {
    await f.assistant.respond("owner", "Remember our cafe chat");
    const selected = await f.task(
      "EXACT_BACKGROUND_OBJECTIVE",
      "owner",
      "queued",
    );
    const unrelated = await f.task("NEWER_UNRELATED_OBJECTIVE");
    const previous = randomUUID();
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,task_id,state) VALUES($1,'owner',$2,'stopped')",
      [previous, selected],
    );
    const history = new HistoryStore(f.db);
    await history.append("owner", previous, 0, [
      { role: "user", content: "BACKGROUND_PRIVATE_HISTORY" },
      { role: "assistant", content: "Recorded research checkpoint." },
    ]);
    background = f.assistant.resumeDetailed("owner", selected);
    const jobInput = await bounded(entered.promise, "background model");
    assert.equal(runtime(jobInput).work.task.id, selected);
    assert(
      JSON.stringify(jobInput.messages).includes("BACKGROUND_PRIVATE_HISTORY"),
    );
    assert(
      !JSON.stringify(jobInput.messages).includes(
        "Our recent cafe conversation.",
      ),
    );
    const foreground = await bounded(
      f.assistant.respondDetailed("owner", "Is the cafe open?"),
      "foreground answer during background work",
    );
    assert.equal(foreground.reply, "Yes, the cafe is open.");
    assert.equal(jobInput.signal.aborted, false);
    const foregroundInput = inputs.find(
      (input) => latestUser(input) === "Is the cafe open?",
    )!;
    assert.equal(runtime(foregroundInput).work, null);
    assert(
      JSON.stringify(foregroundInput.messages).includes(
        "Our recent cafe conversation.",
      ),
    );
    assert(
      !JSON.stringify(foregroundInput.messages).includes(
        "BACKGROUND_PRIVATE_HISTORY",
      ),
    );
    assert.equal(
      (
        await f.db.query("SELECT task_id FROM runtime_runs WHERE id=$1", [
          foreground.runId,
        ])
      ).rows[0].task_id,
      null,
    );
    release.resolve(text("BACKGROUND_DELIVERED_RESULT"));
    const result = await bounded(background, "background completion");
    assert.equal(
      (
        await f.db.query("SELECT task_id FROM runtime_runs WHERE id=$1", [
          result.runId,
        ])
      ).rows[0].task_id,
      selected,
    );
    assert.equal(
      (
        await f.db.query("SELECT used_models FROM work_tasks WHERE id=$1", [
          selected,
        ])
      ).rows[0].used_models,
      4,
    );
    assert.equal(
      (
        await f.db.query("SELECT used_models FROM work_tasks WHERE id=$1", [
          unrelated,
        ])
      ).rows[0].used_models,
      3,
    );
    assert(
      !JSON.stringify((await history.recent("owner")).messages).includes(
        "BACKGROUND_DELIVERED_RESULT",
      ),
    );
    await f.assistant.recordDelivery("owner", result.runId!, result.reply);
    await f.assistant.recordDelivery("owner", result.runId!, result.reply);
    const conversation = await history.recent("owner");
    assert.equal(
      conversation.messages.filter(
        (message) => message.content === result.reply,
      ).length,
      1,
    );
    assert(
      !JSON.stringify(conversation.messages).includes(
        "BACKGROUND_PRIVATE_HISTORY",
      ),
    );
    const references = (
      await f.db.query(
        "SELECT id FROM conversation_messages WHERE user_id='owner' AND run_id=$1",
        [result.runId],
      )
    ).rows;
    assert.equal(references.length, 1);
    assert.equal(
      JSON.parse((await history.read("owner", references[0].id, 0)).content)
        .content,
      result.reply,
    );
  } finally {
    release.resolve(text("Cleanup background result"));
    if (background) await background;
    f.assistant.shutdown();
    await f.pg.close();
  }
});

test("new foreground input aborts the active model and the next request retains the latest exchange", async () => {
  const entered = deferred<Input>();
  const inputs: Input[] = [];
  const f = await fixture({
    generate: async (input) => {
      inputs.push(input);
      if (latestUser(input) === "Check the slower option") {
        entered.resolve(input);
        return new Promise<Generation>((_, reject) => {
          if (input.signal.aborted) reject(input.signal.reason);
          else
            input.signal.addEventListener(
              "abort",
              () => reject(input.signal.reason),
              { once: true },
            );
        });
      }
      return text(
        latestUser(input) === "What details do you need?"
          ? "Which option and date should I use?"
          : "I will use the newer option for tomorrow.",
      );
    },
  });
  try {
    await f.assistant.respond("owner", "What details do you need?");
    const first = f.assistant.respondDetailed(
      "owner",
      "Check the slower option",
    );
    const active = await bounded(entered.promise, "first foreground model");
    const second = f.assistant.respondDetailed(
      "owner",
      "Use the newer option tomorrow instead",
    );
    const [stopped, answered] = await bounded(
      Promise.all([first, second]),
      "corrected foreground turn",
    );
    assert.equal(active.signal.aborted, true);
    assert.equal(stopped.reply, "");
    assert.equal(answered.reply, "I will use the newer option for tomorrow.");
    const next = inputs.find(
      (input) => latestUser(input) === "Use the newer option tomorrow instead",
    )!;
    const content = next.messages.map((message) => message.content);
    assert(content.includes("Which option and date should I use?"));
    assert(
      content.indexOf("Check the slower option") <
        content.indexOf("Use the newer option tomorrow instead"),
    );
    assert.equal(runtime(next).work, null);
    assert.equal(
      (
        await f.db.query("SELECT stop_reason FROM runtime_runs WHERE id=$1", [
          stopped.runId,
        ])
      ).rows[0].stop_reason,
      "interrupted",
    );
    const records = (
      await f.db.query(
        "SELECT message,state FROM conversation_inputs WHERE message IN ($1,$2)",
        ["Check the slower option", "Use the newer option tomorrow instead"],
      )
    ).rows;
    assert.deepEqual(
      Object.fromEntries(
        records.map((record) => [record.message, record.state]),
      ),
      {
        "Check the slower option": "interrupted",
        "Use the newer option tomorrow instead": "completed",
      },
    );
  } finally {
    f.assistant.shutdown();
    await f.pg.close();
  }
});

test("new input waits for a dispatched write, records its result and marks remaining calls undispatched", async () => {
  const startedWrite = deferred();
  const finishWrite = deferred();
  let writes = 0;
  const inputs: Input[] = [];
  const skipped = tool("memory_set", {
    key: "must-not-run",
    value: "Old request",
  });
  const write = tool("sheet_sync", {});
  const f = await fixture(
    {
      generate: async (input) => {
        inputs.push(input);
        return latestUser(input) === "Save this and remember it"
          ? calls(write, skipped)
          : text("I received the correction after the export completed.");
      },
    },
    async () => {
      writes++;
      startedWrite.resolve();
      await finishWrite.promise;
      return {
        synced: true,
        url: "https://docs.google.com/spreadsheets/d/test",
      };
    },
  );
  let first: ReturnType<Assistant["respondDetailed"]> | undefined;
  let second: ReturnType<Assistant["respondDetailed"]> | undefined;
  try {
    first = f.assistant.respondDetailed("owner", "Save this and remember it");
    await bounded(startedWrite.promise, "dispatched write");
    const id = await f.assistant.recordInput(
      "owner",
      "Only export; do not save a preference",
    );
    second = f.assistant.respondDetailed(
      "owner",
      "Only export; do not save a preference",
      undefined,
      undefined,
      { id },
    );
    assert.equal(inputs.length, 1);
    assert.deepEqual(
      (await f.db.query("SELECT operation,state FROM runtime_calls")).rows,
      [{ operation: "sheet_sync", state: "started" }],
    );
    finishWrite.resolve();
    const [stopped, answered] = await bounded(
      Promise.all([first, second]),
      "write completion and correction",
    );
    assert.equal(stopped.reply, "");
    assert.equal(
      answered.reply,
      "I received the correction after the export completed.",
    );
    assert.equal(writes, 1);
    assert.equal((await f.db.query("SELECT key FROM memories")).rows.length, 0);
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT operation,state FROM runtime_calls WHERE run_id=$1",
          [stopped.runId],
        )
      ).rows,
      [{ operation: "sheet_sync", state: "success" }],
    );
    const history = await new HistoryStore(f.db).recent("owner", stopped.runId);
    const notDispatched = history.messages.find(
      (message) => message.tool_call_id === skipped.id,
    )!;
    assert.equal(JSON.parse(notDispatched.content!).code, "NOT_DISPATCHED");
    const newInput = inputs.find(
      (input) => latestUser(input) === "Only export; do not save a preference",
    )!;
    assert(
      newInput.messages.some(
        (message) =>
          message.tool_call_id === write.id &&
          String(message.content).includes('"synced":true'),
      ),
    );
    assert(
      newInput.messages.some(
        (message) =>
          message.tool_call_id === skipped.id &&
          String(message.content).includes("NOT_DISPATCHED"),
      ),
    );
    await f.assistant.respond("owner", "Thank you");
    assert.equal(writes, 1);
  } finally {
    finishWrite.resolve();
    f.assistant.shutdown();
    await Promise.allSettled([first, second].filter(Boolean));
    await f.pg.close();
  }
});

test("continuation and cancellation choose exact owner jobs and never guess among candidates", async () => {
  const f = await fixture({ generate: async () => text("Unused model") });
  try {
    const one = await f.task("First paused job");
    const two = await f.task("Second paused job");
    const other = await f.task("Other-owner job", "other");
    const ambiguous = await f.assistant.grant("owner");
    assert.equal((ambiguous as any).ambiguous, true);
    assert.equal(ambiguous.rows.length, 0);
    assert.equal((await f.assistant.grant("owner", other)).rows.length, 0);
    assert.deepEqual(await f.assistant.cancel("owner"), { cancelled: false });
    assert.deepEqual(await f.assistant.cancel("owner", other), {
      cancelled: false,
    });
    assert.deepEqual((await f.assistant.grant("owner", one)).rows, [
      { id: one },
    ]);
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT status,budget_models FROM work_tasks WHERE id=$1",
          [one],
        )
      ).rows[0],
      { status: "queued", budget_models: 49 },
    );
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT status,budget_models FROM work_tasks WHERE id=$1",
          [two],
        )
      ).rows[0],
      { status: "paused", budget_models: 9 },
    );
    assert.deepEqual(await f.assistant.cancel("owner", two), {
      cancelled: true,
    });
    assert.equal(
      (await f.db.query("SELECT status FROM work_tasks WHERE id=$1", [one]))
        .rows[0].status,
      "queued",
    );
    assert.equal(
      (await f.db.query("SELECT status FROM work_tasks WHERE id=$1", [other]))
        .rows[0].status,
      "paused",
    );
  } finally {
    await f.pg.close();
  }
});

test("an exact continuation ID remains usable beyond the brief job list limit", async () => {
  const f = await fixture({ generate: async () => text("Unused model") });
  try {
    const older = await f.task("Old but explicitly selected job");
    await f.db.query(
      "UPDATE work_tasks SET updated_at=now()-interval '1 year' WHERE id=$1",
      [older],
    );
    for (let index = 0; index < 50; index++)
      await f.task(`Newer unrelated ${index}`, "owner", "running");
    assert.deepEqual((await f.assistant.grant("owner", older)).rows, [
      { id: older },
    ]);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int AS total FROM work_tasks WHERE status='running'",
        )
      ).rows[0].total,
      50,
    );
  } finally {
    await f.pg.close();
  }
});

test("a pending question retains exact sources across restart and text assent cannot create Calendar events", async () => {
  const source = randomUUID();
  let initialCalls = 0;
  let creates = 0;
  const f = await fixture({
    generate: async () => {
      initialCalls++;
      return initialCalls === 1
        ? calls(tool("source_read", { id: source }))
        : calls(
            tool("finish_turn", {
              reason: "awaiting_user",
              reply:
                "What date and time should I use for the Board review in this document?",
            }),
          );
    },
  });
  let restarted: Assistant | undefined;
  try {
    await f.task("OLDER_UNRELATED_CALENDAR_TASK");
    await f.db.query(
      "INSERT INTO research_sources(id,user_id,url,content) VALUES($1,'owner','https://example.com/board-review','Current document: Board review, main office, one hour.')",
      [source],
    );
    const question = await f.assistant.respondDetailed(
      "owner",
      "Add the Board review from this document to my calendar",
    );
    assert.match(question.reply, /What date and time/);
    const stored = (
      await f.db.query(
        "SELECT pending_reply FROM conversation_contexts WHERE user_id='owner' AND run_id=$1",
        [question.runId],
      )
    ).rows[0].pending_reply;
    assert.deepEqual(stored.sourceIds, [source]);
    assert.equal(stored.runId, question.runId);
    assert.match(stored.question, /Board review/);
    f.assistant.shutdown();
    await recoverRuntime(f.db);

    const calendar = new CalendarActions(
      f.db,
      {
        create: async () => {
          creates++;
          return {
            id: "created-event",
            url: "https://calendar.google.com/calendar/event",
          };
        },
        findCreated: async () => null,
      } as any,
      "owner",
    );
    const tools = new JobTools(
      f.db,
      { call: async () => ({}) },
      undefined,
      undefined,
      undefined,
      calendar,
    );
    const inputs: Input[] = [];
    const perRun = new Map<string, number>();
    restarted = new Assistant(
      f.db,
      new CustomAgent({
        generate: async (input) => {
          inputs.push(input);
          const attempt = (perRun.get(input.sessionId!) ?? 0) + 1;
          perRun.set(input.sessionId!, attempt);
          if (latestUser(input) === "Tomorrow at 9 for one hour")
            return attempt === 1
              ? calls(
                  tool("calendar_draft", {
                    title: "Board review",
                    start: "2026-09-14T09:00:00+08:00",
                    end: "2026-09-14T10:00:00+08:00",
                    location: "Main office",
                  }),
                )
              : calls(
                  tool("finish_turn", {
                    reason: "awaiting_approval",
                    reply:
                      "Please approve the saved Board review event using its Calendar card.",
                  }),
                );
          // Even an erroneous model call after text assent cannot reach Calendar creation.
          return attempt === 1
            ? calls(tool("calendar_create", { title: "Board review" }))
            : text("Use the exact Calendar approval card to create the event.");
        },
      }),
      tools,
      { calendar: true },
    );
    const draft = await restarted.respondDetailed(
      "owner",
      "Tomorrow at 9 for one hour",
    );
    assert.match(draft.reply, /approve the saved Board review/);
    const resumed = inputs[0]!;
    assert.deepEqual(runtime(resumed).conversation.pendingReply.sourceIds, [
      source,
    ]);
    assert.equal(
      runtime(resumed).conversation.pendingReply.runId,
      question.runId,
    );
    assert(
      JSON.stringify(resumed.messages).includes(
        "What date and time should I use for the Board review",
      ),
    );
    assert(
      !JSON.stringify(resumed.messages).includes(
        "OLDER_UNRELATED_CALENDAR_TASK",
      ),
    );
    const approval = (
      await f.db.query(
        "SELECT id,status,payload FROM approvals WHERE user_id='owner' AND operation='calendar_create'",
      )
    ).rows[0];
    assert.equal(approval.payload.draft.title, "Board review");
    assert.equal(approval.status, "pending");
    assert.equal(creates, 0);
    await restarted.respond("owner", "Yes, go ahead");
    assert.equal(creates, 0);
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT status,payload->>'execution' AS execution FROM approvals WHERE id=$1",
          [approval.id],
        )
      ).rows[0],
      { status: "pending", execution: "not_started" },
    );
    const rejected = (
      await f.db.query(
        "SELECT state FROM runtime_calls WHERE operation='calendar_create'",
      )
    ).rows;
    assert.deepEqual(rejected, [{ state: "failed" }]);
  } finally {
    restarted?.shutdown();
    f.assistant.shutdown();
    await f.pg.close();
  }
});
