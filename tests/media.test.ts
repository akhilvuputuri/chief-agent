import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Assistant } from "../src/agent.js";
import { CustomAgent, omitImages } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import type { Database } from "../src/db.js";
import type { ModelAdapter } from "../src/model.js";
import type { ImageAttachment } from "../src/protocol.js";
import { imageMessage } from "../src/attachments.js";
import { mediaCacheKey, reusable, sha256 } from "../src/media.js";
const text = (content: string) => ({
  message: { role: "assistant" as const, content },
});
const call = (name: string, args: unknown) => ({
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
const isChild = (input: any) =>
  String(input.messages[0]?.content).includes("media-processing specialist");
const observation = (input: any) =>
  JSON.parse(
    String(input.messages.findLast((m: any) => m.role === "tool")?.content),
  );
const assignment = (input: any) => {
  const content = input.messages.find((m: any) => m.role === "user").content;
  return JSON.parse(Array.isArray(content) ? content[0].text : content);
};
/** True when the current turn has not dispatched a tool yet (history may hold older tool messages). */
const fresh = (input: any) =>
  input.messages.filter((m: any) => m.role !== "system").at(-1)?.role ===
  "user";
const photoBytes = Buffer.from("\xff\xd8fake-jpeg-street-sign", "latin1");
function image(): ImageAttachment {
  return {
    id: randomUUID(),
    name: "photo.jpg",
    mimeType: "image/jpeg",
    bytes: photoBytes.length,
    data: photoBytes.toString("base64"),
    sha256: sha256(photoBytes),
  };
}
async function fixture(model: ModelAdapter, media?: ModelAdapter) {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner'),('other')");
  const assistant = new Assistant(
    db,
    new CustomAgent(model, media ? { media } : {}),
    new JobTools(db, { call: async () => ({ content: "unused" }) }),
    { web: true },
  );
  return { pg, db, assistant };
}
const imageReport = (targetId: string) => ({
  targets: [
    {
      targetId,
      kind: "image",
      status: "complete",
      summary: "A street sign reading Orchard Road.",
      facts: [
        {
          text: "Sign text: Orchard Road",
          reference: "centre of image",
          confidence: "high",
        },
      ],
      quotes: [],
      omissions: "",
      uncertainty: "Smaller text below the sign is blurred.",
    },
  ],
});

test("images reach only the media specialist; the coordinator gets compact facts and a stored extraction", async () => {
  let parentCalls = 0,
    childCalls = 0,
    attachmentId = "";
  const photo = image();
  const note = imageMessage("What does this sign say?", [photo]);
  const f = await fixture({
    model: "main-model",
    generate: async (input) => {
      const serialized = JSON.stringify(input.messages);
      if (isChild(input)) {
        childCalls++;
        assert.deepEqual(input.tools.map((t) => t.name).sort(), [
          "finish_turn",
          "media_report",
          "source_read",
        ]);
        const user = input.messages.find((m: any) => m.role === "user")!;
        assert.ok(Array.isArray(user.content));
        assert.match(
          (user.content as any)[1].image_url.url,
          /^data:image\/jpeg;base64,/,
        );
        const data = JSON.parse((user.content as any)[0].text);
        assert.equal(data.targets[0].targetId, attachmentId);
        assert.equal(data.targets[0].kind, "image");
        return call("media_report", imageReport(attachmentId));
      }
      parentCalls++;
      // The coordinator never receives image bytes in any iteration.
      assert.doesNotMatch(serialized, /data:image|fake-jpeg/);
      if (parentCalls === 1) {
        attachmentId = /attachmentId=([0-9a-f-]{36})/.exec(note)![1]!;
        return call("media_delegate", {
          objective: "What does this sign say?",
          context: "",
          attachmentIds: [attachmentId],
          sourceIds: [],
        });
      }
      const o = observation(input).result;
      assert.equal(o.status, "reported");
      assert.equal(o.cacheHit, false);
      assert.equal(o.targets[0].targetId, attachmentId);
      assert.equal(o.targets[0].facts[0].text, "Sign text: Orchard Road");
      assert.match(o.targets[0].extractionSourceId, /^[0-9a-f-]{36}$/);
      assert.equal(o.targets[0].sha256, photo.sha256);
      return text("The sign says Orchard Road.");
    },
  });
  try {
    const reply = await f.assistant.respond("owner", note, undefined, [photo]);
    assert.equal(reply, "The sign says Orchard Road.");
    assert.equal(childCalls, 1);
    assert.equal(parentCalls, 2);
    // Traces, checkpoints and sources never retain the image bytes.
    const dump = JSON.stringify(
      (
        await f.db.query(
          "SELECT (SELECT json_agg(e) FROM events e) AS events,(SELECT json_agg(r.messages) FROM runtime_runs r) AS runs,(SELECT json_agg(s) FROM research_sources s) AS sources,(SELECT json_agg(c.history) FROM conversations c) AS conversations,(SELECT json_agg(x) FROM runtime_calls x) AS calls",
        )
      ).rows[0],
    );
    assert.doesNotMatch(dump, /fake-jpeg|data:image\/jpeg;base64,\/9j/);
    assert.match(dump, /image omitted from trace/);
    const source = (await f.db.query("SELECT * FROM research_sources")).rows[0];
    assert.equal(source.user_id, "owner");
    assert.equal(source.url, `telegram:image/${photo.sha256}/photo.jpg`);
    assert.match(source.content, /Sign text: Orchard Road/);
    assert.match(source.content, /image bytes were not retained/);
    const started = (
      await f.db.query(
        "SELECT data FROM events WHERE type='research.child_started'",
      )
    ).rows[0].data;
    assert.equal(started.role, "media");
    assert.equal(started.profile.attachments[0].sha256, photo.sha256);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM events WHERE type='media.processed' AND data->>'status'='reported'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await f.pg.close();
  }
});

test("identical content and question reuse the stored result; stale attachment IDs and foreign sources are rejected", async () => {
  let childCalls = 0;
  const first = image(),
    second = { ...image(), sha256: first.sha256 };
  const f = await fixture({
    generate: async (input) => {
      if (isChild(input)) {
        childCalls++;
        return call(
          "media_report",
          imageReport(assignment(input).targets[0].targetId),
        );
      }
      const user = String(
        input.messages.findLast((m: any) => m.role === "user")!.content,
      );
      const id = /attachmentId=([0-9a-f-]{36})/.exec(user)?.[1];
      if (fresh(input) && id)
        return call("media_delegate", {
          objective: "What does this sign say?",
          context: "",
          attachmentIds: [id],
          sourceIds: [],
        });
      if (fresh(input) && user.startsWith("stale"))
        return call("media_delegate", {
          objective: "Describe",
          context: "",
          attachmentIds: [first.id],
          sourceIds: [],
        });
      if (fresh(input) && user.startsWith("foreign"))
        return call("media_delegate", {
          objective: "Summarise",
          context: "",
          attachmentIds: [],
          sourceIds: ["44444444-4444-4444-8444-444444444444"],
        });
      const o = observation(input);
      return text(
        o.error
          ? "error:" + o.error.message
          : `cacheHit=${o.result.cacheHit} target=${o.result.targets[0].targetId}`,
      );
    },
  });
  try {
    await f.db.query(
      "INSERT INTO research_sources(id,user_id,url,content) VALUES('44444444-4444-4444-8444-444444444444','other','https://example.com/private','Private text')",
    );
    const one = await f.assistant.respond(
      "owner",
      imageMessage("What does this sign say?", [first]),
      undefined,
      [first],
    );
    assert.equal(one, `cacheHit=false target=${first.id}`);
    const two = await f.assistant.respond(
      "owner",
      imageMessage("What does this sign say?", [second]),
      undefined,
      [second],
    );
    assert.equal(two, `cacheHit=true target=${second.id}`);
    assert.equal(childCalls, 1);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM events WHERE type='media.cache_hit'",
        )
      ).rows[0].n,
      1,
    );
    const stale = await f.assistant.respond("owner", "stale request");
    assert.match(stale, /attachment unavailable.*resend/);
    const foreign = await f.assistant.respond("owner", "foreign request");
    assert.match(foreign, /stored source not found in owner scope/);
    assert.equal(childCalls, 1);
    assert.notEqual(
      mediaCacheKey("What does this sign say?", [first], []),
      mediaCacheKey("Is it red?", [first], []),
    );
    assert.notEqual(
      mediaCacheKey("q", [first], [], "main-model"),
      mediaCacheKey("q", [first], [], "vision-model"),
    );
    assert.equal(
      reusable([{ status: "complete" }, { status: "partial" }]),
      true,
    );
    assert.equal(
      reusable([{ status: "complete" }, { status: "blocked" }]),
      false,
    );
    assert.equal(reusable([]), false);
  } finally {
    await f.pg.close();
  }
});

