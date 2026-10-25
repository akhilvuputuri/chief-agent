import test from "node:test";
import assert from "node:assert/strict";
import { GmailTools, indexBody } from "../src/gmail.js";
import {
  chunks,
  MailIndex,
  OpenRouterEmbedder,
  withoutQuotes,
  type Embedder,
} from "../src/mail-recall.js";
import { action } from "../src/protocol.js";
import { runtimeContext } from "../src/runtime.js";
import { projectObservation } from "../src/observations.js";
import { plugins } from "../src/plugin-registry.js";
import { runFindingsAgent } from "../src/agents.js";
import { spending, type Spending } from "../src/spending.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 25);

/** Deterministic bag-of-words vectors: texts sharing words score higher. */
const words: Embedder = {
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(512);
      for (const w of t.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
        let h = 0;
        for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 512;
        v[h] += 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};

type Mail = {
  id: string;
  at: number;
  subject: string;
  text: string;
  from?: string;
};
function mailbox(initial: Mail[]) {
  const mail = [...initial];
  const queries: string[] = [];
  const reads: string[] = [];
  const gmail = {
    async indexPage(user: string, query: string) {
      assert.equal(user, "owner");
      queries.push(query);
      const after = Number(query.match(/after:(\d+)/)?.[1] ?? 0) * 1000;
      return {
        messages: mail
          .filter((m) => m.at >= after)
          .map((m) => ({ id: m.id, threadId: "t" + m.id })),
      };
    },
    async indexMessage(user: string, id: string) {
      reads.push(id);
      const m = mail.find((x) => x.id === id)!;
      return {
        id,
        threadId: "t" + id,
        at: m.at,
        from: m.from ?? "someone@example.com",
        to: "owner@example.com",
        subject: m.subject,
        date: new Date(m.at).toUTCString(),
        text: m.text,
      };
    },
  };
  return { gmail, mail, queries, reads };
}

test("quoted replies are dropped and every chunk carries the headers", () => {
  assert.equal(
    withoutQuotes(
      "Thanks, see you then.\n\nOn Mon, 1 Sep 2026 at 10:00, Ann <a@x.com> wrote:\n> old text",
    ),
    "Thanks, see you then.",
  );
  assert.equal(withoutQuotes("Hi\n> quoted\nBye"), "Hi\nBye");
  const parts = chunks({
    id: "a1",
    threadId: "ta1",
    at: NOW,
    from: "Landlord <l@example.com>",
    to: "owner@example.com",
    subject: "Deposit",
    date: "Mon",
    text: "x".repeat(20_000),
  });
  assert.equal(parts.length, 6);
  assert.match(parts[0]!.embedText, /^From: Landlord.*\nSubject: Deposit/s);
  assert.ok(parts.every((p) => p.text.length <= 1500));
});

test("HTML-only messages are indexed as display text", () => {
  const html = Buffer.from(
    "<html><style>p{}</style><p>Your aircon repair quote is <b>$180</b></p></html>",
  ).toString("base64url");
  assert.equal(
    indexBody({
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/html", body: { data: html } }],
    }),
    "Your aircon repair quote is $180",
  );
  const plain = Buffer.from("plain wins").toString("base64url");
  assert.equal(
    indexBody({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: plain } },
        { mimeType: "text/html", body: { data: html } },
      ],
    }),
    "plain wins",
  );
});

test("recall finds an email by what it was about, owner-scoped", async () => {
  const box = mailbox([
    {
      id: "a1",
      at: NOW - 3 * DAY,
      subject: "Re: unit 5",
      text: "We apologise for the late delivery of your sofa. A voucher is attached.",
    },
    {
      id: "b2",
      at: NOW - 5 * DAY,
      subject: "Statement",
      text: "Your monthly card statement is ready to view.",
    },
    {
      id: "c3",
      at: NOW - 6 * DAY,
      subject: "Lease",
      text: "The security deposit for the flat is two months of rent.",
    },
  ]);
  const index = new MailIndex(box.gmail, words, "owner", () => NOW);
  const early = await index.recall("owner", "deposit for the flat");
  assert.equal(early.status, "building");
  await index.start();
  assert.match(box.queries[0]!, /category:primary .*newer_than:30d/);
  const found = await index.recall("owner", "late delivery sofa apology");
  assert.equal(found.status, "ready");
  assert.equal(found.results![0]!.messageId, "a1");
  assert.equal(found.results![0]!.threadId, "ta1");
  assert.match(found.warning!, /Untrusted email content/);
  // The projection keeps the warning on a full page.
  const projected = projectObservation("gmail_recall", found).result;
  assert.match(projected.warning, /Untrusted email content/);
  await assert.rejects(index.recall("intruder", "deposit"), /not connected/);
});

