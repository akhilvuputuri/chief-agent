import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Canvases } from "../src/canvases.js";
import { canvasDocument, canvasCreate } from "../src/canvas-schema.js";
import { MiniAuth } from "../src/miniapp-auth.js";
import { server } from "../src/server.js";
import { JobTools } from "../src/tools.js";
import { ensureUser, type Database } from "../src/db.js";
import { runtimeContext, jsonSchema } from "../src/runtime.js";
import { readOperations } from "../src/execution.js";
import { TelegramViews } from "../src/telegram-views.js";
const token = "123456789:fake-telegram-token-for-tests-only";
const origin = "https://example.test";
const doc = (title = "Research") => ({
  schemaVersion: 1 as const,
  title,
  summary: "Saved findings",
  blocks: [
    {
      id: "intro",
      type: "text" as const,
      title: "Summary",
      body: "<script>alert(1)</script> Unknown experience remains unknown.",
    },
  ],
  sources: [],
});
async function fixture() {
  const pg = new PGlite();
  for (const name of [
    "001_initial",
    "002_preparation",
    "003_skills",
    "004_daily",
    "005_work",
    "006_runtime",
    "008_costs",
    "012_message_storage",
    "013_conversation_control",
    "009_calendar_approval",
    "011_canvases",
  ])
    await pg.exec(
      await readFile(
        new URL("../db/" + name + ".sql", import.meta.url),
        "utf8",
      ),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  return { pg, db, canvases: new Canvases(db) };
}
function signed(user = 123, seconds = Math.floor(Date.now() / 1000)) {
  const p = new URLSearchParams({
    auth_date: String(seconds),
    user: JSON.stringify({ id: user, first_name: "Test" }),
    query_id: "fixture",
  });
  const data = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  p.set(
    "hash",
    createHmac(
      "sha256",
      createHmac("sha256", "WebAppData").update(token).digest(),
    )
      .update(data)
      .digest("hex"),
  );
  return p.toString();
}
test("canvases retain independent immutable revisions, reject stale writes and survive fresh service instances", async () => {
  const { pg, db, canvases: c } = await fixture();
  try {
    const run = randomUUID(),
      key = randomUUID();
    const a = await c.write("123", run, {
      operation: "canvas_create",
      requestKey: key,
      document: doc("A"),
    });
    const b = await c.write("123", run, {
      operation: "canvas_create",
      requestKey: randomUUID(),
      document: doc("B"),
    });
    const changed = await c.write("123", run, {
      operation: "canvas_update",
      id: a.id,
      baseRevision: 1,
      requestKey: randomUUID(),
      document: doc("A improved"),
    });
    assert.equal(changed.revision, 2);
    assert.equal((await c.read("123", a.id, 1)).document.title, "A");
    assert.equal(
      (await new Canvases(db).read("123", a.id)).document.title,
      "A improved",
    );
    assert.equal((await c.read("123", b.id)).document.title, "B");
    await assert.rejects(
      c.write("123", run, {
        operation: "canvas_update",
        id: a.id,
        baseRevision: 1,
        requestKey: randomUUID(),
        document: doc("Stale"),
      }),
      /revision conflict/,
    );
    assert.equal((await c.history("123", a.id)).items.length, 2);
    await assert.rejects(c.read("456", a.id), /not found/);
    assert.deepEqual((await c.list("456")).items, []);
    assert.deepEqual((await c.history("456", a.id)).items, []);
    await assert.rejects(
      c.write("456", run, {
        operation: "canvas_update",
        id: a.id,
        baseRevision: 2,
        requestKey: randomUUID(),
        document: doc(),
      }),
      /not found/,
    );
    const read = await c.toolRead("123", run, a.id, 1, 0);
    assert.equal(read.revision, 1);
    const events = (
      await db.query(
        "SELECT type,data FROM events WHERE type LIKE 'canvas.%' ORDER BY id",
      )
    ).rows;
    assert.equal(events.filter((e) => e.type === "canvas.revised").length, 3);
    assert.ok(events.some((e) => e.type === "canvas.conflict"));
    assert.ok(
      events.some(
        (e) => e.type === "canvas.read" && e.data.originRunId === run,
      ),
    );
    assert.ok(
      events.every((e) => !JSON.stringify(e.data).includes("Saved findings")),
    );
  } finally {
    await pg.close();
  }
});
test("exact duplicate requests are idempotent; competing updates cannot both win; failed atomic write leaves no orphan", async () => {
  const { pg, db, canvases: c } = await fixture();
  try {
    const run = randomUUID(),
      request = {
        operation: "canvas_create" as const,
        requestKey: randomUUID(),
        document: doc(),
      };
    const [a, b] = await Promise.all([
      c.write("123", run, request),
      c.write("123", run, request),
    ]);
    assert.equal(a.id, b.id);
    assert.equal((await c.list("123")).items.length, 1);
    await assert.rejects(
      c.write("123", run, { ...request, document: doc("different") }),
      /already used/,
    );
    const update = {
      operation: "canvas_update" as const,
      id: a.id,
      baseRevision: 1,
      requestKey: randomUUID(),
      document: doc("next"),
    };
    const results = await Promise.allSettled([
      c.write("123", run, update),
      c.write("123", run, {
        ...update,
        requestKey: randomUUID(),
        document: doc("race"),
      }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await c.read("123", a.id)).latest_revision, 2);
    const saved = results[0]!.status === "fulfilled";
    if (saved) {
      const again = await new Canvases(db).write("123", randomUUID(), update);
      assert.equal(again.revision, 2);
      assert.equal(again.replayed, true);
    }
    await assert.rejects(
      c.write("123", run, {
        operation: "canvas_create",
        requestKey: randomUUID(),
        document: {
          ...doc(),
          sources: [
            {
              label: "Wrong owner",
              url: "https://example.test",
              sourceId: randomUUID(),
            },
          ],
        },
      }),
      /source ID/,
    );
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM canvases")).rows[0].n,
      1,
    );
    await pg.exec(
      await readFile(
        new URL("../db/011_canvases.sql", import.meta.url),
        "utf8",
      ),
    );
    assert.equal((await c.read("123", a.id)).latest_revision, 2);
  } finally {
    await pg.close();
  }
});
test("schema and runtime dispatcher reject invalid content and identity arguments, and validate exact source ownership", async () => {
  const { pg, db } = await fixture();
  try {
    assert.throws(
      () =>
        canvasDocument.parse({
          ...doc(),
          blocks: [doc().blocks[0], doc().blocks[0]],
        }),
      /unique/,
    );
    assert.throws(
      () =>
        canvasDocument.parse({
          ...doc(),
          blocks: [
            {
              id: "t",
              title: "T",
              type: "table",
              columns: ["A"],
              rows: [["A", "B"]],
            },
          ],
        }),
      /match/,
    );
    assert.throws(() =>
      canvasDocument.parse({
        ...doc(),
        sources: [{ label: "Bad", url: "javascript:alert(1)" }],
      }),
    );
    assert.throws(() => canvasDocument.parse({ ...doc(), html: "<script>" }));
    assert.throws(() =>
      canvasDocument.parse({
        ...doc(),
        blocks: [
          {
            id: "g",
            title: "G",
            type: "chart",
            unit: "x",
            points: [{ label: "a", value: Infinity }],
          },
        ],
      }),
    );
    const tools = new JobTools(db, {
      call: async () => {
        throw new Error("unexpected external call");
      },
    } as any);
    await assert.rejects(
      tools.execute("123", randomUUID(), {
        operation: "canvas_create",
        user: "456",
        requestKey: randomUUID(),
        document: doc(),
      }),
    );
    const source = randomUUID();
    await db.query(
      "INSERT INTO research_sources(id,user_id,url,content) VALUES($1,'456','https://example.test/source','private')",
      [source],
    );
    await assert.rejects(
      tools.execute("123", randomUUID(), {
        operation: "canvas_create",
        requestKey: randomUUID(),
        document: {
          ...doc(),
          sources: [
            {
              label: "s",
              url: "https://example.test/source",
              sourceId: source,
            },
          ],
        },
      }),
      /source ID/,
    );
    const result: any = await tools.execute(
      "123",
      randomUUID(),
      { operation: "canvas_create", requestKey: randomUUID(), document: doc() },
      true,
    );
    assert.ok(result.receiptId);
    assert.equal(result.result.revision, 1);
    assert.equal(readOperations.has("canvas_read"), true);
    assert.equal(readOperations.has("canvas_update"), false);
    assert.ok(
      !runtimeContext({}, null).tools.some((t) => t.name === "canvas_create"),
    );
    assert.ok(
      runtimeContext({ canvases: true }, null).tools.some(
        (t) => t.name === "canvas_create",
      ),
    );
    assert.ok(
      jsonSchema(canvasCreate).properties.document.properties.blocks.items.anyOf
        .length === 6,
    );
  } finally {
    await pg.close();
  }
});
test("Telegram authentication rejects tampering, duplicate fields, stale/future launch data and expired/forged sessions", () => {
  let now = Date.now();
  const auth = new MiniAuth(token, new Set(["123"]), () => now);
  const s = auth.authenticate(signed());
  assert.equal(auth.verify("Bearer " + s.token), "123");
  for (const raw of [
    signed(456),
    signed(123, Math.floor(now / 1000) - 301),
    signed(123, Math.floor(now / 1000) + 60),
    signed().replace("Test", "Forged"),
    signed() + "&auth_date=1",
  ])
    assert.throws(() => auth.authenticate(raw));
  assert.throws(() => auth.verify("Bearer " + s.token + "x"));
  assert.throws(() => auth.verify(undefined));
  now += 1801000;
  assert.throws(() => auth.verify("Bearer " + s.token));
});
test("Mini App endpoints require sessions and enforce ownership with no write/approval routes", async () => {
  const { pg, db, canvases: c } = await fixture();
  const app = server(db, { origin, token, allowed: new Set(["123", "456"]) });
  try {
    const a = await c.write("123", randomUUID(), {
      operation: "canvas_create",
      requestKey: randomUUID(),
      document: doc(),
    });
    const auth = new MiniAuth(token, new Set(["123", "456"]));
    const mine = {
      authorization: "Bearer " + auth.authenticate(signed()).token,
    };
    const other = {
      authorization: "Bearer " + auth.authenticate(signed(456)).token,
    };
    assert.equal((await app.inject({ url: "/miniapp/" })).statusCode, 200);
    for (const url of [
      "/api/miniapp/canvases",
      "/api/miniapp/roles",
      "/api/miniapp/canvases/" + a.id,
      "/api/miniapp/canvases/" + a.id + "/head",
      "/api/miniapp/canvases/" + a.id + "/history",
    ])
      assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/miniapp/session",
          payload: { initData: signed() },
          headers: { origin: "https://evil.test" },
        })
      ).statusCode,
      403,
    );
    const session = await app.inject({
      method: "POST",
      url: "/api/miniapp/session",
      payload: { initData: signed() },
      headers: { origin },
    });
    assert.equal(session.statusCode, 200);
    assert.ok(session.json().token);
    assert.equal(session.headers["cache-control"], "no-store");
    assert.equal(
      (
        await app.inject({
          url: "/api/miniapp/canvases/" + a.id,
          headers: mine,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/miniapp/canvases/" + a.id,
          headers: other,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/miniapp/canvases/" + a.id + "/head",
          headers: other,
        })
      ).statusCode,
      404,
    );
    assert.deepEqual(
      (
        await app.inject({
          url: "/api/miniapp/canvases/" + a.id + "/history",
          headers: other,
        })
      ).json().items,
      [],
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/miniapp/canvases",
          headers: mine,
          payload: {},
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/miniapp/calendar/approve",
          headers: mine,
          payload: {},
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ url: "/api/miniapp/roles?user=456", headers: mine }))
        .statusCode,
      400,
    );
    const role = randomUUID();
    await db.query(
      "INSERT INTO jobs(id,user_id,title,company) VALUES($1,'123','Role','Firm')",
      [role],
    );
    assert.equal(
      (await app.inject({ url: "/api/miniapp/roles/" + role, headers: other }))
        .statusCode,
      404,
    );
    const html = await app.inject({ url: "/miniapp/" });
    assert.match(
      String(html.headers["content-security-policy"]),
      /default-src 'none'/,
    );
    assert.ok(!html.body.includes("Saved findings"));
    assert.equal((await app.inject({ url: "/.env" })).statusCode, 404);
  } finally {
    await app.close();
    await pg.close();
  }
});
test("Telegram canvas buttons are owner-checked and preserve exact revision links", async () => {
  const { pg, db, canvases: c } = await fixture();
  try {
    const run = randomUUID();
    const a = await c.write("123", run, {
      operation: "canvas_create",
      requestKey: randomUUID(),
      document: doc("A"),
    });
    const b = await c.write("456", run, {
      operation: "canvas_create",
      requestKey: randomUUID(),
      document: doc("B"),
    });
    const messages: any[] = [];
    const views = new TelegramViews(
      db,
      {
        sendMessage: async (...args: any[]) => {
          messages.push(args);
          return { message_id: 1 };
        },
      } as any,
      undefined,
      origin,
    );
    await views.deliver("123", "123", {
      reply: "Here is your analysis.",
      canvases: [{ id: a.id, revision: 1 }, { id: b.id }, { id: randomUUID() }],
      runId: run,
    });
    const links = messages
      .flatMap((m) => m[2]?.reply_markup?.inline_keyboard ?? [])
      .flat();
    assert.equal(links.length, 1);
    assert.ok(links[0].web_app.url.includes(a.id));
    assert.ok(links[0].web_app.url.includes("revision=1"));
  } finally {
    await pg.close();
  }
});

