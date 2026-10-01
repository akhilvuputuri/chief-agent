import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import { ensureUser, type Database } from "../src/db.js";
import {
  destination,
  slowReply,
  taskDelivery,
} from "../src/delivery-routing.js";
import { RoutineDelivery } from "../src/routines.js";
import { randomUUID } from "node:crypto";

async function database() {
  const pg = new PGlite();
  for (const f of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + f, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "owner");
  await ensureUser(db, "other");
  return { pg, db };
}

test("host destinations cover foreground, owner work, feeds, unprompted decisions and failures", () => {
  for (const kind of ["foreground", "owner_work"] as const) {
    assert.deepEqual(
      destination({ kind, threadId: 42, reason: "awaiting_approval" }),
      { kind: "thread", threadId: 42 },
    );
    assert.deepEqual(destination({ kind }), { kind: "general" });
  }
  for (const kind of ["news", "markets"] as const)
    assert.deepEqual(destination({ kind }), { kind: "topic", topic: kind });
  assert.deepEqual(destination({ kind: "unprompted", reason: "answer" }), {
    kind: "topic",
    topic: "updates",
  });
  for (const reason of [
    "awaiting_user",
    "awaiting_approval",
    "failed",
    "budget_exhausted",
    undefined,
  ])
    assert.deepEqual(destination({ kind: "unprompted", reason }), {
      kind: "general",
    });
  assert.deepEqual(destination({ kind: "notice" }), { kind: "general" });
  assert.equal(
    slowReply({ threadId: 42, receivedAt: new Date(0).toISOString() }, 60001),
    true,
  );
  assert.equal(
    slowReply({ threadId: 42, receivedAt: new Date(0).toISOString() }, 60000),
    false,
  );
  assert.equal(
    slowReply({ receivedAt: new Date(0).toISOString() }, 90000),
    false,
  );
  assert.equal(
    slowReply({ threadId: 42, receivedAt: "invalid" }, 90000),
    false,
  );
});

test("cross-thread input waits, does not suppress original delivery, and preserves FIFO", async () => {
  const { pg, db } = await database();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const wait = new Promise<void>((r) => (release = r));
  let calls = 0;
  const model = {
    generate: async () => {
      calls++;
      if (calls === 1) {
        started();
        await wait;
      }
      return {
        message: { role: "assistant" as const, content: "Answer " + calls },
      };
    },
  };
  const a = new Assistant(
    db,
    new CustomAgent(model),
    new JobTools(db, { call: async () => ({}) }),
  );
  try {
    const first = a.respondDetailed(
      "owner",
      "General request",
      undefined,
      undefined,
      { updateId: 1 },
    );
    await ready;
    const news = a.respondDetailed(
      "owner",
      "News request",
      undefined,
      undefined,
      { threadId: 42, updateId: 2 },
    );
    const general = a.respondDetailed(
      "owner",
      "Later General request",
      undefined,
      undefined,
      { updateId: 3 },
    );
    // Wait for persistence; the cross-thread boundary must not be skipped.
    while (
      (await db.query("SELECT count(*)::int AS n FROM conversation_inputs"))
        .rows[0].n < 3
    )
      await new Promise((r) => setTimeout(r, 5));
    release();
    const out = await Promise.all([first, news, general]);
    assert.equal(calls, 3);
    assert.equal(out[0]!.threadId, undefined);
    assert.equal(out[1]!.threadId, 42);
    assert.equal(out[2]!.threadId, undefined);
    assert.equal(await a.isCurrentDelivery("owner", out[1]!), true);
    // The later General message legitimately supersedes the first General reply.
    assert.equal(await a.isCurrentDelivery("owner", out[0]!), false);
    const runs = (
      await db.query(
        "SELECT run_id,message FROM conversation_inputs ORDER BY ordinal",
      )
    ).rows;
    assert.equal(new Set(runs.map((r) => r.run_id)).size, 3);
  } finally {
    release();
    await pg.close();
  }
});

test("a pending message in another thread alone leaves current output deliverable", async () => {
  const { pg, db } = await database();
  const a = new Assistant(
    db,
    new CustomAgent({
      generate: async () => ({
        message: { role: "assistant", content: "Saved reply" },
      }),
    }),
    new JobTools(db, { call: async () => ({}) }),
  );
  try {
    const out = await a.respondDetailed(
      "owner",
      "Hello",
      undefined,
      undefined,
      { updateId: 1 },
    );
    await a.recordInput("owner", "Separate News question", { threadId: 42 });
    assert.equal(await a.isCurrentDelivery("owner", out), true);
    await a.recordInput("owner", "Correction in General");
    assert.equal(await a.isCurrentDelivery("owner", out), false);
  } finally {
    await pg.close();
  }
});

test("ordinary work captures its destination and restart never replays an uncertain send", async () => {
  const { pg, db } = await database();
  const task = randomUUID(),
    run = randomUUID();
  try {
    await db.query(
      "INSERT INTO work_tasks(id,user_id,objective,request,delivery_context) VALUES($1,'owner','Task','Request',$2::jsonb)",
      [task, JSON.stringify({ source: "owner", threadId: 42 })],
    );
    await db.query(
      "INSERT INTO runtime_runs(id,user_id,task_id,state,stop_reason) VALUES($1,'owner',$2,'stopped','answer')",
      [run, task],
    );
    let sent = 0;
    const d = new RoutineDelivery(db, async (_u, p) => {
      sent++;
      assert.deepEqual(p.destination, { kind: "thread", threadId: 42 });
      throw Error("uncertain");
    });
    await d.capture("owner", task, {
      reply: "Result",
      runId: run,
      reason: "answer",
    });
    await db.query("UPDATE work_tasks SET delivery_context='{}' WHERE id=$1", [
      task,
    ]);
    await d.tick();
    await new RoutineDelivery(db, async () => {
      sent++;
    }).recover();
    await d.tick();
    assert.equal(sent, 1);
    assert.equal(
      (await db.query("SELECT state FROM work_deliveries")).rows[0].state,
      "uncertain",
    );
    await assert.rejects(
      () => taskDelivery(db, "other", task, { reply: "x" }),
      /Unknown/,
    );
  } finally {
    await pg.close();
  }
});

test("a slow preparing topic input followed by ready General input drains both handler slots", async () => {
  const { pg, db } = await database();
  let calls = 0;
  const a = new Assistant(
    db,
    new CustomAgent({
      generate: async () => ({
        message: { role: "assistant", content: `Answer ${++calls}` },
      }),
    }),
    new JobTools(db, { call: async () => ({}) }),
  );
  try {
    const photo = await a.recordInput("owner", "Photo pending", {
      threadId: 42,
      preparing: true,
      updateId: 10,
    });
    const general = a.respondDetailed(
      "owner",
      "Separate General question",
      undefined,
      undefined,
      { updateId: 11 },
    );
    while (
      (await db.query("SELECT count(*)::int AS n FROM conversation_inputs"))
        .rows[0].n < 2
    )
      await new Promise((r) => setTimeout(r, 5));
    await a.prepareInput("owner", photo, "Describe this photo");
    const photoHandler = a.respondDetailed(
      "owner",
      "Describe this photo",
      undefined,
      undefined,
      { id: photo },
    );
    const outputs = await Promise.all([general, photoHandler]);
    assert.equal(calls, 2);
    assert.deepEqual(
      outputs.map((o) => o.threadId),
      [42, undefined],
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM conversation_inputs WHERE state='queued'",
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await pg.close();
  }
});