test("new mail is topped up on recall and old mail leaves the window", async () => {
  let now = NOW;
  const box = mailbox([
    { id: "a1", at: NOW - 29 * DAY, subject: "Old", text: "dentist checkup" },
  ]);
  const index = new MailIndex(box.gmail, words, "owner", () => now);
  await index.start();
  box.mail.push({
    id: "n9",
    at: NOW + DAY,
    subject: "Booking",
    text: "Your badminton court booking is confirmed",
  });
  now = NOW + 2 * DAY;
  const found = await index.recall("owner", "badminton court booking");
  assert.match(box.queries.at(-1)!, /after:\d+/);
  assert.equal(found.results![0]!.messageId, "n9");
  // a1 is now 31 days old.
  assert.ok(found.results!.every((r) => r.messageId !== "a1"));
  assert.equal(index.messages, 1);
  // Already-indexed mail is not fetched again.
  await index.recall("owner", "badminton");
  assert.equal(box.reads.filter((id) => id === "n9").length, 1);
});

test("a failed build reports unavailable and can be retried", async () => {
  let fail = true;
  const box = mailbox([{ id: "a1", at: NOW, subject: "s", text: "hello" }]);
  const flaky: Embedder = {
    async embed(texts) {
      if (fail) throw new Error("provider down");
      return words.embed(texts);
    },
  };
  const index = new MailIndex(box.gmail, flaky, "owner", () => NOW);
  await index.start();
  assert.equal(index.state, "failed");
  assert.equal((await index.recall("owner", "hello")).status, "unavailable");
  fail = false;
  await index.start();
  assert.equal((await index.recall("owner", "hello")).status, "ready");
});

test("the OpenRouter embedder orders, truncates and normalises vectors", async () => {
  const bodies: any[] = [];
  const transport = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init!.body)));
    return Response.json({
      data: [
        { index: 1, embedding: Array.from({ length: 1536 }, () => 2) },
        { index: 0, embedding: Array.from({ length: 1536 }, (_, i) => i) },
      ],
      usage: { prompt_tokens: 4 },
    });
  }) as typeof fetch;
  const [first, second] = await new OpenRouterEmbedder(
    "key",
    undefined,
    transport,
  ).embed(["a", "b"]);
  assert.equal(bodies[0].model, "openai/text-embedding-3-small");
  assert.deepEqual(bodies[0].input, ["a", "b"]);
  assert.equal(first!.length, 512);
  assert.ok(Math.abs(Math.hypot(...first!) - 1) < 1e-5);
  assert.ok(first![0]! < first![511]!);
  assert.ok(Math.abs(second![0]! - second![511]!) < 1e-6);
  const refused = (async () =>
    new Response("no", { status: 402 })) as typeof fetch;
  await assert.rejects(
    new OpenRouterEmbedder("key", undefined, refused).embed(["a"]),
    /failed \(402\)/,
  );
  const short = (async () => Response.json({ data: [] })) as typeof fetch;
  await assert.rejects(
    new OpenRouterEmbedder("key", undefined, short).embed(["a"]),
  );
});