test("document questions require the specialist to read the stored text and quote it exactly; writes are denied", async () => {
  let childCalls = 0;
  const sourceId = randomUUID(),
    otherSourceId = randomUUID();
  const f = await fixture({
    generate: async (input) => {
      if (isChild(input)) {
        childCalls++;
        const data = assignment(input);
        assert.equal(data.targets[0].kind, "document");
        assert.equal(data.targets[0].sourceId, sourceId);
        const report = (quote: string, extra: object = {}) => ({
          targets: [
            {
              targetId: sourceId,
              kind: "document",
              status: "complete",
              summary: "The notice period is two months.",
              facts: [
                {
                  text: "Notice period: two months",
                  reference: "page 2",
                  confidence: "high",
                },
              ],
              quotes: [{ sourceId, quote }],
              omissions: "",
              uncertainty: "",
              ...extra,
            },
          ],
        });
        // Six child model calls is the specialist's own limit; every step below is one call.
        if (childCalls === 1)
          return call("memory_set", { key: "notice", value: "two months" });
        if (childCalls === 2) {
          assert.ok(observation(input).error);
          // A child cannot delegate again: the operation is outside its tool set.
          return call("media_delegate", {
            objective: "nested",
            context: "",
            attachmentIds: [],
            sourceIds: [sourceId],
          });
        }
        if (childCalls === 3) {
          assert.ok(observation(input).error);
          // Quoting before any read is rejected: the source was not read by this child.
          return call("media_report", report("two (2) months"));
        }
        if (childCalls === 4) {
          assert.match(
            observation(input).error.message,
            /read by this specialist/,
          );
          return call("source_read", { id: sourceId, offset: 0 });
        }
        if (childCalls === 5) {
          assert.match(observation(input).result.content, /two \(2\) months/);
          // Reads outside the assignment are refused even though the source belongs to the owner.
          return call("source_read", { id: otherSourceId, offset: 0 });
        }
        assert.match(
          observation(input).error.message,
          /read outside this specialist's assignment/,
        );
        return call("media_report", report("two (2) months"));
      }
      if (fresh(input))
        return call("media_delegate", {
          objective: "What is the notice period?",
          context: "Employment contract sent by the user",
          attachmentIds: [],
          sourceIds: [sourceId],
        });
      const o = observation(input).result;
      assert.equal(o.status, "reported");
      assert.equal(o.targets[0].quotes[0].quote, "two (2) months");
      assert.equal(o.targets[0].extractionSourceId, undefined);
      assert.doesNotMatch(JSON.stringify(input.messages), /Clause 12/);
      return text("Two months, per page 2.");
    },
  });
  try {
    await f.db.query(
      "INSERT INTO research_sources(id,user_id,url,content) VALUES($1,'owner','telegram:document/u1/contract.pdf',$2)",
      [
        sourceId,
        "--- Page 1 ---\nEmployment agreement. Clause 12 governs termination.\n\n--- Page 2 ---\nEither party may terminate with two (2) months written notice.",
      ],
    );
    await f.db.query(
      "INSERT INTO research_sources(id,user_id,url,content) VALUES($1,'owner','https://example.com/other','Unrelated owner page')",
      [otherSourceId],
    );
    assert.equal(
      await f.assistant.respond("owner", "What is the notice period?"),
      "Two months, per page 2.",
    );
    assert.equal(childCalls, 6);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM events WHERE type='research.child_started'",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM memories")).rows[0].n,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM research_sources")).rows[0]
        .n,
      2,
    );
  } finally {
    await f.pg.close();
  }
});

