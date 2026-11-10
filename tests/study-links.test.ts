import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { readerServer } from "./helpers/reader-mock.js";
import { mcpReaderLink, type ReaderLink } from "../src/news.js";
import { JobTools } from "../src/tools.js";
import { McpFailure } from "../src/mcp-errors.js";
import type { FeedFetcher } from "../src/news-feed.js";
import {
  StudyLinks,
  StudyStore,
  linkChoiceButtons,
  settleUncertainStudyWrites,
  topicFilter,
  type StudyLinksDeps,
} from "../src/study-links.js";
import { dedupeKey, linkUrl } from "../src/link-classifier.js";
import type { LinkJudge, LinkJudgeResult } from "../src/jev.js";
import { readOperations } from "../src/execution.js";
import { STUDY_WRITE_OPERATIONS } from "../src/study-links-schema.js";
import { toolError, ToolValidationError } from "../src/tool-errors.js";
import { readLinkClassifierConfig } from "../src/jev.js";
import { pageMetadata } from "../src/link-classifier.js";

const config = readLinkClassifierConfig();

const page = (
  title = "Building agent architectures that hold up",
  description = "A practical walkthrough of tool-using agent architectures, orchestration and evaluation.",
  site = "Example Engineering",
) =>
  `<html><head><title>${title}</title>
   <meta property="og:site_name" content="${site}">
   <meta property="og:description" content="${description}">
   </head><body><article>${description}</article></body></html>`;

/** A judge that answers what the test intends, and records what it was asked. */
function judge(result: (input: any) => LinkJudgeResult) {
  const seen: any[] = [];
  const api: LinkJudge = {
    judge: async (input) => {
      seen.push(input);
      return result(input);
    },
  };
  return { api, seen };
}

const verdict = (
  route: "study" | "reader" | "both" | "unsure",
  overrides: Partial<Extract<LinkJudgeResult, { ok: true }>> = {},
): LinkJudgeResult => ({
  ok: true,
  route,
  confidence: 0.86,
  topic: "agent-platforms",
  kind: "technical",
  // Only a cue Jev actually read from the owner's words is explicit; the default is
  // "no cue", so nothing here saves to a cued place by accident.
  cue: "none",
  model: "typesafe/jev-1.13-20260917",
  ...overrides,
});

async function fixture(linkJudge: LinkJudge) {
  const pg = await migratedPGlite([
    "001_initial",
    "002_preparation",
    "003_skills",
    "004_daily",
    "005_work",
    "006_runtime",
    "030_mcp",
    "031_link_resolution",
    "036_study_links",
  ]);
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  // Keyed by the dedupe key, so a www or trailing-slash variant finds the same page
  // the way a real server's redirect would, while the URL itself stays as shared.
  const pages = new Map<string, string>();
  pages.set(dedupeKey("https://example.org/agents"), page());
  const fetcher: FeedFetcher = {
    get: async (url) => {
      const body = pages.get(url) ?? pages.get(dedupeKey(url));
      if (body === undefined) throw new Error("blocked");
      return { body, finalUrl: url };
    },
  };
  const reader = readerServer();
  const asked: { text: string; buttons: { text: string; data: string }[] }[] =
    [];
  const deps = (overrides: Partial<StudyLinksDeps> = {}): StudyLinksDeps => ({
    db,
    judge: linkJudge,
    config,
    fetcher,
    memory: { active: async () => [] } as any,
    reader: () => mcpReaderLink(reader.make(db)),
    ask: async (_user, message) => {
      asked.push({ text: message.text, buttons: message.buttons });
      return { messageId: 400 + asked.length };
    },
    ...overrides,
  });
  return {
    pg,
    db,
    pages,
    reader,
    asked,
    fetcher,
    links: (overrides: Partial<StudyLinksDeps> = {}) =>
      new StudyLinks(deps(overrides)),
    store: new StudyStore(db),
  };
}

/** The real tool dispatcher, so the host's own gate and turn record are what is tested. */
const jobTools = (db: Database, links: StudyLinks, mcp?: any) =>
  new JobTools(
    db,
    { call: async () => ({}) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    mcp,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    links,
  );

const studyCount = async (db: Database, user = "123") =>
  Number(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM study_resources WHERE user_id=$1",
        [user],
      )
    ).rows[0].n,
  );

test("the owner's study list is a durable, owner-scoped collection with duplicate detection", async () => {
  const f = await fixture(judge(() => verdict("study")).api);
  try {
    const store = f.store;
    const write = {
      url: linkUrl("https://example.org/agents?utm_source=x"),
      canonicalUrl: dedupeKey(
        linkUrl("https://example.org/agents?utm_source=x"),
      ),
      title: "Building agent architectures that hold up",
      source: "example.org",
      topic: "agent platforms",
      route: "study",
      reason: "Study material",
      confidence: 0.86,
      model: "typesafe/jev-1.13-20260917",
    };
    const first = await store.add("123", write);
    assert.equal(first.existing, false);
    assert.equal(first.entry.status, "to_study");
    assert.deepEqual(first.entry.tags, []);
    assert.equal(first.entry.url, write.url);
    // A tracking-parameter variant is the same link.
    const duplicate = await store.add("123", {
      ...write,
      url: "https://www.example.org/agents/?ref=newsletter",
    });
    assert.equal(duplicate.existing, true);
    assert.equal(duplicate.entry.id, first.entry.id);
    assert.equal(await studyCount(f.db), 1);
    // Owner scope: another owner's identical link is a separate entry.
    await f.store.add("456", write);
    assert.equal(await studyCount(f.db, "456"), 1);
    assert.equal(await studyCount(f.db), 1);
    assert.equal(await f.store.find("456", first.entry.id), undefined);
    // Another owner cannot remove this entry.
    assert.equal(await f.store.remove("456", first.entry.id), undefined);
    assert.equal(await studyCount(f.db), 1);

    const updated = await store.update("123", first.entry.id, {
      status: "in_progress",
      notes: "Read §2 on tool routing",
      tags: ["agents", "evaluation"],
    });
    assert.equal(updated!.status, "in_progress");
    assert.equal(updated!.notes, "Read §2 on tool routing");
    assert.deepEqual(updated!.tags, ["agents", "evaluation"]);
    await store.add("123", {
      ...write,
      canonicalUrl: "https://example.org/voice",
      url: "https://example.org/voice",
      title: "Realtime voice round trip",
      topic: "voice and conversational AI",
      tags: ["voice"],
    });
    assert.deepEqual(
      (await store.list("123", { status: "in_progress" })).map((e) => e.id),
      [first.entry.id],
    );
    assert.equal(
      (await store.list("123", { topic: "voice and conversational ai" }))
        .length,
      1,
    );
    // A broad query resolves to every configured interest area, because "agent platforms"
    // and "developer tools" contain no "AI" to match.
    assert.deepEqual(topicFilter("AI", config.interests).labels, [
      "applied ai engineering",
      "agent platforms",
      "developer tools",
      "voice and conversational ai",
    ]);
    assert.equal(
      (
        await store.list("123", {
          topics: topicFilter("what's on my AI study list", config.interests)
            .labels,
        })
      ).length,
      2,
    );
    assert.deepEqual(topicFilter("applied ai", config.interests).labels, [
      "applied ai engineering",
    ]);
    // A query is not a LIKE pattern: %, _ and \ are literal characters.
    assert.equal((await store.list("123", { topic: "%" })).length, 0);
    assert.equal((await store.list("123", { topic: "_" })).length, 0);
    assert.deepEqual(await store.topics("123"), [
      "agent platforms",
      "voice and conversational AI",
    ]);
    assert.equal((await store.list("123", { tag: "VOICE" })).length, 1);
    assert.equal((await store.list("123", { tag: "missing" })).length, 0);
    assert.equal((await store.counts("123")).to_study, 1);
    assert.equal((await store.counts("123")).in_progress, 1);
    assert.deepEqual(
      (await store.remove("123", first.entry.id))?.title,
      "Building agent architectures that hold up",
    );
    assert.equal(await studyCount(f.db), 1);
  } finally {
    await f.pg.close();
  }
});

test("confident study material is saved from the page, with no Reader call", async () => {
  const seen: any[] = [];
  const f = await fixture({
    judge: async (input) => {
      seen.push(input);
      return verdict("study");
    },
  });
  try {
    const result: any = await f.links().save("123", {
      url: "https://example.org/agents?utm_source=feed",
      ownerMessage: "save this",
    });
    assert.equal(result.outcome, "study");
    assert.match(result.message, /Saved to your study list/);
    // Title, site and topic come from the page and the classification, never invented.
    assert.equal(
      (
        await f.store.findByCanonical(
          "123",
          dedupeKey(linkUrl("https://example.org/agents")),
        )
      )?.title,
      "Building agent architectures that hold up",
    );
    assert.equal(seen[0].site, "Example Engineering");
    assert.match(seen[0].excerpt, /agent architectures/);
    assert.deepEqual(seen[0].interests.slice(0, 4), config.interests);
    assert.equal(f.reader.calls.length, 0);
    // A repeat of the same link does not create a second entry.
    const again: any = await f.links().save("123", {
      url: "https://www.example.org/agents/?ref=x",
      ownerMessage: "save this",
    });
    assert.equal(again.outcome, "duplicate");
    assert.match(again.message, /Already on your study list/);
  } finally {
    await f.pg.close();
  }
});

