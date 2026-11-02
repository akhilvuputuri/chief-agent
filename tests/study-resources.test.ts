import test from "node:test";
import assert from "node:assert/strict";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { Study, readerRequestKey, studyLimits } from "../src/study.js";
import {
  readLinkRouting,
  type LinkClassification,
  type LinkFacts,
} from "../src/link-router.js";
import type { ReaderLink } from "../src/news.js";
import { ToolValidationError } from "../src/tool-errors.js";
import { domainOf, selectDomains } from "../src/tool-domains.js";
import { runtimeContext } from "../src/runtime.js";

const config = readLinkRouting();

const pageFor = (title: string, topic = "Engineering") =>
  `<html><head><title>${title}</title><meta property="og:site_name" content="Example Engineering"><meta property="article:section" content="${topic}"><meta name="description" content="A walkthrough with planner loops."></head><body></body></html>`;

/** Every URL resolves to `pages[url]`, or to a one-paragraph page. */
const fetcher = (pages: Record<string, string> = {}) => ({
  get: async (url: string) => ({
    body: pages[url] ?? pageFor("A page"),
    finalUrl: url,
  }),
});

const judge = (
  decision: Partial<LinkClassification> = {},
  seen: { facts: LinkFacts[] } = { facts: [] },
) => ({
  config,
  model: "typesafe/jev-test",
  calls: 0,
  async classify(facts: LinkFacts) {
    this.calls++;
    seen.facts.push(facts);
    return {
      ok: true,
      verdict: "study" as const,
      probabilities: { study: 0.9, reader: 0.1 },
      confidence: 0.9,
      via: "reading" as const,
      model: "typesafe/jev-test",
      latencyMs: 1,
      costUsd: 0.001,
      ...decision,
    } satisfies LinkClassification;
  },
});

const readerWith = () => {
  const saved: { key: string; url: string }[] = [];
  const link: ReaderLink = {
    save: async (_user, requestKey, url) => {
      saved.push({ key: requestKey, url });
      return { state: "complete" };
    },
    savedArticles: async () => ({ articles: [], partial: false, skipped: 0 }),
  };
  return { saved, link };
};

async function fixture(
  deps: {
    classifier?: ReturnType<typeof judge> | object;
    reader?: ReaderLink;
    pages?: Record<string, string>;
  } = {},
) {
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  await ensureUser(db, "a");
  await ensureUser(db, "b");
  const store = new Study(db, {
    classifier: deps.classifier as any,
    fetcher: fetcher(deps.pages),
    ...(deps.reader ? { reader: () => deps.reader } : {}),
  });
  return {
    pg,
    db,
    store,
    call: (user: string, input: object) =>
      store.call(user, input as any, "run"),
  };
}

test("a confident study judgment is saved once, with its reason and confidence", async () => {
  const seen = { facts: [] as LinkFacts[] };
  const classifier = judge({}, seen);
  const reader = readerWith();
  const f = await fixture({
    classifier,
    reader: reader.link,
    pages: {
      "https://example.com/agents": pageFor("Building agent platforms"),
    },
  });
  try {
    const result: any = await f.call("a", {
      operation: "link_save",
      url: "https://example.com/agents",
      ownerMessage: "save this",
    });
    assert.equal(result.savedTo, "study");
    assert.equal(result.needsChoice, false);
    assert.equal(result.title, "Building agent platforms");
    assert.equal(result.source, "Example Engineering");
    assert.equal(result.topic, "Engineering");
    assert.equal(result.confidence, 90);
    assert.match(result.reason, /Building agent platforms/);
    assert.match(result.excerpt, /planner loops/);
    assert.equal(reader.saved.length, 0);
    assert.equal(classifier.calls, 1);
    // The owner's own words reach the classifier as the explicit-cue signal.
    assert.equal(seen.facts[0]!.ownerMessage, "save this");
    assert.equal(seen.facts[0]!.page.title, "Building agent platforms");
    const row = (await f.db.query("SELECT * FROM study_resources")).rows[0]!;
    assert.equal(row.user_id, "a");
    assert.equal(row.status, "to_study");
    assert.equal(row.classification.destination, "study");
    assert.equal(row.classification.confidence, 0.9);
    assert.equal(row.classification.model, "typesafe/jev-test");
  } finally {
    await f.pg.close();
  }
});