test("blocked readings are neither stored nor reused, so resending the same photo runs the specialist again", async () => {
  let childCalls = 0;
  const first = image(),
    second = image();
  const blocked = (targetId: string) => ({
    targets: [
      {
        targetId,
        kind: "image",
        status: "blocked",
        summary: "Too dark to read.",
        facts: [],
        quotes: [],
        omissions: "Entire image unreadable.",
        uncertainty: "",
      },
    ],
  });
  const f = await fixture({
    generate: async (input) => {
      if (isChild(input)) {
        childCalls++;
        const id = assignment(input).targets[0].targetId;
        return call(
          "media_report",
          childCalls === 1 ? blocked(id) : imageReport(id),
        );
      }
      const user = String(
        input.messages.findLast((m: any) => m.role === "user")!.content,
      );
      const id = /attachmentId=([0-9a-f-]{36})/.exec(user)?.[1];
      if (fresh(input) && id)
        return call("media_delegate", {
          objective: "Read the label",
          context: "",
          attachmentIds: [id],
          sourceIds: [],
        });
      const o = observation(input).result;
      return text(
        `cacheHit=${o.cacheHit} status=${o.targets[0].status} stored=${o.targets[0].extractionSourceId ?? "none"}`,
      );
    },
  });
  try {
    assert.equal(
      await f.assistant.respond("owner", imageMessage("", [first]), undefined, [
        first,
      ]),
      "cacheHit=false status=blocked stored=none",
    );
    assert.equal(
      await f.assistant.respond(
        "owner",
        imageMessage("", [second]),
        undefined,
        [second],
      ),
      "cacheHit=false status=complete stored=" +
        (await f.db.query("SELECT id FROM research_sources")).rows[0]!.id,
    );
    assert.equal(childCalls, 2);
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT (data->>'reusable')::boolean AS reusable FROM events WHERE type='media.processed' ORDER BY id",
        )
      ).rows.map((r) => r.reusable),
      [false, true],
    );
  } finally {
    await f.pg.close();
  }
});