test("one link URL keeps the owner's host and drops only tracking; the dedupe key normalises www", () => {
  // Reader is sent this exact value, so the host and path stay as served.
  assert.equal(
    linkUrl("https://www.example.org/agents/?utm_source=x&ref=y#top"),
    "https://www.example.org/agents/",
  );
  assert.equal(linkUrl("https://example.org/a"), "https://example.org/a");
  // The dedupe key catches the same link shared with or without www.
  assert.equal(
    dedupeKey("https://www.example.org/agents/"),
    "example.org/agents",
  );
  assert.equal(dedupeKey("https://example.org/agents"), "example.org/agents");
});

test("a www variant is the same entry and the stored link stays the one the owner shared", async () => {
  const f = await fixture(judge(() => verdict("study")).api);
  try {
    f.pages.set(dedupeKey("https://example.org/agents"), page());
    const links = f.links();
    const first: any = await links.save("123", {
      url: "https://www.example.org/agents?utm_source=x",
    });
    assert.equal(first.outcome, "study");
    assert.equal(
      (await f.store.list("123"))[0]!.url,
      "https://www.example.org/agents",
    );
    const variant: any = await links.save("123", {
      url: "https://example.org/agents/?ref=newsletter",
    });
    assert.equal(variant.outcome, "duplicate");
    assert.equal(await studyCount(f.db), 1);
  } finally {
    await f.pg.close();
  }
});

/** ReaderLink whose save records the row's key before the call, and can "crash" once. */
function windowReader(
  f: { db: Database },
  decisionId: () => string,
  base: ReaderLink,
) {
  const seen: { rowKey?: string; key: string }[] = [];
  const state = { crashed: false };
  const link: ReaderLink = {
    savedArticles: (user, signal) => base.savedArticles(user, signal),
    save: async (user, requestKey, url, signal) => {
      const row = (
        await f.db.query(
          "SELECT reader_request_key FROM link_decisions WHERE id=$1",
          [decisionId()],
        )
      ).rows[0];
      seen.push({
        rowKey: row?.reader_request_key ?? undefined,
        key: requestKey,
      });
      if (!state.crashed) {
        state.crashed = true;
        // The process died after the key was stored and before Reader was contacted.
        throw new Error("gateway restarted");
      }
      return base.save(user, requestKey, url, signal);
    },
  };
  return { link, seen };
}

test("the Reader key is on the decision row before the call, so a crash stays resumable", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.3 })).api,
  );
  try {
    let decisionId = "";
    const probe = windowReader(
      f,
      () => decisionId,
      mcpReaderLink(f.reader.make(f.db)),
    );
    const links = f.links({ reader: () => probe.link });
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    decisionId = saved.decisionId;
    const first = await links.confirm("123", decisionId, "reader", 401);
    assert.equal(first.settled, false);
    // The crash was before Chief persisted the request, so Reader cannot hold the link: a
    // definite non-send, never an uncertain one, and never "nothing was written" after a
    // partial write (there was none).
    assert.match(first.text, /nothing was saved/i);
    assert.doesNotMatch(first.text, /may already have it/);
    // The row already carried the key when Reader was first contacted.
    assert.equal(probe.seen.length, 1);
    assert.equal(probe.seen[0]!.rowKey, probe.seen[0]!.key);
    const before = await links.decisions.get("123", decisionId);
    assert.equal(before!.readerRequestKey, probe.seen[0]!.key);
    // The next tap resumes that same request; it does not create a second save.
    const second = await links.confirm("123", decisionId, "reader", 401);
    assert.equal(second.settled, true, second.text);
    assert.equal(probe.seen[1]!.key, probe.seen[0]!.key);
    assert.equal(f.reader.calls.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("an earlier pending Reader save is found through the URL Chief sent, not the resolved one", async () => {
  const f = await fixture(judge(() => verdict("reader", { topic: null })).api);
  try {
    const key = randomUUID();
    // Reader resolution rewrote payload.url to the publisher; source_payload keeps ours.
    await f.db.query(
      `INSERT INTO mcp_operations(user_id,connection,request_key,tool,binding,schema_hash,payload,source_payload)
       VALUES('123','reader',$1,'save_link','reader:v1','hash',$2::jsonb,$3::jsonb)`,
      [
        key,
        JSON.stringify({ url: "https://publisher.example.com/story" }),
        JSON.stringify({ url: "https://www.reddit.com/r/x/comments/1/link" }),
      ],
    );
    assert.equal(
      (
        await f.store.pendingReaderSave(
          "123",
          "https://reddit.com/r/x/comments/1/link?utm_source=x",
        )
      )?.requestKey,
      key,
    );
    const saved: any = await f.links().save("123", {
      url: "https://reddit.com/r/x/comments/1/link",
    });
    assert.match(saved.message, /already in progress/);
    assert.ok(saved.message.includes(key), saved.message);
    assert.equal(f.reader.calls.length, 0);
  } finally {
    await f.pg.close();
  }
});

test("the phone-friendly list carries each link and the topics in use", async () => {
  const f = await fixture(judge(() => verdict("study")).api);
  try {
    const links = f.links();
    await links.save("123", { url: "https://example.org/agents" });
    const listed: any = await links.list("123");
    assert.match(listed.text, /Study list — 1 shown/);
    assert.match(listed.text, /Building agent architectures that hold up/);
    assert.match(listed.text, /https:\/\/example\.org\/agents/);
    assert.deepEqual(listed.topics, ["agent platforms"]);
    const missing: any = await links.list("123", { topic: "quantum" });
    assert.match(missing.text, /No study entries match topic quantum/);
    assert.match(missing.text, /Topics on your list: agent platforms/);
  } finally {
    await f.pg.close();
  }
});

test("confident offline reading goes to Reader with one normalised URL and no study entry", async () => {
  const f = await fixture(
    judge(() => verdict("reader", { kind: "news", topic: null })).api,
  );
  try {
    const result: any = await f.links().save("123", {
      url: "https://example.org/agents?utm_source=feed",
      ownerMessage: "save this article to Reader for offline reading",
    });
    assert.equal(result.outcome, "reader");
    assert.match(result.message, /Saved to Reader/);
    assert.equal(f.reader.calls.length, 1);
    assert.equal(f.reader.calls[0]!.url, "https://example.org/agents");
    assert.equal(await studyCount(f.db), 0);
  } finally {
    await f.pg.close();
  }
});

test("the owner's explicit cue decides both directions and reaches the classifier", async () => {
  // The stub decides from the message it is given, the way Jev does: a cue that the host
  // dropped or the model paraphrased changes the answer, so this test can fail.
  const cue = (message: string): "reader" | "study" | "unsure" =>
    /offline reading|read later/i.test(message)
      ? "reader"
      : /study|learning/i.test(message)
        ? "study"
        : "unsure";
  const reading = await fixture({
    judge: async (input) => {
      const route = cue(input.message);
      return route === "unsure"
        ? verdict("unsure", { confidence: 0.4 })
        : verdict(route, { kind: "technical" });
    },
  });
  try {
    // "for offline reading" wins even though the page is a tutorial.
    const result: any = await reading.links().save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this tutorial for offline reading",
    });
    assert.equal(result.outcome, "reader");
    assert.equal(await studyCount(reading.db), 0);
    // Without the cue the same page is a question, so the assertion above really depends
    // on the owner's words reaching the classifier.
    const silent: any = await reading.links().save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    assert.equal(silent.outcome, "needs_choice");
  } finally {
    await reading.pg.close();
  }
  const studying = await fixture({
    judge: async (input) =>
      verdict(cue(input.message) === "reader" ? "reader" : "study", {
        kind: "news",
      }),
  });
  try {
    const result: any = await studying.links().save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this news story to my study list",
    });
    assert.equal(result.outcome, "study");
    assert.equal(await studyCount(studying.db), 1);
    assert.equal(studying.reader.calls.length, 0);
  } finally {
    await studying.pg.close();
  }
});

