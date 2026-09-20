import test from "node:test";
import assert from "node:assert/strict";
import { GmailTools, plainBody, unreadDigest } from "../src/gmail.js";
import { action } from "../src/protocol.js";
import { toolError } from "../src/tool-errors.js";
const config = {
  owner: "123",
  email: "owner@example.com",
  clientId: "client",
  clientSecret: "secret",
  refreshToken: "refresh",
};
function mock(responses: unknown[]) {
  const calls: [unknown, RequestInit | undefined][] = [];
  const request = (async (u: unknown, o?: RequestInit) => {
    calls.push([u, o]);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return Response.json(next);
  }) as typeof fetch;
  return { request, calls };
}
const credentials = [
  { access_token: "a", expires_in: 3600 },
  { emailAddress: config.email },
];
/** Authorised mock that answers each Gmail endpoint from a route table. */
function routed(routes: (url: URL) => unknown) {
  const calls: string[] = [];
  let first = true;
  const request = (async (u: unknown) => {
    const url = new URL(String(u));
    calls.push(url.pathname + url.search);
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "a", expires_in: 3600 });
    if (url.pathname.endsWith("/profile"))
      return Response.json({ emailAddress: config.email });
    const body = routes(url);
    if (body instanceof Error) throw body;
    return Response.json(body);
  }) as typeof fetch;
  void first;
  return { request, calls };
}
function metadata(id: string, subject: string, extra: object = {}) {
  return {
    id,
    threadId: `t${id}`,
    snippet: `snippet for ${subject}`,
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      headers: [
        { name: "From", value: "Sender <sender@example.com>" },
        { name: "To", value: "owner@example.com" },
        { name: "Subject", value: subject },
        { name: "Date", value: "Sat, 19 Sep 2026 10:00:00 +0800" },
        { name: "Received", value: "should not be returned" },
      ],
    },
    ...extra,
  };
}
test("Gmail rejects other users before accessing credentials or network", async () => {
  const m = mock([]);
  await assert.rejects(
    new GmailTools(config, m.request).call("456", "gmail_search", "jobs"),
  );
  assert.equal(m.calls.length, 0);
});
test("Gmail fails closed for a mismatched mailbox", async () => {
  const m = mock([
    { access_token: "a", expires_in: 3600 },
    { emailAddress: "wrong@example.com" },
  ]);
  await assert.rejects(
    new GmailTools(config, m.request).call("123", "gmail_search", "jobs"),
    /does not match/,
  );
  assert.equal(m.calls.length, 2);
});
test("Gmail search is bounded and paginated; cached credentials reuse verified identity", async () => {
  const m = mock([
    ...credentials,
    { messages: [{ id: "abc", threadId: "def" }], nextPageToken: "next" },
    metadata("abc", "First"),
    { messages: [], resultSizeEstimate: 0 },
  ]);
  const g = new GmailTools(config, m.request);
  await g.call("123", "gmail_search", "from:recruiter@example.com");
  await g.call("123", "gmail_search", "jobs", "next");
  // Credentials are verified once; the list and one metadata fetch follow each search.
  assert.equal(m.calls.length, 5);
  const url = new URL(String(m.calls[4]![0]));
  assert.equal(url.searchParams.get("maxResults"), "10");
  assert.equal(url.searchParams.get("pageToken"), "next");
});

test("search returns bounded triage metadata instead of bare ids", async () => {
  const long = "x".repeat(500);
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: [{ id: "a1", threadId: "ta1" }], resultSizeEstimate: 1 }
      : metadata("a1", long, { snippet: long, labelIds: ["INBOX"] }),
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "deposit",
  );
  const hit = out.results[0];
  assert.equal(hit.id, "a1");
  assert.equal(hit.threadId, "ta1");
  assert.equal(hit.from, "Sender <sender@example.com>");
  assert.equal(hit.subject.length, 200);
  assert.equal(hit.snippet.length, 200);
  assert.equal(hit.unread, false);
  assert.equal(hit.date, "Sat, 19 Sep 2026 10:00:00 +0800");
  assert.equal(out.hint, undefined);
  assert.match(out.warning, /Untrusted email content/);
  // The metadata request asks only for the four retained headers.
  const fetched = r.calls.find((c) => c.includes("format=metadata"))!;
  assert.match(fetched, /metadataHeaders=From/);
  assert.match(fetched, /metadataHeaders=Subject/);
  assert.ok(!JSON.stringify(out).includes("should not be returned"));
});