test("a configured media model handles only specialist calls, and incomplete processing is reported as such", async () => {
  const photo = image();
  const seen: string[] = [];
  const main: ModelAdapter = {
    model: "main-model",
    generate: async (input) => {
      seen.push("main");
      if (fresh(input))
        return call("media_delegate", {
          objective: "Read the receipt total",
          context: "",
          attachmentIds: [photo.id],
          sourceIds: [],
        });
      const o = observation(input).result;
      assert.equal(o.status, "incomplete");
      assert.equal(o.targets[0].status, "blocked");
      assert.equal(o.targets[0].kind, "image");
      assert.deepEqual(o.targets[0].facts, []);
      assert.deepEqual(o.targets[0].quotes, []);
      assert.match(o.targets[0].omissions, /stopped before/);
      assert.match(o.notice, /resends/);
      return text("I could not read the receipt; please resend it.");
    },
  };
  const media: ModelAdapter = {
    model: "vision-model",
    generate: async () => {
      seen.push("media");
      return call("finish_turn", {
        reason: "answer",
        reply: "The image is too blurred to read.",
      });
    },
  };
  const f = await fixture(main, media);
  try {
    const reply = await f.assistant.respond(
      "owner",
      imageMessage("", [photo]),
      undefined,
      [photo],
    );
    assert.equal(reply, "I could not read the receipt; please resend it.");
    assert.deepEqual(seen, ["main", "media", "main"]);
    const models = (
      await f.db.query(
        "SELECT data->>'model' AS model FROM events WHERE type='model.started' ORDER BY id",
      )
    ).rows.map((r) => r.model);
    assert.deepEqual(models, ["main-model", "vision-model", "main-model"]);
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM research_sources")).rows[0]
        .n,
      0,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT data->>'status' AS s FROM events WHERE type='media.processed'",
        )
      ).rows[0].s,
      "incomplete",
    );
  } finally {
    await f.pg.close();
  }
});

test("omitImages replaces image data in traced model input and leaves text untouched", () => {
  const traced = omitImages([
    { role: "system", content: "rules" },
    {
      role: "user",
      content: [
        { type: "text", text: "question" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ]);
  assert.equal(traced[0]!.content, "rules");
  assert.deepEqual(traced[1]!.content, [
    { type: "text", text: "question" },
    {
      type: "image_url",
      image_url: { url: "[image omitted from trace: 26 characters]" },
    },
  ]);
});
