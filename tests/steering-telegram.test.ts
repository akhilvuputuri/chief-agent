import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { telegram, sendCalendarApprovals } from "../src/telegram.js";
import type { Assistant, Incoming, Agent } from "../src/agent.js";
import type { Delivery } from "../src/answer.js";
import type { Database } from "../src/db.js";
import type { ImageAttachment } from "../src/protocol.js";
import { readConfig } from "../src/config.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Telegram operation stalled")),
          2000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
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
const photo = (fileId = "photo") => ({
  caption: "Read this sign",
  photo: [
    {
      file_id: fileId,
      file_unique_id: fileId,
      width: 10,
      height: 10,
      file_size: 20,
    },
  ],
});
const voice = {
  voice: {
    file_id: "voice",
    file_unique_id: "voice",
    duration: 1,
    file_size: 20,
  },
};
const runId = "00000000-0000-4000-8000-000000000001";
const jpeg = new Uint8Array(
  Buffer.from("\xff\xd8private-image-bytes", "latin1"),
);

type Input = { id: string; message: string; metadata: Incoming };
type Prepared = { id: string; message: string; images?: ImageAttachment[] };
async function fixture(options: { voice?: boolean } = {}) {
  const claims = new Set<number>();
  const inputs: Input[] = [];
  const ready: Prepared[] = [];
  const failed: string[] = [];
  const calls: { sql: string; values: unknown[] }[] = [];
  const sent: { method: string; payload: any }[] = [];
  const state = {
    revision: 0,
    currentRun: true,
    responds: 0,
    controls: [] as string[],
    finished: [] as string[],
    onRecord: (_input: Input) => {},
    query: async (_sql: string): Promise<any[] | undefined> => undefined,
    respond: async (
      _progress?: (text: string, runId?: string) => Promise<void>,
    ): Promise<Delivery> => ({
      reply: "Understood",
      runId,
      inputRevision: state.revision,
    }),
  };
  const db: Database = {
    query: async (sql, values = []) => {
      calls.push({ sql, values });
      const rows = await state.query(sql);
      if (rows !== undefined) return { rows };
      if (sql.startsWith("INSERT INTO inbound_updates")) {
        const id = values[0] as number;
        if (claims.has(id)) return { rows: [] };
        claims.add(id);
        return { rows: [{ update_id: id }] };
      }
      return { rows: [] };
    },
  };
  const assistant = {
    recordInput: async (_user: string, message: string, metadata: Incoming) => {
      const input = { id: randomUUID(), message, metadata };
      inputs.push(input);
      state.revision++;
      state.onRecord(input);
      return input.id;
    },
    prepareInput: async (
      _user: string,
      id: string,
      message: string,
      images?: ImageAttachment[],
    ) => {
      ready.push({ id, message, images });
    },
    failInput: async (_user: string, id: string) => {
      failed.push(id);
    },
    respondDetailed: async (
      _user: string,
      _message: string,
      progress?: (text: string, runId?: string) => Promise<void>,
    ) => {
      state.responds++;
      return state.respond(progress);
    },
    finishDelivery: (_user: string, run: string) => {
      state.finished.push(run);
    },
    resetConversation: async () => {
      state.controls.push("reset");
    },
    isCurrentRun: async () => state.currentRun,
    isCurrentDelivery: async (_user: string, delivery: Delivery) =>
      !!delivery.runId && delivery.inputRevision === state.revision,
    cancel: async () => {
      state.controls.push("cancel");
      return { cancelled: true };
    },
    grant: async () => {
      state.controls.push("continue");
      return { rows: [] };
    },
    tools: {
      decide: async (_user: string, _id: string, approve: boolean) => {
        state.controls.push(approve ? "approve" : "deny");
        return { status: "denied" };
      },
    },
  } as unknown as Assistant;
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://x:x@localhost/x",
      TELEGRAM_BOT_TOKEN: "123:long-test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      OPENAI_API_KEY: options.voice ? "test-voice-key" : "",
      VOICE_REPLIES: options.voice ? "true" : "false",
    }),
    assistant,
    db,
  );
  bot.api.config.use(async (_previous, method, payload) => {
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
    if (method === "getFile") {
      const id = (payload as any).file_id;
      return {
        ok: true,
        result: {
          file_id: id,
          file_unique_id: id,
          file_path:
            id === "evil"
              ? "../secret"
              : id === "voice"
                ? "voice/note.ogg"
                : `photos/${id}.jpg`,
        },
      } as any;
    }
    sent.push({ method, payload });
    return { ok: true, result: { message_id: sent.length } } as any;
  });
  await bot.init();
  return {
    bot,
    assistant,
    db,
    state,
    inputs,
    ready,
    failed,
    calls,
    sent,
    replies: () =>
      sent
        .filter((item) => item.method === "sendMessage")
        .map((item) => item.payload.text),
  };
}

