import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { HistoryStore } from "../src/history.js";
import { Execution } from "../src/execution.js";
import { JobTools } from "../src/tools.js";
import type { Database } from "../src/db.js";
import type { Generation, Message, ModelAdapter } from "../src/model.js";

const text = (content: string): Generation => ({
  message: { role: "assistant", content },
});
const startTask = (): Generation => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: randomUUID(),
        type: "function",
        function: {
          name: "work_start",
          arguments: JSON.stringify({
            objective: "Inspect the selected original sources",
            steps: [
              {
                key: "inspect",
                title: "Read the sources",
                verification: "evidence",
              },
            ],
          }),
        },
      },
    ],
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
async function fixture() {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL(`../db/${file}`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner'),('other')");
  const assistant = (model: ModelAdapter) =>
    new Assistant(
      db,
      new CustomAgent(model),
      new JobTools(db, { call: async () => ({}) }),
    );
  return { pg, db, assistant, histories: new HistoryStore(db) };
}

test("a superseded bound-task final stays out of granted resume context after recreating the Assistant", async () => {
  const f = await fixture();
  const entered = deferred<void>();
  const finish = deferred<Generation>();
  let generations = 0;
  const model: ModelAdapter = {
    generate: async (input) => {
      generations++;
      if (generations === 1) return startTask();
      if (generations === 2) {
        entered.resolve();
        return finish.promise;
      }
      assert.doesNotMatch(
        JSON.stringify(input.messages),
        /WITHHELD_BOUND_FINAL/,
      );
      return text(
        generations === 3
          ? "Foreground correction handled"
          : "Resumed from recorded sources",
      );
    },
  };
  const firstAssistant = f.assistant(model);
  let restarted: Assistant | undefined;
  try {
    const original = firstAssistant.respondDetailed(
      "owner",
      "Inspect my selected original sources",
      undefined,
      undefined,
      { updateId: 17 },
    );
    await entered.promise;
    const input = await firstAssistant.recordInput(
      "owner",
      "Pause that and answer this brief question",
    );
    const later = firstAssistant.respondDetailed(
      "owner",
      "Pause that and answer this brief question",
      undefined,
      undefined,
      { id: input },
    );
    finish.resolve(text("WITHHELD_BOUND_FINAL"));
    const [interrupted, corrected] = await Promise.all([original, later]);
    assert.equal(interrupted.reply, "");
    assert.equal(corrected.reply, "Foreground correction handled");
    const task = (
      await f.db.query("SELECT id,status,pause_reason FROM work_tasks")
    ).rows[0];
    assert.equal(task.status, "paused");
    assert.equal(task.pause_reason, "interrupted");
    const raw = (
      await f.db.query(
        "SELECT m.ordinal,c.payload FROM run_messages m JOIN message_contents c USING(user_id,hash) WHERE m.user_id=$1 AND m.run_id=$2 ORDER BY m.ordinal",
        ["owner", interrupted.runId],
      )
    ).rows;
    const suppressed = raw.find(
      (row) => row.payload.content === "WITHHELD_BOUND_FINAL",
    );
    assert.ok(suppressed);
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT reason,released_at FROM run_message_context_exclusions WHERE user_id=$1 AND run_id=$2 AND message_index=$3",
          ["owner", interrupted.runId, suppressed.ordinal],
        )
      ).rows,
      [{ reason: "superseded", released_at: null }],
    );
    await new HistoryStore(f.db).markDelivered("owner", interrupted.runId!);
    assert.doesNotMatch(
      JSON.stringify(
        (await new HistoryStore(f.db).recent("owner", interrupted.runId))
          .messages,
      ),
      /WITHHELD_BOUND_FINAL/,
    );
    firstAssistant.shutdown();
    restarted = f.assistant(model);
    assert.equal((await restarted.grant("owner", task.id)).rows.length, 1);
    assert.equal(
      (await restarted.resumeDetailed("owner", task.id)).reply,
      "Resumed from recorded sources",
    );
    assert.equal(generations, 4);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int AS n FROM run_messages m JOIN message_contents c USING(user_id,hash) WHERE m.user_id=$1 AND m.run_id=$2 AND c.payload->>'content'='WITHHELD_BOUND_FINAL'",
          ["owner", interrupted.runId],
        )
      ).rows[0].n,
      1,
    );
  } finally {
    finish.resolve(text("Cleanup"));
    firstAssistant.shutdown();
    restarted?.shutdown();
    await f.pg.close();
  }
});

