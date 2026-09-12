import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Api } from "grammy";
import { ensureUser, type Database } from "../src/db.js";
import { TelegramViews } from "../src/telegram-views.js";
import { renderView, initialPosition } from "../src/telegram-view-render.js";
import { formatTelegram } from "../src/telegram-format.js";
import { finishSchema } from "../src/answer.js";
import { telegram } from "../src/telegram.js";
import { readConfig } from "../src/config.js";
import type { Assistant } from "../src/agent.js";
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
    "009_calendar_approval",
  ])
    await pg.exec(
      await readFile(new URL(`../db/${name}.sql`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  let time = Date.now();
  const sent: any[] = [],
    edited: any[] = [];
  const api = {
    sendMessage: async (chat: string, text: string, options: any) => {
      sent.push({ chat, text, ...options });
      return { message_id: sent.length };
    },
    editMessageText: async (
      chat: string,
      message: number,
      text: string,
      options: any,
    ) => {
      edited.push({ chat, message, text, ...options });
      return true;
    },
  } as unknown as Pick<Api, "sendMessage" | "editMessageText">;
  const views = new TelegramViews(db, api, () => time);
  return {
    pg,
    db,
    api,
    views,
    sent,
    edited,
    advance: (ms = 1000) => {
      time += ms;
    },
    now: () => time,
  };
}
const button = (message: any, label: string) =>
  message.reply_markup.inline_keyboard.flat().find((b: any) => b.text === label)
    ?.callback_data as string;
test("long answers disclose complete formatted text with bounded callbacks; survive restart and reject other owners/chats/messages", async () => {
  const f = await fixture();
  try {
    const prose = "**" + "🙂 detail ".repeat(1200) + "**";
    await f.views.deliver("123", "123", {
      reply: prose,
      sections: [{ title: "Analysis", body: "Evidence-based notes" }],
      sources: [{ label: "Source", url: "https://example.com" }],
    });
    assert.equal(f.sent.length, 1);
    const first = f.sent[0];
    assert.ok(button(first, "Show more"));
    const nav = button(first, "Show more");
    assert.match(
      (await f.views.navigate("456", "123", 1, nav))!,
      /unavailable/,
    );
    assert.match(
      (await f.views.navigate("123", "456", 1, nav))!,
      /unavailable/,
    );
    assert.match(
      (await f.views.navigate("123", "123", 2, nav))!,
      /unavailable/,
    );
    assert.equal(f.edited.length, 0);
    let page = first;
    let joined = page.text.split("\n\nText ")[0];
    const resumed = new TelegramViews(f.db, f.api, f.now);
    while (button(page, page === first ? "Show more" : "Next text")) {
      f.advance();
      assert.equal(
        await resumed.navigate(
          "123",
          "123",
          1,
          button(page, page === first ? "Show more" : "Next text"),
        ),
        undefined,
      );
      page = f.edited.at(-1);
      joined += page.text.split("\n\nText ")[0];
      for (const row of page.reply_markup.inline_keyboard)
        for (const b of row)
          assert.ok(Buffer.byteLength(b.callback_data) <= 64);
      assert.ok(page.text.length <= 4096);
      for (const e of page.entities)
        assert.ok(e.offset + e.length <= page.text.length);
    }
    assert.equal(
      joined,
      formatTelegram(prose)
        .map((p) => p.text)
        .join(""),
    );
    f.advance();
    await resumed.navigate("123", "123", 1, button(page, "Sources"));
    assert.match(f.edited.at(-1).text, /https:\/\/example.com/);
    const taps = (
      await f.db.query(
        "SELECT data FROM events WHERE type='telegram.view_tapped' ORDER BY id",
      )
    ).rows;
    assert.equal(taps.filter((t) => t.data.firstTapMs !== null).length, 1);
    f.advance(8 * 86400000);
    assert.match(
      (await resumed.navigate(
        "123",
        "123",
        1,
        button(f.edited.at(-1), "Summary"),
      ))!,
      /expired/,
    );
  } finally {
    await f.pg.close();
  }
});
test("record paging/filter/detail refreshes saved state and keeps approval views read-only", async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 9; n++)
      await f.db.query(
        "INSERT INTO jobs(id,user_id,title,company,status) VALUES($1,'123',$2,'Company',$3)",
        [randomUUID(), `Role ${n}`, n === 8 ? "archived" : "saved"],
      );
    const foreign = randomUUID();
    await f.db.query(
      "INSERT INTO jobs(id,user_id,title,company) VALUES($1,'456','PRIVATE TITLE','Other')",
      [foreign],
    );
    await f.views.open("123", "123", { kind: "records", collection: "roles" });
    assert.doesNotMatch(f.sent[0].text, /PRIVATE TITLE|Role 6/);
    await f.views.navigate("123", "123", 1, button(f.sent[0], "Next"));
    assert.match(f.edited.at(-1).text, /Role 8/);
    f.advance();
    await f.views.navigate(
      "123",
      "123",
      1,
      button(f.edited.at(-1), "Active only"),
    );
    assert.doesNotMatch(f.edited.at(-1).text, /Role 8/);
    f.advance();
    await f.views.navigate(
      "123",
      "123",
      1,
      button(f.edited.at(-1), "1. Company — Role 0"),
    );
    assert.match(f.edited.at(-1).text, /No saved description/);
    await f.db.query(
      "UPDATE jobs SET description='Updated saved information' WHERE user_id='123' AND title='Role 0'",
    );
    f.advance();
    await f.views.navigate("123", "123", 1, button(f.edited.at(-1), "Refresh"));
    assert.match(f.edited.at(-1).text, /Updated saved information/);
    const ref = await renderView(
      f.db,
      "123",
      {
        kind: "answer",
        answer: {
          reply: "Reference",
          records: [{ kind: "role", id: foreign }],
        },
      },
      {
        ...initialPosition(),
        tab: "records",
        detail: { kind: "role", id: foreign },
      },
    );
    assert.doesNotMatch(ref.text, /PRIVATE TITLE/);
    assert.match(ref.text, /unavailable/);
    const draftId = randomUUID();
    await f.db.query(
      "INSERT INTO approvals(id,user_id,run_id,operation,payload) VALUES($1,'123',$2,'calendar_create',$3::jsonb)",
      [
        draftId,
        randomUUID(),
        JSON.stringify({
          draft: {
            title: "Appointment",
            start: "2026-09-20T10:00:00+08:00",
            end: "2026-09-20T11:00:00+08:00",
          },
        }),
      ],
    );
    const draft = await renderView(
      f.db,
      "123",
      { kind: "records", collection: "drafts" },
      { ...initialPosition(), detail: { kind: "calendar_draft", id: draftId } },
    );
    assert.match(draft.text, /read-only view/);
    assert.ok(
      draft.actions
        .flat()
        .every((a) => !/approve|create|decline/i.test(a.label)),
    );
    assert.equal(
      (await f.db.query("SELECT status FROM approvals WHERE id=$1", [draftId]))
        .rows[0].status,
      "pending",
    );
    for (const collection of ["items", "schedules", "drafts"] as const)
      assert.ok(
        (
          await renderView(
            f.db,
            "123",
            { kind: "records", collection },
            initialPosition(),
          )
        ).text,
      );
    assert.match(
      (await renderView(f.db, "123", { kind: "briefing" }, initialPosition()))
        .text,
      /Daily overview/,
    );
  } finally {
    await f.pg.close();
  }
});
test("duplicate/stale taps never replay positional navigation; leases serialize edits and errors release them", async () => {
  const f = await fixture();
  try {
    await f.views.open("123", "123", {
      kind: "answer",
      answer: { reply: "x ".repeat(3000) },
    });
    const first = button(f.sent[0], "Show more");
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    const original = f.api.editMessageText;
    f.api.editMessageText = (async (...args: any[]) => {
      entered();
      await held;
      return (original as any)(...args);
    }) as any;
    const pending = f.views.navigate("123", "123", 1, first);
    await started;
    assert.match((await f.views.navigate("123", "123", 1, first))!, /updating/);
    release();
    await pending;
    f.api.editMessageText = original;
    f.advance();
    await f.views.navigate("123", "123", 1, first);
    assert.match(f.edited.at(-1).text, /Text 2\//);
    f.advance();
    f.api.editMessageText = (async () => {
      throw new Error("private Telegram upstream error");
    }) as any;
    assert.match(
      (await f.views.navigate(
        "123",
        "123",
        1,
        button(f.edited.at(-1), "Next text"),
      ))!,
      /Could not update/,
    );
    f.api.editMessageText = original;
    f.advance();
    await f.views.navigate("123", "123", 1, button(f.edited.at(-1), "Refresh"));
    const state = (
      await f.db.query(
        "SELECT data FROM events WHERE type='telegram.view_state'",
      )
    ).rows[0].data;
    assert.equal(state.lease, undefined);
    assert.equal(state.leaseUntil, undefined);
  } finally {
    await f.pg.close();
  }
});
test("envelope is bounded, excludes authority and leaves approval notices visible", async () => {
  for (const extra of [
    { owner: "456" },
    { records: [{ kind: "role", id: "invented" }] },
    { sources: [{ label: "Bad", url: "javascript:alert(1)" }] },
    { sections: [{ title: "x", body: "a".repeat(20001) }] },
  ])
    assert.equal(
      finishSchema.safeParse({ reason: "answer", reply: "Fine", ...extra })
        .success,
      false,
    );
  const f = await fixture();
  try {
    await f.views.deliver("123", "123", {
      reply: "Detailed " + "prose ".repeat(1000),
      notices: ["Approval required\n/approve test-id"],
    });
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1].text, /\/approve test-id/);
    const metric = (
      await f.db.query(
        "SELECT data FROM events WHERE type='telegram.delivered'",
      )
    ).rows[0].data;
    assert.equal(metric.messages, 1);
    assert.equal(metric.noticeMessages, 1);
    assert.ok(metric.legacyChunks > 1);
  } finally {
    await f.pg.close();
  }
});
test("actual grammy callbacks acknowledge and edit in place with no agent execution", async () => {
  const f = await fixture();
  try {
    const methods: string[] = [],
      sent: any[] = [],
      edits: any[] = [];
    const bot = telegram(
      readConfig({
        DATABASE_URL: "postgres://test:test@localhost/test",
        TELEGRAM_BOT_TOKEN: "123:long-test-token",
        TELEGRAM_ALLOWED_USER_IDS: "123,456",
      }),
      {
        respondDetailed: () => {
          throw new Error("Must not call model");
        },
      } as unknown as Assistant,
      f.db,
    );
    bot.api.config.use(async (_prev, method, payload) => {
      methods.push(method);
      if (method === "getMe")
        return {
          ok: true,
          result: {
            id: 999,
            is_bot: true,
            first_name: "Test",
            username: "test_bot",
          },
        } as any;
      if (method === "sendMessage") {
        sent.push(payload);
        return { ok: true, result: { message_id: sent.length } } as any;
      }
      if (method === "editMessageText") edits.push(payload);
      return { ok: true, result: true } as any;
    });
    await bot.init();
    const from = { id: 123, first_name: "Test", is_bot: false };
    const chat = { id: 123, type: "private" as const };
    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, date: 1, from, chat, text: "/roles" },
    });
    const data = button(sent[0], "Refresh");
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "tap",
        chat_instance: "test",
        from,
        message: { message_id: 1, date: 1, chat, text: "old" },
        data,
      },
    });
    assert.equal(edits.length, 1);
    assert.equal(sent.length, 1);
    assert.ok(
      methods.indexOf("answerCallbackQuery") <
        methods.indexOf("editMessageText"),
    );
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "foreign",
        chat_instance: "test",
        from: { ...from, id: 456 },
        message: { message_id: 1, date: 1, chat, text: "old" },
        data,
      },
    });
    assert.equal(edits.length, 1);
    assert.match(sent.at(-1).text, /unavailable/);
  } finally {
    await f.pg.close();
  }
});
test("task views show recorded support, model/research costs including unknowns and stable task identity", async () => {
  const f = await fixture();
  try {
    const task = randomUUID(),
      run = randomUUID(),
      source = randomUUID(),
      proof = randomUUID();
    await f.db.query(
      "INSERT INTO work_tasks(id,user_id,objective,request,used_models,used_tools) VALUES($1,'123','Test tracked request','Original',2,3)",
      [task],
    );
    await f.db.query(
      "INSERT INTO research_sources(id,user_id,url,content) VALUES($1,'123','https://example.com','Verified source text')",
      [source],
    );
    await f.db.query(
      "INSERT INTO work_evidence(id,task_id,source_id,claim,quote,applicability,reason) VALUES($1,$2,$3,'Relevant claim','Verified source text','matched','Exact source')",
      [proof, task, source],
    );
    await f.db.query(
      "INSERT INTO work_steps(task_id,key,title,verification,status,result,proofs) VALUES($1,'check','Check the source','evidence','done','Recorded result',ARRAY[$2]::uuid[])",
      [task, proof],
    );
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,task_id) VALUES($1,'123',$2)",
      [run, task],
    );
    await f.db.query(
      "INSERT INTO provider_charges(id,run_id,provider,estimated_usd,actual_usd) VALUES($1,$2,'model',0.5,0.3),($3,$2,'search',0.1,NULL)",
      [randomUUID(), run, randomUUID()],
    );
    const pos = initialPosition();
    const costs = await renderView(
      f.db,
      "123",
      { kind: "task", id: task },
      { ...pos, tab: "costs" },
    );
    assert.match(costs.text, /\$0\.3000/);
    assert.match(costs.text, /unknown charge: 1/);
    assert.match(costs.text, /Model calls: 2/);
    const step = await renderView(
      f.db,
      "123",
      { kind: "task", id: task },
      { ...pos, step: "check" },
    );
    assert.match(step.text, /Recorded result/);
    assert.match(step.text, /Verified source text/);
    assert.match(step.text, /does not certify/);
    const foreign = await renderView(
      f.db,
      "456",
      { kind: "task", id: task },
      pos,
    );
    assert.doesNotMatch(foreign.text, /Test tracked|Verified source/);
    await f.views.open("123", "123", { kind: "task" });
    assert.equal(
      (
        await f.db.query(
          "SELECT data FROM events WHERE type='telegram.view_state'",
        )
      ).rows[0].data.view.id,
      task,
    );
  } finally {
    await f.pg.close();
  }
});
test("same-titled roles are distinguished by authoritative company in lists and answer references", async () => {
  const f = await fixture();
  try {
    const ids = [randomUUID(), randomUUID()];
    for (let i = 0; i < 2; i++)
      await f.db.query(
        "INSERT INTO jobs(id,user_id,title,company) VALUES($1,'123','Applied AI Engineer',$2)",
        [ids[i], i ? "Beta" : "Alpha"],
      );
    for (const view of [
      { kind: "records" as const, collection: "roles" as const },
      {
        kind: "answer" as const,
        answer: {
          reply: "Two roles",
          records: ids.map((id) => ({ kind: "role" as const, id })),
        },
      },
    ]) {
      const rendered = await renderView(f.db, "123", view, {
        ...initialPosition(),
        tab: view.kind === "answer" ? "records" : "main",
      });
      assert.match(rendered.text, /Alpha — Applied AI Engineer/);
      assert.match(rendered.text, /Beta — Applied AI Engineer/);
      const labels = rendered.actions
        .flat()
        .map((a) => a.label)
        .join("\n");
      assert.match(labels, /Alpha — Applied AI Engineer/);
      assert.match(labels, /Beta — Applied AI Engineer/);
    }
  } finally {
    await f.pg.close();
  }
});
