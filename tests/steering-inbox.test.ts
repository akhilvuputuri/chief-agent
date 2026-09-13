import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Assistant, type Agent } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import { HistoryStore } from "../src/history.js";
import { recoverRuntime, type Budget } from "../src/execution.js";
import type { Database } from "../src/db.js";
import type { Generation, ModelAdapter } from "../src/model.js";
import type { AgentRequest, ImageAttachment } from "../src/protocol.js";

type Input = Parameters<ModelAdapter["generate"]>[0];
const text = (content: string): Generation => ({
  message: { role: "assistant", content },
});
const call = (name: string, args: unknown): Generation => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: randomUUID(),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
});
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
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
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(
  model: ModelAdapter,
  options: {
    budget?: Budget;
    decorate?: (request: AgentRequest) => void;
    wrapDb?: (db: Database) => Database;
  } = {},
) {
  const pg = new PGlite();
  for (const name of (await readdir(new URL("../db/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL(`../db/${name}`, import.meta.url), "utf8"),
    );
  const db =
    options.wrapDb?.(pg as unknown as Database) ?? (pg as unknown as Database);
  await db.query("INSERT INTO users(id) VALUES('owner'),('other')");
  const requests: AgentRequest[] = [];
  const custom = new CustomAgent(model);
  const agent: Agent = {
    run: async (request) => {
      requests.push(request);
      options.decorate?.(request);
      return custom.run(request);
    },
  };
  const tools = new JobTools(db, { call: async () => ({}) });
  const assistant = new Assistant(db, agent, tools, undefined, options.budget);
  return { pg, db, assistant, requests, history: new HistoryStore(db) };
}
const users = (input: Input) =>
  input.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content);
const image: ImageAttachment = {
  id: randomUUID(),
  name: "receipt.png",
  mimeType: "image/png",
  bytes: 20,
  data: "EPHEMERAL_IMAGE_SECRET_BASE64",
};

test("a burst of ordered inputs produces one run, one final reply and one durable occurrence per input", async () => {
  const entered = deferred<Input>();
  const release = deferred<Generation>();
  const seen: Input[] = [];
  const f = await fixture({
    generate: async (input) => {
      seen.push(input);
      if (seen.length === 1) {
        entered.resolve(input);
        return release.promise;
      }
      return text("Use all three constraints.");
    },
  });
  const pending: Promise<unknown>[] = [];
  try {
    const first = f.assistant.respondDetailed(
      "owner",
      "Compare the three venues",
    );
    pending.push(first);
    const active = await bounded(entered.promise, "initial model");
    const followups = ["Include wheelchair access", "Keep the total under 200"];
    const ids = [];
    for (const message of followups)
      ids.push(await f.assistant.recordInput("owner", message));
    const others = followups.map((message, index) =>
      f.assistant.respondDetailed("owner", message, undefined, undefined, {
        id: ids[index],
      }),
    );
    pending.push(...others);
    assert.equal(active.signal.aborted, false);
    release.resolve(text("STALE_UNSENT_VENUE_ANSWER"));
    const replies = await bounded(
      Promise.all([first, ...others]),
      "burst completion",
    );
    assert.deepEqual(
      replies.map((reply) => reply.reply),
      ["Use all three constraints.", "", ""],
    );
    assert.equal(seen.length, 2);
    assert.equal(new Set(seen.map((input) => input.sessionId)).size, 1);
    assert.deepEqual(users(seen[1]!), [
      "Compare the three venues",
      ...followups,
    ]);
    const records = (
      await f.db.query(
        "SELECT id,state,run_id,message_index,consumed_at FROM conversation_inputs ORDER BY ordinal",
      )
    ).rows;
    assert.equal(records.length, 3);
    assert(
      records.every(
        (row) =>
          row.state === "completed" &&
          row.run_id === replies[0]!.runId &&
          row.consumed_at,
      ),
    );
    assert.equal(new Set(records.map((row) => row.message_index)).size, 3);
    const journal = await f.history.recent("owner", replies[0]!.runId);
    for (const content of ["Compare the three venues", ...followups])
      assert.equal(
        journal.messages.filter((message) => message.content === content)
          .length,
        1,
      );
    assert(
      journal.messages.some(
        (message) => message.content === "STALE_UNSENT_VENUE_ANSWER",
      ),
    );
    assert(
      !(await f.history.recent("owner")).messages.some(
        (message) => message.content === "STALE_UNSENT_VENUE_ANSWER",
      ),
    );
    assert.deepEqual(
      await f.history.search("owner", "STALE_UNSENT_VENUE_ANSWER"),
      [],
    );
    assert.deepEqual(
      (await f.db.query("SELECT used_models,stop_reason FROM runtime_runs"))
        .rows,
      [{ used_models: 2, stop_reason: "answer" }],
    );
    assert.equal(
      (await f.db.query("SELECT 1 FROM events WHERE type='model.failed'")).rows
        .length,
      0,
    );
  } finally {
    release.resolve(text("Cleanup"));
    f.assistant.shutdown();
    await bounded(Promise.allSettled(pending), "burst cleanup");
    await f.pg.close();
  }
});

test("slow image preparation preserves input order while ready text and other users remain independent", async () => {
  const entered = deferred<Input>();
  const release = deferred<Generation>();
  const ownerInputs: Input[] = [];
  const f = await fixture({
    generate: async (input) => {
      if (users(input).includes("Other user question"))
        return text("Other user answered.");
      ownerInputs.push(input);
      if (ownerInputs.length === 1) {
        entered.resolve(input);
        return release.promise;
      }
      return text("The receipt and correction are ready.");
    },
  });
  const pending: Promise<unknown>[] = [];
  try {
    const first = f.assistant.respondDetailed("owner", "Compare the receipt");
    pending.push(first);
    const active = await bounded(entered.promise, "active model");
    const imageId = await f.assistant.recordInput(
      "owner",
      "Receipt is being prepared",
      { preparing: true },
    );
    const textId = await f.assistant.recordInput(
      "owner",
      "Use the final total, including tax",
    );
    const correction = f.assistant.respondDetailed(
      "owner",
      "Use the final total, including tax",
      undefined,
      undefined,
      { id: textId },
    );
    pending.push(correction);
    await until(
      async () =>
        (
          await f.db.query(
            "SELECT preparation FROM conversation_inputs WHERE id=$1",
            [textId],
          )
        ).rows[0]?.preparation === "ready",
      "independent text preparation",
    );
    assert.equal(active.signal.aborted, false);
    release.resolve(text("Stale pre-receipt answer"));
    await until(
      async () =>
        (await f.db.query("SELECT 1 FROM events WHERE type='model.completed'"))
          .rows.length > 0,
      "model checkpoint",
    );
    const other = await bounded(
      f.assistant.respondDetailed("other", "Other user question"),
      "independent user",
    );
    assert.equal(other.reply, "Other user answered.");
    assert.equal(ownerInputs.length, 1);
    const attachment = f.assistant.respondDetailed(
      "owner",
      "[Receipt attachment ready]",
      undefined,
      [image],
      { id: imageId },
    );
    pending.push(attachment);
    const replies = await bounded(
      Promise.all([first, correction, attachment]),
      "prepared input adoption",
    );
    assert.deepEqual(
      replies.map((reply) => reply.reply),
      ["The receipt and correction are ready.", "", ""],
    );
    assert.deepEqual(users(ownerInputs[1]!), [
      "Compare the receipt",
      "[Receipt attachment ready]",
      "Use the final total, including tax",
    ]);
    assert.deepEqual(
      f.requests[0]!.images?.map((attachment) => attachment.id),
      [image.id],
    );
    assert.equal(ownerInputs[0]!.sessionId, ownerInputs[1]!.sessionId);
    const durable = JSON.stringify(
      (
        await f.db.query(
          "SELECT payload FROM message_contents UNION ALL SELECT data AS payload FROM events",
        )
      ).rows,
    );
    assert(!durable.includes(image.data));
    await f.assistant.respondDetailed("owner", "A separate later question");
    assert.equal(f.requests.at(-1)!.images, undefined);
  } finally {
    release.resolve(text("Cleanup"));
    f.assistant.shutdown();
    await bounded(Promise.allSettled(pending), "image cleanup");
    await f.pg.close();
  }
});

test("failed preparation releases the next ready input without inventing image content", async () => {
  const entered = deferred();
  const release = deferred<Generation>();
  const seen: Input[] = [];
  const f = await fixture({
    generate: async (input) => {
      seen.push(input);
      if (seen.length === 1) {
        entered.resolve();
        return release.promise;
      }
      return text("I can answer the text correction.");
    },
  });
  const pending: Promise<unknown>[] = [];
  try {
    const first = f.assistant.respondDetailed("owner", "Read my receipt");
    pending.push(first);
    await bounded(entered.promise, "model");
    const broken = await f.assistant.recordInput(
      "owner",
      "UNAVAILABLE_IMAGE_NOTE",
      { preparing: true },
    );
    const ready = await f.assistant.recordInput("owner", "The amount is 42");
    const later = f.assistant.respondDetailed(
      "owner",
      "The amount is 42",
      undefined,
      undefined,
      { id: ready },
    );
    pending.push(later);
    release.resolve(text("Stale reply"));
    await f.assistant.failInput("owner", broken);
    const replies = await bounded(
      Promise.all([first, later]),
      "failed preparation wakeup",
    );
    assert.deepEqual(
      replies.map((reply) => reply.reply),
      ["I can answer the text correction.", ""],
    );
    assert.deepEqual(users(seen[1]!), ["Read my receipt", "The amount is 42"]);
    assert.equal(f.requests[0]!.images, undefined);
    const failed = (
      await f.db.query(
        "SELECT message,state,preparation,run_id,consumed_at FROM conversation_inputs WHERE id=$1",
        [broken],
      )
    ).rows[0];
    assert.deepEqual(failed, {
      message: "UNAVAILABLE_IMAGE_NOTE",
      state: "failed",
      preparation: "failed",
      run_id: null,
      consumed_at: null,
    });
  } finally {
    release.resolve(text("Cleanup"));
    f.assistant.shutdown();
    await bounded(Promise.allSettled(pending), "failed preparation cleanup");
    await f.pg.close();
  }
});

test("restart preserves input identity and text, fails unfinished preparation and never replays ephemeral images", async () => {
  const seen: Input[] = [];
  const f = await fixture({
    generate: async (input) => {
      seen.push(input);
      return text("Fresh question answered.");
    },
  });
  try {
    const pending = await f.assistant.recordInput("owner", "Pending receipt", {
      preparing: true,
    });
    const ready = await f.assistant.recordInput("owner", "Ready receipt", {
      preparing: true,
    });
    await f.assistant.prepareInput("owner", ready, "Ready receipt", [image]);
    f.assistant.shutdown();
    await recoverRuntime(f.db);
    const restarted = new Assistant(
      f.db,
      new CustomAgent({
        generate: async (input) => {
          seen.push(input);
          return text("Fresh question answered.");
        },
      }),
      f.assistant.tools,
    );
    try {
      const stale = await restarted.respondDetailed(
        "owner",
        "Ready receipt",
        undefined,
        undefined,
        { id: ready },
      );
      assert.equal(stale.reply, "");
      assert.equal(seen.length, 0);
      const reply = await restarted.respondDetailed("owner", "Fresh question");
      assert.equal(reply.reply, "Fresh question answered.");
      assert.deepEqual(users(seen[0]!), ["Fresh question"]);
      assert.deepEqual(
        (
          await f.db.query(
            "SELECT id,message,state,run_id FROM conversation_inputs WHERE id=ANY($1::uuid[]) ORDER BY ordinal",
            [[pending, ready]],
          )
        ).rows,
        [
          {
            id: pending,
            message: "Pending receipt",
            state: "failed",
            run_id: null,
          },
          {
            id: ready,
            message: "Ready receipt",
            state: "failed",
            run_id: null,
          },
        ],
      );
    } finally {
      restarted.shutdown();
    }
  } finally {
    f.assistant.shutdown();
    await f.pg.close();
  }
});

test("steering spends the existing model budget and absorbed handlers cannot create a fresh allocation", async () => {
  const entered = deferred<Input>();
  const release = deferred<Generation>();
  let calls = 0;
  const f = await fixture(
    {
      generate: async (input) => {
        calls++;
        entered.resolve(input);
        return release.promise;
      },
    },
    { budget: { ms: 900000, models: 1, tools: 10 } },
  );
  const pending: Promise<unknown>[] = [];
  try {
    const first = f.assistant.respondDetailed("owner", "Start the comparison");
    pending.push(first);
    const active = await bounded(entered.promise, "allocated model");
    const id = await f.assistant.recordInput(
      "owner",
      "Include the maintenance cost",
    );
    const second = f.assistant.respondDetailed(
      "owner",
      "Include the maintenance cost",
      undefined,
      undefined,
      { id },
    );
    pending.push(second);
    release.resolve(text("STALE_BUDGET_ANSWER"));
    const replies = await bounded(
      Promise.all([first, second]),
      "exhausted continuation",
    );
    assert.equal(active.signal.aborted, false);
    assert.equal(calls, 1);
    assert.equal(replies[1]!.reply, "");
    assert.deepEqual(
      (await f.db.query("SELECT used_models,stop_reason FROM runtime_runs"))
        .rows,
      [{ used_models: 1, stop_reason: "budget_exhausted" }],
    );
    const inputs = (
      await f.db.query(
        "SELECT run_id FROM conversation_inputs ORDER BY ordinal",
      )
    ).rows;
    assert(inputs.every((row) => row.run_id === replies[0]!.runId));
    assert(
      !(await f.history.recent("owner")).messages.some(
        (message) => message.content === "STALE_BUDGET_ANSWER",
      ),
    );
  } finally {
    release.resolve(text("Cleanup"));
    f.assistant.shutdown();
    await bounded(Promise.allSettled(pending), "budget cleanup");
    await f.pg.close();
  }
});

test("pending delivery is absent from recent history and search until transport marks it sent", async () => {
  const f = await fixture({
    generate: async () => text("UNSENT_QUASAR_OBSERVATION"),
  });
  try {
    const reply = await f.assistant.respondDetailed(
      "owner",
      "Tell me something about astronomy",
      undefined,
      undefined,
      { updateId: 123 },
    );
    assert.equal(reply.reply, "UNSENT_QUASAR_OBSERVATION");
    assert(
      !(await f.history.recent("owner")).messages.some(
        (message) => message.content === reply.reply,
      ),
    );
    assert.deepEqual(
      await f.history.search("owner", "UNSENT_QUASAR_OBSERVATION"),
      [],
    );
    assert(
      !JSON.stringify(await f.history.search("owner", "astronomy")).includes(
        reply.reply,
      ),
    );
    assert(
      (await f.history.recent("owner", reply.runId)).messages.some(
        (message) => message.content === reply.reply,
      ),
    );
    await f.history.markDelivered("owner", reply.runId!);
    await f.history.markDelivered("owner", reply.runId!);
    assert.equal(
      (await f.history.recent("owner")).messages.filter(
        (message) => message.content === reply.reply,
      ).length,
      1,
    );
    assert.equal(
      (await f.history.search("owner", "UNSENT_QUASAR_OBSERVATION")).length,
      1,
    );
    const id = await f.assistant.recordInput(
      "owner",
      "Actually answer a different question",
    );
    assert.equal(await f.assistant.isCurrentDelivery("owner", reply), false);
    await f.assistant.failInput("owner", id);
    assert.equal(
      await f.assistant.isCurrentDelivery("owner", reply),
      false,
      "failed newer input cannot revive an obsolete answer",
    );
  } finally {
    f.assistant.shutdown();
    await f.pg.close();
  }
});

test("three inputs remain protected with large fixed schemas and task binding saves their complete request", async () => {
  const entered = deferred();
  const release = deferred<Generation>();
  const seen: Input[] = [];
  const original =
    "Use the exact Board review BR-792 document and preserve the original target.";
  const followups = [
    "Use tomorrow at nine",
    "Include the finance team context",
  ];
  const f = await fixture(
    {
      generate: async (input) => {
        seen.push(input);
        if (seen.length === 1) {
          entered.resolve();
          return release.promise;
        }
        if (seen.length === 2)
          return call("work_start", {
            objective: "Prepare Board review BR-792",
            steps: [
              {
                key: "source",
                title: "Review the document",
                verification: "evidence",
              },
            ],
          });
        return text("The exact Board review request is saved.");
      },
    },
    {
      decorate: (request) => {
        request.runtime!.tools!.push({
          name: "large_fixed_schema",
          description: "fixed schema field ".repeat(2000),
          parameters: { type: "object", properties: {} },
        });
      },
    },
  );
  const pending: Promise<unknown>[] = [];
  try {
    const first = f.assistant.respondDetailed("owner", original);
    pending.push(first);
    await bounded(entered.promise, "original target model");
    const later = [];
    for (const message of followups) {
      const id = await f.assistant.recordInput("owner", message);
      later.push(
        f.assistant.respondDetailed("owner", message, undefined, undefined, {
          id,
        }),
      );
    }
    pending.push(...later);
    release.resolve(text("Stale original reply"));
    const replies = await bounded(
      Promise.all([first, ...later]),
      "task binding after followups",
    );
    assert.deepEqual(
      replies.map((reply) => reply.reply),
      ["The exact Board review request is saved.", "", ""],
    );
    assert.equal(seen.length, 3);
    for (const input of seen.slice(1))
      assert.deepEqual(users(input), [original, ...followups]);
    const task = (
      await f.db.query("SELECT id,request,used_models FROM work_tasks")
    ).rows[0];
    assert(task.request.startsWith(original));
    assert(
      task.request.indexOf(followups[0]) < task.request.indexOf(followups[1]),
    );
    assert(
      task.request.includes(followups[0]) &&
        task.request.includes(followups[1]),
    );
    assert.equal(task.used_models, 3);
    assert.deepEqual(
      (await f.db.query("SELECT task_id,request FROM work_turns")).rows,
      [{ task_id: task.id, request: task.request }],
    );
  } finally {
    release.resolve(text("Cleanup"));
    f.assistant.shutdown();
    await bounded(Promise.allSettled(pending), "task binding cleanup");
    await f.pg.close();
  }
});

test("explicit cancellation still aborts an active model instead of waiting for a steering checkpoint", async () => {
  const entered = deferred<Input>();
  const f = await fixture({
    generate: async (input) => {
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
    },
  });
  let response: ReturnType<Assistant["respondDetailed"]> | undefined;
  try {
    response = f.assistant.respondDetailed("owner", "Research the options");
    const active = await bounded(entered.promise, "cancellable model");
    assert.deepEqual(await f.assistant.cancel("owner"), { cancelled: true });
    await bounded(response, "cancelled run");
    assert.equal(active.signal.aborted, true);
    assert.deepEqual(
      (await f.db.query("SELECT stop_reason FROM runtime_runs")).rows,
      [{ stop_reason: "cancelled" }],
    );
  } finally {
    f.assistant.shutdown();
    if (response) await bounded(response, "cancel cleanup");
    await f.pg.close();
  }
});

test("input arriving as the run exhausts its budget is retained without a free replacement run", async () => {
  const stopping = deferred();
  const releaseStop = deferred();
  let held = false;
  let models = 0;
  const f = await fixture(
    {
      generate: async () => {
        models++;
        return call("memory_list", {});
      },
    },
    {
      budget: { ms: 900000, models: 1, tools: 10 },
      wrapDb: (db) => ({
        query: async (sql, values) => {
          const result = await db.query(sql, values);
          if (
            !held &&
            sql.startsWith(
              "UPDATE runtime_runs SET state='stopped',stop_reason=$2",
            ) &&
            values?.[1] === "budget_exhausted"
          ) {
            held = true;
            stopping.resolve();
            await releaseStop.promise;
          }
          return result;
        },
      }),
    },
  );
  const pending: Promise<unknown>[] = [];
  try {
    const first = f.assistant.respondDetailed(
      "owner",
      "Compare the saved options",
    );
    pending.push(first);
    await bounded(stopping.promise, "budget stop");
    const id = await f.assistant.recordInput(
      "owner",
      "Include the expensive option too",
    );
    const later = f.assistant.respondDetailed(
      "owner",
      "Include the expensive option too",
      undefined,
      undefined,
      { id },
    );
    pending.push(later);
    releaseStop.resolve();
    const replies = await bounded(
      Promise.all([first, later]),
      "budget boundary input",
    );
    assert.equal(models, 1);
    assert.equal(replies[1]!.reply, "");
    assert.deepEqual(
      (await f.db.query("SELECT used_models,stop_reason FROM runtime_runs"))
        .rows,
      [{ used_models: 1, stop_reason: "budget_exhausted" }],
    );
    const saved = (
      await f.db.query(
        "SELECT message,state,consumed_at,metadata FROM conversation_inputs WHERE id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(saved.message, "Include the expensive option too");
    assert.equal(saved.state, "failed");
    assert.equal(saved.consumed_at, null);
    assert.equal(saved.metadata.parkedReason, "budget_exhausted");
    assert.match(
      replies[0]!.reply,
      /queued messages were saved but not executed/,
    );
    assert.equal(
      await f.assistant.isCurrentDelivery("owner", replies[0]!),
      true,
    );
  } finally {
    releaseStop.resolve();
    f.assistant.shutdown();
    await bounded(Promise.allSettled(pending), "budget stop cleanup");
    await f.pg.close();
  }
});

test("a task-bound model finishes its checkpoint before a correction starts a fresh unbound turn", async () => {
  const entered = deferred<Input>();
  const release = deferred<Generation>();
  const seen: Input[] = [];
  const f = await fixture({
    generate: async (input) => {
      seen.push(input);
      if (seen.length === 1)
        return call("work_start", {
          objective: "Review selected Board documents",
          steps: [
            {
              key: "check",
              title: "Read the sources",
              verification: "evidence",
            },
          ],
        });
      if (seen.length === 2) {
        entered.resolve(input);
        return release.promise;
      }
      return text("The nearby cafe opens at nine.");
    },
  });
  const pending: Promise<unknown>[] = [];
  try {
    const first = f.assistant.respondDetailed(
      "owner",
      "Review the Board documents",
    );
    pending.push(first);
    const active = await bounded(entered.promise, "bound model");
    const id = await f.assistant.recordInput(
      "owner",
      "When does the nearby cafe open?",
    );
    const later = f.assistant.respondDetailed(
      "owner",
      "When does the nearby cafe open?",
      undefined,
      undefined,
      { id },
    );
    pending.push(later);
    assert.equal(active.signal.aborted, false);
    assert.equal(seen.length, 2);
    release.resolve(text("UNSENT_BOUND_TASK_REPLY"));
    const replies = await bounded(
      Promise.all([first, later]),
      "task checkpoint handoff",
    );
    assert.deepEqual(
      replies.map((reply) => reply.reply),
      ["", "The nearby cafe opens at nine."],
    );
    assert.notEqual(replies[0]!.runId, replies[1]!.runId);
    assert.equal(active.signal.aborted, false);
    const task = (
      await f.db.query(
        "SELECT id,status,pause_reason,used_models FROM work_tasks",
      )
    ).rows[0];
    assert.equal(task.status, "paused");
    assert.equal(task.pause_reason, "interrupted");
    assert.equal(task.used_models, 2);
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT task_id,stop_reason,used_models FROM runtime_runs ORDER BY started_at",
        )
      ).rows,
      [
        { task_id: task.id, stop_reason: "interrupted", used_models: 2 },
        { task_id: null, stop_reason: "answer", used_models: 1 },
      ],
    );
    const lastState = seen[2]!.messages.findLast(
      (message) => message.role === "system",
    )!.content as string;
    assert(lastState.includes('"work":null'));
    assert(lastState.includes(task.id));
    assert(
      !(await f.history.recent("owner")).messages.some(
        (message) => message.content === "UNSENT_BOUND_TASK_REPLY",
      ),
    );
  } finally {
    release.resolve(text("Cleanup"));
    f.assistant.shutdown();
    await bounded(Promise.allSettled(pending), "bound handoff cleanup");
    await f.pg.close();
  }
});

test("cancelling pending attachment preparation prevents later execution and preserves another owner's input", async () => {
  const seen: Input[] = [];
  const f = await fixture({
    generate: async (input) => {
      seen.push(input);
      return text("The other owner's attachment is ready.");
    },
  });
  try {
    const cancelled = await f.assistant.recordInput(
      "owner",
      "Owner receipt being prepared",
      { preparing: true },
    );
    const other = await f.assistant.recordInput(
      "other",
      "Other receipt being prepared",
      { preparing: true },
    );
    assert.equal(
      (await f.db.query("SELECT id FROM runtime_runs")).rows.length,
      0,
    );
    assert.deepEqual(await f.assistant.cancel("owner"), { cancelled: true });
    const rows = (
      await f.db.query(
        "SELECT user_id,message,state,preparation,consumed_at,metadata FROM conversation_inputs ORDER BY ordinal",
      )
    ).rows;
    assert.equal(rows[0].state, "failed");
    assert.equal(rows[0].message, "Owner receipt being prepared");
    assert.equal(rows[0].consumed_at, null);
    assert.equal(rows[0].metadata.parkedReason, "cancelled");
    assert.equal(rows[1].user_id, "other");
    assert.equal(rows[1].state, "queued");
    assert.equal(rows[1].preparation, "pending");
    assert.equal(rows[1].metadata.parkedReason, undefined);

    await f.assistant.prepareInput(
      "owner",
      cancelled,
      "Late owner receipt is ready",
      [image],
    );
    const ignored = await bounded(
      f.assistant.respondDetailed(
        "owner",
        "Late owner receipt is ready",
        undefined,
        [image],
        { id: cancelled },
      ),
      "cancelled preparation completion",
    );
    assert.equal(ignored.reply, "");
    assert.equal(seen.length, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(
      (await f.db.query("SELECT id FROM runtime_runs")).rows.length,
      0,
    );
    assert.deepEqual(await f.assistant.cancel("owner"), { cancelled: false });

    const answered = await bounded(
      f.assistant.respondDetailed(
        "other",
        "Other receipt is ready",
        undefined,
        [image],
        { id: other },
      ),
      "other owner's independent preparation",
    );
    assert.equal(answered.reply, "The other owner's attachment is ready.");
    assert.equal(seen.length, 1);
    assert.deepEqual(users(seen[0]!), ["Other receipt is ready"]);
    assert.deepEqual(
      (await f.db.query("SELECT user_id FROM runtime_runs")).rows,
      [{ user_id: "other" }],
    );
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT message,state,run_id,consumed_at FROM conversation_inputs WHERE id=$1",
          [cancelled],
        )
      ).rows,
      [
        {
          message: "Owner receipt being prepared",
          state: "failed",
          run_id: null,
          consumed_at: null,
        },
      ],
    );
  } finally {
    f.assistant.shutdown();
    await f.pg.close();
  }
});

