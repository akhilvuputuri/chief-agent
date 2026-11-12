import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { McpTools } from "../src/mcp.js";
import { McpFailure, type McpTransport } from "../src/mcp-client.js";
import { canonicalUrl, LinkTools, choiceCard } from "../src/links.js";
import {
  LinkClassifier,
  linkQuestions,
  readLinkConfig,
} from "../src/link-classifier.js";
import { readDecisionConfig } from "../src/shadow.js";
import { JobTools } from "../src/tools.js";
import { action } from "../src/protocol.js";
import { telegram, sendLinkChoices } from "../src/telegram.js";
import { readConfig } from "../src/config.js";
import type { FeedFetcher } from "../src/news-feed.js";
import { pageMeta } from "../src/news-feed.js";

const token = "test-credential-for-links-only";
const registry = {
  version: 1,
  connections: [
    {
      id: "reader",
      url: "https://reader.example.com/mcp",
      credential: "reader",
      description: "Save articles",
      tools: [
        {
          name: "save_link",
          mode: "idempotent_write",
          idempotencyArgument: "idempotency_key",
          result: "reader_receipt",
        },
      ],
    },
  ],
};
const saveLinkSchema = {
  type: "object",
  properties: {
    url: { type: "string", format: "uri", maxLength: 2048 },
    idempotency_key: { type: "string" },
  },
  required: ["url", "idempotency_key"],
  additionalProperties: false,
};
const text = (data: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});
type Behaviour = "ok" | "reject" | "uncertain" | "throw";

/**
 * Reader as Chief sees it: the real McpTools (which replays a stored key and refuses a
 * different payload under the same key) over a fake remote server that, like Reader, also
 * remembers each idempotency key with its URL and refuses a different URL under it.
 */
function fakeReader(db: Database) {
  const sent: { key: string; url: string }[] = [];
  const server = new Map<string, { url: string; id: string }>();
  let behaviour: Behaviour = "ok";
  const transport: McpTransport = async (_url, supplied, use) => {
    assert.equal(supplied, token);
    return use({
      list: async () => [{ name: "save_link", inputSchema: saveLinkSchema }],
      call: async (_name, args) => {
        const key = String(args.idempotency_key);
        const url = String(args.url);
        sent.push({ key, url });
        if (behaviour === "throw") throw new Error("socket hang up");
        if (behaviour === "uncertain") throw new McpFailure("uncertain");
        if (behaviour === "reject") throw new McpFailure("invalid");
        const known = server.get(key);
        if (known && known.url !== url) throw new McpFailure("invalid");
        const id = known?.id ?? randomUUID();
        server.set(key, { url, id });
        return text({
          submission_id: id,
          status: "ready",
          duplicate: !!known,
        });
      },
    });
  };
  const mcp = new McpTools(
    db,
    registry,
    { reader: { owner: "123", token } },
    transport,
    async () => {},
  );
  return {
    mcp,
    sent,
    set: (b: Behaviour) => {
      behaviour = b;
    },
  };
}

const page = (title: string, site: string, body: string) =>
  `<html><head><title>${title} | ${site}</title><meta property="og:title" content="${title}"><meta property="og:site_name" content="${site}"><meta name="description" content="${body.slice(0, 80)}"></head><body><p>${body}</p></body></html>`;
const PAGES: Record<string, string> = {
  "https://x.com/dev/status/1": page(
    "A thread on agent architectures: planners, tools and memory",
    "X",
    "Here is how I structure production agent systems: a planner, a tool router and a memory layer, with evaluations at each step.",
  ),
  "https://news.example.com/2026/city-budget": page(
    "City council passes the annual budget",
    "Example News",
    "The council voted on Tuesday to approve the budget after a long debate about transport spending and housing.",
  ),
};
/** Links that redirect, as twitter.com does to x.com. */
const REDIRECTS: Record<string, string> = {
  "https://twitter.com/dev/status/1": "https://x.com/dev/status/1",
};
let fetchDown = false;
const fetcher: FeedFetcher = {
  async get(url) {
    if (fetchDown) throw new Error("Feed request failed (HTTP 503)");
    const bare = url.split("?")[0]!;
    const finalUrl = REDIRECTS[bare] ?? bare;
    const body = PAGES[finalUrl];
    if (!body) throw new Error("Feed request failed (HTTP 404)");
    return { body, finalUrl };
  },
};

/** Jev over a recorded transport: answers per destination and probability, or fails. */
function jev(
  answer:
    | { destination?: "study" | "reader"; p?: number; topic?: string }
    | "timeout"
    | "malformed",
) {
  const requests: any[] = [];
  const transport = (async (_url: string, init: any) => {
    requests.push(JSON.parse(init.body));
    if (answer === "timeout") {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }
    if (answer === "malformed")
      return Response.json({ answers: { destination: { choice: "maybe" } } });
    const answers: any = {};
    if (answer.destination)
      answers.destination = {
        choice: answer.destination,
        probabilities: {
          [answer.destination]: answer.p ?? 0.9,
          [answer.destination === "study" ? "reader" : "study"]:
            1 - (answer.p ?? 0.9),
        },
      };
    if (answer.topic)
      answers.topic = {
        choice: answer.topic,
        probabilities: { [answer.topic]: 0.8 },
      };
    return Response.json({ answers, usage: { cost: 0.00008 } });
  }) as typeof fetch;
  return {
    classifier: new LinkClassifier("key", undefined, transport),
    requests,
  };
}

const INTERESTS = [
  "applied AI engineering",
  "agent platforms",
  "developer tools",
  "voice/conversational AI",
];