test("an unsure link asks with three taps and saves nothing; a slow Jev never falls back to Reader", async () => {
  for (const [name, result] of [
    ["unsure", verdict("unsure", { confidence: 0.4 })],
    ["low confidence", verdict("study", { confidence: 0.3 })],
    ["timeout", { ok: false, failure: "timeout" } as LinkJudgeResult],
    ["failed", { ok: false, failure: "failed" } as LinkJudgeResult],
  ] as const) {
    const f = await fixture(judge(() => result).api);
    try {
      const saved: any = await f.links().save("123", {
        url: "https://example.org/agents",
        ownerMessage: "save this",
      });
      assert.equal(saved.outcome, "needs_choice", name);
      assert.equal(saved.delivered, true, name);
      assert.equal(await studyCount(f.db), 0, name);
      assert.equal(f.reader.calls.length, 0, name);
      assert.deepEqual(
        saved.buttons.map((b: any) => b.text),
        ["Study list", "Reader", "Both"],
        name,
      );
      for (const button of saved.buttons)
        assert.ok(Buffer.byteLength(button.data) <= 64, name);
      const row = (
        await f.db.query("SELECT * FROM link_decisions WHERE id=$1", [
          saved.decisionId,
        ])
      ).rows[0];
      assert.equal(row.route, "unsure", name);
      assert.equal(row.state, "pending", name);
      assert.equal(f.asked.length, 1, name);
    } finally {
      await f.pg.close();
    }
  }
});

test("a page Chief could not read cannot become study material with an invented title", async () => {
  // Jev reads the cue from the owner's words, as the real one does; a page it cannot read
  // contributes no title, so only an explicit cue decides where it goes.
  const reading = (input: any): LinkJudgeResult =>
    verdict("study", {
      cue: /ai learning|study|offline/i.test(input.message)
        ? "explicit"
        : "none",
    });
  const f = await fixture(judge(reading).api);
  try {
    // No cue: nothing names it honestly, so it is a question, not an entry called "blocked".
    const saved: any = await f.links().save("123", {
      url: "https://blocked.example.org/thread",
      ownerMessage: "save this",
    });
    assert.equal(saved.outcome, "needs_choice");
    assert.match(saved.question, /title could not be read/);
    assert.equal(await studyCount(f.db), 0);
    assert.equal(f.reader.calls.length, 0);
    // An explicit cue wins even when the page has no readable title: it is saved where the
    // owner said, named after the site, and the receipt says the title could not be read.
    const cued: any = await f.links().save("123", {
      url: "https://blocked.example.org/thread",
      ownerMessage: "save this for AI learning",
    });
    assert.equal(cued.outcome, "study", cued.message);
    assert.match(cued.message, /Saved to your study list/);
    assert.match(cued.message, /title couldn't be read/);
    const entry = (await f.store.list("123"))[0]!;
    assert.equal(entry.title, "blocked.example.org");
    assert.equal(entry.url, "https://blocked.example.org/thread");
    assert.equal(f.reader.calls.length, 0);
    assert.equal(await studyCount(f.db), 1);
  } finally {
    await f.pg.close();
  }
});

test("a cued Reader save of an unreadable page still goes to Reader, never to the study list", async () => {
  const f = await fixture(
    judge(() =>
      verdict("reader", {
        kind: "news",
        topic: null,
        cue: "explicit",
      }),
    ).api,
  );
  try {
    const saved: any = await f.links().save("123", {
      url: "https://blocked.example.org/story",
      ownerMessage: "save this story for offline reading",
    });
    assert.equal(saved.outcome, "reader", saved.message);
    assert.equal(await studyCount(f.db), 0);
    assert.equal(f.reader.calls.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("both writes succeed on the Both route and both are recorded", async () => {
  const f = await fixture(judge(() => verdict("both")).api);
  try {
    const result: any = await f.links().save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this both ways",
    });
    assert.equal(result.outcome, "both");
    assert.match(result.message, /study list and to Reader/);
    assert.equal(f.reader.calls.length, 1);
    const entry = (await f.store.list("123"))[0]!;
    assert.equal(entry.readerSaved, true);
  } finally {
    await f.pg.close();
  }
});

test("a Both save that half-fails says what was written and never that nothing was", async () => {
  const f = await fixture(judge(() => verdict("both")).api);
  try {
    f.reader.fail("invalid");
    const result: any = await f.links().save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this both ways",
    });
    assert.match(result.message, /Saved to your study list/);
    assert.match(result.message, /refused/);
    assert.doesNotMatch(result.message, /Nothing was written/);
    assert.equal(await studyCount(f.db), 1);
    assert.equal((await f.store.list("123"))[0]!.readerSaved, false);
  } finally {
    await f.pg.close();
  }
});

test("a stored Reader rejection gets a new key next time; an in-flight key is reused", async () => {
  const f = await fixture(judge(() => verdict("reader", { topic: null })).api);
  try {
    const links = f.links();
    f.reader.fail("invalid");
    const first: any = await links.save("123", {
      url: "https://example.org/agents",
    });
    // A definite Reader rejection is a failure, not an uncertainty.
    assert.equal(first.outcome, "failed");
    const refused = f.reader.calls[0]!;
    assert.equal(
      (await f.store.readerOperation("123", refused.key))?.state,
      "rejected",
    );
    // A refusal must not block every later attempt: a new attempt gets a new key.
    const second: any = await links.save("123", {
      url: "https://example.org/agents",
    });
    assert.equal(second.outcome, "reader");
    assert.notEqual(f.reader.calls[1]!.key, refused.key);
    assert.equal(f.reader.calls[1]!.url, refused.url);
    // The same key and payload replays the stored receipt; a different payload is refused.
    const mcp = f.reader.make(f.db);
    const replay: any = await mcp.call("123", {
      operation: "mcp_write",
      connection: "reader",
      tool: "save_link",
      requestKey: f.reader.calls[1]!.key,
      arguments: { url: f.reader.calls[1]!.url },
    });
    assert.equal(replay.state, "complete");
    await assert.rejects(
      mcp.call("123", {
        operation: "mcp_write",
        connection: "reader",
        tool: "save_link",
        requestKey: f.reader.calls[1]!.key,
        arguments: { url: "https://example.org/other" },
      }),
      /bound to another connection, tool or payload/,
    );
    assert.equal(f.reader.calls.length, 2);
  } finally {
    await f.pg.close();
  }
});

test("a tracking-parameter variant reuses one canonical URL and reports an in-flight Reader save", async () => {
  const f = await fixture(judge(() => verdict("reader", { topic: null })).api);
  try {
    const links = f.links();
    f.reader.fail("uncertain");
    const first: any = await links.save("123", {
      url: "https://example.org/agents?utm_source=a",
    });
    assert.equal(first.outcome, "uncertain");
    const pending = f.reader.calls[0]!;
    assert.equal(pending.url, "https://example.org/agents");
    const row = (
      await f.db.query(
        "SELECT payload FROM mcp_operations WHERE request_key=$1",
        [pending.key],
      )
    ).rows[0];
    assert.equal(row.payload.url, "https://example.org/agents");
    // The same link with different tracking parameters is the same request, so no second save.
    // A save this one never sent is a definite non-send, not an uncertain result.
    const second: any = await links.save("123", {
      url: "https://www.example.org/agents/?ref=b",
    });
    assert.equal(second.outcome, "blocked");
    assert.match(second.message, /already in progress/);
    // The owner is told which request is in flight, so it can be settled later.
    assert.ok(second.message.includes(pending.key), second.message);
    assert.equal(f.reader.calls.length, 1);
    // A genuine retry of that identical request replays under the same key.
    const retried = await links.readerSave(
      "123",
      "https://example.org/agents",
      { requestKey: pending.key },
    );
    assert.equal(retried.state, "accepted", retried.detail);
    assert.equal(f.reader.calls.at(-1)!.key, pending.key);
  } finally {
    await f.pg.close();
  }
});

test("an unsure link's tap writes only the chosen destination and reports exactly that", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    const study = await links.confirm("123", saved.decisionId, "study", 401);
    assert.equal(study.settled, true);
    assert.match(study.text, /Saved to your study list/);
    assert.equal(await studyCount(f.db), 1);
    assert.equal(f.reader.calls.length, 0);
    // Settled: a second tap reports only what the record holds and writes nothing.
    // It must never claim the Reader half the owner did not get.
    const repeat = await links.confirm("123", saved.decisionId, "both", 401);
    assert.equal(repeat.settled, true);
    assert.match(repeat.text, /already saved to your study list/);
    assert.doesNotMatch(repeat.text, /study list and Reader/);
    assert.match(repeat.text, /isn't in Reader/);
    // Moving the entry to Reader would take it off the study list, so the advice names the
    // request that adds the Reader copy and keeps the entry instead.
    assert.match(repeat.text, /add it to Reader too/);
    assert.doesNotMatch(repeat.text, /move it to Reader/);
    assert.equal(repeat.choice, "study");
    assert.equal(await studyCount(f.db), 1);
    assert.equal(f.reader.calls.length, 0);
    // A tap on an older card is refused.
    const stale = await links.confirm("123", saved.decisionId, "reader", 999);
    assert.equal(stale.settled, false);
    assert.match(stale.text, /older message/);
  } finally {
    await f.pg.close();
  }
});