test("gmail_recall takes plain words only and is offered only with the index", () => {
  assert.ok(
    action.safeParse({ operation: "gmail_recall", query: "x" }).success,
  );
  assert.ok(
    !action.safeParse({
      operation: "gmail_recall",
      query: "x",
      account: "secondary",
    }).success,
  );
  const names = (availability: Record<string, boolean>) =>
    runtimeContext(availability, null).tools.map((t) => t.name);
  assert.ok(!names({ gmail: true }).includes("gmail_recall"));
  assert.ok(names({ gmail: true, mailIndex: true }).includes("gmail_recall"));
  // The email agent stays invocable without the index and gains it with the index.
  const gmailTools = [
    "gmail_accounts",
    "gmail_search",
    "gmail_thread",
    "gmail_read",
    "observation_read",
  ];
  const email = (available: string[]) =>
    plugins.agentCatalogue(new Set(available)).find((a) => a.type === "email");
  assert.deepEqual(email(gmailTools)?.tools, gmailTools);
  assert.ok(
    email([...gmailTools, "gmail_recall"])?.tools.includes("gmail_recall"),
  );
  assert.equal(email(gmailTools.slice(1)), undefined);
  const coordinator = runtimeContext(
    { gmail: true },
    null,
    undefined,
    undefined,
    true,
  );
  assert.ok(
    JSON.parse(coordinator.context).agentCatalogue.some(
      (a: { type: string }) => a.type === "email",
    ),
  );
});

test("index reads stay in the primary mailbox and check message identity", async () => {
  const calls: string[] = [];
  const body = Buffer.from("Body text").toString("base64url");
  const request = (async (u: unknown) => {
    const url = new URL(String(u));
    calls.push(url.pathname + url.search);
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "a", expires_in: 3600 });
    if (url.pathname.endsWith("/profile"))
      return Response.json({ emailAddress: "owner@example.com" });
    if (url.pathname.endsWith("/messages"))
      return Response.json({ messages: [{ id: "abc", threadId: "def" }] });
    return Response.json({
      id: url.pathname.split("/").at(-1),
      threadId: "def",
      internalDate: "1700000000000",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Subject", value: "Hello" }],
        body: { data: body },
      },
    });
  }) as typeof fetch;
  const gmail = new GmailTools(
    {
      owner: "123",
      email: "owner@example.com",
      clientId: "c",
      clientSecret: "s",
      refreshToken: "r",
    },
    request,
  );
  const page = await gmail.indexPage("123", "category:primary newer_than:30d");
  assert.deepEqual(page.messages, [{ id: "abc", threadId: "def" }]);
  const m = await gmail.indexMessage("123", "abc");
  assert.equal(m.text, "Body text");
  assert.equal(m.subject, "Hello");
  assert.equal(m.at, 1700000000000);
  await assert.rejects(gmail.indexMessage("123", "../x"), /Invalid/);
  await assert.rejects(gmail.indexPage("999", "x"), /not connected/);
  assert.ok(calls.some((c) => c.includes("maxResults=100")));
});

test("the email agent runs without the index and gains gmail_recall with it", async () => {
  for (const mailIndex of [false, true]) {
    const runtime = runtimeContext(
      { gmail: true, mailIndex },
      null,
      undefined,
      undefined,
      true,
    );
    const definition = plugins.get(plugins.resolve("email"));
    // Tool validation passes; the run then stops at the allocation check.
    await assert.rejects(
      runFindingsAgent(
        {
          executeAgent: async () => ({}),
          execution: {
            db: {},
            user: "owner",
            remaining: async () => ({ models: 1, tools: 1, ms: 1000 }),
          },
          signal: new AbortController().signal,
          runtime,
        } as any,
        { type: "email", objective: "find it", context: "" },
        definition,
        {} as any,
        {} as any,
        async () => ({}) as any,
      ),
      /remaining allocation is reserved/,
    );
    // The coordinator still delegates Gmail to the email agent instead of losing it.
    assert.ok(!runtime.tools.some((t) => t.name === "gmail_search"));
    assert.equal(
      runtime.allTools!.some((t) => t.name === "gmail_recall"),
      mailIndex,
    );
  }
});