test("photo and voice preparation overlap a held response, with one delivery using the latest voice intent", async () => {
  const f = await fixture({ voice: true });
  const entered = deferred(),
    release = deferred();
  f.state.respond = async () => {
    if (f.state.responds > 1) return { reply: "" };
    entered.resolve();
    await release.promise;
    return {
      reply: "Combined answer",
      runId,
      inputRevision: f.state.revision,
      voiceReply: true,
    };
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/audio/transcriptions"))
      return Response.json({ text: "Use the photo and explain aloud" });
    if (url.endsWith("/audio/speech"))
      return new Response(new Uint8Array([1, 2, 3]));
    return new Response(
      url.includes("/voice/") ? new Uint8Array([4, 5, 6]) : jpeg,
    );
  }) as typeof fetch;
  const first = f.bot.handleUpdate(
    update(1, { text: "Read the next attachment" }),
  );
  try {
    await bounded(entered.promise);
    await bounded(
      Promise.all([
        f.bot.handleUpdate(update(2, photo())),
        f.bot.handleUpdate(update(3, voice)),
      ]),
    );
    assert.equal(f.ready.length, 3);
    assert.equal(f.inputs[1]!.metadata.preparing, true);
    assert.equal(f.inputs[2]!.metadata.voiceReply, true);
    assert.equal(
      f.ready.find((item) => item.images)?.images?.[0]?.data,
      Buffer.from(jpeg).toString("base64"),
    );
    assert(
      f.ready.some(
        (item) => item.message === "Use the photo and explain aloud",
      ),
    );
    assert.deepEqual(f.replies(), []);
    release.resolve();
    await bounded(first);
    assert.deepEqual(f.replies(), ["Combined answer"]);
    assert.deepEqual(f.state.finished, [runId]);
    assert.equal(
      f.sent.filter((item) => item.method === "sendVoice").length,
      1,
    );
    assert.doesNotMatch(
      JSON.stringify(f.calls),
      /private-image-bytes|\/9hwcml2YXRl/,
    );
  } finally {
    release.resolve();
    await first;
    globalThis.fetch = oldFetch;
  }
});