test("a Both card whose Reader half is refused settles instead of asking again for ever", async () => {
  let answer: "unsure" | "reader" = "unsure";
  const f = await fixture(
    judge(() =>
      answer === "unsure"
        ? verdict("unsure", { confidence: 0.4 })
        : verdict("reader", { kind: "news", topic: null }),
    ).api,
  );
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    f.reader.fail("invalid");
    const first = await links.confirm("123", saved.decisionId, "both", 401);
    // Nothing is dropped and nothing is called uncertain: the study entry is named, the
    // refusal is given, and the card is settled rather than left re-sending to Reader.
    assert.equal(first.settled, true, first.text);
    assert.match(first.text, /Saved to your study list/);
    assert.match(first.text, /Reader refused/);
    assert.doesNotMatch(first.text, /^Nothing was written/);
    assert.doesNotMatch(first.text, /tap again/i);
    assert.match(first.text, /save it to Reader/);
    assert.equal(await studyCount(f.db), 1);
    const after = await links.decisions.get("123", saved.decisionId);
    assert.equal(after!.state, "confirmed");
    assert.equal(after!.studyState, "done");
    assert.equal(after!.readerState, "rejected");
    assert.equal(after!.choice, "both");
    // A later tap never sends a second Reader request for a card that is already settled.
    const repeat = await links.confirm("123", saved.decisionId, "both", 401);
    assert.equal(repeat.settled, true);
    assert.match(repeat.text, /already saved to your study list/);
    assert.match(repeat.text, /add it to Reader too/);
    assert.equal(f.reader.calls.length, 1);
    // Only a new, explicit request retries Reader, and it gets a new key (requirement 9).
    answer = "reader";
    const retried: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save it to Reader",
    });
    assert.equal(retried.outcome, "reader", retried.message);
    assert.equal(f.reader.calls.length, 2);
    assert.notEqual(f.reader.calls[1]!.key, f.reader.calls[0]!.key);
    assert.equal(await studyCount(f.db), 1);
    // Reader accepted, so the entry now records it.
    assert.equal((await f.store.list("123"))[0]!.readerSaved, true);
  } finally {
    await f.pg.close();
  }
});

test("a tap that cannot finish keeps its buttons and its row resumable", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    // A claim held by another tap: the buttons still work later, because the lease expires.
    await f.db.query(
      "UPDATE link_decisions SET claim_token=$2,claimed_at=now() WHERE id=$1",
      [saved.decisionId, randomUUID()],
    );
    const busy = await links.confirm("123", saved.decisionId, "study", 401);
    assert.equal(busy.settled, false);
    assert.match(busy.text, /Still working/);
    assert.equal(await studyCount(f.db), 0);
    // The same callback data still resolves after the lease ages out.
    await f.db.query(
      "UPDATE link_decisions SET claimed_at=now()-interval '5 minutes' WHERE id=$1",
      [saved.decisionId],
    );
    const resumed = await links.confirm("123", saved.decisionId, "study", 401);
    assert.equal(resumed.settled, true);
    assert.equal(await studyCount(f.db), 1);
    // The keyboard carries exactly one row of three taps within Telegram's limit.
    const buttons = linkChoiceButtons(saved.decisionId);
    assert.deepEqual(
      buttons.map((b) => b.text),
      ["Study list", "Reader", "Both"],
    );
    for (const button of buttons)
      assert.match(button.data, /^lnk:(study|reader|both):[0-9a-f-]{36}$/);
  } finally {
    await f.pg.close();
  }
});

test("a failure after the Reader write reports uncertainty instead of losing the study entry", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const brokenStore = Object.assign(new StudyStore(f.db), {
      add: async () => {
        throw new Error("database unavailable");
      },
    });
    const links = f.links({ store: brokenStore });
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    const outcome = await links.confirm("123", saved.decisionId, "both", 401);
    assert.equal(outcome.settled, false);
    assert.match(outcome.text, /Saved to Reader/);
    assert.match(outcome.text, /Nothing else was changed/);
    assert.doesNotMatch(outcome.text, /^Nothing was written/);
    const row = await links.decisions.get("123", saved.decisionId);
    assert.equal(row!.state, "pending");
    assert.equal(row!.readerState, "accepted");
    // The unfinished study step is retryable with the real store.
    const retried = await f
      .links()
      .confirm("123", saved.decisionId, "both", 401);
    assert.equal(retried.settled, true, retried.text);
    assert.equal(await studyCount(f.db), 1);
    assert.equal(f.reader.calls.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("corrections move an item between the study list and Reader", async () => {
  const f = await fixture(judge(() => verdict("study")).api);
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
    });
    const entry = (await f.store.list("123"))[0]!;
    f.reader.setLibrary([
      {
        url: "https://example.org/voice",
        title: "Realtime voice round trip",
        domain: "example.org",
      },
    ]);
    f.pages.set(
      dedupeKey("https://example.org/voice"),
      page(
        "Realtime voice round trip",
        "Building a low-latency voice agent with streaming speech models.",
        "Example Voice",
      ),
    );
    const toReader: any = await links.move("123", {
      id: entry.id,
      to: "reader",
    });
    assert.equal(toReader.moved, true);
    assert.equal(f.reader.calls.length, 1);
    assert.equal(f.reader.calls[0]!.url, entry.url);
    assert.equal(await studyCount(f.db), 0);
    // Reader → study says plainly that Reader keeps its own copy.
    const toStudy: any = await links.move("123", {
      url: "https://example.org/voice",
      to: "study",
    });
    assert.equal(toStudy.moved, true);
    assert.match(toStudy.message, /Reader still has its own copy/);
    assert.equal(await studyCount(f.db), 1);
    // The moved entry carries the page's own title and a topic from the page, not the URL
    // and not an empty subject (review nit).
    const moved = (await f.store.list("123"))[0]!;
    assert.equal(moved.title, "Realtime voice round trip");
    assert.equal(moved.url, "https://example.org/voice");
    assert.equal(moved.topic, "agent platforms");
    assert.equal(moved.model, "typesafe/jev-1.13-20260917");
    // Reader refusing a move leaves the study entry alone.
    f.reader.fail("invalid");
    const refused: any = await links.move("123", {
      url: "https://example.org/voice",
      to: "reader",
    });
    assert.equal(refused.moved, false);
    assert.match(refused.message, /Still on your study list/);
    assert.equal(await studyCount(f.db), 1);
    // A link that is not on the study list cannot be "moved" to Reader.
    await assert.rejects(
      links.move("123", { url: "https://example.org/nowhere", to: "reader" }),
      /No study entry with that id or link/,
    );
    assert.ok(saved);
  } finally {
    await f.pg.close();
  }
});

test("page metadata comes from the page itself, and a blocked page yields no title", async () => {
  assert.deepEqual(pageMetadata(page(), "https://example.org/agents"), {
    title: "Building agent architectures that hold up",
    site: "Example Engineering",
    excerpt:
      "A practical walkthrough of tool-using agent architectures, orchestration and evaluation.",
  });
  // No title at all: nothing is invented.
  assert.equal(
    pageMetadata(
      "<html><body><p>hello</p></body></html>",
      "https://a.example/x",
    ).title,
    null,
  );
});

test("the page's own post text reaches the classifier when the meta tags are thin", async () => {
  // A page that carries no description still contributes its visible text, which is what
  // an X thread or a tutorial looks like on the wire (review finding 9).
  const thread =
    "<html><head><title>Thread by @someone</title></head><body>" +
    "<script>var hidden = 'not the post';</script>" +
    "<div><p>How I build multi-agent systems: orchestration, tool routing and evals.</p>" +
    "<p>Step two is a planner that writes its own tests.</p></div>" +
    "<style>.hidden{}</style></body></html>";
  const meta = pageMetadata(thread, "https://x.com/someone/status/1");
  assert.equal(meta.title, "Thread by @someone");
  assert.equal(meta.site, "x.com");
  assert.match(meta.excerpt!, /multi-agent systems/);
  assert.match(meta.excerpt!, /planner that writes its own tests/);
  assert.doesNotMatch(meta.excerpt!, /not the post|hidden/);
  // A description still comes first, and the post text follows it.
  const both = pageMetadata(
    page("Title", "Description text", "Site"),
    "https://example.org/a",
  );
  assert.match(both.excerpt!, /^Description text/);
  // A PDF is not markup: it has no title to read, so nothing is invented from it.
  assert.deepEqual(
    pageMetadata("%PDF-1.7 binary noise", "https://example.org/paper.pdf"),
    { title: null, site: "example.org", excerpt: null },
  );
  // And the fetch path treats it as unreadable, so study material becomes a question.
  const f = await fixture(judge(() => verdict("study")).api);
  try {
    f.pages.set(
      dedupeKey("https://example.org/paper.pdf"),
      "%PDF-1.7 binary noise",
    );
    const saved: any = await f
      .links()
      .save("123", { url: "https://example.org/paper.pdf" });
    assert.equal(saved.outcome, "needs_choice");
    assert.equal(await studyCount(f.db), 0);
  } finally {
    await f.pg.close();
  }
});