test("input arriving during the initial empty inbox read is included before the first model call", async () => {
  const snapshotRead = deferred();
  const releaseSnapshot = deferred();
  let held = false;
  const seen: Input[] = [];
  const f = await fixture(
    {
      generate: async (input) => {
        seen.push(input);
        return text("Both original and follow-up are included.");
      },
    },
    {
      budget: { ms: 900000, models: 1, tools: 10 },
      wrapDb: (db) => ({
        query: async (sql, values) => {
          const result = await db.query(sql, values);
          if (
            !held &&
            values?.[0] === "owner" &&
            sql.startsWith(
              "SELECT id,ordinal,message,metadata,preparation FROM conversation_inputs",
            ) &&
            sql.includes("ORDER BY ordinal LIMIT 100") &&
            result.rows.length === 0
          ) {
            held = true;
            snapshotRead.resolve();
            await releaseSnapshot.promise;
          }
          return result;
        },
      }),
    },
  );
  const pending: Promise<unknown>[] = [];
  try {
    const first = f.assistant.respondDetailed(
      "owner",
      "Compare the original venues",
    );
    pending.push(first);
    await bounded(snapshotRead.promise, "initial empty inbox snapshot");
    assert.deepEqual(
      (await f.db.query("SELECT state,used_models FROM runtime_runs")).rows,
      [{ state: "running", used_models: 0 }],
    );
    assert.equal(seen.length, 0);
    const id = await f.assistant.recordInput(
      "owner",
      "Also include the accessible entrance",
    );
    const second = f.assistant.respondDetailed(
      "owner",
      "Also include the accessible entrance",
      undefined,
      undefined,
      { id },
    );
    pending.push(second);
    releaseSnapshot.resolve();
    const replies = await bounded(
      Promise.all([first, second]),
      "startup inbox race",
    );
    assert.deepEqual(
      replies.map((reply) => reply.reply),
      ["Both original and follow-up are included.", ""],
    );
    assert.equal(seen.length, 1);
    assert.deepEqual(users(seen[0]!), [
      "Compare the original venues",
      "Also include the accessible entrance",
    ]);
    assert.equal(seen[0]!.signal.aborted, false);
    assert.deepEqual(
      (await f.db.query("SELECT used_models,stop_reason FROM runtime_runs"))
        .rows,
      [{ used_models: 1, stop_reason: "answer" }],
    );
    const inputs = (
      await f.db.query(
        "SELECT run_id,state,consumed_at FROM conversation_inputs ORDER BY ordinal",
      )
    ).rows;
    assert.equal(inputs.length, 2);
    assert(
      inputs.every(
        (input) =>
          input.state === "completed" &&
          input.run_id === replies[0]!.runId &&
          input.consumed_at,
      ),
    );
    assert.equal(
      (await f.db.query("SELECT 1 FROM events WHERE type='model.failed'")).rows
        .length,
      0,
    );
  } finally {
    releaseSnapshot.resolve();
    f.assistant.shutdown();
    await bounded(Promise.allSettled(pending), "startup race cleanup");
    await f.pg.close();
  }
});