test("preparation is bounded and controls and text bypass held downloads without steering control records", async () => {
  const f = await fixture();
  const twoDownloads = deferred(),
    release = deferred(),
    threeRecords = deferred();
  let downloads = 0,
    active = 0,
    maximum = 0;
  f.state.respond = async () => ({ reply: "" });
  f.state.onRecord = () => {
    if (f.inputs.length === 3) threeRecords.resolve();
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    downloads++;
    maximum = Math.max(maximum, ++active);
    if (downloads === 2) twoDownloads.resolve();
    await release.promise;
    active--;
    return new Response(jpeg);
  }) as typeof fetch;
  const photos = [1, 2, 3].map((id) =>
    f.bot.handleUpdate(update(id, photo(`photo_${id}`))),
  );
  try {
    await bounded(Promise.all([twoDownloads.promise, threeRecords.promise]));
    assert.equal(downloads, 2);
    await bounded(
      f.bot.handleUpdate(update(4, { text: "Keep the answer brief" })),
    );
    await bounded(f.bot.handleUpdate(update(5, { text: "/cancel" })));
    await bounded(f.bot.handleUpdate(update(6, { text: `/approve ${runId}` })));
    await bounded(f.bot.handleUpdate(update(7, { text: "/voice" })));
    assert.equal(f.inputs.length, 4);
    assert.equal(f.ready.length, 1);
    assert.equal(f.ready[0]!.message, "Keep the answer brief");
    assert.deepEqual(f.state.controls, ["cancel", "approve"]);
    release.resolve();
    await bounded(Promise.all(photos));
    assert.equal(downloads, 3);
    assert.equal(maximum, 2);
    await f.bot.handleUpdate(update(1, photo()));
    assert.equal(
      f.inputs.length,
      4,
      "Telegram replay must not create another input",
    );
  } finally {
    release.resolve();
    await Promise.all(photos);
    globalThis.fetch = oldFetch;
  }
});