test("only the listing is a read operation; every other study tool is a write", () => {
  assert.equal(readOperations.has("study_list"), true);
  for (const op of ["link_save", "study_update", "study_remove", "link_move"])
    assert.equal(readOperations.has(op), false, op);
});

test("a changed tap replaces the choice only before anything is written", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const saved: any = await f.links().save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    // Nothing written yet: changing the tap changes the destination.
    const brokenStore = Object.assign(new StudyStore(f.db), {
      add: async () => {
        throw new Error("database unavailable");
      },
    });
    const failedStudy = await f
      .links({ store: brokenStore })
      .confirm("123", saved.decisionId, "study", 401);
    assert.equal(failedStudy.settled, false);
    assert.match(failedStudy.text, /Nothing was written/);
    assert.equal(failedStudy.choice, "study");
    const changed = await f
      .links()
      .confirm("123", saved.decisionId, "reader", 401);
    assert.equal(changed.settled, true, changed.text);
    assert.match(changed.text, /Saved to Reader/);
    assert.equal(await studyCount(f.db), 0);
    assert.equal((await f.store.list("123")).length, 0);
    assert.equal(f.reader.calls.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("an uncertain Reader result after a partial write says the result is uncertain", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    f.reader.fail("uncertain");
    const first = await links.confirm("123", saved.decisionId, "both", 401);
    assert.equal(first.settled, false);
    assert.match(first.text, /Saved to your study list/);
    assert.match(first.text, /result is uncertain/);
    assert.doesNotMatch(first.text, /^Nothing was written/);
    const row = await links.decisions.get("123", saved.decisionId);
    assert.equal(row!.readerState, "uncertain");
    // Tapping Study list after the partial write still finishes the Reader half.
    const second = await links.confirm("123", saved.decisionId, "study", 401);
    assert.equal(second.settled, true, second.text);
    assert.match(second.text, /study list and Reader/);
    assert.equal(await studyCount(f.db), 1);
    assert.equal(f.reader.calls.length, 2);
  } finally {
    await f.pg.close();
  }
});

test("an uncertain Reader-only tap never claims that nothing was written", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    f.reader.fail("uncertain");
    const outcome = await links.confirm("123", saved.decisionId, "reader", 401);
    assert.equal(outcome.settled, false);
    assert.match(outcome.text, /result is uncertain/i);
    assert.match(outcome.text, /Reader may already have it/);
    assert.doesNotMatch(outcome.text, /Nothing was written/);
    assert.equal(await studyCount(f.db), 0);
    const row = await links.decisions.get("123", saved.decisionId);
    assert.equal(row!.readerState, "uncertain");
    assert.equal(row!.readerRequestKey, f.reader.calls[0]!.key);
  } finally {
    await f.pg.close();
  }
});

test("a Both tap whose study insert failed and whose Reader result is uncertain names both", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const brokenStore = Object.assign(new StudyStore(f.db), {
      add: async () => {
        throw new Error("database unavailable");
      },
    });
    const links = f.links({ store: brokenStore });
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    f.reader.fail("uncertain");
    const outcome = await links.confirm("123", saved.decisionId, "both", 401);
    assert.equal(outcome.settled, false);
    assert.match(outcome.text, /study entry wasn't written/);
    assert.match(outcome.text, /Reader may already have it/);
    assert.doesNotMatch(outcome.text, /Nothing was written/);
    assert.equal(await studyCount(f.db), 0);
  } finally {
    await f.pg.close();
  }
});

test("after an uncertain Reader tap, tapping Study list keeps the Reader request open", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    f.reader.fail("uncertain");
    const first = await links.confirm("123", saved.decisionId, "reader", 401);
    assert.equal(first.settled, false);
    const key = f.reader.calls[0]!.key;
    // An unconfirmed Reader save may still land, so the card is not settled with it: the
    // study half is written and the same Reader request stays open under its own key.
    f.reader.fail("uncertain");
    const second = await links.confirm("123", saved.decisionId, "study", 401);
    assert.equal(second.settled, false, second.text);
    assert.match(second.text, /Saved to your study list/);
    assert.match(second.text, /result is uncertain/i);
    assert.match(second.text, /Reader may already have it/);
    assert.doesNotMatch(second.text, /isn't in Reader/);
    assert.equal(second.choice, "both");
    const row = await links.decisions.get("123", saved.decisionId);
    assert.equal(row!.state, "pending");
    assert.equal(row!.readerState, "uncertain");
    assert.equal(await studyCount(f.db), 1);
    assert.equal(f.reader.calls.length, 2);
    assert.equal(f.reader.calls[1]!.key, key);
    // Only when that same request settles is the card confirmed, and it never claimed the
    // Reader copy was absent in the meantime.
    const third = await links.confirm("123", saved.decisionId, "reader", 401);
    assert.equal(third.settled, true, third.text);
    assert.match(third.text, /study list and Reader/);
    assert.equal(f.reader.calls[2]!.key, key);
    assert.equal(
      (await links.decisions.get("123", saved.decisionId))!.state,
      "confirmed",
    );
  } finally {
    await f.pg.close();
  }
});

