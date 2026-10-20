import test from "node:test";
import assert from "node:assert/strict";
import type { Api } from "grammy";
import type { Database } from "../src/db.js";
import { MediaOutbox } from "../src/media-outbox.js";
import { sendRunMedia } from "../src/telegram-media.js";

const run = "00000000-0000-4000-8000-000000000001";
const db: Database = {
  // The run family: just this run.
  query: async () => ({ rows: [{ id: run }] }),
};
function api(fail?: string) {
  const sent: { method: string; chat: unknown; options: any }[] = [];
  const send =
    (method: string) => async (chat: unknown, _file: unknown, options: any) => {
      if (method === fail) throw new Error("Bad Request");
      sent.push({ method, chat, options });
      return {};
    };
  return {
    sent,
    api: {
      sendPhoto: send("sendPhoto"),
      sendAnimation: send("sendAnimation"),
    } as unknown as Api,
  };
}
function queue() {
  const media = new MediaOutbox();
  media.put(run, {
    kind: "photo",
    bytes: Buffer.from("png"),
    filename: "rain-radar.png",
    caption: "Map",
  });
  media.put(run, {
    kind: "animation",
    bytes: Buffer.from("gif"),
    filename: "rain-radar.gif",
    caption: "Loop",
  });
  return media;
}

test("queued pictures go to the owner in the reply's thread, in order, each on its own", async () => {
  const media = queue();
  const ok = api();
  assert.equal(
    await sendRunMedia(ok.api, db, media, "123", run, { message_thread_id: 7 }),
    2,
  );
  assert.deepEqual(
    ok.sent.map((s) => [
      s.method,
      s.chat,
      s.options.message_thread_id,
      s.options.caption,
    ]),
    [
      ["sendPhoto", "123", 7, "Map"],
      ["sendAnimation", "123", 7, "Loop"],
    ],
  );
  assert.deepEqual(media.take([run]), []);
  // A failed photo does not stop the animation after it.
  const failing = api("sendPhoto");
  assert.equal(await sendRunMedia(failing.api, db, queue(), "123", run, {}), 1);
  assert.deepEqual(
    failing.sent.map((s) => s.method),
    ["sendAnimation"],
  );
});

test("a withheld reply sends no pictures and leaves them queued", async () => {
  const media = queue();
  const quiet = api();
  assert.equal(
    await sendRunMedia(quiet.api, db, media, "123", run, {}, async () => false),
    0,
  );
  assert.deepEqual(quiet.sent, []);
  assert.equal(media.take([run]).length, 2);
});