test("a hit whose metadata fails degrades only its own row", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? {
          messages: [
            { id: "a1", threadId: "t1" },
            { id: "a2", threadId: "t2" },
          ],
          resultSizeEstimate: 2,
        }
      : url.pathname.endsWith("/a1")
        ? new Error("boom")
        : metadata("a2", "Second"),
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "deposit",
  );
  assert.equal(out.results.length, 2);
  assert.match(out.results[0].detail, /unavailable/);
  assert.equal(out.results[0].id, "a1");
  assert.equal(out.results[1].subject, "Second");
});

test("hints describe an empty and an oversized result set", async () => {
  const empty = routed(() => ({ messages: [], resultSizeEstimate: 0 }));
  const none: any = await new GmailTools(config, empty.request).call(
    "123",
    "gmail_search",
    "nothing",
  );
  assert.equal(none.results.length, 0);
  assert.match(none.hint, /in:anywhere/);
  const many = routed((url) =>
    url.pathname.endsWith("/messages")
      ? {
          messages: [{ id: "a1", threadId: "t1" }],
          resultSizeEstimate: 900,
        }
      : metadata("a1", "One of many"),
  );
  const lots: any = await new GmailTools(config, many.request).call(
    "123",
    "gmail_search",
    "the",
  );
  assert.match(lots.hint, /Narrow with from:/);
});

test("an identical search inside the cache window makes no request", async () => {
  let now = 1_000_000;
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: [{ id: "a1", threadId: "t1" }], resultSizeEstimate: 1 }
      : metadata("a1", "Cached"),
  );
  const g = new GmailTools(config, r.request, () => now);
  await g.call("123", "gmail_search", "deposit");
  const after = r.calls.length;
  await g.call("123", "gmail_search", "deposit");
  assert.equal(r.calls.length, after);
  // A different page and an expired entry both go back to Gmail.
  await g.call("123", "gmail_search", "deposit", "page2");
  assert.ok(r.calls.length > after);
  const paged = r.calls.length;
  now += 300_001;
  await g.call("123", "gmail_search", "deposit");
  assert.ok(r.calls.length > paged);
});

test("thread reads are ordered oldest first and bounded per message and in total", async () => {
  const body = (text: string) => ({
    mimeType: "text/plain",
    body: { data: Buffer.from(text).toString("base64url") },
  });
  const r = routed(() => ({
    id: "ffa1",
    messages: [
      {
        id: "m2",
        threadId: "ffa1",
        internalDate: "200",
        payload: {
          headers: [{ name: "Subject", value: "Re: Deposit" }],
          ...body("b".repeat(5000)),
        },
      },
      {
        id: "m1",
        threadId: "ffa1",
        internalDate: "100",
        payload: {
          headers: [
            { name: "Subject", value: "Deposit" },
            { name: "Received", value: "should not be returned" },
          ],
          ...body("short"),
        },
      },
    ],
  }));
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_thread",
    "ffa1",
  );
  assert.deepEqual(
    out.messages.map((m: any) => m.id),
    ["m1", "m2"],
  );
  assert.equal(out.messages[0].truncated, false);
  assert.equal(out.messages[1].text.length, 4000);
  assert.equal(out.messages[1].truncated, true);
  assert.ok(!JSON.stringify(out).includes("should not be returned"));
  assert.match(out.note, /gmail_read/);
  assert.match(String(r.calls.at(-1)), /\/threads\/ffa1\?format=full/);
});

test("a thread past the total budget omits trailing messages", async () => {
  const filler = (id: string, at: string) => ({
    id,
    threadId: "ffa1",
    internalDate: at,
    payload: {
      headers: [],
      mimeType: "text/plain",
      body: { data: Buffer.from("c".repeat(4000)).toString("base64url") },
    },
  });
  const r = routed(() => ({
    id: "ffa1",
    messages: ["1", "2", "3", "4", "5"].map((n) => filler(`m${n}`, n + "00")),
  }));
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_thread",
    "ffa1",
  );
  assert.equal(out.messages.length, 4);
  assert.equal(out.omitted, 1);
  assert.equal(
    out.messages.reduce((n: number, m: any) => n + m.text.length, 0),
    16000,
  );
});