test("a Reader save that was never sent is never described as one Reader may have", async () => {
  const f = await fixture({
    judge: async (input) =>
      input.url.endsWith("/other")
        ? verdict("reader", { topic: null })
        : verdict("unsure", { confidence: 0.3 }),
  });
  try {
    const links = f.links();
    // An in-flight save for a different link holds the Reader write: Reader refuses a
    // second write until it is reconciled.
    f.reader.fail("uncertain");
    const other: any = await links.save("123", {
      url: "https://example.org/other",
    });
    assert.equal(other.outcome, "uncertain");
    const pendingKey = f.reader.calls[0]!.key;
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    assert.equal(saved.outcome, "needs_choice");
    const outcome = await links.confirm("123", saved.decisionId, "reader", 401);
    assert.equal(outcome.settled, false);
    // A definite non-send, not an uncertain one.
    assert.match(outcome.text, /wasn't sent/);
    assert.doesNotMatch(outcome.text, /may already have it/);
    assert.match(outcome.text, /Nothing was written/);
    assert.equal(f.reader.calls.length, 1);
    assert.equal(await studyCount(f.db), 0);
    const row = await links.decisions.get("123", saved.decisionId);
    assert.equal(row!.readerState, "none");
    assert.equal(row!.state, "pending");
    // Once that other save settles, the same buttons still work.
    const settledOther = await links.readerSave(
      "123",
      "https://example.org/other",
      { requestKey: pendingKey },
    );
    assert.equal(settledOther.state, "accepted", settledOther.detail);
    const second = await links.confirm("123", saved.decisionId, "reader", 401);
    assert.equal(second.settled, true, second.text);
    assert.match(second.text, /Saved to Reader/);
  } finally {
    await f.pg.close();
  }
});

test("a Both save of a link already on the study list does not claim to add it again", async () => {
  const f = await fixture(judge(() => verdict("both")).api);
  try {
    const links = f.links();
    const first: any = await links.save("123", {
      url: "https://example.org/agents",
    });
    assert.match(first.message, /study list and to Reader/);
    const again: any = await links.save("123", {
      url: "https://example.org/agents?utm_source=repeat",
    });
    assert.equal(again.outcome, "both");
    assert.match(again.message, /Already on your study list/);
    assert.match(again.message, /saved to Reader/);
    assert.equal(await studyCount(f.db), 1);
  } finally {
    await f.pg.close();
  }
});

test("a tap adopts the key of an identical Reader save that is already in flight", async () => {
  let route: "reader" | "unsure" = "reader";
  const f = await fixture({
    judge: async () =>
      route === "reader"
        ? verdict("reader", { topic: null })
        : verdict("unsure", { confidence: 0.3 }),
  });
  try {
    const links = f.links();
    // An earlier save of this exact link is still unconfirmed: it holds a pending key.
    f.reader.fail("uncertain");
    const direct: any = await links.save("123", {
      url: "https://example.org/agents",
    });
    assert.equal(direct.outcome, "uncertain");
    const key = f.reader.calls[0]!.key;
    assert.equal((await f.store.readerOperation("123", key))?.state, "pending");
    // The same link, now genuinely unsure, reaches the taps.
    route = "unsure";
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    assert.equal(saved.outcome, "needs_choice");
    // The tap finishes the request that is already in flight instead of being blocked by it.
    const outcome = await links.confirm("123", saved.decisionId, "reader", 401);
    assert.equal(outcome.settled, true, outcome.text);
    assert.match(outcome.text, /Saved to Reader/);
    // The owner is told an earlier save of the same link was already in flight, so a reused
    // request is never mistaken for a second save (requirement 8).
    assert.match(
      outcome.text,
      /earlier Reader save for this link was still in progress/i,
    );
    assert.equal(f.reader.calls.length, 2);
    assert.equal(f.reader.calls[1]!.key, key);
    const row = await links.decisions.get("123", saved.decisionId);
    assert.equal(row!.readerRequestKey, key);
    assert.equal(row!.readerState, "accepted");
  } finally {
    await f.pg.close();
  }
});

test("a repeat save of the identical link reuses the in-flight request and says so", async () => {
  const f = await fixture(judge(() => verdict("reader", { topic: null })).api);
  try {
    const links = f.links();
    // The first save never confirmed, so its request key is still in flight.
    f.reader.fail("uncertain");
    const first: any = await links.save("123", {
      url: "https://example.org/agents",
    });
    assert.equal(first.outcome, "uncertain");
    const key = f.reader.calls[0]!.key;
    // The same link shared again settles that same request instead of starting a second,
    // and the owner is told an earlier save was already in progress (requirement 8).
    const second: any = await links.save("123", {
      url: "https://example.org/agents?utm_source=newsletter",
    });
    assert.equal(second.outcome, "reader", second.message);
    assert.match(second.message, /Saved to Reader for offline reading/);
    assert.match(
      second.message,
      /earlier Reader save for this link was still in progress/i,
    );
    assert.equal(f.reader.calls.length, 2);
    assert.equal(f.reader.calls[1]!.key, key);
    assert.equal(f.reader.calls[1]!.url, "https://example.org/agents");
  } finally {
    await f.pg.close();
  }
});

test("a study entry that was inserted is reported as saved when its card update fails", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    // The INSERT commits, then recording it on the card fails. The entry exists, so the
    // reply must never say it wasn't written (requirement 10, review finding 1).
    const real = links.decisions.setStudy.bind(links.decisions);
    links.decisions.setStudy = async () => {
      throw new Error("connection reset");
    };
    const outcome = await links.confirm("123", saved.decisionId, "study", 401);
    assert.equal(await studyCount(f.db), 1);
    assert.equal(outcome.settled, false);
    assert.match(outcome.text, /Saved to your study list/);
    assert.match(outcome.text, /card couldn't be updated/);
    assert.doesNotMatch(outcome.text, /study entry wasn't written/);
    assert.doesNotMatch(outcome.text, /Nothing was written/);
    // Two days pass before the owner retries. The entry exists even though the row does not
    // say so, so the expired card must not claim nothing was written either - and it acts
    // on nothing, while still reporting the entry it finds in the collection.
    await f.db.query(
      "UPDATE link_decisions SET expires_at=now()-interval '1 hour' WHERE id=$1",
      [saved.decisionId],
    );
    links.decisions.setStudy = real;
    const retried = await links.confirm("123", saved.decisionId, "study", 401);
    assert.equal(retried.settled, true, retried.text);
    assert.match(retried.text, /expired/i);
    assert.match(retried.text, /already in your study list/);
    assert.doesNotMatch(retried.text, /nothing was written/i);
    assert.equal(await studyCount(f.db), 1);
    const row = await links.decisions.get("123", saved.decisionId);
    // Nothing was written by the late tap, so the card still does not claim the entry.
    assert.equal(row!.studyState, "none");
    assert.equal(row!.state, "pending");
  } finally {
    await f.pg.close();
  }
});

test("a Reader save that was accepted is never reported as nothing when its card update fails", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    // The first call records the key before Reader is contacted; the second records the
    // outcome and is the one that fails here (review finding 2).
    const real = links.decisions.setReaderAttempt.bind(links.decisions);
    let calls = 0;
    links.decisions.setReaderAttempt = async (...args) => {
      if (++calls > 1) throw new Error("connection reset");
      return real(...args);
    };
    const outcome = await links.confirm("123", saved.decisionId, "reader", 401);
    assert.equal(f.reader.calls.length, 1);
    assert.equal(
      (await f.store.readerOperation("123", f.reader.calls[0]!.key))?.state,
      "complete",
    );
    assert.equal(outcome.settled, false);
    assert.match(outcome.text, /Saved to Reader/);
    assert.doesNotMatch(outcome.text, /Nothing was written/);
  } finally {
    await f.pg.close();
  }
});

test("a non-public or non-https link is refused as input, not as an uncertain write", async () => {
  const f = await fixture(judge(() => verdict("study")).api);
  try {
    const links = f.links();
    for (const url of ["http://example.org/agents", "https://localhost/x"]) {
      const error = await links
        .save("123", { url, ownerMessage: "save this" })
        .then(() => undefined)
        .catch((e) => e);
      assert.ok(error instanceof ToolValidationError, `${url}: ${error}`);
      // A validation refusal is a definite "nothing was written"; a bare Error would be
      // TOOL_FAILED, which the host records as uncertain and blocks every later write.
      const mapped = toolError(error);
      assert.equal(mapped.code, "VALIDATION_FAILED", url);
      assert.doesNotMatch(mapped.message, /inspect its durable state/i);
    }
    await assert.rejects(
      links.move("123", { url: "http://example.org/agents", to: "reader" }),
      ToolValidationError,
    );
    assert.equal(await studyCount(f.db), 0);
    assert.equal(f.reader.calls.length, 0);
  } finally {
    await f.pg.close();
  }
});