test("unsupported, missing, unavailable and failed attachment preparation terminalizes every input", async () => {
  const f = await fixture();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("Download unavailable");
  }) as typeof fetch;
  try {
    for (const [index, message] of [
      {
        document: {
          file_id: "doc",
          file_unique_id: "doc",
          mime_type: "application/msword",
          file_name: "notes.doc",
        },
      },
      voice,
      { sticker: { file_id: "sticker", file_unique_id: "sticker" } },
      {
        photo: [
          {
            file_id: "oversized",
            file_unique_id: "oversized",
            width: 1,
            height: 1,
            file_size: 11 * 1024 * 1024,
          },
        ],
      },
      photo("evil"),
      photo("missing"),
    ].entries())
      await f.bot.handleUpdate(update(index + 1, message));
    assert.equal(f.inputs.length, 6);
    assert.deepEqual(
      f.failed,
      f.inputs.map((input) => input.id),
    );
    assert.equal(f.ready.length, 0);
    assert.equal(f.state.responds, 0);
    assert.equal(f.replies().length, 6);
    assert(f.inputs.every((input) => input.metadata.preparing));
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("a finalized response and progress superseded before delivery are not sent", async () => {
  const f = await fixture();
  const finalized = deferred(),
    release = deferred();
  f.state.currentRun = false;
  f.state.respond = async (progress) => {
    if (f.state.responds > 1)
      return { reply: "New answer", runId, inputRevision: f.state.revision };
    const reply = {
      reply: "Old answer",
      runId,
      inputRevision: f.state.revision,
    };
    await progress?.("Old progress", runId);
    finalized.resolve();
    await release.promise;
    return reply;
  };
  const first = f.bot.handleUpdate(update(1, { text: "Original request" }));
  try {
    await bounded(finalized.promise);
    await bounded(f.bot.handleUpdate(update(2, { text: "Correction" })));
    release.resolve();
    await bounded(first);
    assert.deepEqual(f.replies(), ["New answer"]);
  } finally {
    release.resolve();
    await first;
  }
});

for (const failSpeech of [false, true])
  test(`new input during speech ${failSpeech ? "failure" : "generation"} suppresses stale audio and fallback`, async () => {
    const f = await fixture({ voice: true });
    const speechStarted = deferred(),
      release = deferred();
    f.state.respond = async () => ({
      reply: f.state.responds === 1 ? "First answer" : "Updated answer",
      runId,
      inputRevision: f.state.revision,
      voiceReply: f.state.responds === 1,
    });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/audio/transcriptions"))
        return Response.json({ text: "Answer aloud" });
      if (url.endsWith("/audio/speech")) {
        speechStarted.resolve();
        await release.promise;
        if (failSpeech) throw new Error("Speech unavailable");
      }
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    const first = f.bot.handleUpdate(update(1, voice));
    try {
      await bounded(speechStarted.promise);
      await bounded(
        f.bot.handleUpdate(update(2, { text: "Actually, just text" })),
      );
      release.resolve();
      await bounded(first);
      assert.deepEqual(f.replies(), ["First answer", "Updated answer"]);
      assert.equal(
        f.sent.filter((item) => item.method === "sendVoice").length,
        0,
      );
    } finally {
      release.resolve();
      await first;
      globalThis.fetch = oldFetch;
    }
  });

test("calendar preview checks freshness after reading pending approvals", async () => {
  const f = await fixture();
  let current = true;
  f.state.query = async (sql) => {
    if (!sql.startsWith("SELECT id,payload FROM approvals")) return;
    current = false;
    return [
      {
        id: randomUUID(),
        payload: {
          draft: {
            title: "Review",
            start: "2026-09-20T15:00:00+08:00",
            end: "2026-09-20T16:00:00+08:00",
          },
        },
      },
    ];
  };
  await sendCalendarApprovals(f.bot, f.db, "123", async () => current);
  assert.deepEqual(f.replies(), []);
  assert.equal(
    f.calls.filter((call) => call.sql.startsWith("UPDATE approvals")).length,
    0,
  );
});

test("absorbed handlers cannot deliver calendar previews even when the delivery guard allows unversioned output", async () => {
  const f = await fixture();
  f.state.respond = async () => ({ reply: "" });
  f.assistant.isCurrentDelivery = async () => true;
  f.state.query = async (sql) =>
    sql.startsWith("SELECT id,payload FROM approvals")
      ? [
          {
            id: randomUUID(),
            payload: {
              draft: {
                title: "Review",
                start: "2026-09-20T15:00:00+08:00",
                end: "2026-09-20T16:00:00+08:00",
              },
            },
          },
        ]
      : undefined;
  await f.bot.handleUpdate(update(1, { text: "Already absorbed" }));
  assert.deepEqual(f.replies(), []);
});

test("unreadable PDFs and failed transcription leave no pending input", async () => {
  const f = await fixture({ voice: true });
  // A valid one-page PDF with no text content models a scanned document.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/audio/transcriptions"))
      throw new Error("Transcription unavailable");
    return new Response(
      String(input).includes("/voice/")
        ? new Uint8Array([1, 2, 3])
        : Buffer.from(pdf),
    );
  }) as typeof fetch;
  try {
    await f.bot.handleUpdate(
      update(1, {
        document: {
          file_id: "scanned",
          file_unique_id: "scanned",
          file_name: "scan.pdf",
          mime_type: "application/pdf",
        },
      }),
    );
    await f.bot.handleUpdate(update(2, voice));
    assert.deepEqual(
      f.failed,
      f.inputs.map((input) => input.id),
    );
    assert.equal(f.state.responds, 0);
    assert.equal(f.ready.length, 0);
    assert.match(f.replies()[0]!, /no selectable text/);
    assert.match(f.replies()[1]!, /could not finish/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

async function realFixture(
  run: Agent["run"],
  options: {
    voiceReplies?: boolean;
    onQuery?: (sql: string, values: unknown[]) => void;
  } = {},
) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { readFile, readdir } = await import("node:fs/promises");
  const { Assistant } = await import("../src/agent.js");
  const { JobTools } = await import("../src/tools.js");
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    await pg.exec(
      await readFile(new URL(`../db/${file}`, import.meta.url), "utf8"),
    );
  }
  const db: Database = {
    query: async (sql, values = []) => {
      const result = await pg.query(sql, values);
      options.onQuery?.(sql, values);
      return result;
    },
  };
  const assistant = new Assistant(
    db,
    { run },
    new JobTools(db, { call: async () => ({}) }),
  );
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://x:x@localhost/x",
      TELEGRAM_BOT_TOKEN: "123:long-test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      OPENAI_API_KEY: "test-voice-key",
      VOICE_REPLIES: options.voiceReplies ? "true" : "false",
    }),
    assistant,
    db,
  );
  const sent: { method: string; payload: any }[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
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
    if (method === "getFile") {
      const id = (payload as any).file_id;
      return {
        ok: true,
        result: {
          file_id: id,
          file_unique_id: id,
          file_path: id === "voice" ? "voice/note.ogg" : "photos/photo.jpg",
        },
      } as any;
    }
    sent.push({ method, payload });
    return { ok: true, result: { message_id: sent.length } } as any;
  });
  await bot.init();
  return {
    pg,
    db,
    assistant,
    bot,
    sent,
    replies: () =>
      sent
        .filter((item) => item.method === "sendMessage")
        .map((item) => item.payload.text),
  };
}