async function fixture(
  answer: Parameters<typeof jev>[0] = { destination: "study" },
  wrap?: (db: Database) => Database,
) {
  const pg = await migratedPGlite();
  const raw = pg as unknown as Database;
  await ensureUser(raw, "123");
  await ensureUser(raw, "456");
  const db = wrap ? wrap(raw) : raw;
  const reader = fakeReader(raw);
  const j = jev(answer);
  const links = new LinkTools(db, {
    classifier: j.classifier,
    fetcher,
    mcp: () => reader.mcp,
  });
  const run = randomUUID();
  await raw.query("INSERT INTO runtime_runs(id,user_id) VALUES($1,'123')", [
    run,
  ]);
  const say = (message: string) =>
    raw.query(
      "INSERT INTO conversation_inputs(id,user_id,run_id,message) VALUES($1,'123',$2,$3)",
      [randomUUID(), run, message],
    );
  const rows = async (table: string) =>
    (await raw.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
  return { pg, db: raw, links, reader, jev: j, run, say, rows };
}
const save = (url: string, extra: Record<string, unknown> = {}) =>
  action.parse({
    operation: "link_save",
    url,
    interests: INTERESTS,
    ...extra,
  }) as any;

test("canonical URL strips tracking and X share parameters, sorts the rest, and stays public", () => {
  assert.equal(
    canonicalUrl("https://X.com/dev/status/1?s=20&t=abc&utm_source=tw#frag"),
    "https://x.com/dev/status/1",
  );
  assert.equal(
    canonicalUrl("https://example.com/a?b=2&a=1&fbclid=x&utm_medium=y"),
    "https://example.com/a?a=1&b=2",
  );
  assert.equal(
    canonicalUrl("https://www.reddit.com/r/x/comments/abc/t/?share=1"),
    "https://www.reddit.com/r/x/comments/abc/t/",
  );
  // A plain http link is upgraded; a link that is not a public hostname is refused.
  assert.equal(
    canonicalUrl("http://Blog.Example.com/post?utm_source=x"),
    "https://blog.example.com/post",
  );
  assert.throws(() => canonicalUrl("https://localhost/a"));
  assert.throws(() => canonicalUrl("https://10.0.0.1/a"));
  assert.throws(() => canonicalUrl("https://example.com:8443/a"));
});

test("page facts come from the page, and a missing title stays null", () => {
  const meta = pageMeta(PAGES["https://x.com/dev/status/1"]!);
  assert.equal(
    meta.title,
    "A thread on agent architectures: planners, tools and memory",
  );
  assert.equal(meta.site, "X");
  assert.match(meta.excerpt ?? "", /planner, a tool router/);
  assert.deepEqual(pageMeta("<html><body>hi</body></html>"), {
    title: null,
    site: null,
    description: null,
    excerpt: null,
  });
});

test("link config parses and has no model of its own; the classifier uses Jev from decisions.json", () => {
  const config = readLinkConfig();
  assert.ok(config.confident > 0.5 && config.confident < 1);
  assert.equal("model" in config, false);
  const j = jev({ destination: "study" });
  assert.equal(j.classifier.model, readDecisionConfig().model);
  assert.match(j.classifier.model, /^typesafe\/jev-/);
  // An explicit cue skips the destination question; interests still get a topic question.
  const qs = linkQuestions(config, {
    ownerMessage: "",
    page: {
      url: "https://a.b/",
      site: "a.b",
      title: null,
      description: null,
      excerpt: null,
    },
    interests: ["x"],
    explicit: "reader",
  });
  assert.deepEqual(Object.keys(qs), ["topic"]);
});

test("confident study: an X thread on agent architectures goes to the study list, never Reader", async () => {
  const f = await fixture({
    destination: "study",
    p: 0.93,
    topic: "interest_2",
  });
  try {
    await f.say("save this https://x.com/dev/status/1?s=20");
    const r: any = await f.links.call(
      "123",
      f.run,
      save("https://x.com/dev/status/1?s=20"),
    );
    assert.equal(r.state, "saved");
    assert.equal(r.destination, "study");
    assert.equal(r.topic, "agent platforms");
    assert.match(
      r.where,
      /^Saved to your study list \(agent platforms\)\. Say "move it to Reader" to change\.$/,
    );
    assert.equal(f.reader.sent.length, 0);
    const [row] = await f.rows("study_resources");
    assert.equal(row.url, "https://x.com/dev/status/1");
    assert.equal(
      row.title,
      "A thread on agent architectures: planners, tools and memory",
    );
    assert.equal(row.site, "X");
    assert.equal(row.status, "to_study");
    assert.equal(row.classified_by, "jev");
    assert.ok(Math.abs(row.classification_confidence - 0.93) < 1e-6);
    assert.match(row.classification_reason, /study material \(93%\)/);
    // Jev saw the owner's words, the page facts and the interests, on the configured model.
    const request = f.jev.requests[0];
    assert.equal(request.model, readDecisionConfig().model);
    assert.equal(
      request.state.owner_message,
      "save this https://x.com/dev/status/1?s=20",
    );
    assert.deepEqual(request.state.learning_interests, INTERESTS);
    assert.match(request.state.link.excerpt, /tool router/);
    assert.equal(request.questions.destination.type, "choice");
  } finally {
    await f.pg.close();
  }
});

test("confident reading: a news story goes to Reader with the canonical URL and no study row", async () => {
  const f = await fixture({ destination: "reader", p: 0.88 });
  try {
    const r: any = await f.links.call(
      "123",
      f.run,
      save("https://news.example.com/2026/city-budget?utm_source=x"),
    );
    assert.equal(r.destination, "reader");
    assert.equal(r.state, "saved", JSON.stringify(r.reader));
    assert.equal(r.reader.state, "complete");
    assert.deepEqual(
      f.reader.sent.map((s) => s.url),
      ["https://news.example.com/2026/city-budget"],
    );
    assert.equal((await f.rows("study_resources")).length, 0);
    assert.match(r.where, /Saved to Reader for offline reading\./);
  } finally {
    await f.pg.close();
  }
});

test("explicit owner cues override Jev both ways", async () => {
  const f = await fixture({ destination: "study", p: 0.99 });
  try {
    const toReader: any = await f.links.call(
      "123",
      f.run,
      save("https://x.com/dev/status/1", { destination: "reader" }),
    );
    assert.equal(toReader.destination, "reader");
    assert.equal(toReader.classifiedBy, "owner");
    assert.equal(toReader.reason, "You asked for Reader.");
    assert.equal((await f.rows("study_resources")).length, 0);
    assert.equal(f.reader.sent.length, 1);
    // No destination question was asked of Jev for an explicit cue.
    assert.equal(f.jev.requests[0].questions.destination, undefined);
  } finally {
    await f.pg.close();
  }
  const g = await fixture({ destination: "reader", p: 0.99 });
  try {
    const toStudy: any = await g.links.call(
      "123",
      g.run,
      save("https://news.example.com/2026/city-budget", {
        destination: "study",
      }),
    );
    assert.equal(toStudy.destination, "study");
    assert.equal(g.reader.sent.length, 0);
    const [row] = await g.rows("study_resources");
    assert.equal(row.classified_by, "owner");
    assert.equal(row.classification_confidence, 1);
  } finally {
    await g.pg.close();
  }
});

for (const [name, answer] of [
  ["low confidence", { destination: "reader", p: 0.55 }],
  ["a Jev timeout", "timeout"],
  ["a malformed answer", "malformed"],
] as const)
  test(`uncertain (${name}) creates a choice card with three buttons and never defaults to Reader`, async () => {
    const f = await fixture(answer as any);
    try {
      const r: any = await f.links.call(
        "123",
        f.run,
        save("https://news.example.com/2026/city-budget"),
      );
      assert.equal(r.state, "needs_choice");
      assert.match(r.where, /Study list, Reader or Both/);
      assert.equal(f.reader.sent.length, 0);
      assert.equal((await f.rows("study_resources")).length, 0);
      const [choice] = await f.rows("link_choices");
      assert.equal(choice.state, "open");
      assert.equal(choice.delivery, "pending");
      const card = choiceCard(choice);
      assert.deepEqual(
        card.buttons[0]!.map((b) => [b.text, b.callback_data]),
        [
          ["Study list", `lk:${choice.id}:s`],
          ["Reader", `lk:${choice.id}:r`],
          ["Both", `lk:${choice.id}:b`],
        ],
      );
      assert.match(card.text, /City council passes the annual budget/);
    } finally {
      await f.pg.close();
    }
  });

test("study store: duplicate detection, filters, updates, removal and owner isolation", async () => {
  const f = await fixture({
    destination: "study",
    p: 0.9,
    topic: "interest_1",
  });
  try {
    const first: any = await f.links.call(
      "123",
      f.run,
      save("https://x.com/dev/status/1", { tags: ["agents"] }),
    );
    const again: any = await f.links.call(
      "123",
      f.run,
      save("https://x.com/dev/status/1?utm_source=a&t=zz"),
    );
    assert.equal(again.study.duplicate, true);
    assert.equal(again.study.entry.id, first.study.entry.id);
    assert.match(again.where, /already on your study list/);
    assert.equal((await f.rows("study_resources")).length, 1);
    // Unreadable page: the title stays null rather than invented.
    const blank: any = await f.links.call(
      "123",
      f.run,
      save("https://docs.example.org/guide"),
    );
    assert.equal(blank.study.entry.title, null);
    assert.equal(blank.study.entry.site, "docs.example.org");
    const id = first.study.entry.id;
    const list = (a: Record<string, unknown>) =>
      f.links.call(
        "123",
        f.run,
        action.parse({ operation: "study_list", ...a }) as any,
      ) as any;
    assert.equal((await list({})).entries.length, 2);
    assert.equal((await list({ tag: "agents" })).entries.length, 1);
    assert.equal((await list({ topic: "applied AI" })).entries.length, 2);
    assert.equal((await list({ topic: "nothing like it" })).entries.length, 0);
    assert.equal((await list({ limit: 1 })).nextOffset, 1);
    const updated: any = await f.links.call(
      "123",
      f.run,
      action.parse({
        operation: "study_update",
        id,
        status: "in_progress",
        notes: "read part 1",
        tags: ["agents", "memory"],
      }) as any,
    );
    assert.equal(updated.entry.status, "in_progress");
    assert.equal(updated.entry.notes, "read part 1");
    assert.deepEqual(updated.entry.tags, ["agents", "memory"]);
    assert.equal((await list({ status: "in_progress" })).entries.length, 1);
    assert.deepEqual((await list({})).counts, { in_progress: 1, to_study: 1 });
    // Another owner can neither see nor change the entry.
    assert.equal(
      (
        (await f.links.call(
          "456",
          f.run,
          action.parse({ operation: "study_list" }) as any,
        )) as any
      ).entries.length,
      0,
    );
    await assert.rejects(
      f.links.call(
        "456",
        f.run,
        action.parse({ operation: "study_update", id, status: "done" }) as any,
      ),
      /not found/,
    );
    await assert.rejects(
      f.links.call(
        "456",
        f.run,
        action.parse({ operation: "study_remove", id }) as any,
      ),
      /not found/,
    );
    await assert.rejects(
      f.db.query("UPDATE study_resources SET status='finished' WHERE id=$1", [
        id,
      ]),
      /check/,
    );
    const removed: any = await f.links.call(
      "123",
      f.run,
      action.parse({ operation: "study_remove", id }) as any,
    );
    assert.equal(removed.removed, true);
    assert.equal((await list({})).entries.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("corrections: study to Reader removes the entry only after Reader confirms", async () => {
  const f = await fixture({ destination: "study", p: 0.9 });
  try {
    const saved: any = await f.links.call(
      "123",
      f.run,
      save("https://x.com/dev/status/1"),
    );
    const id = saved.study.entry.id;
    const move = () =>
      f.links.call(
        "123",
        f.run,
        action.parse({ operation: "link_move", id, to: "reader" }) as any,
      ) as any;
    f.reader.set("uncertain");
    const pending = await move();
    assert.equal(pending.moved, false);
    assert.equal(pending.reader.state, "pending");
    assert.match(pending.where, /stays on your study list/);
    assert.equal((await f.rows("study_resources")).length, 1);
    // The retry reuses the pending key and payload; Reader confirms; the entry goes.
    f.reader.set("ok");
    const done = await move();
    assert.equal(done.moved, true);
    assert.equal(done.reader.earlierPending, true);
    assert.equal(f.reader.sent[0]!.key, f.reader.sent[1]!.key);
    assert.equal((await f.rows("study_resources")).length, 0);
  } finally {
    await f.pg.close();
  }
});

test("corrections: a rejected move keeps the entry; Reader to study adds it and says Reader keeps its copy", async () => {
  const f = await fixture({ destination: "study", p: 0.9 });
  try {
    const saved: any = await f.links.call(
      "123",
      f.run,
      save("https://x.com/dev/status/1"),
    );
    f.reader.set("reject");
    const rejected: any = await f.links.call(
      "123",
      f.run,
      action.parse({
        operation: "link_move",
        id: saved.study.entry.id,
        to: "reader",
      }) as any,
    );
    assert.equal(rejected.reader.state, "rejected");
    assert.equal((await f.rows("study_resources")).length, 1);
    const toStudy: any = await f.links.call(
      "123",
      f.run,
      action.parse({
        operation: "link_move",
        url: "https://news.example.com/2026/city-budget",
        to: "study",
      }) as any,
    );
    assert.equal(toStudy.moved, true);
    assert.match(toStudy.where, /can't delete from Reader/);
    assert.equal((await f.rows("study_resources")).length, 2);
  } finally {
    await f.pg.close();
  }
});

test("item 8: one canonical URL for the key lookup and the payload; an earlier pending save is reused and named", async () => {
  const f = await fixture({ destination: "reader", p: 0.9 });
  try {
    f.reader.set("uncertain");
    const first: any = await f.links.call(
      "123",
      f.run,
      save("https://news.example.com/2026/city-budget?utm_source=a"),
    );
    assert.equal(first.reader.state, "pending");
    assert.equal(first.state, "not_confirmed");
    f.reader.set("ok");
    // Same link, different tracking parameters: same canonical payload, same key, no
    // "bound to another payload" refusal, and the owner is told about the earlier save.
    const second: any = await f.links.call(
      "123",
      f.run,
      save("https://news.example.com/2026/city-budget?utm_campaign=b&fbclid=c"),
    );
    assert.equal(second.reader.state, "complete");
    assert.equal(second.reader.earlierPending, true);
    assert.match(
      second.where,
      /earlier Reader save of this link was still pending/,
    );
    assert.equal(f.reader.sent.length, 2);
    assert.equal(f.reader.sent[0]!.key, f.reader.sent[1]!.key);
    assert.equal(f.reader.sent[0]!.url, f.reader.sent[1]!.url);
    const ops = await f.rows("mcp_operations");
    assert.equal(ops.length, 1);
    assert.equal(
      ops[0].payload.url,
      "https://news.example.com/2026/city-budget",
    );
    // A completed save is not sent again.
    const third: any = await f.links.call(
      "123",
      f.run,
      save("https://news.example.com/2026/city-budget"),
    );
    assert.equal(third.reader.already, true);
    assert.equal(f.reader.sent.length, 2);
  } finally {
    await f.pg.close();
  }
});

test("item 9: after a stored rejection a new attempt gets a new key and can succeed", async () => {
  const f = await fixture({ destination: "reader", p: 0.9 });
  try {
    f.reader.set("reject");
    const first: any = await f.links.call(
      "123",
      f.run,
      save("https://news.example.com/2026/city-budget"),
    );
    assert.equal(first.reader.state, "rejected");
    assert.match(first.where, /refused/);
    f.reader.set("ok");
    const second: any = await f.links.call(
      "123",
      f.run,
      save("https://news.example.com/2026/city-budget"),
    );
    assert.equal(second.reader.state, "complete");
    assert.notEqual(f.reader.sent[0]!.key, f.reader.sent[1]!.key);
    const states = (await f.rows("mcp_operations")).map((r) => r.state).sort();
    assert.deepEqual(states, ["complete", "rejected"]);
  } finally {
    await f.pg.close();
  }
});

test("the Reader mock behaves like src/mcp.ts: replays a stored key, refuses another payload under it", async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const write = (url: string) =>
      f.reader.mcp.call("123", {
        operation: "mcp_write",
        connection: "reader",
        tool: "save_link",
        requestKey: key,
        arguments: { url },
      });
    const a: any = await write("https://news.example.com/a");
    const b: any = await write("https://news.example.com/a");
    assert.deepEqual(b.result.submissionId, a.result.submissionId);
    assert.equal(f.reader.sent.length, 1);
    await assert.rejects(
      write("https://news.example.com/b"),
      /bound to another/,
    );
  } finally {
    await f.pg.close();
  }
});

test("Both route: both writes succeed", async () => {
  const f = await fixture({ destination: "study" });
  try {
    const r: any = await f.links.call(
      "123",
      f.run,
      save("https://x.com/dev/status/1", { destination: "both" }),
    );
    assert.equal(r.state, "saved");
    assert.equal(r.reader.state, "complete");
    assert.equal(r.study.duplicate, false);
    assert.match(r.where, /study list.*Reader/);
    assert.equal((await f.rows("study_resources")).length, 1);
    assert.equal(f.reader.sent.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("Both route: Reader rejects, the study entry is still saved and the reply is honest", async () => {
  const f = await fixture({ destination: "study" });
  try {
    f.reader.set("reject");
    const r: any = await f.links.call(
      "123",
      f.run,
      save("https://x.com/dev/status/1", { destination: "both" }),
    );
    assert.equal(r.state, "partial");
    assert.equal(r.reader.state, "rejected");
    assert.match(r.where, /Saved to your study list/);
    assert.match(r.where, /isn't in Reader/);
    assert.doesNotMatch(r.where, /Saved to Reader/);
    assert.equal((await f.rows("study_resources")).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("Both route: the study insert fails, the Reader outcome is still reported", async () => {
  const f = await fixture({ destination: "study" }, (db) => ({
    query: (sql: string, values?: unknown[]) =>
      /INSERT INTO study_resources/.test(sql)
        ? Promise.reject(new Error("connection reset"))
        : db.query(sql, values),
  }));
  try {
    const r: any = await f.links.call(
      "123",
      f.run,
      save("https://x.com/dev/status/1", { destination: "both" }),
    );
    assert.equal(r.state, "partial");
    assert.equal(r.studyUncertain, true);
    assert.equal(r.reader.state, "complete");
    assert.match(r.where, /may or may not have been added/);
    assert.match(r.where, /Saved to Reader/);
  } finally {
    await f.pg.close();
  }
});

test("a pending save of another link blocks a new Reader save with a clear message", async () => {
  const f = await fixture({ destination: "reader", p: 0.9 });
  try {
    f.reader.set("uncertain");
    await f.links.call(
      "123",
      f.run,
      save("https://news.example.com/2026/city-budget"),
    );
    f.reader.set("ok");
    const other: any = await f.links.call(
      "123",
      f.run,
      save("https://x.com/dev/status/1"),
    );
    assert.equal(other.reader.state, "blocked");
    assert.match(other.where, /Another Reader save is still unconfirmed/);
    // The agent boundary lets only the same link's retry through.
    assert.equal(
      await f.links.retriesPending(
        "123",
        save("https://news.example.com/2026/city-budget?utm_source=z"),
      ),
      true,
    );
    assert.equal(
      await f.links.retriesPending("123", save("https://x.com/dev/status/1")),
      false,
    );
  } finally {
    await f.pg.close();
  }
});

test("an uncertain earlier link_save blocks other writes, but its own retry runs and settles it", async () => {
  const f = await fixture({ destination: "study", p: 0.9 });
  try {
    const stopped = randomUUID();
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,state) VALUES($1,'123','stopped')",
      [stopped],
    );
    const call = randomUUID();
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state) VALUES($1,$2,'p','link_save',$3::jsonb,true,'uncertain')",
      [
        call,
        stopped,
        JSON.stringify({
          raw: JSON.stringify({ url: "https://x.com/dev/status/1?s=1" }),
        }),
      ],
    );
    const uncertain = (
      await f.db.query(
        "SELECT operation,arguments FROM runtime_calls WHERE state='uncertain'",
      )
    ).rows;
    assert.equal(
      await f.links.retriesUncertain(
        "123",
        save("https://x.com/dev/status/1"),
        uncertain,
      ),
      true,
    );
    assert.equal(
      await f.links.retriesUncertain(
        "123",
        save("https://news.example.com/2026/city-budget"),
        uncertain,
      ),
      false,
    );
    await f.links.call("123", f.run, save("https://x.com/dev/status/1"));
    const [settled] = (
      await f.db.query("SELECT state FROM runtime_calls WHERE id=$1", [call])
    ).rows;
    assert.equal(settled.state, "success");
  } finally {
    await f.pg.close();
  }
});

async function choice(f: Awaited<ReturnType<typeof fixture>>) {
  const r: any = await f.links.call(
    "123",
    f.run,
    save("https://x.com/dev/status/1"),
  );
  assert.equal(r.state, "needs_choice");
  return r.choiceId as string;
}

test("item 10: a failure after the study insert says the result is uncertain and names the study entry", async () => {
  let fail = false;
  const f = await fixture({ destination: "study", p: 0.5 }, (db) => ({
    query: (sql: string, values?: unknown[]) =>
      fail && /SET study_written=true/.test(sql)
        ? Promise.reject(new Error("connection reset"))
        : db.query(sql, values),
  }));
  try {
    const id = await choice(f);
    fail = true;
    const out = await f.links.applyChoice("123", id, "both");
    assert.equal(out.final, false);
    assert.match(
      out.message,
      /^Result uncertain: your study list entry was saved\./,
    );
    assert.doesNotMatch(out.message, /nothing/i);
    assert.equal(f.reader.sent.length, 0);
    const [row] = await f.rows("link_choices");
    assert.equal(row.state, "open");
  } finally {
    await f.pg.close();
  }
});

test("item 10: a failure after Reader completes names Reader; a failed reopen still lets a re-tap work after the lease", async () => {
  let fail = false;
  const f = await fixture({ destination: "study", p: 0.5 }, (db) => ({
    query: (sql: string, values?: unknown[]) =>
      fail &&
      (/SET reader_state=\$3/.test(sql) ||
        /SET state='open',claimed_at=NULL WHERE id=\$1 AND user_id=\$2 AND state='applying' RETURNING/.test(
          sql,
        ))
        ? Promise.reject(new Error("connection reset"))
        : db.query(sql, values),
  }));
  try {
    const id = await choice(f);
    fail = true;
    const out = await f.links.applyChoice("123", id, "both");
    assert.equal(out.final, false);
    assert.match(
      out.message,
      /Result uncertain: your study list entry was saved; the Reader save went through\./,
    );
    assert.match(out.message, /in two minutes/);
    let [row] = await f.rows("link_choices");
    assert.equal(row.state, "applying");
    // A tap inside the lease is refused without running anything.
    fail = false;
    const early = await f.links.applyChoice("123", id, "both");
    assert.equal(early.claimed, false);
    assert.equal(f.reader.sent.length, 1);
    // After the lease, the re-tap runs: no second study row, the same Reader request.
    await f.db.query(
      "UPDATE link_choices SET claimed_at=now()-interval '3 minutes' WHERE id=$1",
      [id],
    );
    const retry = await f.links.applyChoice("123", id, "both");
    assert.equal(retry.final, true);
    assert.match(retry.message, /study list/);
    assert.equal((await f.rows("study_resources")).length, 1);
    assert.equal((await f.rows("mcp_operations")).length, 1);
    [row] = await f.rows("link_choices");
    assert.equal(row.state, "done");
    assert.equal(row.reader_state, "complete");
  } finally {
    await f.pg.close();
  }
});

test("item 10: a pending Reader result keeps the card open and a re-tap retries the same key", async () => {
  const f = await fixture({ destination: "reader", p: 0.6 });
  try {
    const id = await choice(f);
    f.reader.set("uncertain");
    const first = await f.links.applyChoice("123", id, "reader");
    assert.equal(first.final, false);
    assert.match(first.message, /Tap again to retry safely/);
    f.reader.set("ok");
    const second = await f.links.applyChoice("123", id, "reader");
    assert.equal(second.final, true);
    assert.equal(f.reader.sent[0]!.key, f.reader.sent[1]!.key);
    const third = await f.links.applyChoice("123", id, "reader");
    assert.equal(third.claimed, false);
    assert.equal(f.reader.sent.length, 2);
  } finally {
    await f.pg.close();
  }
});

test("a concurrent double tap is claimed once", async () => {
  const f = await fixture({ destination: "study", p: 0.5 });
  try {
    const id = await choice(f);
    const [a, b] = await Promise.all([
      f.links.applyChoice("123", id, "both"),
      f.links.applyChoice("123", id, "both"),
    ]);
    assert.equal([a, b].filter((o) => o.claimed).length, 1);
    assert.equal((await f.rows("study_resources")).length, 1);
    assert.equal(f.reader.sent.length, 1);
    // Another owner cannot claim it.
    const other = await f.links.applyChoice("456", id, "study");
    assert.equal(other.claimed, false);
    assert.match(other.message, /no longer available/);
  } finally {
    await f.pg.close();
  }
});

test("Telegram tap: owner-only, edits the card, and keeps the buttons when the result is not final", async () => {
  const f = await fixture({ destination: "reader", p: 0.5 });
  try {
    const id = await choice(f);
    const tools = new JobTools(
      f.db,
      { call: async () => ({}) },
      ...(Array(19).fill(undefined) as []),
      f.links,
    );
    const bot = telegram(
      readConfig({
        DATABASE_URL: "postgres://x:x@localhost/x",
        TELEGRAM_BOT_TOKEN: "123:test-token",
        TELEGRAM_ALLOWED_USER_IDS: "123",
      }),
      { tools } as any,
      f.db,
    );
    const edits: any[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === "getMe")
        return {
          ok: true,
          result: { id: 999, is_bot: true, first_name: "T", username: "t_bot" },
        } as any;
      if (method === "editMessageText") edits.push(payload);
      return { ok: true, result: true } as any;
    });
    await bot.init();
    const tap = (user: number, data: string) =>
      bot.handleUpdate({
        update_id: Math.floor(Math.random() * 1e9),
        callback_query: {
          id: "q",
          chat_instance: "x",
          from: { id: user, is_bot: false, first_name: "T" },
          data,
          message: {
            message_id: 12,
            date: 0,
            chat: { id: user, type: "private" },
          },
        },
      } as any);
    await tap(456, `lk:${id}:r`);
    await bot.linkChoicesIdle();
    assert.equal(edits.length, 0);
    f.reader.set("uncertain");
    await tap(123, `lk:${id}:r`);
    await bot.linkChoicesIdle();
    assert.equal(edits.length, 1);
    assert.match(edits[0].text, /Tap again/);
    assert.deepEqual(
      edits[0].reply_markup.inline_keyboard[0].map((b: any) => b.text),
      ["Study list", "Reader", "Both"],
    );
    f.reader.set("ok");
    await tap(123, `lk:${id}:r`);
    await bot.linkChoicesIdle();
    assert.equal(edits.length, 2);
    assert.match(edits[1].text, /Saved to Reader/);
    assert.deepEqual(edits[1].reply_markup.inline_keyboard, []);
  } finally {
    await f.pg.close();
  }
});

test("choice cards are sent once, in the asking thread, and a refused send can be retried", async () => {
  const f = await fixture({ destination: "study", p: 0.5 });
  try {
    const id = await choice(f);
    const sent: any[] = [];
    let refuse = true;
    const bot = {
      api: {
        sendMessage: async (_user: string, text: string, options: any) => {
          if (refuse) {
            refuse = false;
            throw Object.assign(new Error("Bad Request"), {
              error_code: 400,
              description: "chat not found",
            });
          }
          sent.push({ text, options });
          return {
            message_id: 77,
            message_thread_id: options.message_thread_id,
          };
        },
      },
    } as any;
    await sendLinkChoices(bot, f.db, "123", undefined, 9, f.run);
    assert.equal(sent.length, 0);
    let [row] = await f.rows("link_choices");
    assert.equal(row.delivery, "pending");
    await Promise.all([
      sendLinkChoices(bot, f.db, "123", undefined, 9, f.run),
      sendLinkChoices(bot, f.db, "123", undefined, 9, f.run),
    ]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].options.message_thread_id, 9);
    assert.deepEqual(
      sent[0].options.reply_markup.inline_keyboard[0].map(
        (b: any) => b.callback_data,
      ),
      [`lk:${id}:s`, `lk:${id}:r`, `lk:${id}:b`],
    );
    [row] = await f.rows("link_choices");
    assert.equal(row.delivery, "sent");
    assert.equal(Number(row.chat_message_id), 77);
    // Another owner's sender never sees this card.
    await sendLinkChoices(bot, f.db, "456");
    assert.equal(sent.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("an interrupted card send is kept as uncertain, never resent", async () => {
  const f = await fixture({ destination: "study", p: 0.5 });
  try {
    await choice(f);
    let calls = 0;
    const bot = {
      api: {
        sendMessage: async () => {
          calls++;
          throw new Error("socket hang up");
        },
      },
    } as any;
    await sendLinkChoices(bot, f.db, "123");
    await sendLinkChoices(bot, f.db, "123");
    assert.equal(calls, 1);
    const [row] = await f.rows("link_choices");
    assert.equal(row.delivery, "uncertain");
  } finally {
    await f.pg.close();
  }
});

test("at the agent boundary, a pending Reader save blocks other writes but its own link's retry runs and settles it", async () => {
  const { Assistant } = await import("../src/agent.js");
  const { CustomAgent } = await import("../src/custom-agent.js");
  const f = await fixture({ destination: "reader", p: 0.9 });
  try {
    await ensureUser(f.db, "owner");
    f.reader.set("uncertain");
    // The owner is "123" for the Reader credential; run the turn as that owner.
    await f.links.call(
      "123",
      f.run,
      save("https://news.example.com/2026/city-budget"),
    );
    f.reader.set("ok");
    let n = 0;
    const model = {
      generate: async () => {
        n++;
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
        // First turn: another write is refused while the Reader save is pending.
        if (n === 1) return call("memory_set", { key: "a", value: "1" });
        if (n === 2)
          return {
            message: { role: "assistant" as const, content: "Blocked." },
          };
        // Second turn: saving the same link again is its retry, so it runs.
        if (n === 3)
          return call("link_save", {
            url: "https://news.example.com/2026/city-budget?utm_source=again",
          });
        return { message: { role: "assistant" as const, content: "Done." } };
      },
    } as any;
    const tools = new JobTools(
      f.db,
      { call: async () => ({}) },
      // gmail … gathering, then mcp; links … publicBrowser, then linkTools.
      ...(Array(13).fill(undefined) as []),
      f.reader.mcp,
      ...(Array(5).fill(undefined) as []),
      f.links,
    );
    const assistant = new Assistant(f.db, new CustomAgent(model), tools, {
      web: true,
      delegation: false,
      mcp: true,
      studyList: true,
    });
    await assistant.respond("123", "remember a");
    await assistant.respond("123", "save it again");
    const calls = (
      await f.db.query(
        "SELECT operation,state,result FROM runtime_calls WHERE operation IN ('memory_set','link_save') ORDER BY started_at,id",
      )
    ).rows;
    assert.deepEqual(
      calls.map((c) => [c.operation, c.state, c.result?.error?.code ?? null]),
      [
        ["memory_set", "failed", "WRITE_BLOCKED"],
        ["link_save", "success", null],
      ],
    );
    assert.equal(f.reader.sent.length, 2);
    assert.equal(f.reader.sent[0]!.key, f.reader.sent[1]!.key);
    const [op] = await f.rows("mcp_operations");
    assert.equal(op.state, "complete");
  } finally {
    await f.pg.close();
  }
});

test("an unusable link is refused before dispatch, so it never becomes an uncertain write", async () => {
  for (const url of [
    "https://10.0.0.1/a",
    "https://example.com:8443/a",
    "https://intranet.local/a",
    "ftp://example.com/a",
  ]) {
    assert.throws(() => save(url), /public web link|Invalid url/);
    assert.throws(() =>
      action.parse({ operation: "link_move", url, to: "study" }),
    );
  }
  const { Assistant } = await import("../src/agent.js");
  const { CustomAgent } = await import("../src/custom-agent.js");
  const f = await fixture({ destination: "study", p: 0.9 });
  try {
    let n = 0;
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
    const model = {
      generate: async () => {
        n++;
        if (n === 1) return call("link_save", { url: "https://10.0.0.1/a" });
        if (n === 2) return call("memory_set", { key: "a", value: "1" });
        return { message: { role: "assistant" as const, content: "Done." } };
      },
    } as any;
    const tools = new JobTools(
      f.db,
      { call: async () => ({}) },
      ...(Array(13).fill(undefined) as []),
      f.reader.mcp,
      ...(Array(5).fill(undefined) as []),
      f.links,
    );
    const assistant = new Assistant(f.db, new CustomAgent(model), tools, {
      web: true,
      delegation: false,
      mcp: true,
      studyList: true,
    });
    await assistant.respond("123", "save https://10.0.0.1/a");
    const calls = (
      await f.db.query(
        "SELECT operation,state,result FROM runtime_calls WHERE operation IN ('memory_set','link_save') ORDER BY started_at,id",
      )
    ).rows;
    assert.deepEqual(
      calls.map((c) => [c.operation, c.state, c.result?.error?.code ?? null]),
      [
        ["link_save", "failed", "INVALID_INPUT"],
        ["memory_set", "success", null],
      ],
    );
  } finally {
    await f.pg.close();
  }
});

test("a plain http link is saved as its https form", async () => {
  const f = await fixture({ destination: "study", p: 0.9 });
  try {
    const r: any = await f.links.call(
      "123",
      f.run,
      save("http://x.com/dev/status/1?s=20"),
    );
    assert.equal(r.state, "saved");
    const [row] = await f.rows("study_resources");
    assert.equal(row.url, "https://x.com/dev/status/1");
  } finally {
    await f.pg.close();
  }
});

test("a redirected link's pending Reader save is found again from the link as shared", async () => {
  const f = await fixture({ destination: "reader", p: 0.9 });
  try {
    f.reader.set("uncertain");
    const first: any = await f.links.call(
      "123",
      f.run,
      save("https://twitter.com/dev/status/1?s=20"),
    );
    assert.equal(first.reader.state, "pending");
    // The payload is the redirected URL, the same one used for the key.
    assert.equal(f.reader.sent[0]!.url, "https://x.com/dev/status/1");
    // At the agent boundary the same link as shared is its genuine retry.
    assert.equal(
      await f.reader.mcp.pendingAllows(
        "123",
        save("https://twitter.com/dev/status/1"),
      ),
      false,
    );
    assert.equal(
      await f.links.retriesPending(
        "123",
        save("https://twitter.com/dev/status/1"),
      ),
      true,
    );
    assert.equal(
      await f.links.retriesPending(
        "123",
        save("https://news.example.com/2026/city-budget"),
      ),
      false,
    );
    // Even when the page can't be read this time (no redirect seen), the retry reuses the
    // same key and payload, and the owner is told about the earlier save.
    f.reader.set("ok");
    fetchDown = true;
    const second: any = await f.links.call(
      "123",
      f.run,
      save("https://twitter.com/dev/status/1"),
    );
    fetchDown = false;
    assert.equal(second.reader.state, "complete");
    assert.equal(second.reader.earlierPending, true);
    assert.match(second.where, /earlier Reader save of this link/);
    assert.equal(f.reader.sent.length, 2);
    assert.deepEqual(f.reader.sent[1], f.reader.sent[0]);
    assert.equal((await f.rows("mcp_operations")).length, 1);
  } finally {
    fetchDown = false;
    await f.pg.close();
  }
});

test("learning interests come from the owner's explicit memory when Chief passes none", async () => {
  const { MemoryStore } = await import("../src/memory.js");
  const f = await fixture({
    destination: "study",
    p: 0.9,
    topic: "interest_2",
  });
  try {
    await new MemoryStore(f.db).write("123", {
      key: "ai_learning_topics",
      value: "applied AI engineering, agent platforms; developer tools",
      kind: "fact",
      origin: "owner",
      reason: "owner said",
      source: {},
    });
    const r: any = await f.links.call(
      "123",
      f.run,
      action.parse({
        operation: "link_save",
        url: "https://x.com/dev/status/1",
      }) as any,
    );
    const request = f.jev.requests.at(-1);
    assert.deepEqual(request.state.learning_interests, [
      "applied AI engineering",
      "agent platforms",
      "developer tools",
    ]);
    assert.ok(request.questions.topic);
    assert.equal(r.topic, "agent platforms");
  } finally {
    await f.pg.close();
  }
});

test("switching a card to the study list after a pending Reader tap says so and keeps the card open", async () => {
  const f = await fixture({ destination: "reader", p: 0.6 });
  try {
    const id = await choice(f);
    f.reader.set("uncertain");
    const first = await f.links.applyChoice("123", id, "reader");
    assert.equal(first.final, false);
    const second = await f.links.applyChoice("123", id, "study");
    assert.equal(second.final, false);
    assert.match(second.message, /Saved to your study list/);
    assert.match(
      second.message,
      /earlier Reader save of this link is still unconfirmed/,
    );
    let [row] = await f.rows("link_choices");
    assert.equal(row.state, "open");
    // Tapping Reader settles it with the same request.
    f.reader.set("ok");
    const third = await f.links.applyChoice("123", id, "reader");
    assert.equal(third.final, true);
    assert.equal(f.reader.sent[0]!.key, f.reader.sent[1]!.key);
    [row] = await f.rows("link_choices");
    assert.equal(row.state, "done");
    assert.equal((await f.rows("study_resources")).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("a failure after switching names the earlier unconfirmed Reader save", async () => {
  let fail = false;
  const f = await fixture({ destination: "reader", p: 0.6 }, (db) => ({
    query: (sql: string, values?: unknown[]) =>
      fail && /SET study_written=true/.test(sql)
        ? Promise.reject(new Error("connection reset"))
        : db.query(sql, values),
  }));
  try {
    const id = await choice(f);
    f.reader.set("uncertain");
    await f.links.applyChoice("123", id, "reader");
    fail = true;
    const out = await f.links.applyChoice("123", id, "study");
    assert.equal(out.final, false);
    assert.match(
      out.message,
      /Result uncertain: your study list entry was saved; the Reader save may or may not have gone through\./,
    );
  } finally {
    await f.pg.close();
  }
});