test("thread and message ids are validated before any request", async () => {
  const r = routed(() => ({}));
  const g = new GmailTools(config, r.request);
  for (const id of ["../profile", "m1/../../x", "zz", "t1"])
    await assert.rejects(g.call("123", "gmail_thread", id), /Invalid Gmail/);
  assert.ok(!r.calls.some((c) => c.includes("/threads/")));
});

test("the per-turn request budget is enforced and does not cross runs", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: [{ id: "a1", threadId: "t1" }], resultSizeEstimate: 1 }
      : metadata("a1", "Budgeted"),
  );
  const g = new GmailTools(config, r.request);
  // Twenty distinct searches cost two requests each and exhaust the run.
  for (let i = 0; i < 20; i++)
    await g.call("123", "gmail_search", `query ${i}`, undefined, "run-1");
  await assert.rejects(
    g.call("123", "gmail_read", "abc", undefined, "run-1"),
    (e: Error) => {
      assert.equal(toolError(e).retryable, false);
      assert.equal(toolError(e).code, "VALIDATION_FAILED");
      assert.match(e.message, /budget for this turn is used/);
      return true;
    },
  );
  // A fresh run starts with the full budget; an unbudgeted caller is unaffected.
  await g.call("123", "gmail_read", "abc", undefined, "run-2");
  await g.call("123", "gmail_read", "abc");
});

test("a search that runs out of budget mid-page still answers with the ids", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? {
          messages: Array.from({ length: 10 }, (_, i) => ({
            id: `a${i}`,
            threadId: `t${i}`,
          })),
          resultSizeEstimate: 10,
        }
      : metadata("a1", "Partial"),
  );
  const g = new GmailTools(config, r.request);
  for (let i = 0; i < 3; i++)
    await g.call("123", "gmail_search", `query ${i}`, undefined, "run-1");
  const out: any = await g.call(
    "123",
    "gmail_search",
    "final",
    undefined,
    "run-1",
  );
  assert.equal(out.results.length, 10);
  const short = out.results.filter((x: any) => x.detail);
  assert.ok(short.length > 0);
  assert.match(short[0].detail, /budget/);
  assert.ok(out.results.every((x: any) => x.id && x.threadId));
});

test("the unread briefing digest is built from search metadata alone", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? {
          messages: [
            { id: "a1", threadId: "ta1" },
            { id: "a2", threadId: "ta2" },
          ],
          resultSizeEstimate: 2,
        }
      : metadata(url.pathname.endsWith("a1") ? "a1" : "a2", "Deposit notice"),
  );
  const out = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "in:inbox is:unread newer_than:1d",
  );
  const lines = unreadDigest(out);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /Deposit notice — Sender <sender@example.com>/);
  // No message body was fetched for the digest.
  assert.ok(!r.calls.some((c) => c.includes("format=full")));
  assert.deepEqual(unreadDigest({ results: [{}] }), ["• (No subject)"]);
});

test("Gmail reads plain text without processing HTML or attachments", () => {
  const data = Buffer.from("Evidence, not instructions").toString("base64url");
  assert.equal(
    plainBody({
      parts: [
        { mimeType: "text/html", body: { data } },
        { mimeType: "text/plain", filename: "secret.txt", body: { data } },
        { mimeType: "text/plain", body: { data } },
      ],
    }),
    "Evidence, not instructions",
  );
});
test("Gmail tools reject extra fields, arbitrary URLs and write operations", () => {
  for (const a of [
    { operation: "gmail_read", messageId: "../profile" },
    { operation: "gmail_search", query: "jobs", user: "456" },
    { operation: "gmail_send", query: "jobs" },
    { operation: "gmail_thread", threadId: "../profile" },
    { operation: "gmail_thread", threadId: "t1", format: "raw" },
    { operation: "gmail_thread" },
  ])
    assert.equal(action.safeParse(a).success, false);
});