test("real Assistant consumes prepared photo and voice followups in one Telegram run", async () => {
  const entered = deferred(),
    release = deferred(),
    prepared = deferred();
  let ready = 0,
    modelRuns = 0;
  const adopted: string[] = [];
  const f = await realFixture(
    async (request) => {
      modelRuns++;
      const initial = request.message;
      entered.resolve();
      await release.promise;
      const followups = (await request.steer?.()) ?? [];
      adopted.push(...followups.map((input) => input.message));
      assert.equal(request.images?.length, 1);
      return {
        reply: "Read the photo and voice together",
        stopReason: "answer",
        history: [
          ...request.history,
          { role: "user", content: initial },
          ...followups.map((input) => ({
            role: "user" as const,
            content: input.message,
          })),
          { role: "assistant", content: "Read the photo and voice together" },
        ],
      };
    },
    {
      onQuery: (sql, values) => {
        if (
          sql.startsWith("INSERT INTO events") &&
          values[2] === "telegram.input_ready" &&
          ++ready === 3
        )
          prepared.resolve();
      },
    },
  );
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input) =>
    String(input).endsWith("/audio/transcriptions")
      ? Response.json({ text: "Then explain the image briefly" })
      : new Response(jpeg)) as typeof fetch;
  const first = f.bot.handleUpdate(
    update(1, { text: "Use the next attachments" }),
  );
  let second: Promise<void> | undefined, third: Promise<void> | undefined;
  try {
    await bounded(entered.promise);
    second = f.bot.handleUpdate(update(2, photo()));
    third = f.bot.handleUpdate(update(3, voice));
    await bounded(prepared.promise);
    assert.equal(
      (
        await f.db.query(
          "SELECT id FROM conversation_inputs WHERE preparation='ready'",
        )
      ).rows.length,
      3,
    );
    release.resolve();
    await bounded(Promise.all([first, second, third]));
    assert.equal(modelRuns, 1);
    assert.equal(adopted.length, 2);
    assert.match(adopted[0]!, /Attached image/);
    assert.equal(adopted[1], "Then explain the image briefly");
    assert.deepEqual(f.replies(), ["Read the photo and voice together"]);
    const rows = (
      await f.db.query(
        "SELECT state,run_id FROM conversation_inputs ORDER BY ordinal",
      )
    ).rows;
    assert(rows.every((row) => row.state === "completed"));
    assert.equal(new Set(rows.map((row) => row.run_id)).size, 1);
    assert.doesNotMatch(
      JSON.stringify(
        (await f.db.query("SELECT payload FROM message_contents")).rows,
      ),
      /private-image-bytes/,
    );
  } finally {
    release.resolve();
    f.assistant.shutdown();
    await Promise.allSettled([first, second, third].filter(Boolean));
    globalThis.fetch = oldFetch;
    await f.pg.close();
  }
});