test("a confident reading judgment goes to Reader and writes no study row", async () => {
  const reader = readerWith();
  const f = await fixture({
    classifier: judge({
      verdict: "reader",
      probabilities: { study: 0.1, reader: 0.9 },
    }),
    reader: reader.link,
  });
  try {
    const result: any = await f.call("a", {
      operation: "link_save",
      url: "https://example.com/essay",
    });
    assert.equal(result.savedTo, "reader");
    assert.equal(result.needsChoice, false);
    assert.equal(reader.saved.length, 1);
    assert.equal(reader.saved[0]!.url, "https://example.com/essay");
    assert.match(reader.saved[0]!.key, /^[0-9a-f-]{36}$/);
    assert.equal(
      (await f.db.query("SELECT * FROM study_resources")).rows.length,
      0,
    );
  } finally {
    await f.pg.close();
  }
});

test("an unsure judgment asks with a durable prompt and saves nowhere", async () => {
  const reader = readerWith();
  const f = await fixture({
    classifier: judge({
      verdict: "unsure",
      confidence: 0.4,
      probabilities: { study: 0.4, reader: 0.4 },
      via: undefined,
    }),
    reader: reader.link,
  });
  try {
    const result: any = await f.call("a", {
      operation: "link_save",
      url: "https://example.com/maybe",
    });
    assert.equal(result.needsChoice, true);
    assert.ok(result.promptId);
    assert.equal(reader.saved.length, 0);
    assert.equal(
      (await f.db.query("SELECT * FROM study_resources")).rows.length,
      0,
    );
    const pending: any[] = await f.store.pending("a");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.id, result.promptId);
    await f.store.announced("a", result.promptId);
    assert.equal((await f.store.pending("a")).length, 0);
    // Repeating "save this" reuses the open question instead of stacking cards.
    const again: any = await f.call("a", {
      operation: "link_save",
      url: "https://www.example.com/maybe/?utm_source=x",
    });
    assert.equal(again.promptId, result.promptId);
    assert.equal(
      (await f.db.query("SELECT * FROM study_link_prompts")).rows.length,
      1,
    );
  } finally {
    await f.pg.close();
  }
});

test("a classifier that cannot answer asks instead of defaulting to Reader", async () => {
  const reader = readerWith();
  const f = await fixture({
    classifier: {
      config,
      model: null,
      async classify() {
        return {
          ok: false,
          verdict: "unsure",
          probabilities: {},
          confidence: 0,
          latencyMs: 1,
          costUsd: null,
          model: null,
          error: "timeout",
        };
      },
    },
    reader: reader.link,
  });
  try {
    const result: any = await f.call("a", {
      operation: "link_save",
      url: "https://example.com/x",
    });
    assert.equal(result.needsChoice, true);
    assert.equal(reader.saved.length, 0);
    assert.equal(
      (await f.db.query("SELECT * FROM study_resources")).rows.length,
      0,
    );
    // Without a classifier at all the behaviour is the same, never a Reader save.
    const bare = new Study(f.db, { fetcher: fetcher() });
    const saved: any = await bare.call(
      "a",
      { operation: "link_save", url: "https://example.com/y" } as any,
      "run",
    );
    assert.equal(saved.needsChoice, true);
    assert.equal(reader.saved.length, 0);
  } finally {
    await f.pg.close();
  }
});

test("an explicit owner cue decides the destination", async () => {
  const seen = { facts: [] as LinkFacts[] };
  const classifier = judge(
    {
      verdict: "study",
      confidence: 0.3,
      via: "cue",
      cue: 0.93,
      probabilities: { study: 0.3, reader: 0.6 },
    },
    seen,
  );
  const f = await fixture({ classifier, reader: readerWith().link });
  try {
    const result: any = await f.call("a", {
      operation: "link_save",
      url: "https://example.com/learning",
      ownerMessage: "save this for AI learning",
    });
    assert.equal(result.savedTo, "study");
    assert.equal(
      seen.facts[0]!.ownerMessage,
      "save this for ai learning".replace("ai", "AI"),
    );
    assert.match(result.reason, /You said "save this for AI learning"/);
  } finally {
    await f.pg.close();
  }
});