test("conversation to saved canvas to finish envelope retains the actual ID and exact revision", async () => {
  const { pg, db } = await fixture();
  try {
    let calls = 0,
      savedId = "";
    const model = {
      generate: async (request: any) => {
        calls++;
        const tool = (name: string, args: unknown) => ({
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
        if (calls === 1)
          return tool("canvas_create", {
            requestKey: randomUUID(),
            document: doc("A test plan"),
          });
        const observation = request.messages.findLast(
          (m: any) => m.role === "tool",
        );
        savedId = JSON.parse(observation.content).result.id;
        assert.ok(savedId);
        return tool("finish_turn", {
          reason: "answer",
          reply: "Your plan is saved.",
          canvases: [{ id: savedId, revision: 1 }],
        });
      },
    };
    const assistant = new Assistant(
      db,
      new CustomAgent(model),
      new JobTools(db, { call: async () => ({ content: "unused" }) }),
      { canvases: true },
    );
    const delivered = await assistant.respondDetailed(
      "123",
      "Save a plan as a canvas",
    );
    assert.equal(delivered.reply, "Your plan is saved.");
    assert.deepEqual(delivered.canvases, [{ id: savedId, revision: 1 }]);
    assert.equal(
      (await new Canvases(db).read("123", savedId)).document.title,
      "A test plan",
    );
  } finally {
    await pg.close();
  }
});