test("cancel after model completion suppresses deferred speech and late progress, then releases delivery ownership", async () => {
  const speechStarted = deferred(),
    releaseSpeech = deferred();
  let progress: ((text: string) => Promise<void>) | undefined;
  let modelRuns = 0,
    finished = 0;
  const f = await realFixture(
    async (request) => {
      modelRuns++;
      progress = request.progress;
      return {
        reply: "Answer aloud",
        stopReason: "answer",
        history: [
          ...request.history,
          { role: "user", content: request.message },
          { role: "assistant", content: "Answer aloud" },
        ],
      };
    },
    { voiceReplies: true },
  );
  const finishDelivery = f.assistant.finishDelivery.bind(f.assistant);
  f.assistant.finishDelivery = (user, run) => {
    finished++;
    return finishDelivery(user, run);
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/audio/transcriptions"))
      return Response.json({ text: "Answer aloud" });
    if (url.endsWith("/audio/speech")) {
      speechStarted.resolve();
      await releaseSpeech.promise;
    }
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;
  const first = f.bot.handleUpdate(update(1, voice));
  try {
    await bounded(speechStarted.promise);
    assert.deepEqual(f.replies(), ["Answer aloud"]);
    await bounded(f.bot.handleUpdate(update(2, { text: "/cancel" })));
    assert.match(f.replies()[1]!, /Cancelled/);
    await progress?.("Stale progress after cancellation");
    releaseSpeech.resolve();
    await bounded(first);
    await progress?.("Stale progress after delivery cleanup");
    await f.bot.handleUpdate(update(1, voice));
    assert.equal(
      modelRuns,
      1,
      "Replayed ordinary input must not start another model call",
    );
    assert.equal(f.replies().length, 2);
    assert.equal(
      f.sent.filter((item) => item.method === "sendVoice").length,
      0,
    );
    assert.equal(finished, 1);
    assert.equal(
      (await f.db.query("SELECT id FROM conversation_inputs")).rows.length,
      1,
    );
    assert.equal((await f.assistant.cancel("123")).cancelled, false);
  } finally {
    releaseSpeech.resolve();
    f.assistant.shutdown();
    await first;
    globalThis.fetch = oldFetch;
    await f.pg.close();
  }
});

test("reset waits for earlier foreground commits and removes their conversation context without steering", async () => {
  const entered = deferred(),
    release = deferred(),
    resetStarted = deferred();
  const historySizes: number[] = [];
  const f = await realFixture(async (request) => {
    historySizes.push(request.history.length);
    entered.resolve();
    await release.promise;
    return {
      reply: "Saved answer",
      stopReason: "answer",
      history: [
        ...request.history,
        { role: "user", content: request.message },
        { role: "assistant", content: "Saved answer" },
      ],
    };
  });
  const resetConversation = f.assistant.resetConversation.bind(f.assistant);
  f.assistant.resetConversation = (user) => {
    resetStarted.resolve();
    return resetConversation(user);
  };
  const first = f.bot.handleUpdate(
    update(1, { text: "Work before resetting" }),
  );
  let reset: Promise<void> | undefined;
  let resetFinished = false;
  try {
    await bounded(entered.promise);
    reset = f.bot.handleUpdate(update(2, { text: "/reset" })).then(() => {
      resetFinished = true;
    });
    await bounded(resetStarted.promise);
    assert.equal(resetFinished, false);
    await bounded(f.bot.handleUpdate(update(3, { text: "/voice" })));
    assert.match(f.replies()[0]!, /Voice transcription/);
    release.resolve();
    await bounded(Promise.all([first, reset]));
    assert.equal(
      (await f.db.query("SELECT user_id FROM conversations")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT id FROM conversation_contexts")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT id FROM conversation_inputs")).rows.length,
      1,
    );
    assert(
      f.replies().some((reply) => reply.startsWith("Conversation reset.")),
    );
    await f.bot.handleUpdate(update(4, { text: "Begin a fresh conversation" }));
    assert.deepEqual(historySizes, [0, 0]);
  } finally {
    release.resolve();
    f.assistant.shutdown();
    await Promise.allSettled([first, reset].filter(Boolean));
    await f.pg.close();
  }
});
