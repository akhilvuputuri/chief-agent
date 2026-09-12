import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { telegram } from "../src/telegram.js";
import { readConfig } from "../src/config.js";
import { Assistant } from "../src/agent.js";
import { JobTools } from "../src/tools.js";
import type { Database } from "../src/db.js";
test("Telegram handles natural text once and ignores unauthorized users and groups", async () => {
  const pg = new PGlite();
  await pg.exec(
    await readFile(new URL("../db/001_initial.sql", import.meta.url), "utf8"),
  );
  await pg.exec(
    await readFile(
      new URL("../db/002_preparation.sql", import.meta.url),
      "utf8",
    ),
  );
  await pg.exec(
    await readFile(new URL("../db/005_work.sql", import.meta.url), "utf8"),
  );
  await pg.exec(
    await readFile(new URL("../db/003_skills.sql", import.meta.url), "utf8"),
  );
  await pg.exec(
    await readFile(new URL("../db/006_runtime.sql", import.meta.url), "utf8"),
  );
  const db = pg as unknown as Database;
  let turns = 0;
  const replies: string[] = [];
  const assistant = new Assistant(
    db,
    {
      run: async (req) => {
        turns++;
        return {
          reply: `Understood: ${req.message}`,
          history: [{ role: "user", content: req.message }],
        };
      },
    },
    new JobTools(db, { call: async () => ({}) }),
  );
  const c = readConfig({
    DATABASE_URL: "postgres://x:x@localhost/x",
    TELEGRAM_BOT_TOKEN: "123:long-test-token",
    TELEGRAM_ALLOWED_USER_IDS: "123",
  });
  const bot = telegram(c, assistant, db);
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "getMe")
      return {
        ok: true,
        result: {
          id: 999,
          is_bot: true,
          first_name: "Test",
          username: "test_bot",
        },
      };
    if (method === "sendMessage") replies.push((payload as any).text);
    return { ok: true, result: true } as any;
  });
  await bot.init();
  const update = (id: number, user = 123, type = "private") =>
    ({
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        chat: { id: user, type },
        from: { id: user, is_bot: false, first_name: "Test" },
        text: "Compare these roles with my background",
      },
    }) as any;
  try {
    await bot.handleUpdate(update(1));
    await bot.handleUpdate(update(1));
    await bot.handleUpdate(update(2, 456));
    await bot.handleUpdate(update(3, 123, "group"));
    assert.equal(turns, 1);
    assert.equal(replies.length, 1);
    assert.match(replies[0]!, /Compare these roles/);
    assert.equal(
      (await pg.query("SELECT * FROM inbound_updates")).rows.length,
      1,
    );
  } finally {
    await pg.close();
  }
});

test("status responds while a conversation is still running", async () => {
  const pg = new PGlite();
  for (const f of [
    "001_initial",
    "002_preparation",
    "003_skills",
    "005_work",
    "006_runtime",
    "008_costs",
  ])
    await pg.exec(
      await readFile(new URL("../db/" + f + ".sql", import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    held = new Promise<void>((r) => (release = r));
  const assistant = new Assistant(
    db,
    {
      run: async (req) => {
        entered();
        await held;
        return { reply: "Finished", history: [], stopReason: "answer" };
      },
    },
    new JobTools(db, { call: async () => ({}) }),
  );
  const c = readConfig({
    DATABASE_URL: "postgres://x:x@localhost/x",
    TELEGRAM_BOT_TOKEN: "123:long-test-token",
    TELEGRAM_ALLOWED_USER_IDS: "123",
  });
  const bot = telegram(c, assistant, db);
  const replies: string[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "getMe")
      return {
        ok: true,
        result: {
          id: 999,
          is_bot: true,
          first_name: "Test",
          username: "test_bot",
        },
      };
    if (method === "sendMessage") replies.push((payload as any).text);
    return { ok: true, result: true } as any;
  });
  await bot.init();
  const update = (id: number, text: string) =>
    ({
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        chat: { id: 123, type: "private" },
        from: { id: 123, is_bot: false, first_name: "Test" },
        text,
      },
    }) as any;
  const running = bot.handleUpdate(update(1, "Research this"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await started;
    await Promise.race([
      bot.handleUpdate(update(2, "/status")),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Status waited behind conversation")),
          2000,
        );
      }),
    ]);
    assert.equal(replies.length, 1);
    assert.match(replies[0]!, /No tracked task yet/);
  } finally {
    if (timer) clearTimeout(timer);
    release();
    await running;
    await pg.close();
  }
});