test("duplicate URLs are detected across tracking parameters and www", async () => {
  const f = await fixture({ classifier: judge() });
  try {
    const first: any = await f.call("a", {
      operation: "link_save",
      url: "https://example.com/agents",
    });
    const second: any = await f.call("a", {
      operation: "link_save",
      url: "https://www.example.com/agents/?utm_source=x",
    });
    assert.equal(first.duplicate, false);
    assert.equal(second.savedTo, "study");
    assert.equal(second.duplicate, true);
    assert.equal(second.id, first.id);
    assert.equal(
      (await f.db.query("SELECT * FROM study_resources")).rows.length,
      1,
    );
    // Another owner is a different collection.
    const other: any = await f.call("b", {
      operation: "link_save",
      url: "https://example.com/agents",
    });
    assert.equal(other.duplicate, false);
  } finally {
    await f.pg.close();
  }
});

test("an explicit study save records the owner's decision without asking Jev", async () => {
  const classifier = judge();
  const f = await fixture({ classifier });
  try {
    const result: any = await f.call("a", {
      operation: "study_save",
      url: "https://example.com/notes",
      topic: "Agent platforms",
      tags: ["agents", "tools"],
      notes: "Read before the design review",
    });
    assert.equal(result.savedTo, "study");
    assert.equal(result.topic, "Agent platforms");
    assert.deepEqual(result.tags, ["agents", "tools"]);
    assert.equal(classifier.calls, 0);
    const row = (await f.db.query("SELECT * FROM study_resources")).rows[0]!;
    assert.equal(
      row.classification.reason,
      "You asked for this on your study list.",
    );
    assert.equal(row.classification.explicit, true);
    assert.equal(row.status, "to_study");
    const again: any = await f.call("a", {
      operation: "study_save",
      url: "https://example.com/notes",
    });
    assert.equal(again.duplicate, true);
  } finally {
    await f.pg.close();
  }
});

test("the list filters by topic, tag and status and stays bounded", async () => {
  const f = await fixture();
  try {
    const saved: any[] = [];
    for (let i = 0; i < 12; i++)
      saved.push(
        await f.call("a", {
          operation: "study_save",
          url: `https://example.com/item-${i}`,
          ...(i % 2 === 0 ? { topic: "Voice AI" } : { topic: "Agents" }),
          ...(i === 0 ? { tags: ["voice"] } : {}),
        }),
      );
    await f.call("a", {
      operation: "study_update",
      id: saved[1].id,
      status: "done",
    });
    const all: any = await f.call("a", { operation: "study_list" });
    assert.equal(all.count, studyLimits.listPage);
    assert.equal(all.items.length, studyLimits.listPage);
    assert.equal(all.more, true);
    assert.equal(all.counts.to_study + all.counts.done, 12);
    assert.equal(all.items[0]!.id, saved.at(-1)!.id);
    assert.match(
      all.lines[0]!,
      /A page — Example Engineering · Agents · to study/,
    );
    const byTag: any = await f.call("a", {
      operation: "study_list",
      tag: "voice",
    });
    assert.equal(byTag.items.length, 1);
    assert.equal(byTag.items[0]!.id, saved[0]!.id);
    const byTopic: any = await f.call("a", {
      operation: "study_list",
      topic: "voice ai",
    });
    assert.equal(byTopic.items.length, 6);
    const done: any = await f.call("a", {
      operation: "study_list",
      status: "done",
    });
    assert.equal(done.items.length, 1);
    assert.equal(done.items[0]!.id, saved[1].id);
    const empty: any = await f.call("a", {
      operation: "study_list",
      tag: "nope",
    });
    assert.equal(empty.count, 0);
    assert.match(empty.note, /Nothing saved/);
    // Another owner's list is separate and empty.
    const other: any = await f.call("b", { operation: "study_list" });
    assert.equal(other.count, 0);
  } finally {
    await f.pg.close();
  }
});

