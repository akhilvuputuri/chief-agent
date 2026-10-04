import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { type Database, ensureUser } from "../src/db.js";
import {
  recordFeedSent,
  inputAnchor,
  recentFeedIndex,
  readFeed,
} from "../src/telegram-feeds.js";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import { conversationState } from "../src/conversation-state.js";

async function fixture() {
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
async function edition(
  db: Database,
  title = "A precise story",
  user = "owner",
) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO news_editions(id,user_id,edition_date,kind,state,payload) VALUES($1,$2,current_date,'on_demand','sent',$3::jsonb)",
    [id, user, JSON.stringify({ text: title, items: [] })],
  );
  await db.query(
    "INSERT INTO news_items(id,edition_id,user_id,position,source_name,url,canonical_url,domain,title,topics,score) VALUES($1,$2,$3,1,'Source','https://example.com/story','https://example.com/story','example.com',$4,'{}','{}')",
    [randomUUID(), id, user, title],
  );
  return id;
}

test("exact feed reply has durable identity at any age, fallback quote is bounded and owner isolated", async () => {
  const { pg, db } = await fixture();
  try {
    const id = await edition(db);
    await recordFeedSent(db, "owner", id, "news", { message_id: 101 }, 42);
    await db.query(
      "UPDATE events SET created_at=now()-interval '3 days' WHERE type='telegram.feed_sent'",
    );
    const exact = await inputAnchor(db, "owner", {
      replyToMessageId: 101,
      threadId: 42,
    });
    assert.equal(exact?.kind, "feed");
    assert.deepEqual(exact?.references, [{ kind: "news", id }]);
    assert.ok(exact?.sentAt);
    assert.equal(
      await inputAnchor(db, "other", { replyToMessageId: 101 }),
      null,
    );
    await assert.rejects(() => readFeed(db, "other", "news", id), /not found/);
    const fallback = await inputAnchor(db, "owner", {
      replyToMessageId: 999,
      quotedReplyText: "x".repeat(3000),
    });
    assert.equal(fallback?.kind, "quote");
    assert.equal(fallback?.quote?.length, 2000);
    assert.equal(
      await inputAnchor(db, "owner", { threadId: 42, topic: "news" }),
      null,
    );
  } finally {
    await pg.close();
  }
});

test("recent feed index is available in General, capped, and implicit anchors freeze at intake", async () => {
  const { pg, db } = await fixture();
  try {
    const old = await edition(db, "First precise story");
    await recordFeedSent(db, "owner", old, "news", { message_id: 101 }, 42);
    const a = new Assistant(
      db,
      new CustomAgent({
        generate: async () => ({
          message: { role: "assistant", content: "ok" },
        }),
      }),
      new JobTools(db, { call: async () => ({}) }),
    );
    const input = await a.recordInput("owner", "Explain this", {
      topic: "news",
      threadId: 42,
    });
    const newer = await edition(db, "Different precise story");
    await recordFeedSent(db, "owner", newer, "news", { message_id: 102 }, 42);
    const state = await conversationState(db, "owner", input);
    assert.equal(state.feedAnchor.references[0].id, old);
    assert.match(await recentFeedIndex(db, "owner"), /First precise story/);
    for (let n = 0; n < 17; n++) {
      const id = await edition(db, `Bounded title ${n} ${"x".repeat(500)}`);
      await recordFeedSent(
        db,
        "owner",
        id,
        "news",
        { message_id: 200 + n },
        42,
      );
    }
    const index = await recentFeedIndex(db, "owner");
    assert.ok(index.length <= 3000);
    assert.ok(index.split("\n").length <= 15);
    assert.equal(
      await inputAnchor(db, "owner", { threadId: 555, topic: "retired" }),
      null,
    );
  } finally {
    await pg.close();
  }
});

test("General request can read exact stored edition with no web or second model for resolution", async () => {
  const { pg, db } = await fixture();
  let calls = 0;
  try {
    const id = await edition(db);
    await recordFeedSent(db, "owner", id, "news", { message_id: 101 }, 42);
    const a = new Assistant(
      db,
      new CustomAgent({
        generate: async (input) => {
          calls++;
          const system = JSON.stringify(
            input.messages.filter((m) => m.role === "system"),
          );
          assert.match(system, /A precise story/);
          if (calls === 1) {
            assert.ok(input.tools.some((t) => t.name === "feed_read"));
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "read",
                    type: "function",
                    function: {
                      name: "feed_read",
                      arguments: JSON.stringify({ kind: "news", id }),
                    },
                  },
                ],
              },
            };
          }
          assert.match(
            String(input.messages.find((m) => m.role === "tool")?.content),
            /A precise story/,
          );
          return {
            message: {
              role: "assistant",
              content: "This is the exact saved story.",
            },
          };
        },
      }),
      new JobTools(db, {
        call: async () => {
          throw Error("Should not search again");
        },
      }),
    );
    const out = await a.respondDetailed(
      "owner",
      "Tell me more about the story this morning",
    );
    assert.equal(calls, 2);
    assert.match(out.reply, /exact saved/);
    assert.equal(
      (
        await db.query(
          "SELECT is_write FROM runtime_calls WHERE operation='feed_read'",
        )
      ).rows[0].is_write,
      false,
    );
  } finally {
    await pg.close();
  }
});