test("a burst of new mail is indexed over several recalls without gaps", async () => {
  let now = NOW;
  const box = mailbox([
    { id: "a0", at: NOW - DAY, subject: "s", text: "seed" },
  ]);
  // Gmail lists newest first.
  const listNewestFirst = box.gmail.indexPage;
  box.gmail.indexPage = async (user, query) => {
    const page = await listNewestFirst(user, query);
    return { messages: page.messages.reverse() };
  };
  const index = new MailIndex(box.gmail, words, "owner", () => now);
  await index.start();
  for (let i = 1; i <= 80; i++)
    box.mail.push({
      id: "n" + i,
      // One message from the future must not stop later listings.
      at: i === 80 ? NOW + 400 * DAY : NOW + i * 1000,
      subject: "s" + i,
      text: "burst message " + i,
    });
  now = NOW + 2 * DAY;
  const first = await index.recall("owner", "burst");
  assert.match(first.note!, /not indexed yet/);
  assert.equal(index.messages, 51);
  // The oldest new mail is indexed first, so nothing older is left behind.
  assert.ok(box.reads.includes("n1") && !box.reads.includes("n80"));
  const second = await index.recall("owner", "burst");
  assert.equal(second.note, undefined);
  assert.equal(index.messages, 81);
  box.mail.push({ id: "z1", at: now, subject: "late", text: "late arrival" });
  await index.recall("owner", "late arrival");
  assert.equal(index.messages, 82);
});

test("a failed build keeps its progress, pauses before retrying and runs outside the turn ledger", async () => {
  let now = NOW;
  const mail = Array.from({ length: 25 }, (_, i) => ({
    id: "m" + i,
    at: NOW - i * 1000,
    subject: "s" + i,
    text: "message body " + i,
  }));
  const box = mailbox(mail);
  let calls = 0;
  let ledgers = 0;
  const flaky: Embedder = {
    async embed(texts) {
      if (spending.getStore()) ledgers += 1;
      if (++calls === 2) throw new Error("Embedding request failed (429)");
      return words.embed(texts);
    },
  };
  const index = new MailIndex(box.gmail, flaky, "owner", () => now);
  await index.start();
  assert.equal(index.state, "failed");
  assert.equal(index.messages, 10);
  const reads = box.reads.length;
  const turn = { begin: async () => "c", settle: async () => {} };
  const ask = () =>
    spending.run(turn as unknown as Spending, () =>
      index.recall("owner", "message"),
    );
  assert.equal((await ask()).status, "unavailable");
  assert.equal(box.reads.length, reads);
  now += 6 * 60_000;
  assert.equal((await ask()).status, "unavailable");
  await index.start();
  assert.equal(index.state, "ready");
  assert.equal(index.messages, 25);
  // Only the 15 messages not yet indexed were read again.
  assert.equal(box.reads.length, reads + 15);
  assert.equal(ledgers, 0);
});

test("an unreadable message is retried once and then left out", async () => {
  const box = mailbox([
    { id: "ok", at: NOW, subject: "s", text: "fine" },
    { id: "bad", at: NOW, subject: "s", text: "broken" },
  ]);
  const read = box.gmail.indexMessage;
  box.gmail.indexMessage = async (user, id) => {
    if (id === "bad") throw new Error("Gmail request failed (500)");
    return read(user, id);
  };
  const index = new MailIndex(box.gmail, words, "owner", () => NOW);
  await index.start();
  assert.equal(index.state, "ready");
  assert.equal(index.messages, 1);
  await index.recall("owner", "fine");
  assert.equal(index.messages, 1);
});

test("a full page of escape-heavy results keeps its warning field", async () => {
  const dense = '"\\'.repeat(60);
  const box = mailbox(
    Array.from({ length: 10 }, (_, i) => ({
      id: "d" + i,
      at: NOW - i,
      subject: dense,
      from: dense,
      text: dense.repeat(10) + " common words",
    })),
  );
  const index = new MailIndex(box.gmail, words, "owner", () => NOW);
  await index.start();
  const found = await index.recall("owner", "common words", 10);
  assert.ok(JSON.stringify(found).length < 12_000);
  assert.ok(found.omitted! > 0);
  const projected = projectObservation("gmail_recall", found).result;
  assert.match(projected.warning, /Untrusted email content/);
});

test("quoted history in HTML replies is not indexed", () => {
  const html = Buffer.from(
    '<div>Yes, Tuesday works.</div><div class="gmail_quote">On Mon, Ann wrote:<blockquote>Can we meet about the deposit?</blockquote></div>',
  ).toString("base64url");
  assert.equal(
    indexBody({ mimeType: "text/html", body: { data: html } }),
    "Yes, Tuesday works.",
  );
});