test("'what's on my AI study list' finds AI interests whose labels contain no AI", async () => {
  const f = await fixture(judge(() => verdict("study")).api);
  try {
    const links = f.links();
    await links.save("123", { url: "https://example.org/agents" }); // agent platforms
    const other = f.links({
      judge: {
        judge: async () => verdict("study", { topic: "developer-tools" }),
      },
    });
    f.pages.set(
      dedupeKey("https://example.org/tools"),
      page("A developer tool", "A CLI for agents.", "Example Tools"),
    );
    await other.save("123", { url: "https://example.org/tools" });
    // An entry Jev could not name a topic for is still study material: a broad question
    // must list it, labelled "Other", instead of hiding it behind the label filter.
    const untopiced = f.links({
      judge: {
        judge: async () => verdict("study", { topic: null }),
      },
    });
    f.pages.set(
      dedupeKey("https://example.org/unfiled"),
      page("An unfiled thread", "Something to work through.", "Example"),
    );
    assert.equal(
      (await untopiced.save("123", { url: "https://example.org/unfiled" }))
        .entry?.topic,
      null,
    );
    const listed: any = await links.list("123", {
      topic: "what's on my AI study list",
    });
    assert.equal(listed.count, 3, listed.text);
    assert.deepEqual(
      listed.entries.map((e: any) => e.topic).sort(),
      [null, "agent platforms", "developer tools"].sort(),
    );
    assert.match(listed.text, /An unfiled thread[\s\S]*Other/);
    assert.match(
      listed.text,
      /Study list \(topic what's on my AI study list\) — 3 shown/,
    );
    // A narrow topic query still matches only what it names.
    const narrow: any = await links.list("123", { topic: "agent platforms" });
    assert.equal(narrow.count, 1, narrow.text);
    // A topic the list does not hold still reports what is in use instead of guessing.
    const missing: any = await links.list("123", { topic: "quantum" });
    assert.equal(missing.count, 0);
    assert.match(
      missing.text,
      /Topics on your list: agent platforms, developer tools/,
    );
  } finally {
    await f.pg.close();
  }
});

test("a pending Reader save does not block a study write, and the tool reports that key", async () => {
  const f = await fixture({
    judge: async (input) =>
      String(input.url).includes("other")
        ? verdict("reader", { topic: null, kind: "essay" })
        : verdict("study"),
  });
  try {
    // An earlier save of a different link is still unconfirmed in Reader.
    f.reader.fail("uncertain");
    const first: any = await f
      .links()
      .save("123", { url: "https://example.org/other" });
    assert.equal(first.outcome, "uncertain");
    const key = f.reader.calls[0]!.key;
    // The host gate refuses an ordinary write while an MCP operation is pending...
    const mcp = f.reader.make(f.db);
    assert.equal(
      await mcp.pendingAllows("123", {
        operation: "link_save",
        url: "https://example.org/agents",
      }),
      false,
    );
    // ...but the study writes are exempt, because each one reconciles its own state and
    // the Reader hand-off reports the save already in flight (review finding 6).
    for (const op of STUDY_WRITE_OPERATIONS)
      assert.equal(readOperations.has(op), false, op);
    assert.deepEqual([...STUDY_WRITE_OPERATIONS].sort(), [
      "link_move",
      "link_save",
      "study_remove",
      "study_update",
    ]);
    // So a study save of an unrelated link still works while that save is pending.
    const saved: any = await f.links().save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    assert.equal(saved.outcome, "study");
    assert.equal(await studyCount(f.db), 1);
    assert.equal(f.reader.calls.length, 1);
    // The requirement-8 notice reaches the owner from the same tool the turn calls.
    const noticed: any = await f.links().save("123", {
      url: "https://www.example.org/other/?utm_source=x",
    });
    assert.match(noticed.message, /already in progress/);
    assert.ok(noticed.message.includes(key), noticed.message);
    assert.equal(f.reader.calls.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("an expired choice card writes nothing", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    await f.db.query(
      "UPDATE link_decisions SET expires_at=now()-interval '1 hour' WHERE id=$1",
      [saved.decisionId],
    );
    const outcome = await links.confirm("123", saved.decisionId, "study", 401);
    assert.equal(outcome.settled, true);
    assert.match(outcome.text, /expired/);
    assert.doesNotMatch(outcome.text, /Saved to/);
    assert.equal(await studyCount(f.db), 0);
    assert.equal(f.reader.calls.length, 0);
  } finally {
    await f.pg.close();
  }
});

test("an expired card acts on nothing and still reports what it already holds", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    // The study half lands, the Reader half stays unconfirmed: the card holds a write.
    f.reader.fail("uncertain");
    const first = await links.confirm("123", saved.decisionId, "both", 401);
    assert.equal(first.settled, false, first.text);
    assert.equal(await studyCount(f.db), 1);
    await f.db.query(
      "UPDATE link_decisions SET expires_at=now()-interval '1 hour' WHERE id=$1",
      [saved.decisionId],
    );
    // A tap two days late is not the owner's answer, so it writes nothing - and it still
    // never says nothing was written, because the study entry and the Reader attempt exist.
    const second = await links.confirm("123", saved.decisionId, "both", 401);
    assert.equal(second.settled, true, second.text);
    assert.match(second.text, /expired/i);
    assert.match(second.text, /already in your study list/);
    assert.match(
      second.text,
      /Reader copy from that attempt may still have landed/,
    );
    assert.doesNotMatch(second.text, /^Nothing was written/);
    assert.equal(await studyCount(f.db), 1);
    // No second Reader save was sent by the late tap.
    assert.equal(f.reader.calls.length, 1);
    const row = await links.decisions.get("123", saved.decisionId);
    assert.equal(row!.state, "pending");
    assert.equal(row!.readerState, "uncertain");
  } finally {
    await f.pg.close();
  }
});

test("expired or refused cards never block a later explicit request for either place", async () => {
  let answer: "unsure" | "reader" = "unsure";
  const f = await fixture({
    judge: async () =>
      answer === "unsure"
        ? verdict("unsure", { confidence: 0.4 })
        : verdict("reader", { kind: "news", topic: null }),
  });
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    f.reader.fail("invalid");
    const first = await links.confirm("123", saved.decisionId, "both", 401);
    // The study entry is written and Reader refused that link, so the card settles and a
    // later tap can never re-send to Reader (review finding 4).
    assert.equal(first.settled, true, first.text);
    assert.match(first.text, /Reader refused/);
    assert.equal(await studyCount(f.db), 1);
    // A new explicit request retries only Reader, under a new key (requirement 9).
    answer = "reader";
    const retried: any = await links.save("123", {
      url: "https://example.org/agents?utm_source=again",
      ownerMessage: "save it to Reader",
    });
    assert.equal(retried.outcome, "reader", retried.message);
    assert.equal(f.reader.calls.length, 2);
    assert.notEqual(f.reader.calls[1]!.key, f.reader.calls[0]!.key);
    assert.equal(f.reader.calls[1]!.url, "https://example.org/agents");
    assert.equal(await studyCount(f.db), 1);
  } finally {
    await f.pg.close();
  }
});

test("a study tap fills a missing topic from the page, the same way a save does", async () => {
  let answer: LinkJudgeResult = verdict("unsure", {
    confidence: 0.4,
    topic: null,
  });
  const f = await fixture({ judge: async () => answer });
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    assert.equal(saved.outcome, "needs_choice");
    const card = (await links.decisions.get("123", saved.decisionId))!;
    assert.equal(card.title, "Building agent architectures that hold up");
    assert.equal(card.topic, null);
    // The topic comes from the page through Jev when the entry is written, not from the
    // card's silence and never invented (review nit).
    answer = verdict("study", { topic: "developer-tools" });
    const outcome = await links.confirm("123", saved.decisionId, "study", 401);
    assert.equal(outcome.settled, true, outcome.text);
    const entries = await f.store.list("123");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.topic, "developer tools");
    assert.equal(entries[0]!.model, "typesafe/jev-1.13-20260917");
  } finally {
    await f.pg.close();
  }
});

test("a card whose page Chief still cannot read keeps the link as its title, with no topic", async () => {
  const f = await fixture(
    judge(() => verdict("study", { confidence: 0.4, topic: null })).api,
  );
  try {
    const links = f.links();
    // No page at all: there is no title to name it by, so even a study route asks.
    const saved: any = await links.save("123", {
      url: "https://example.org/unreadable",
      ownerMessage: "save this",
    });
    assert.equal(saved.outcome, "needs_choice");
    const outcome = await links.confirm("123", saved.decisionId, "study", 401);
    assert.equal(outcome.settled, true, outcome.text);
    const entries = await f.store.list("123");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.title, "https://example.org/unreadable");
    assert.equal(entries[0]!.topic, null);
  } finally {
    await f.pg.close();
  }
});

test("reader_attempts counts one attempt, not every record of it", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    const outcome = await links.confirm("123", saved.decisionId, "reader", 401);
    assert.equal(outcome.settled, true, outcome.text);
    const row = await links.decisions.get("123", saved.decisionId);
    assert.equal(row!.readerAttempts, 1);
    assert.equal(row!.readerRequestKey, f.reader.calls[0]!.key);
  } finally {
    await f.pg.close();
  }
});

test("a tap acts on the row it claims, not the snapshot it read first", async () => {
  const f = await fixture(
    judge(() => verdict("unsure", { confidence: 0.4 })).api,
  );
  try {
    const links = f.links();
    const saved: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this",
    });
    // Another tap finishes its Reader half while this one is still deciding; its study
    // insert fails, so the row stays pending with an accepted Reader save.
    const brokenStore = Object.assign(new StudyStore(f.db), {
      add: async () => {
        throw new Error("database unavailable");
      },
    });
    const inner = f.links({ store: brokenStore });
    const stale = (await links.decisions.get("123", saved.decisionId))!;
    assert.equal(stale.readerState, "none");
    const realGet = links.decisions.get.bind(links.decisions);
    let first = true;
    links.decisions.get = async (user: string, id: string) => {
      if (!first) return realGet(user, id);
      first = false;
      // Both: Reader accepts, the broken study insert leaves the card pending.
      await inner.confirm("123", saved.decisionId, "both", 401);
      return stale;
    };
    const outcome = await links.confirm("123", saved.decisionId, "reader", 401);
    // The claimed row already holds the accepted save, so no second Reader save is sent.
    assert.equal(f.reader.calls.length, 1);
    assert.equal(outcome.settled, true, outcome.text);
    assert.match(outcome.text, /Saved to Reader/);
    const row = await links.decisions.get("123", saved.decisionId);
    assert.equal(row!.readerState, "accepted");
    assert.equal(row!.state, "confirmed");
  } finally {
    await f.pg.close();
  }
});

test("x.com and twitter.com share links de-duplicate, and no other site loses s or t", () => {
  // An app share adds s and t, and twitter.com serves the same post: one entry, not three.
  assert.equal(
    dedupeKey("https://twitter.com/someone/status/1?s=20&t=AbCd"),
    "x.com/someone/status/1",
  );
  assert.equal(
    dedupeKey("https://x.com/someone/status/1?s=46&t=Zz9"),
    dedupeKey("https://www.x.com/someone/status/1/"),
  );
  // Only a status link of those two hosts: elsewhere s and t can be real parameters.
  assert.equal(
    dedupeKey("https://example.org/post?s=20&t=AbCd"),
    "example.org/post?s=20&t=AbCd",
  );
  assert.equal(dedupeKey("https://x.com/someone?s=20"), "x.com/someone?s=20");
  assert.equal(
    dedupeKey("https://news.example.org/story/1?t=12"),
    "news.example.org/story/1?t=12",
  );
});

test("the same X thread shared twice with different share codes is one study entry", async () => {
  const f = await fixture(judge(() => verdict("study")).api);
  try {
    f.pages.set(
      dedupeKey("https://x.com/someone/status/9"),
      page("Thread on agent architectures", "How the agents are wired."),
    );
    const links = f.links();
    const first: any = await links.save("123", {
      url: "https://x.com/someone/status/9?s=20&t=one",
    });
    assert.equal(first.outcome, "study");
    const again: any = await links.save("123", {
      url: "https://twitter.com/someone/status/9?s=46&t=two",
    });
    assert.equal(again.outcome, "duplicate", again.message);
    assert.match(again.message, /Already on your study list/);
    assert.equal(await studyCount(f.db), 1);
  } finally {
    await f.pg.close();
  }
});