test("status, notes and tags update on an exact owner-scoped item", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.call("a", {
      operation: "study_save",
      url: "https://example.com/update-me",
    });
    const updated: any = await f.call("a", {
      operation: "study_update",
      id: saved.id,
      status: "in_progress",
      notes: "Chapter 3",
      tags: ["agents"],
      topic: "Agents",
    });
    assert.equal(updated.item.status, "in_progress");
    assert.equal(updated.item.notes, "Chapter 3");
    assert.match(
      updated.line,
      /A page — Example Engineering · Agents · in progress/,
    );
    const cleared: any = await f.call("a", {
      operation: "study_update",
      id: saved.id,
      notes: "",
    });
    assert.equal(cleared.item.notes, null);
    assert.equal(cleared.item.status, "in_progress");
    await assert.rejects(
      f.call("a", { operation: "study_update", id: saved.id }),
      ToolValidationError,
    );
    await assert.rejects(
      f.call("b", { operation: "study_update", id: saved.id, status: "done" }),
      ToolValidationError,
    );
  } finally {
    await f.pg.close();
  }
});

test("remove deletes only the owner's item", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.call("a", {
      operation: "study_save",
      url: "https://example.com/drop-me",
    });
    await assert.rejects(
      f.call("b", { operation: "study_remove", id: saved.id }),
      ToolValidationError,
    );
    const removed: any = await f.call("a", {
      operation: "study_remove",
      id: saved.id,
    });
    assert.equal(removed.removed, true);
    assert.equal(
      (await f.db.query("SELECT * FROM study_resources")).rows.length,
      0,
    );
  } finally {
    await f.pg.close();
  }
});

test("corrections move an item between the study list and Reader", async () => {
  const reader = readerWith();
  const f = await fixture({ classifier: judge(), reader: reader.link });
  try {
    const saved: any = await f.call("a", {
      operation: "study_save",
      url: "https://example.com/move-me",
    });
    const moved: any = await f.call("a", {
      operation: "study_move",
      to: "reader",
      id: saved.id,
    });
    assert.equal(moved.savedTo, "reader");
    assert.equal(reader.saved.length, 1);
    assert.equal(
      (await f.db.query("SELECT * FROM study_resources")).rows.length,
      0,
    );
    const back: any = await f.call("a", {
      operation: "study_move",
      to: "study",
      url: "https://example.com/move-me",
    });
    assert.equal(back.savedTo, "study");
    assert.match(back.note, /Reader keeps its own copy/);
    const row = (await f.db.query("SELECT * FROM study_resources")).rows[0]!;
    assert.equal(
      row.classification.reason,
      "You moved this to your study list.",
    );
    // Without a Reader connection a move fails loudly instead of losing the item.
    const bare = new Study(f.db, { classifier: judge(), fetcher: fetcher() });
    await assert.rejects(
      bare.call(
        "a",
        { operation: "study_move", to: "reader", id: saved.id } as any,
        "run",
      ),
      ToolValidationError,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM study_resources")).rows.length,
      1,
    );
  } finally {
    await f.pg.close();
  }
});