test("pending final exclusions survive reload and delivery releases only that occurrence, never superseded text", async () => {
  const f = await fixture();
  const run = randomUUID();
  const history: Message[] = [
    { role: "user", content: "Keep exact occurrences" },
    { role: "assistant", content: "Identical reply text" },
    { role: "assistant", content: "Identical reply text" },
    { role: "assistant", content: "Unrelated visible reply" },
  ];
  try {
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id) VALUES($1,'owner')",
      [run],
    );
    await f.histories.append("owner", run, 0, history);
    await f.histories.excludeFromContext("owner", run, [1], "pending_delivery");
    await f.histories.excludeFromContext("owner", run, [2]);
    await f.histories.excludeFromContext("owner", run, [2], "pending_delivery");
    assert.doesNotMatch(
      JSON.stringify(
        (await new HistoryStore(f.db).recent("owner", run)).messages,
      ),
      /Identical reply text/,
    );
    await assert.rejects(
      () => f.histories.excludeFromContext("other", run, [1]),
      /owner run/,
    );
    await assert.rejects(
      () => f.histories.excludeFromContext("owner", run, [3, 999]),
      /owner run/,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int AS n FROM run_message_context_exclusions",
        )
      ).rows[0].n,
      2,
    );
    await f.histories.markDelivered("other", run);
    assert.doesNotMatch(
      JSON.stringify((await f.histories.recent("owner", run)).messages),
      /Identical reply text/,
    );
    await f.histories.markDelivered("owner", run);
    // Repeating the same pending registration does not hide an already delivered occurrence.
    await f.histories.excludeFromContext("owner", run, [1], "pending_delivery");
    const projected = (await new HistoryStore(f.db).recent("owner", run))
      .messages;
    assert.equal(
      projected.filter((m) => m.content === "Identical reply text").length,
      1,
    );
    assert.ok(projected.some((m) => m.content === "Unrelated visible reply"));
    assert.equal(
      (await f.histories.recent("owner", run, 3)).messages.length,
      1,
    );
    const raw = (
      await f.db.query(
        "SELECT c.payload FROM run_messages m JOIN message_contents c USING(user_id,hash) WHERE m.user_id=$1 AND m.run_id=$2 ORDER BY m.ordinal",
        ["owner", run],
      )
    ).rows.map((row) => row.payload);
    assert.deepEqual(raw, history);
  } finally {
    await f.pg.close();
  }
});

test("Telegram-managed final candidates are excluded from resumed context until their delivery is recorded", async () => {
  const f = await fixture();
  const assistant = f.assistant({
    generate: async () => text("PENDING_FINAL_CANDIDATE"),
  });
  try {
    const result = await assistant.respondDetailed(
      "owner",
      "Answer the current question",
      undefined,
      undefined,
      { updateId: 31 },
    );
    assert.equal(result.reply, "PENDING_FINAL_CANDIDATE");
    assert.doesNotMatch(
      JSON.stringify(
        (await new HistoryStore(f.db).recent("owner", result.runId)).messages,
      ),
      /PENDING_FINAL_CANDIDATE/,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT reason FROM run_message_context_exclusions WHERE user_id=$1 AND run_id=$2",
          ["owner", result.runId],
        )
      ).rows[0].reason,
      "pending_delivery",
    );
    await f.histories.markDelivered("owner", result.runId!);
    assert.match(
      JSON.stringify(
        (await new HistoryStore(f.db).recent("owner", result.runId)).messages,
      ),
      /PENDING_FINAL_CANDIDATE/,
    );
  } finally {
    assistant.shutdown();
    await f.pg.close();
  }
});