test("a stored Reader auth refusal before anything is sent says not saved, not uncertain", async () => {
  const f = await fixture(judge(() => verdict("reader", { topic: null })).api);
  try {
    // src/mcp.ts refuses a connection with a stored auth failure before it transports
    // anything, so nothing can be in Reader and the reply must not say it might be.
    let calls = 0;
    const links = f.links({
      reader: () => ({
        save: async () => {
          calls++;
          throw new McpFailure("auth");
        },
        savedArticles: async () => ({
          articles: [],
          partial: false,
          skipped: 0,
        }),
      }),
    });
    const result: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this for offline reading",
    });
    assert.equal(result.outcome, "failed", result.message);
    assert.match(result.message, /nothing was saved/i);
    assert.doesNotMatch(result.message, /uncertain|may already/i);
    assert.equal(calls, 1);
    assert.equal(await studyCount(f.db), 0);
  } finally {
    await f.pg.close();
  }
});

test("a cancelled turn creates no choice card and writes nothing", async () => {
  const f = await fixture(judge(() => verdict("study")).api);
  try {
    const controller = new AbortController();
    controller.abort();
    const error = await f
      .links()
      .save(
        "123",
        { url: "https://example.org/agents", ownerMessage: "save this" },
        controller.signal,
      )
      .then(() => undefined)
      .catch((e) => e);
    assert.ok(error instanceof ToolValidationError, String(error));
    assert.match(error.message, /cancelled/i);
    const cards = (
      await f.db.query("SELECT count(*)::int AS n FROM link_decisions")
    ).rows[0].n;
    assert.equal(cards, 0);
    assert.equal(f.asked.length, 0);
    assert.equal(await studyCount(f.db), 0);
  } finally {
    await f.pg.close();
  }
});

test("a turn cannot save a link straight to Reader; it is pointed at link_save", async () => {
  const f = await fixture(judge(() => verdict("study")).api);
  try {
    const run = randomUUID();
    await f.db.query("INSERT INTO runtime_runs(id,user_id) VALUES($1,'123')", [
      run,
    ]);
    const tools = jobTools(f.db, f.links(), f.reader.make(f.db));
    await assert.rejects(
      tools.execute("123", run, {
        operation: "mcp_write",
        connection: "reader",
        tool: "save_link",
        requestKey: randomUUID(),
        arguments: { url: "https://example.org/agents" },
      }),
      (error: any) => {
        assert.ok(error instanceof ToolValidationError, String(error));
        assert.match(error.message, /link_save/);
        assert.match(error.message, /nothing was sent/i);
        return true;
      },
    );
    // Nothing reached Reader and nothing was persisted.
    assert.equal(f.reader.calls.length, 0);
    const operations = (
      await f.db.query("SELECT count(*)::int AS n FROM mcp_operations")
    ).rows[0].n;
    assert.equal(operations, 0);
    // Other Reader writes are not the link path, so they are not refused by this guard.
    assert.equal(
      await f.db
        .query(
          "SELECT count(*)::int AS n FROM mcp_operations WHERE tool='save_link'",
        )
        .then((r) => r.rows[0].n),
      0,
    );
  } finally {
    await f.pg.close();
  }
});

test("the host's record of the owner's turn is what the classifier reads", async () => {
  const seen: any[] = [];
  const f = await fixture({
    judge: async (input) => {
      seen.push(input);
      return verdict(
        /offline reading/i.test(input.message) ? "reader" : "study",
        {
          topic: null,
        },
      );
    },
  });
  try {
    const run = randomUUID();
    await f.db.query("INSERT INTO runtime_runs(id,user_id) VALUES($1,'123')", [
      run,
    ]);
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'123',$2)",
      [run, "save this tutorial for offline reading"],
    );
    const tools = jobTools(f.db, f.links());
    const result: any = await tools.execute("123", run, {
      operation: "link_save",
      url: "https://example.org/agents",
      // A paraphrase the model wrote must not replace the owner's own words.
      ownerMessage: "save this",
    });
    // The cue in the host's record decided the route, so the owner's words really arrived.
    assert.equal(result.outcome, "reader", JSON.stringify(result));
    assert.equal(seen[0].message, "save this tutorial for offline reading");
    assert.equal(await studyCount(f.db), 0);
  } finally {
    await f.pg.close();
  }
});

test("a Reader save that timed out is settled from chat, and later writes are not blocked", async () => {
  // Review blocking finding: the guard that sends a Reader link save back to link_save must
  // still let a replay of Chief's own persisted request through, or one timeout would refuse
  // every ordinary write for ever.
  const f = await fixture(judge(() => verdict("reader", { topic: null })).api);
  try {
    const run = randomUUID();
    await f.db.query("INSERT INTO runtime_runs(id,user_id) VALUES($1,'123')", [
      run,
    ]);
    const mcp = f.reader.make(f.db);
    const tools = jobTools(f.db, f.links(), mcp);
    // Reader times out: the link save is uncertain and its mcp_operations row stays pending.
    f.reader.fail("uncertain");
    const saved: any = await tools.execute("123", run, {
      operation: "link_save",
      url: "https://example.org/agents",
    });
    assert.equal(saved.outcome, "uncertain", saved.message);
    const key = f.reader.calls[0]!.key;
    // While it is pending the host gate refuses an ordinary write...
    assert.equal(
      await mcp.pendingAllows("123", {
        operation: "memory_set",
        key: "python",
        value: "3.13",
      }),
      false,
    );
    // ...and the documented recovery is a replay of that exact request, with no arguments.
    const settled: any = await tools.execute("123", run, {
      operation: "mcp_write",
      connection: "reader",
      tool: "save_link",
      requestKey: key,
    });
    assert.equal(settled.state, "complete", JSON.stringify(settled));
    // The pending row is gone, so the unrelated write is allowed again.
    assert.equal(
      await mcp.pendingAllows("123", {
        operation: "memory_set",
        key: "python",
        value: "3.13",
      }),
      true,
    );
  } finally {
    await f.pg.close();
  }
});

test("a replay bound to another payload is still refused, so the guard is not a back door", async () => {
  const f = await fixture(judge(() => verdict("reader", { topic: null })).api);
  try {
    const run = randomUUID();
    await f.db.query("INSERT INTO runtime_runs(id,user_id) VALUES($1,'123')", [
      run,
    ]);
    const tools = jobTools(f.db, f.links(), f.reader.make(f.db));
    await tools.execute("123", run, {
      operation: "link_save",
      url: "https://example.org/agents",
    });
    const key = f.reader.calls[0]!.key;
    await assert.rejects(
      tools.execute("123", run, {
        operation: "mcp_write",
        connection: "reader",
        tool: "save_link",
        requestKey: key,
        // A different payload under a persisted key is not a replay of it.
        arguments: { url: "https://example.org/something-else" },
      }),
      (error: any) => {
        assert.ok(error instanceof ToolValidationError, String(error));
        assert.match(error.message, /link_save/);
        return true;
      },
    );
    assert.equal(f.reader.calls.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("a Reader failure before Chief persisted the request says nothing was saved", async () => {
  const f = await fixture(judge(() => verdict("reader", { topic: null })).api);
  try {
    // No mcp_operations row means the request never left Chief, which src/mcp.ts guarantees
    // by writing the row before it contacts the server.
    const links = f.links({
      reader: () =>
        ({
          save: async () => {
            throw new Error("connect ECONNREFUSED reader.example.com");
          },
        }) as any,
    });
    const result: any = await links.save("123", {
      url: "https://example.org/agents",
      ownerMessage: "save this for offline reading",
    });
    assert.equal(result.outcome, "failed", result.message);
    assert.match(result.message, /nothing was saved/i);
    assert.doesNotMatch(result.message, /uncertain|may already/i);
    assert.equal(await studyCount(f.db), 0);
  } finally {
    await f.pg.close();
  }
});

test("both writes landing are reported as saved even when the cross-reference fails", async () => {
  // The Reader copy and the study entry exist; a failed markReaderSaved must not turn the
  // pair into "nothing was written" (review nit).
  class FailingStore extends StudyStore {
    async markReaderSaved() {
      throw new Error("the collection is unavailable");
    }
  }
  const f = await fixture(judge(() => verdict("both")).api);
  try {
    const result: any = await f
      .links({ store: new FailingStore(f.db) })
      .save("123", { url: "https://example.org/agents" });
    assert.equal(result.outcome, "both", result.message);
    assert.match(result.message, /study list and to Reader/);
    assert.equal(await studyCount(f.db), 1);
    assert.equal(f.reader.calls.length, 1);
  } finally {
    await f.pg.close();
  }
});