test("photos and PDF documents reach the agent as bounded, owner-scoped attachments", async () => {
  const { minimalPdf } = await import("./attachments.test.js");
  const pg = new PGlite();
  for (const f of [
    "001_initial",
    "002_preparation",
    "003_skills",
    "005_work",
    "006_runtime",
    "008_costs",
  ])
    await pg.exec(
      await readFile(new URL("../db/" + f + ".sql", import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  const requests: any[] = [];
  const tools = new JobTools(db, { call: async () => ({}) });
  const assistant = new Assistant(
    db,
    {
      run: async (req) => {
        requests.push(req);
        return {
          reply: "Seen",
          history: [{ role: "user", content: req.message }],
        };
      },
    },
    tools,
  );
  const c = readConfig({
    DATABASE_URL: "postgres://x:x@localhost/x",
    TELEGRAM_BOT_TOKEN: "123:long-test-token",
    TELEGRAM_ALLOWED_USER_IDS: "123",
  });
  const bot = telegram(c, assistant, db);
  const replies: string[] = [];
  const files: Record<string, Uint8Array> = {
    "photos/file_1.jpg": new Uint8Array(
      Buffer.from("\xff\xd8fake-jpeg", "latin1"),
    ),
    "documents/file_2.pdf": minimalPdf([
      "Alex Example, Singapore. Summary of experience.",
      "Second page: TypeScript, Postgres.",
    ]),
    "documents/file_3.pdf": minimalPdf([" "]),
  };
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "getMe")
      return {
        ok: true,
        result: { id: 999, is_bot: true, first_name: "Test", username: "t" },
      };
    if (method === "sendMessage") replies.push((payload as any).text);
    if (method === "getFile") {
      const id = (payload as any).file_id as string;
      const path = {
        photo: "photos/file_1.jpg",
        pdf: "documents/file_2.pdf",
        scanned: "documents/file_3.pdf",
        evil: "../secret",
      }[id];
      return {
        ok: true,
        result: { file_id: id, file_unique_id: "u" + id, file_path: path },
      } as any;
    }
    return { ok: true, result: true } as any;
  });
  await bot.init();
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    fetched.push(url);
    const path = url.split("/bot123:long-test-token/")[1];
    const body = path && files[path];
    if (!body) return new Response("missing", { status: 404 });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const update = (id: number, message: Record<string, unknown>) =>
    ({
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        chat: { id: 123, type: "private" },
        from: { id: 123, is_bot: false, first_name: "Test" },
        ...message,
      },
    }) as any;
  try {
    await bot.handleUpdate(
      update(1, {
        caption: "What does this sign say?",
        photo: [
          {
            file_id: "tiny",
            file_unique_id: "a",
            width: 1,
            height: 1,
            file_size: 10,
          },
          {
            file_id: "photo",
            file_unique_id: "b",
            width: 9,
            height: 9,
            file_size: 12,
          },
        ],
      }),
    );
    assert.equal(requests.length, 1);
    assert.match(
      requests[0].message,
      /^What does this sign say\?\n\n\[Attached image: photo\.jpg \(image\/jpeg, 1 KB\)/,
    );
    assert.equal(requests[0].images.length, 1);
    assert.equal(requests[0].images[0].mimeType, "image/jpeg");
    assert.equal(
      Buffer.from(requests[0].images[0].data, "base64").toString("latin1"),
      "\xff\xd8fake-jpeg",
    );
    assert.deepEqual(replies, ["Seen"]);
    assert.match(
      fetched[0]!,
      /file\/bot123:long-test-token\/photos\/file_1\.jpg$/,
    );
    // Persisted history and memory sources hold only the note, not image bytes.
    const stored = JSON.stringify(
      (await pg.query("SELECT history FROM conversations")).rows,
    );
    assert.match(stored, /Attached image/);
    assert.doesNotMatch(stored, /fake-jpeg|base64,/);

    await bot.handleUpdate(
      update(2, {
        caption: "Summarise my CV",
        document: {
          file_id: "pdf",
          file_unique_id: "upd",
          file_name: "cv.pdf",
          mime_type: "application/pdf",
          file_size: 900,
        },
      }),
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[1].images, undefined);
    assert.match(
      requests[1].message,
      /^Summarise my CV\n\n\[Attached PDF: cv\.pdf \(1 KB\), 2 pages, text extracted from 2, \d+ characters\. sourceId=([0-9a-f-]{36})/,
    );
    assert.match(
      requests[1].message,
      /--- Page 2 ---\nSecond page: TypeScript, Postgres\./,
    );
    const sourceId = /sourceId=([0-9a-f-]{36})/.exec(requests[1].message)![1]!;
    const source = (await pg.query("SELECT * FROM research_sources"))
      .rows[0] as any;
    assert.equal(source.id, sourceId);
    assert.equal(source.user_id, "123");
    assert.equal(source.url, "telegram:document/upd/cv.pdf");
    assert.match(source.content, /Alex Example/);
    const read = (await tools.execute(
      "123",
      "00000000-0000-4000-8000-000000000001",
      { operation: "source_read", id: sourceId, offset: 20 },
    )) as any;
    assert.equal(read.offset, 20);
    assert.equal(read.totalCharacters, source.content.length);
    assert.equal(read.content, source.content.slice(20, 8020));
    await assert.rejects(
      tools.execute("456", "00000000-0000-4000-8000-000000000002", {
        operation: "source_read",
        id: sourceId,
      }),
      /Source not found|Usage owner|violates/,
    );

    await bot.handleUpdate(
      update(3, {
        document: {
          file_id: "scanned",
          file_unique_id: "s",
          file_name: "scan.pdf",
          mime_type: "application/pdf",
          file_size: 400,
        },
      }),
    );
    assert.equal(requests.length, 2);
    assert.match(replies.at(-1)!, /no selectable text/);

    await bot.handleUpdate(
      update(4, {
        document: {
          file_id: "doc",
          file_unique_id: "d",
          file_name: "notes.docx",
          mime_type:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          file_size: 400,
        },
      }),
    );
    assert.equal(requests.length, 2);
    assert.match(
      replies.at(-1)!,
      /I can read photos, image files .* and PDF documents/,
    );

    await bot.handleUpdate(
      update(5, {
        photo: [
          {
            file_id: "photo",
            file_unique_id: "b",
            width: 9,
            height: 9,
            file_size: 11 * 1024 * 1024,
          },
        ],
      }),
    );
    assert.equal(requests.length, 2);
    assert.match(replies.at(-1)!, /could not finish/);

    await bot.handleUpdate(
      update(6, {
        document: {
          file_id: "evil",
          file_unique_id: "e",
          file_name: "x.pdf",
          mime_type: "application/pdf",
          file_size: 5,
        },
      }),
    );
    assert.equal(requests.length, 2);
    assert.match(replies.at(-1)!, /could not finish/);
    assert.equal(fetched.filter((u) => u.includes("secret")).length, 0);
    const events = (
      await pg.query(
        "SELECT type,data FROM events WHERE type LIKE 'image.%' OR type LIKE 'document.%' ORDER BY id",
      )
    ).rows as any[];
    assert.deepEqual(
      events.map((e) => e.type),
      ["image.received", "document.extracted", "document.unreadable"],
    );
    assert.equal(events[1].data.pages, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await pg.close();
  }
});