test("the first completed final checkpoint already hides its candidate before later tracing or finish", async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const execution = new Execution(f.db, "owner", randomUUID(), signal);
  try {
    await execution.start();
    const checkpoint = execution.checkpoint.bind(execution);
    let checked = false;
    execution.checkpoint = async (messages, pending = []) => {
      await checkpoint(messages, pending);
      if (messages.at(-1)?.content !== "ATOMIC_PENDING_FINAL") return;
      assert.deepEqual(pending, [1]);
      assert.doesNotMatch(
        JSON.stringify(
          (await new HistoryStore(f.db).recent("owner", execution.run))
            .messages,
        ),
        /ATOMIC_PENDING_FINAL/,
      );
      assert.equal(
        (
          await f.db.query(
            "SELECT count(*)::int AS n FROM events WHERE run_id=$1 AND type='model.completed'",
            [execution.run],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await f.db.query("SELECT state FROM runtime_runs WHERE id=$1", [
            execution.run,
          ])
        ).rows[0].state,
        "running",
      );
      assert.equal(
        (
          await f.db.query(
            "SELECT count(*)::int AS n FROM run_messages m JOIN message_contents c USING(user_id,hash) WHERE m.user_id=$1 AND m.run_id=$2 AND c.payload->>'content'='ATOMIC_PENDING_FINAL'",
            ["owner", execution.run],
          )
        ).rows[0].n,
        1,
      );
      checked = true;
    };
    const output = await new CustomAgent({
      generate: async () => text("ATOMIC_PENDING_FINAL"),
    }).run({
      runId: execution.run,
      capability: "",
      message: "Current request",
      history: [],
      memories: [],
      managedDelivery: true,
      execution,
      signal,
      execute: async () => ({}),
    });
    assert.equal(output.reply, "ATOMIC_PENDING_FINAL");
    assert.ok(checked);
  } finally {
    await f.pg.close();
  }
});

test("a failed pending exclusion rolls back the whole checkpoint and its exact retry appends once", async () => {
  const f = await fixture();
  const execution = new Execution(
    f.db,
    "owner",
    randomUUID(),
    new AbortController().signal,
  );
  const prefix: Message[] = [{ role: "user", content: "Original request" }];
  const messages: Message[] = [
    ...prefix,
    { role: "assistant", content: "ATOMIC_RETRY_FINAL" },
  ];
  try {
    await execution.start();
    await execution.checkpoint(prefix);
    await f.pg
      .exec(`CREATE FUNCTION reject_pending_exclusion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic exclusion failure'; END $$;
      CREATE TRIGGER reject_pending_exclusion BEFORE INSERT ON run_message_context_exclusions FOR EACH ROW EXECUTE FUNCTION reject_pending_exclusion();`);
    await assert.rejects(
      () => execution.checkpoint(messages, [1]),
      /Synthetic exclusion failure/,
    );
    assert.equal(
      (
        await f.db.query("SELECT message_count FROM runtime_runs WHERE id=$1", [
          execution.run,
        ])
      ).rows[0].message_count,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int AS n FROM run_messages WHERE run_id=$1",
          [execution.run],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int AS n FROM message_contents WHERE payload->>'content'='ATOMIC_RETRY_FINAL'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int AS n FROM run_message_context_exclusions",
        )
      ).rows[0].n,
      0,
    );
    await f.pg.exec(
      "DROP TRIGGER reject_pending_exclusion ON run_message_context_exclusions",
    );
    await execution.checkpoint(messages, [1]);
    await execution.checkpoint(messages);
    assert.equal(
      (
        await f.db.query("SELECT message_count FROM runtime_runs WHERE id=$1", [
          execution.run,
        ])
      ).rows[0].message_count,
      2,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int AS n FROM run_messages WHERE run_id=$1",
          [execution.run],
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int AS n FROM run_message_context_exclusions WHERE run_id=$1",
          [execution.run],
        )
      ).rows[0].n,
      1,
    );
    assert.doesNotMatch(
      JSON.stringify(
        (await new HistoryStore(f.db).recent("owner", execution.run)).messages,
      ),
      /ATOMIC_RETRY_FINAL/,
    );
  } finally {
    await f.pg.close();
  }
});