test("a refused Reader save at classification time asks instead of losing the link", async () => {
  const failing: ReaderLink = {
    save: async () => {
      throw new Error("The article link could not be verified");
    },
    savedArticles: async () => ({ articles: [], partial: false, skipped: 0 }),
  };
  const f = await fixture({
    classifier: judge({
      verdict: "reader",
      probabilities: { study: 0.1, reader: 0.9 },
    }),
    reader: failing,
  });
  try {
    const result: any = await f.call("a", {
      operation: "link_save",
      url: "https://example.com/unverifiable",
    });
    assert.equal(result.needsChoice, true);
    assert.match(result.readerError, /could not be verified/);
    assert.equal((await f.store.pending("a")).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("a tapped choice saves once and is not replayed", async () => {
  const reader = readerWith();
  const f = await fixture({
    classifier: judge({ verdict: "unsure", confidence: 0.4, via: undefined }),
    reader: reader.link,
  });
  try {
    const ask: any = await f.call("a", {
      operation: "link_save",
      url: "https://example.com/tap",
    });
    const study = await f.store.resolvePrompt("a", ask.promptId, "study");
    assert.equal(study.ok, true);
    assert.match(study.text, /Saved to your study list/);
    assert.equal(reader.saved.length, 0);
    assert.equal(
      (await f.db.query("SELECT * FROM study_resources")).rows.length,
      1,
    );
    const again = await f.store.resolvePrompt("a", ask.promptId, "both");
    assert.equal(again.ok, false);
    assert.match(again.text, /expired or was already answered/);
    assert.equal(reader.saved.length, 0);
    // A foreign owner cannot answer it either.
    const foreign = await f.store.resolvePrompt("b", ask.promptId, "study");
    assert.equal(foreign.ok, false);
  } finally {
    await f.pg.close();
  }
});

test("choosing Reader or both resolves the prompt and saves to both places", async () => {
  const reader = readerWith();
  const f = await fixture({
    classifier: judge({ verdict: "unsure", confidence: 0.4, via: undefined }),
    reader: reader.link,
  });
  try {
    const first: any = await f.call("a", {
      operation: "link_save",
      url: "https://example.com/both",
    });
    const both = await f.store.resolvePrompt("a", first.promptId, "both");
    assert.equal(both.ok, true);
    assert.match(both.text, /study list and Reader/);
    assert.equal(reader.saved.length, 1);
    const resolved = (await f.db.query("SELECT * FROM study_link_prompts"))
      .rows[0]!;
    assert.equal(resolved.resolution, "both");
    assert.ok(resolved.resolved_at);
    const second: any = await f.call("a", {
      operation: "link_save",
      url: "https://example.com/reader-only",
    });
    const value = await f.store.resolvePrompt("a", second.promptId, "reader");
    assert.equal(value.ok, true);
    assert.equal(reader.saved.length, 2);
    assert.equal(
      (await f.db.query("SELECT * FROM study_resources")).rows.length,
      1,
    );
  } finally {
    await f.pg.close();
  }
});

test("a failed Reader save leaves the ask open and keeps the study copy", async () => {
  const flaky: ReaderLink = {
    save: async () => {
      throw new Error("Reader is unavailable");
    },
    savedArticles: async () => ({ articles: [], partial: false, skipped: 0 }),
  };
  const f = await fixture({
    classifier: judge({ verdict: "unsure", confidence: 0.4, via: undefined }),
    reader: flaky,
  });
  try {
    const ask: any = await f.call("a", {
      operation: "link_save",
      url: "https://example.com/flaky",
    });
    const outcome = await f.store.resolvePrompt("a", ask.promptId, "both");
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /Reader could not take/);
    assert.match(outcome.text, /It is on your study list/);
    const row = (await f.db.query("SELECT * FROM study_link_prompts")).rows[0]!;
    assert.equal(row.resolved_at, null);
  } finally {
    await f.pg.close();
  }
});

test("Reader request keys are stable per owner and link", () => {
  const key = readerRequestKey("a", "https://example.com/x?utm_source=y");
  assert.equal(
    readerRequestKey("a", "https://example.com/x"),
    readerRequestKey("a", "https://example.com/x"),
  );
  assert.equal(
    readerRequestKey("a", "https://example.com/x"),
    readerRequestKey("a", "https://example.com/x?utm_source=z"),
  );
  assert.notEqual(key, readerRequestKey("b", "https://example.com/x"));
  assert.match(
    key,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("study tools belong to their own domain and cues select it", () => {
  assert.equal(domainOf("link_save"), "study");
  assert.equal(domainOf("study_list"), "study");
  assert.equal(domainOf("link_resolve"), undefined);
  assert.equal(domainOf("study_update"), "study");
  const cue = (message: string) => [...selectDomains({ message })];
  assert.ok(cue("save this link").includes("study"));
  assert.ok(cue("https://example.com/x").includes("study"));
  assert.ok(cue("what's on my study list").includes("study"));
  assert.ok(!cue("hello there").includes("study"));
  const on = runtimeContext(
    { web: true, study: true },
    null,
    undefined,
    new Set(["study"] as any),
  );
  for (const name of [
    "link_save",
    "study_save",
    "study_list",
    "study_update",
    "study_remove",
    "study_move",
  ])
    assert.ok(
      on.tools.some((t) => t.name === name),
      name,
    );
  const off = runtimeContext({ web: true }, null, undefined, new Set());
  assert.ok(!off.tools.some((t) => t.name === "link_save"));
  assert.ok(!("study" in (JSON.parse(off.context).toolDomains.loadable ?? {})));
});