test("thread-local last exchange and pending question preserve shared history", async () => {
  const { pg, db } = await fixture();
  try {
    let n = 0;
    const a = new Assistant(
      db,
      new CustomAgent({
        generate: async () => ({
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: randomUUID(),
                type: "function",
                function: {
                  name: "finish_turn",
                  arguments: JSON.stringify({
                    reply: ++n === 1 ? "Which detail?" : "General question?",
                    reason: "awaiting_user",
                  }),
                },
              },
            ],
          },
        }),
      }),
      new JobTools(db, { call: async () => ({}) }),
    );
    await a.respondDetailed("owner", "News question", undefined, undefined, {
      threadId: 42,
    });
    await a.respondDetailed("owner", "General question");
    const input = await a.recordInput("owner", "Yes", { threadId: 42 });
    const state = await conversationState(db, "owner", input);
    assert.equal(state.pendingReply.askedIn, 0);
    assert.equal(state.lastExchangeHere.askedIn, 42);
    assert.equal(state.lastExchangeHere.request, "News question");
    assert.equal(state.lastExchangeHere.pendingReply.askedIn, 42);
  } finally {
    await pg.close();
  }
});

test("market anchors contain only the fresh 15-minute cluster, capped at five", async () => {
  const { pg, db } = await fixture();
  try {
    for (let n = 0; n < 7; n++) {
      const item = randomUUID(),
        id = randomUUID();
      await db.query(
        "INSERT INTO watchlist_items(id,user_id,symbol,name,exchange,mic_code,exchange_timezone,currency) VALUES($1,'owner',$2,'Stock','NASDAQ','XNGS','America/New_York','USD')",
        [item, `SYM${n}`],
      );
      await db.query(
        "INSERT INTO stock_alerts(id,user_id,item_id,trading_date,state,payload) VALUES($1,'owner',$2,current_date,'sent',$3::jsonb)",
        [id, item, JSON.stringify({ symbol: `SYM${n}`, reply: "Saved alert" })],
      );
      await recordFeedSent(
        db,
        "owner",
        id,
        "markets",
        { message_id: 300 + n },
        43,
      );
      if (n === 0)
        await db.query(
          "UPDATE events SET created_at=now()-interval '16 minutes' WHERE run_id=$1",
          [id],
        );
    }
    const anchor = await inputAnchor(db, "owner", {
      topic: "markets",
      threadId: 43,
    });
    assert.equal(anchor?.references?.length, 5);
    assert.equal(anchor?.titles?.length, 5);
    await db.query(
      "UPDATE events SET created_at=now()-interval '7 hours' WHERE type='telegram.feed_sent'",
    );
    assert.equal(
      await inputAnchor(db, "owner", { topic: "markets", threadId: 43 }),
      null,
    );
  } finally {
    await pg.close();
  }
});

test("batched old explicit references survive absorption and superseded-answer removal", async () => {
  const { pg, db } = await fixture();
  try {
    const first = await edition(db, "Old first story"),
      second = await edition(db, "Old second story");
    await recordFeedSent(db, "owner", first, "news", { message_id: 501 }, 42);
    await recordFeedSent(db, "owner", second, "news", { message_id: 502 }, 42);
    await db.query(
      "UPDATE events SET created_at=now()-interval '3 days' WHERE type='telegram.feed_sent'",
    );
    let calls = 0;
    let references: string = "";
    const a = new Assistant(
      db,
      new CustomAgent({
        generate: async (input) => {
          calls++;
          if (calls === 1) {
            await a.recordInput("owner", "Explain the first", {
              threadId: 42,
              replyToMessageId: 501,
            });
            await a.recordInput("owner", "Compare the second", {
              threadId: 42,
              replyToMessageId: 502,
            });
            return {
              message: { role: "assistant", content: "Superseded candidate" },
            };
          }
          if (calls === 2) references = JSON.stringify(input.messages);
          return {
            message: {
              role: "assistant",
              content: "Compared the exact stories",
            },
          };
        },
      }),
      new JobTools(db, { call: async () => ({}) }),
    );
    await a.respondDetailed("owner", "Initial question", undefined, undefined, {
      threadId: 42,
    });
    assert.ok(references.includes(first));
    assert.ok(references.includes(second));
    await a.respondDetailed("owner", "Next turn", undefined, undefined, {
      threadId: 42,
    });
    const state = await conversationState(db, "owner");
    const lines = state.summary.split("\n");
    assert.ok(
      lines.find((line) => line.includes("Explain the first"))?.includes(first),
    );
    assert.ok(
      lines
        .find((line) => line.includes("Compare the second"))
        ?.includes(second),
    );
    const inputs = (
      await db.query(
        "SELECT id,metadata FROM conversation_inputs WHERE message='Explain the first'",
      )
    ).rows;
    assert.ok(inputs[0].metadata.conversationMessageId);
    const read = await new JobTools(db, { call: async () => ({}) }).execute(
      "owner",
      randomUUID(),
      { operation: "conversation_read", id: inputs[0].id, offset: 0 },
    );
    assert.match((read as any).content, new RegExp(first));
  } finally {
    await pg.close();
  }
});

test("implicit Updates anchor ignores a newer post actually delivered in General", async () => {
  const { pg, db } = await fixture();
  try {
    const right = randomUUID(),
      wrong = randomUUID();
    await recordFeedSent(
      db,
      "owner",
      right,
      "updates",
      { message_id: 601 },
      45,
    );
    await recordFeedSent(
      db,
      "owner",
      wrong,
      "updates",
      { message_id: 602 },
      undefined,
    );
    const anchor = await inputAnchor(db, "owner", {
      topic: "updates",
      threadId: 45,
    });
    assert.equal(anchor?.references?.[0]?.id, right);
    assert.equal(
      await inputAnchor(db, "owner", { topic: "coding", threadId: 45 }),
      null,
    );
    assert.equal(
      (
        await inputAnchor(db, "owner", {
          topic: "coding",
          threadId: 45,
          replyToMessageId: 601,
        })
      )?.references?.[0]?.id,
      right,
    );
  } finally {
    await pg.close();
  }
});
