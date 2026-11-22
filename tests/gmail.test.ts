import test from "node:test";
import assert from "node:assert/strict";
import {
  GmailTools,
  plainBody,
  singaporeDates,
  unreadDigest,
} from "../src/gmail.js";
import { action } from "../src/protocol.js";
import { toolError } from "../src/tool-errors.js";
import { projectionLimits, projectObservation } from "../src/observations.js";
/**
 * Results must survive the model-facing projection intact: above the operation's
 * serialised limit it is replaced by a bare excerpt, which would drop the
 * untrusted-content warning that the repository requires on every email result.
 */
function assertProjects(result: unknown, operation: string) {
  const size = JSON.stringify(result).length;
  const limit = projectionLimits(operation).total;
  assert.ok(size < limit, `${operation} serialises to ${size} characters`);
  const projected = projectObservation(operation, result).result;
  assert.equal(projected.truncated === true && !!projected.excerpt, false);
  assert.equal(Object.keys(projected)[0], "warning");
  assert.match(projected.warning, /Untrusted email content/);
  return projected;
}
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
/**
 * Gmail's batch reply for a multipart request body: each inner GET is answered from
 * `answer`, an Error becoming a failed part, as the batch endpoint reports them.
 */
/** A Gmail error response a route can return: status and JSON body. */
class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}
const rateLimitBody = (reason = "rateLimitExceeded") => ({
  error: { code: 403, errors: [{ reason, domain: "usageLimits" }] },
});
function batchReply(body: string, answer: (url: URL) => unknown) {
  const parts = [...body.matchAll(/Content-ID: <item(\d+)>\r\n\r\nGET (\S+)/g)];
  const text =
    parts
      .map(([, index, path]) => {
        const out = answer(new URL("https://gmail.googleapis.com" + path));
        const status =
          out instanceof Reply
            ? `${out.status} Refused`
            : out instanceof Error
              ? "500 Internal Server Error"
              : "200 OK";
        const json = JSON.stringify(
          out instanceof Reply
            ? out.body
            : out instanceof Error
              ? { error: { code: 500 } }
              : out,
        );
        return `--batch_reply\r\nContent-Type: application/http\r\nContent-ID: <response-item${index}>\r\n\r\nHTTP/1.1 ${status}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${json}\r\n`;
      })
      .join("") + "--batch_reply--\r\n";
  return new Response(text, {
    headers: { "Content-Type": "multipart/mixed; boundary=batch_reply" },
  });
}
/**
 * Authorised mock that answers each Gmail endpoint from a route table. Batch requests
 * are answered part by part from the same table (`inner` records their paths), or
 * fail outright with `batch: "fail"`.
 */
function routed(
  routes: (url: URL) => unknown,
  options: { batch?: "ok" | "fail" | Reply } = {},
) {
  const calls: string[] = [];
  const inner: string[] = [];
  const request = (async (u: unknown, init?: RequestInit) => {
    const url = new URL(String(u));
    calls.push(url.pathname + url.search);
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "a", expires_in: 3600 });
    if (url.pathname.endsWith("/profile"))
      return Response.json({ emailAddress: config.email });
    if (url.pathname === "/batch/gmail/v1") {
      const body = String(init?.body);
      for (const m of body.matchAll(/GET (\S+)/g)) inner.push(m[1]!);
      if (options.batch === "fail")
        return new Response("unavailable", { status: 503 });
      if (options.batch instanceof Reply)
        return Response.json(options.batch.body, {
          status: options.batch.status,
        });
      return batchReply(body, routes);
    }
    const body = routes(url);
    if (body instanceof Error) throw body;
    if (body instanceof Reply)
      return Response.json(body.body, { status: body.status });
    return Response.json(body);
  }) as typeof fetch;
  return { request, calls, inner };
}
/** A route table that answers lists with `ids`, metadata by id and reads with plain text. */
function mailbox(ids: string[], extra: object = {}) {
  return (url: URL) => {
    if (url.pathname.endsWith("/messages"))
      return {
        messages: ids.map((id) => ({ id, threadId: `f${id}` })),
        resultSizeEstimate: ids.length,
        ...extra,
      };
    const id = url.pathname.split("/").pop()!;
    if (url.searchParams.get("format") === "metadata")
      return metadata(id, `Subject ${id}`);
    return { id, threadId: `f${id}`, payload: { headers: [], ...plain("x") } };
  };
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
test("Gmail search pages twenty hits for two requests; cached credentials reuse verified identity", async () => {
  const r = routed((url) =>
    url.searchParams.get("pageToken")
      ? { messages: [], resultSizeEstimate: 0 }
      : url.pathname.endsWith("/messages")
        ? { messages: [{ id: "abc", threadId: "def" }], nextPageToken: "next" }
        : metadata("abc", "First"),
  );
  const g = new GmailTools(config, r.request);
  await g.call("123", "gmail_search", "from:recruiter@example.com");
  await g.call("123", "gmail_search", "jobs", "next");
  // Credentials are verified once; a search is one list plus one metadata batch,
  // and an empty page needs no batch at all.
  assert.deepEqual(
    r.calls.map((c) => c.split("?")[0]),
    [
      "/token",
      "/gmail/v1/users/me/profile",
      "/gmail/v1/users/me/messages",
      "/batch/gmail/v1",
      "/gmail/v1/users/me/messages",
    ],
  );
  const first = new URL("https://x" + r.calls[2]);
  assert.equal(first.searchParams.get("maxResults"), "20");
  const url = new URL("https://x" + r.calls[4]);
  assert.equal(url.searchParams.get("maxResults"), "20");
  assert.equal(url.searchParams.get("pageToken"), "next");
});

test("search returns bounded triage metadata instead of bare ids", async () => {
  const long = "x".repeat(500);
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: [{ id: "a1", threadId: "fa1" }], resultSizeEstimate: 1 }
      : metadata("a1", long, {
          snippet: long,
          labelIds: ["INBOX", "CATEGORY_UPDATES"],
          internalDate: String(Date.parse("2026-09-19T02:00:00Z")),
        }),
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "deposit",
  );
  const hit = out.results[0];
  assert.equal(hit.id, "a1");
  assert.equal(hit.threadId, "fa1");
  assert.equal(hit.from, "Sender <sender@example.com>");
  assert.equal(hit.subject.length, 160);
  assert.equal(hit.snippet.length, 120);
  assert.ok(hit.from.length <= 120);
  assert.equal(hit.unread, false);
  assert.equal(hit.date, "Sat, 19 Sep 2026 10:00:00 +0800");
  // Received time is Gmail's internalDate, in Singapore time.
  assert.equal(hit.received, "2026-09-19T10:00:00+08:00");
  assert.equal(hit.category, "updates");
  assert.equal(hit.folder, "inbox");
  assert.equal(out.hint, undefined);
  assert.match(out.warning, /Untrusted email content/);
  // The metadata request asks only for the four retained headers.
  const fetched = r.inner.find((c) => c.includes("format=metadata"))!;
  assert.match(fetched, /metadataHeaders=From/);
  assert.match(fetched, /metadataHeaders=Subject/);
  assert.ok(!JSON.stringify(out).includes("should not be returned"));
});

test("a hit whose metadata fails degrades only its own row", async () => {
  const ids = ["a1", "a2", "a3", "a4", "a5"];
  const r = routed((url) => {
    if (url.pathname.endsWith("/messages"))
      return {
        messages: ids.map((id) => ({ id, threadId: `f${id}` })),
        resultSizeEstimate: 5,
      };
    const id = url.pathname.split("/").pop()!;
    // The failure sits in the middle, so the worker pool must hand off past it.
    return id === "a3" ? new Error("boom") : metadata(id, `Subject ${id}`);
  });
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "deposit",
  );
  assert.equal(out.results.length, 5);
  // Rows stay dense, in request order, and each carries its own requested id.
  assert.deepEqual(
    out.results.map((x: any) => x.id),
    ids,
  );
  assert.deepEqual(
    out.results.map((x: any) => x.threadId),
    ids.map((id) => `f${id}`),
  );
  assert.match(out.results[2].detail, /unavailable/);
  assert.equal(out.results[2].subject, undefined);
  for (const i of [0, 1, 3, 4]) {
    assert.equal(out.results[i].subject, `Subject ${ids[i]}`);
    assert.equal(out.results[i].detail, undefined);
  }
});

test("row identifiers come from the request, not the response echo", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: [{ id: "a1", threadId: "fa1" }], resultSizeEstimate: 1 }
      : // Gmail echoes a different id; the row must not adopt it.
        metadata("deadbeef", "Echoed", { threadId: "wrongthread" }),
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "deposit",
  );
  assert.equal(out.results[0].id, "a1");
  assert.equal(out.results[0].threadId, "fa1");
});

test("identifiers that are not hexadecimal never reach a request URL", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? {
          messages: [
            { id: "../../../v1/users/me/settings/forwarding", threadId: "fa1" },
            { id: "a1", threadId: "../../settings" },
            { id: "a2", threadId: "fa2" },
          ],
          resultSizeEstimate: 3,
        }
      : metadata("a2", "Only safe hit"),
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "deposit",
  );
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].id, "a2");
  for (const sent of [...r.calls, ...r.inner]) {
    assert.ok(!sent.includes("settings"));
    assert.ok(!sent.includes(".."));
  }
});

test("hints describe an empty and an oversized result set", async () => {
  const empty = routed(() => ({ messages: [], resultSizeEstimate: 0 }));
  const none: any = await new GmailTools(config, empty.request).call(
    "123",
    "gmail_search",
    "nothing",
  );
  assert.equal(none.results.length, 0);
  // An empty page is inconclusive, and the hint says how to broaden.
  assert.match(none.hint, /does not show the email is absent/);
  for (const step of [/quoted phrases/, /dates/, /from:name/, /in:anywhere/])
    assert.match(none.hint, step);
  const many = routed((url) =>
    url.pathname.endsWith("/messages")
      ? {
          messages: [{ id: "a1", threadId: "fa1" }],
          nextPageToken: "more",
          resultSizeEstimate: 900,
        }
      : metadata("a1", "One of many"),
  );
  const lots: any = await new GmailTools(config, many.request).call(
    "123",
    "gmail_search",
    "the",
  );
  assert.match(lots.hint, /Follow nextPageToken/);
  // A last page has nothing left to follow, whatever the estimate says.
  const last = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: [{ id: "a1", threadId: "fa1" }], resultSizeEstimate: 900 }
      : metadata("a1", "Last"),
  );
  const done: any = await new GmailTools(config, last.request).call(
    "123",
    "gmail_search",
    "the",
  );
  assert.equal(done.hint, undefined);
});

test("a full 100-row page of maximal metadata fits the model projection in two batches", async () => {
  const wide = "\u00e9".repeat(500);
  const ids = Array.from({ length: 100 }, (_, i) =>
    (i.toString(16) + "f".repeat(64)).slice(0, 64),
  );
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? {
          // Identifiers at Gmail's maximum accepted length.
          messages: ids.map((id) => ({ id, threadId: id })),
          nextPageToken: "n".repeat(1000),
          resultSizeEstimate: 900,
        }
      : metadata(url.pathname.split("/").pop()!, wide, {
          snippet: wide,
          labelIds: ["UNREAD", "CATEGORY_PROMOTIONS"],
          internalDate: "1789783200000",
        }),
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "deposit",
    undefined,
    undefined,
    undefined,
    { pageSize: 100 },
  );
  assert.equal(out.results.length, 100);
  assert.equal(out.omitted, 0);
  assert.ok(out.results.every((x: any) => x.subject && !x.detail));
  const projected = assertProjects(out, "gmail_search");
  assert.equal(projected.results.length, 100);
  // Batches hold at most 50 parts.
  assert.equal(r.calls.filter((c) => c === "/batch/gmail/v1").length, 2);
  assert.equal(r.inner.length, 100);
});

test("an identical search inside the cache window makes no request", async () => {
  let now = 1_000_000;
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: [{ id: "a1", threadId: "fa1" }], resultSizeEstimate: 1 }
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

const plain = (text: string) => ({
  mimeType: "text/plain",
  body: { data: Buffer.from(text).toString("base64url") },
});
const html = (text: string) => ({
  mimeType: "text/html",
  body: { data: Buffer.from(text).toString("base64url") },
});
test("thread reads are ordered oldest first and bounded per message", async () => {
  const r = routed(() => ({
    id: "ffa1",
    messages: [
      {
        id: "m2",
        threadId: "ffa1",
        internalDate: "200",
        payload: {
          headers: [{ name: "Subject", value: "Re: Deposit" }],
          ...plain("b".repeat(25000)),
        },
      },
      {
        id: "m1",
        threadId: "ffa1",
        internalDate: "100",
        payload: {
          headers: [
            { name: "Subject", value: "Deposit" },
            { name: "From", value: "Sender <sender@example.com>" },
            { name: "Received", value: "should not be returned" },
          ],
          ...plain("short"),
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
  assert.equal(out.messages[0].from, "Sender <sender@example.com>");
  // 20,000 characters per message; the rest is one gmail_read with offset away.
  assert.equal(out.messages[1].text.length, 20000);
  assert.equal(out.messages[1].truncated, true);
  assert.equal(out.messages[1].nextOffset, 20000);
  assert.equal(out.messages[1].totalChars, 25000);
  assert.equal(out.messages[0].text, "short");
  assert.equal(out.messages[0].fromHtml, undefined);
  assertProjects(out, "gmail_thread");
  assert.ok(!JSON.stringify(out).includes("should not be returned"));
  assert.match(out.note, /gmail_read/);
  assert.match(out.warning, /Untrusted email content/);
  assert.match(String(r.calls.at(-1)), /\/threads\/ffa1\?format=full/);
});

test("a long thread of HTML-only messages is readable and still bounded", async () => {
  // HTML-only messages are read as converted text and charged for it, so a long
  // newsletter thread is bounded by the message count and the shared total.
  const r = routed(() => ({
    id: "ffa1",
    messages: Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      threadId: "ffa1",
      internalDate: String(i),
      snippet: "s".repeat(400),
      payload: {
        headers: [
          { name: "Subject", value: "N".repeat(900) },
          { name: "From", value: "F".repeat(900) },
          { name: "To", value: "T".repeat(4000) },
        ],
        ...html("<p>" + "h".repeat(20000) + "</p>"),
      },
    })),
  }));
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_thread",
    "ffa1",
  );
  assert.equal(out.messages.length, 50);
  assert.equal(out.omitted, 10);
  // The 50,000-character total is shared fairly: 1,000 each.
  assert.ok(out.messages.every((m: any) => m.text === "h".repeat(1000)));
  assert.ok(out.messages.every((m: any) => m.fromHtml === true));
  assert.ok(out.messages.every((m: any) => m.truncated && !m.bodyless));
  assert.ok(out.messages.every((m: any) => m.subject.length <= 160));
  assert.ok(out.messages.every((m: any) => m.from.length <= 120));
  assert.ok(!JSON.stringify(out).includes("TTTT"));
  assert.doesNotMatch(out.note, /will not return more/);
  assertProjects(out, "gmail_thread");
});

test("a thread of plain-text messages shares the total character budget fairly", async () => {
  const r = routed(() => ({
    id: "ffa1",
    messages: [
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `m${i}`,
        threadId: "ffa1",
        internalDate: String(i + 1),
        payload: { headers: [], ...plain("c".repeat(6000)) },
      })),
      // A short reply takes only what it needs, and the rest is shared.
      {
        id: "m99",
        threadId: "ffa1",
        internalDate: "999",
        payload: { headers: [], ...plain("thanks") },
      },
    ],
  }));
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_thread",
    "ffa1",
  );
  const total = out.messages.reduce(
    (n: number, m: any) => n + m.text.length,
    0,
  );
  assert.ok(total <= 50000 && total > 49_980, `total ${total}`);
  assert.equal(out.messages.at(-1).text, "thanks");
  assert.equal(out.messages.at(-1).truncated, false);
  const long = out.messages.slice(0, 12).map((m: any) => m.text.length);
  assert.ok(Math.max(...long) - Math.min(...long) <= 1);
  assert.ok(out.messages.slice(0, 12).every((m: any) => m.truncated));
  assert.equal(out.omitted, 0);
  assertProjects(out, "gmail_thread");
});

test("a conversation past the response guard falls back to its message list", async () => {
  let full = true;
  const calls: string[] = [];
  const request = (async (u: unknown) => {
    const url = new URL(String(u));
    calls.push(url.pathname + url.search);
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "a", expires_in: 3600 });
    if (url.pathname.endsWith("/profile"))
      return Response.json({ emailAddress: config.email });
    if (url.search.includes("format=full") && full) {
      full = false;
      // Larger than the two-megabyte response guard.
      return new Response("x".repeat(2_000_100));
    }
    return Response.json({
      id: "ffa1",
      messages: Array.from({ length: 60 }, (_, i) => ({
        id: `m${i}`,
        threadId: "ffa1",
        internalDate: String(i),
        payload: { headers: [{ name: "Subject", value: `Part ${i}` }] },
      })),
    });
  }) as typeof fetch;
  const out: any = await new GmailTools(config, request).call(
    "123",
    "gmail_thread",
    "ffa1",
  );
  // The call answers instead of failing, and points at a usable next step.
  assert.equal(out.truncated, true);
  assert.equal(out.messages.length, 50);
  assert.equal(out.omitted, 10);
  assert.match(out.note, /gmail_read/);
  assert.ok(calls.some((c) => c.includes("format=metadata")));
  assertProjects(out, "gmail_thread");
});

test("thread and message ids are validated before any request", async () => {
  const r = routed(() => ({}));
  const g = new GmailTools(config, r.request);
  for (const id of ["../profile", "m1/../../x", "zz", "t1"])
    await assert.rejects(g.call("123", "gmail_thread", id), /Invalid Gmail/);
  assert.ok(!r.calls.some((c) => c.includes("/threads/")));
});

test("many searches and reads in one run are never refused", async () => {
  const ids = Array.from({ length: 50 }, (_, i) => `a${i}`);
  const r = routed(mailbox(ids));
  const g = new GmailTools(config, r.request);
  // A 50-hit page is one list and one batch, not 51 requests.
  const page: any = await g.call(
    "123",
    "gmail_search",
    "receipts",
    undefined,
    "run-1",
    undefined,
    { pageSize: 50 },
  );
  assert.ok(page.results.every((x: any) => x.subject && !x.detail));
  assert.equal(r.calls.filter((c) => c === "/batch/gmail/v1").length, 1);
  // Far more than the 40 and 200 requests the removed per-run budget allowed.
  for (let i = 0; i < 150; i++)
    await g.call("123", "gmail_search", `query ${i}`, undefined, "run-1");
  for (let i = 0; i < 250; i++)
    await g.call("123", "gmail_read", "abc", undefined, "run-1");
  const last: any = await g.call(
    "123",
    "gmail_read",
    "",
    undefined,
    "run-1",
    undefined,
    { messageIds: ids.slice(0, 25) },
  );
  assert.ok(last.messages.every((m: any) => m.text === "x"));
});

test("a rate-limited batch degrades its rows without fetching them again", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `b${i}`);
  for (const refusal of [
    new Reply(429, { error: { code: 429 } }),
    new Reply(403, rateLimitBody("userRateLimitExceeded")),
  ]) {
    const r = routed(mailbox(ids), { batch: refusal });
    const out: any = await new GmailTools(config, r.request).call(
      "123",
      "gmail_search",
      "final",
    );
    assert.deepEqual(
      out.results.map((x: any) => x.id),
      ids,
    );
    assert.ok(
      out.results.every((x: any) => /rate limited.*retry/.test(x.detail)),
    );
    assert.equal(
      r.calls.filter((c) => c.includes("format=metadata")).length,
      0,
    );
  }
});

test("a failed batch falls back to single fetches, four at a time", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `b${i}`);
  let inFlight = 0;
  let peak = 0;
  const inner = routed(mailbox(ids), { batch: "fail" });
  const request = (async (u: unknown, init?: RequestInit) => {
    const single = String(u).includes("format=metadata");
    if (single) peak = Math.max(peak, ++inFlight);
    try {
      if (single) await new Promise((done) => setTimeout(done, 2));
      return await inner.request(u as string, init);
    } finally {
      if (single) inFlight--;
    }
  }) as typeof fetch;
  const out: any = await new GmailTools(config, request).call(
    "123",
    "gmail_search",
    "final",
  );
  assert.deepEqual(
    out.results.map((x: any) => x.subject),
    ids.map((id) => `Subject ${id}`),
  );
  assert.equal(peak, 4);
});

test("a page degraded by a rate limit is not cached for a later call", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
  let limited = true;
  const r = routed((url) => {
    if (url.pathname.endsWith("/messages"))
      return { messages: ids.map((id) => ({ id, threadId: `f${id}` })) };
    if (limited && url.pathname.endsWith("/c3"))
      return new Reply(429, { error: { code: 429 } });
    return metadata(url.pathname.split("/").pop()!, "Complete");
  });
  const g = new GmailTools(config, r.request);
  const partial: any = await g.call("123", "gmail_search", "deposit");
  assert.match(partial.results[3].detail, /rate limited/);
  // A rate-limited part is not fetched again within the call.
  assert.equal(r.calls.filter((c) => c.includes("/c3?")).length, 0);
  limited = false;
  const complete: any = await g.call("123", "gmail_search", "deposit");
  assert.ok(complete.results.every((x: any) => x.subject === "Complete"));
});

test("a cached page is handed out as a copy, not the stored object", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: [{ id: "a1", threadId: "fa1" }], resultSizeEstimate: 1 }
      : metadata("a1", "Original"),
  );
  const g = new GmailTools(config, r.request);
  const first: any = await g.call("123", "gmail_search", "deposit");
  first.results[0].subject = "Mutated";
  const second: any = await g.call("123", "gmail_search", "deposit");
  assert.equal(second.results[0].subject, "Original");
  assert.notEqual(first, second);
});

test("the unread briefing digest is built from search metadata alone", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? {
          messages: [
            { id: "a1", threadId: "fa1" },
            { id: "a2", threadId: "fa2" },
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
  // A row that could not be retrieved must not become a blank bullet.
  assert.deepEqual(
    unreadDigest({
      results: [{ detail: "not retrieved: unavailable" }, { from: "A" }],
    }),
    ["• (No subject) — A"],
  );
});

test("a page with a next page token but no size estimate still says there is more", async () => {
  // Gmail omits resultSizeEstimate on some queries; the page token is the signal.
  const ids = Array.from({ length: 20 }, (_, i) => `e${i}`);
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? {
          messages: ids.map((id) => ({ id, threadId: `f${id}` })),
          nextPageToken: "p2",
        }
      : metadata(url.pathname.split("/").pop()!, "Hit"),
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "the",
  );
  assert.equal(out.resultSizeEstimate, undefined);
  assert.equal(out.nextPageToken, "p2");
  assert.match(out.hint, /Follow nextPageToken/);
});

test("an oversized result keeps its warning at the front of the excerpt", async () => {
  // Escaping can double the serialised size, so trimming keeps the result whole;
  // if a projection ever excerpts one anyway, the warning must still lead it.
  // A control character serialises as six, the worst case for escaping.
  const quotes = "\u0001".repeat(500);
  const ids = Array.from({ length: 50 }, (_, i) => `d${i}`);
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? {
          messages: ids.map((id) => ({ id, threadId: `f${id}` })),
          nextPageToken: "n".repeat(6000),
          resultSizeEstimate: 900,
        }
      : {
          id: url.pathname.split("/").pop()!,
          threadId: "fa1",
          snippet: quotes,
          labelIds: [],
          payload: {
            headers: [
              { name: "From", value: quotes },
              { name: "To", value: quotes },
              { name: "Subject", value: quotes },
              { name: "Date", value: quotes },
            ],
          },
        },
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "deposit",
    undefined,
    undefined,
    undefined,
    { pageSize: 50 },
  );
  assert.ok(out.nextPageToken.length <= 1000);
  assertProjects(out, "gmail_search");
  assert.ok(out.omitted > 0, "trimmed rows are counted");
  const excerpt = JSON.stringify(out).slice(0, 200);
  assert.match(excerpt, /Untrusted email content/);
});

test("a message with neither a plain-text nor an HTML body is marked bodyless", async () => {
  const r = routed(() => ({
    id: "ffa1",
    messages: Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      threadId: "ffa1",
      internalDate: String(i),
      snippet: "s".repeat(900),
      payload: { headers: [], mimeType: "text/html", body: { data: "" } },
    })),
  }));
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_thread",
    "ffa1",
  );
  // The snippet stands in, bounded to Gmail's own snippet length.
  assert.ok(out.messages.every((m: any) => m.text === "s".repeat(200)));
  assert.ok(out.messages.every((m: any) => m.bodyless === true));
  assert.ok(out.messages.every((m: any) => m.truncated === false));
  assert.ok(out.messages.every((m: any) => m.fromHtml === undefined));
  assertProjects(out, "gmail_thread");
});

test("a cached page cannot be mutated through a second read", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: [{ id: "a1", threadId: "fa1" }], resultSizeEstimate: 1 }
      : metadata("a1", "Original"),
  );
  const g = new GmailTools(config, r.request);
  await g.call("123", "gmail_search", "deposit");
  const second: any = await g.call("123", "gmail_search", "deposit");
  second.results[0].subject = "Mutated";
  const third: any = await g.call("123", "gmail_search", "deposit");
  assert.equal(third.results[0].subject, "Original");
});

test("plainBody takes only inline plain-text parts, never HTML or attachments", () => {
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
    { operation: "gmail_read", messageIds: ["abc", "../profile"] },
    { operation: "gmail_read", messageIds: [] },
    {
      operation: "gmail_read",
      messageIds: Array.from({ length: 26 }, (_, i) => `a${i}`),
    },
    { operation: "gmail_read", messageId: "abc", offset: -1 },
    { operation: "gmail_read", messageId: "abc", offset: 1.5 },
    { operation: "gmail_search", query: "jobs", pageSize: 0 },
    { operation: "gmail_search", query: "jobs", pageSize: 101 },
    { operation: "gmail_search", query: "jobs", pageSize: 2.5 },
    { operation: "gmail_search", query: "jobs", user: "456" },
    { operation: "gmail_send", query: "jobs" },
    { operation: "gmail_thread", threadId: "../profile" },
    { operation: "gmail_thread", threadId: "t1", format: "raw" },
    { operation: "gmail_thread" },
  ])
    assert.equal(action.safeParse(a).success, false);
});

test("Gmail tool schemas accept the new read and page arguments", () => {
  for (const a of [
    { operation: "gmail_read", messageId: "abc", offset: 20000 },
    {
      operation: "gmail_read",
      messageIds: Array.from({ length: 25 }, (_, i) => `a${i}`),
    },
    { operation: "gmail_search", query: "jobs", pageSize: 1 },
    { operation: "gmail_search", query: "jobs", pageSize: 100 },
  ])
    assert.equal(action.safeParse(a).success, true, JSON.stringify(a));
});

const single = (payload: object, extra: object = {}) =>
  routed(() => ({
    id: "abc",
    threadId: "fabc",
    snippet: "Gmail snippet",
    payload: {
      headers: [
        { name: "From", value: "Shop <receipts@example.com>" },
        { name: "Date", value: "Sat, 19 Sep 2026 10:00:00 +0800" },
      ],
      ...payload,
    },
    ...extra,
  }));

test("a single read keeps its result shape and prefers the plain-text part", async () => {
  const r = single({
    mimeType: "multipart/alternative",
    parts: [plain("Plain receipt"), html("<p>HTML receipt</p>")],
  });
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_read",
    "abc",
  );
  // Responsibilities match on id and account; the shape is unchanged for messageId.
  assert.deepEqual(Object.keys(out), [
    "warning",
    "id",
    "threadId",
    "headers",
    "text",
    "truncated",
    "account",
    "email",
  ]);
  assert.equal(out.id, "abc");
  assert.equal(out.account, "primary");
  assert.equal(out.text, "Plain receipt");
  assert.equal(out.truncated, false);
});

test("an HTML-only message is read as converted text, never executed or followed", async () => {
  const r = single(
    html(
      "<html><head><style>p{color:red}</style><script>steal()</script></head><body>" +
        "<p>Your receipt for <b>Example Cloud</b>: SGD&nbsp;4.98</p>" +
        '<img src="https://tracker.example.com/pixel.png"><a href="https://example.com/x">Manage</a>' +
        '<div class="gmail_quote">Earlier quoted message</div></body></html>',
    ),
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_read",
    "abc",
  );
  assert.match(out.text, /Your receipt for Example Cloud : SGD 4\.98/);
  assert.match(out.text, /Manage/);
  assert.doesNotMatch(out.text, /steal|color:red|Earlier quoted/);
  assert.equal(out.fromHtml, true);
  assert.equal(out.bodyless, undefined);
  assert.match(out.warning, /HTML is converted to text only/);
  // Only the message itself was requested: no image, link or other part.
  assert.ok(r.calls.every((c) => !c.includes("tracker") && !c.includes("/x")));
  assert.equal(r.calls.filter((c) => c.includes("/messages/abc")).length, 1);
});

test("a message with neither body part is bodyless and shows the snippet", async () => {
  const r = single({ mimeType: "image/png", body: { data: "AAAA" } });
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_read",
    "abc",
  );
  assert.equal(out.text, "Gmail snippet");
  assert.equal(out.bodyless, true);
  assert.equal(out.truncated, false);
});

test("an HTML-only thread message is read as converted text", async () => {
  const r = routed(() => ({
    id: "ffa1",
    messages: [
      {
        id: "m1",
        threadId: "ffa1",
        internalDate: "1",
        payload: {
          headers: [],
          ...html("<table><tr><td>Order 1234 shipped</td></tr></table>"),
        },
      },
    ],
  }));
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_thread",
    "ffa1",
  );
  assert.equal(out.messages[0].text, "Order 1234 shipped");
  assert.equal(out.messages[0].fromHtml, true);
  assert.equal(out.messages[0].bodyless, undefined);
});

test("a long message continues with offset until the whole text is read", async () => {
  const text = Array.from({ length: 45000 }, (_, i) =>
    String.fromCharCode(97 + (i % 26)),
  ).join("");
  const r = single(plain(text));
  const g = new GmailTools(config, r.request);
  const first: any = await g.call("123", "gmail_read", "abc");
  assert.equal(first.text.length, 20000);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 20000);
  assert.equal(first.totalChars, 45000);
  assert.match(first.note, /offset 20000/);
  // The projection shows the model all 20,000 characters, not 8,000.
  const projected = assertProjects(first, "gmail_read");
  assert.equal(projected.text.length, 20000);
  const read = (offset: number) =>
    g.call("123", "gmail_read", "abc", undefined, undefined, undefined, {
      offset,
    }) as Promise<any>;
  const second = await read(first.nextOffset);
  assert.equal(second.offset, 20000);
  assert.equal(second.nextOffset, 40000);
  const last = await read(second.nextOffset);
  assert.equal(last.truncated, false);
  assert.equal(last.nextOffset, undefined);
  assert.equal(first.text + second.text + last.text, text);
  // An offset at or past the end returns no text; the explanation is a note, not text.
  for (const offset of [45000, 90000]) {
    const past = await read(offset);
    assert.equal(past.text, "");
    assert.equal(past.truncated, false);
    assert.equal(past.totalChars, 45000);
    assert.match(past.note, /No text at this offset; the body has 45000/);
  }
});

test("a message with no body and no snippet has empty text and a note", async () => {
  const r = routed(() => ({
    id: "abc",
    threadId: "fabc",
    payload: { headers: [], mimeType: "image/png", body: { data: "AAAA" } },
  }));
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_read",
    "abc",
  );
  assert.equal(out.text, "");
  assert.equal(out.bodyless, true);
  assert.match(out.note, /no readable body or snippet/);
});

test("a single read returns From, To, Cc, Subject and Date in full", async () => {
  const subject = "Quarterly statement ".repeat(30) + "\u{1F600}";
  const to = Array.from(
    { length: 40 },
    (_, i) => `Person ${i} <p${i}@example.com>`,
  ).join(", ");
  const headers = [
    {
      name: "From",
      value: "Billing Department of Example Store <billing@example.com>",
    },
    { name: "To", value: to },
    { name: "Cc", value: to },
    { name: "Subject", value: subject },
    { name: "Date", value: "Sat, 19 Sep 2026 10:00:00 +0800" },
  ];
  assert.ok(subject.length > 600 && to.length > 1000);
  const r = routed((url) =>
    url.pathname.includes("/threads/")
      ? {
          id: "fabc",
          messages: [
            {
              id: "abc",
              threadId: "fabc",
              internalDate: "1",
              payload: { headers, ...plain("x") },
            },
          ],
        }
      : { id: "abc", threadId: "fabc", payload: { headers, ...plain("x") } },
  );
  const g = new GmailTools(config, r.request);
  const one: any = await g.call("123", "gmail_read", "abc");
  const value = (name: string) =>
    one.headers.find((h: any) => h.name === name)?.value;
  assert.deepEqual(
    one.headers.map((h: any) => h.name),
    ["from", "to", "cc", "subject", "date"],
  );
  assert.equal(value("subject"), subject);
  assert.equal(value("to"), to);
  assert.equal(value("cc"), to);
  assertProjects(one, "gmail_read");
  // Batch entries and thread entries keep the short caps and say where the full ones are.
  const batch: any = await g.call(
    "123",
    "gmail_read",
    "",
    undefined,
    undefined,
    undefined,
    {
      messageIds: ["abc"],
    },
  );
  assert.equal(
    batch.messages[0].headers.find((h: any) => h.name === "subject").value
      .length,
    160,
  );
  assert.match(batch.note, /one messageId returns them in full/);
  const thread: any = await g.call("123", "gmail_thread", "fabc");
  assert.equal(thread.messages[0].subject.length, 160);
  assert.match(thread.note, /returns the full headers/);
});

test("a batch read returns many messages in order with a fair shared total", async () => {
  const bodies: Record<string, string> = {
    a1: "short note",
    a2: "b".repeat(40000),
    a4: "d".repeat(40000),
    a5: "e".repeat(40000),
  };
  const r = routed((url) => {
    const id = url.pathname.split("/").pop()!;
    if (id === "a3") return new Error("unavailable");
    return {
      id,
      threadId: `f${id}`,
      payload: {
        headers: [{ name: "Subject", value: `Subject ${id}` }],
        ...plain(bodies[id]!),
      },
    };
  });
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_read",
    "",
    undefined,
    "run-1",
    undefined,
    { messageIds: ["a1", "a2", "a3", "a4", "a5", "a2"] },
  );
  assert.match(out.warning, /Untrusted email content/);
  assert.equal(out.account, "primary");
  // Request order, repeated ids read once, and the failure stays on its own row.
  assert.deepEqual(
    out.messages.map((m: any) => m.id),
    ["a1", "a2", "a3", "a4", "a5"],
  );
  assert.equal(out.messages[2].detail, "not retrieved: unavailable");
  assert.equal(out.messages[2].text, undefined);
  assert.equal(out.messages[0].text, "short note");
  assert.equal(out.messages[0].truncated, false);
  const long = [1, 3, 4].map((i) => out.messages[i]);
  assert.ok(
    long.every((m: any) => m.truncated && m.nextOffset === m.text.length),
  );
  assert.ok(long.every((m: any) => Math.abs(m.text.length - 16663) <= 1));
  const total = out.messages.reduce(
    (n: number, m: any) => n + (m.text?.length ?? 0),
    0,
  );
  assert.ok(total <= 50000 && total > 49_990, `total ${total}`);
  assert.equal(r.calls.filter((c) => c.includes("format=full")).length, 5);
  assertProjects(out, "gmail_read");
});

test("a batch read caps each message at the single-read size", async () => {
  const r = routed((url) => {
    const id = url.pathname.split("/").pop()!;
    return { id, threadId: `f${id}`, payload: plain("z".repeat(30000)) };
  });
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_read",
    "",
    undefined,
    undefined,
    undefined,
    { messageIds: ["a1", "a2"] },
  );
  assert.ok(out.messages.every((m: any) => m.text.length === 20000));
});

test("batch read arguments are validated before any request", async () => {
  const r = routed(() => ({}));
  const g = new GmailTools(config, r.request);
  const read = (value: string, options: object) =>
    g.call(
      "123",
      "gmail_read",
      value,
      undefined,
      undefined,
      undefined,
      options,
    );
  await assert.rejects(read("abc", { messageIds: ["a1"] }), /not both/);
  await assert.rejects(read("", { messageIds: ["a1"], offset: 5 }), /not both/);
  await assert.rejects(read("", {}), /messageId or messageIds/);
  await assert.rejects(
    read("", { messageIds: Array.from({ length: 26 }, (_, i) => `a${i}`) }),
    /1 to 25/,
  );
  await assert.rejects(
    read("", { messageIds: ["a1", "../profile"] }),
    /Invalid Gmail/,
  );
  assert.equal(r.calls.length, 0);
});

test("a rate-limited message in a batch read says to retry it", async () => {
  const r = routed((url) => {
    const id = url.pathname.split("/").pop()!;
    return id === "a2"
      ? new Reply(429, { error: { code: 429 } })
      : { id, threadId: `f${id}`, payload: plain("body " + id) };
  });
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_read",
    "",
    undefined,
    undefined,
    undefined,
    { messageIds: ["a1", "a2", "a3"] },
  );
  assert.deepEqual(
    out.messages.map((m: any) => m.text ?? m.detail),
    [
      "body a1",
      "not retrieved: Gmail rate limited this request; retry it shortly",
      "body a3",
    ],
  );
});

test("Gmail rate and quota refusals are told apart from permission failures", async () => {
  // The newer error shape names the reason in an ErrorInfo detail.
  const errorInfo = (reason: string, status = "PERMISSION_DENIED") => ({
    error: {
      code: 403,
      status,
      details: [
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason },
      ],
    },
  });
  const cases: [string, Reply, string, "rate" | "daily" | "auth"][] = [
    ["429", new Reply(429, { error: { code: 429 } }), "RATE_LIMITED", "rate"],
    [
      "403 rateLimitExceeded",
      new Reply(403, rateLimitBody()),
      "RATE_LIMITED",
      "rate",
    ],
    [
      "403 userRateLimitExceeded",
      new Reply(403, rateLimitBody("userRateLimitExceeded")),
      "RATE_LIMITED",
      "rate",
    ],
    [
      "403 ErrorInfo RATE_LIMIT_EXCEEDED",
      new Reply(403, errorInfo("RATE_LIMIT_EXCEEDED")),
      "RATE_LIMITED",
      "rate",
    ],
    [
      "403 dailyLimitExceeded",
      new Reply(403, rateLimitBody("dailyLimitExceeded")),
      "RATE_LIMITED",
      "daily",
    ],
    [
      "403 insufficientPermissions",
      new Reply(403, rateLimitBody("insufficientPermissions")),
      "AUTHORIZATION_REQUIRED",
      "auth",
    ],
    [
      "403 ErrorInfo ACCESS_TOKEN_SCOPE_INSUFFICIENT",
      new Reply(403, errorInfo("ACCESS_TOKEN_SCOPE_INSUFFICIENT")),
      "AUTHORIZATION_REQUIRED",
      "auth",
    ],
    [
      "403 without a body reason",
      new Reply(403, {}),
      "AUTHORIZATION_REQUIRED",
      "auth",
    ],
  ];
  for (const [name, reply, code, kind] of cases)
    for (const operation of [
      "gmail_search",
      "gmail_thread",
      "gmail_read",
    ] as const) {
      const r = routed(() => reply);
      await assert.rejects(
        new GmailTools(config, r.request).call(
          "123",
          operation,
          operation === "gmail_search" ? "x" : "abc",
        ),
        (e: Error) => {
          const err = toolError(e);
          assert.equal(err.code, code, `${operation} ${name}`);
          if (kind === "rate") {
            assert.equal(err.retryable, true);
            assert.match(err.message, /Wait a few seconds and retry/);
          }
          if (kind === "daily") {
            assert.equal(err.retryable, false);
            assert.match(err.message, /daily quota .* is used/);
            assert.match(err.message, /reset at midnight Pacific time/);
            assert.doesNotMatch(err.message, /wait a few seconds/i);
          }
          return true;
        },
      );
    }
});

test("a batch part refused for the daily quota says so and is not fetched again", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? {
          messages: [
            { id: "a1", threadId: "fa1" },
            { id: "a2", threadId: "fa2" },
          ],
        }
      : url.pathname.endsWith("/a1")
        ? new Reply(403, rateLimitBody("dailyLimitExceeded"))
        : metadata("a2", "Found"),
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "x",
  );
  assert.equal(
    out.results[0].detail,
    "not retrieved: Gmail's daily quota is used; it resets later",
  );
  assert.equal(out.results[1].subject, "Found");
  assert.equal(r.calls.filter((c) => c.includes("format=metadata")).length, 0);
});

test("rows the page fit drops are listed for a batch read and named in the hint", async () => {
  // Control characters serialise as six, so a full 100-row page cannot fit whole.
  const dense = "\u0001".repeat(500);
  const ids = Array.from({ length: 100 }, (_, i) => `d${i}`);
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? {
          messages: ids.map((id) => ({ id, threadId: `f${id}` })),
          nextPageToken: "more",
        }
      : {
          id: url.pathname.split("/").pop()!,
          threadId: "fa1",
          snippet: dense,
          labelIds: [],
          payload: {
            headers: ["From", "To", "Subject", "Date"].map((name) => ({
              name,
              value: dense,
            })),
          },
        },
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "deposit",
    undefined,
    undefined,
    undefined,
    { pageSize: 100 },
  );
  assert.ok(out.omitted > 0);
  assert.equal(out.results.length + out.omitted, 100);
  // The dropped rows are the tail of the page, in order, with their thread ids.
  assert.deepEqual(
    out.omittedMessages.map((m: any) => m.id),
    ids.slice(out.results.length),
  );
  assert.ok(out.omittedMessages.every((m: any) => m.threadId === `f${m.id}`));
  assert.match(
    out.hint,
    new RegExp(`^${out.omitted} rows did not fit .*gmail_read with messageIds`),
  );
  assert.match(out.hint, /Follow nextPageToken/);
  assertProjects(out, "gmail_search");
});

test("briefing lines and attachment names are cut on code points", async () => {
  const emoji = "\u{1F600}";
  assert.deepEqual(
    unreadDigest({
      results: [
        { subject: "s".repeat(159) + emoji, from: "f".repeat(79) + emoji },
      ],
    }),
    ["\u2022 " + "s".repeat(159) + " \u2014 " + "f".repeat(79)],
  );
  const r = routed(() => ({
    id: "abc",
    threadId: "fabc",
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "application/pdf",
          filename: "n".repeat(119) + emoji + ".pdf",
          body: { attachmentId: "att1", size: 10 },
        },
      ],
    },
  }));
  const [file] = await new GmailTools(config, r.request).attachmentInfo(
    "123",
    "abc",
    "primary",
  );
  assert.equal(file!.name, "n".repeat(119));
});

test("search metadata for a page comes from one batch request", async () => {
  const ids = Array.from({ length: 50 }, (_, i) => `a${i}`);
  let batchInit: RequestInit | undefined;
  const r = routed(mailbox(ids));
  const request = (async (u: unknown, init?: RequestInit) => {
    if (String(u).includes("/batch/")) batchInit = init;
    return r.request(u as string, init);
  }) as typeof fetch;
  const out: any = await new GmailTools(config, request).call(
    "123",
    "gmail_search",
    "receipts",
    undefined,
    undefined,
    undefined,
    { pageSize: 50 },
  );
  assert.equal(out.results.length, 50);
  assert.ok(
    out.results.every((x: any, i: number) => x.subject === `Subject a${i}`),
  );
  // No per-message metadata GETs: one list and one batch of 50 parts.
  assert.equal(r.calls.filter((c) => c.includes("format=metadata")).length, 0);
  assert.equal(r.calls.filter((c) => c === "/batch/gmail/v1").length, 1);
  assert.equal(r.inner.length, 50);
  assert.ok(
    r.inner.every((p) =>
      /^\/gmail\/v1\/users\/me\/messages\/a\d+\?format=metadata/.test(p),
    ),
  );
  assert.equal(batchInit?.method, "POST");
  assert.equal(batchInit?.redirect, "error");
  assert.match(
    String((batchInit?.headers as Record<string, string>)["Content-Type"]),
    /^multipart\/mixed; boundary=/,
  );
});

test("hits a batch did not answer are fetched on their own; a failed batch falls back", async () => {
  const ids = ["a1", "a2", "a3"];
  const routes = (url: URL) =>
    url.pathname.endsWith("/messages")
      ? { messages: ids.map((id) => ({ id, threadId: `f${id}` })) }
      : metadata(url.pathname.split("/").pop()!, "Found");
  // One failed part: only that hit is fetched again.
  let first = true;
  const partial = routed((url) => {
    if (url.pathname.endsWith("/a2") && first) {
      first = false;
      return new Error("part failed");
    }
    return routes(url);
  });
  const a: any = await new GmailTools(config, partial.request).call(
    "123",
    "gmail_search",
    "x",
  );
  assert.ok(a.results.every((x: any) => x.subject === "Found"));
  assert.deepEqual(
    partial.calls
      .filter((c) => c.includes("format=metadata"))
      .map((c) => c.split("?")[0]),
    ["/gmail/v1/users/me/messages/a2"],
  );
  // A rate-limited part is reported, not fetched again; a failed part is fetched once.
  const mixed = routed((url) =>
    url.pathname.endsWith("/a1")
      ? new Reply(403, rateLimitBody())
      : url.pathname.endsWith("/a2")
        ? new Error("still failing")
        : routes(url),
  );
  const m: any = await new GmailTools(config, mixed.request).call(
    "123",
    "gmail_search",
    "x",
  );
  assert.match(m.results[0].detail, /rate limited/);
  assert.equal(m.results[1].detail, "not retrieved: unavailable");
  assert.equal(m.results[2].subject, "Found");
  assert.deepEqual(
    mixed.calls
      .filter((c) => c.includes("format=metadata"))
      .map((c) => c.split("?")[0]),
    ["/gmail/v1/users/me/messages/a2"],
  );
  // The whole batch failing: every hit is fetched on its own and the search answers.
  const failed = routed(routes, { batch: "fail" });
  const b: any = await new GmailTools(config, failed.request).call(
    "123",
    "gmail_search",
    "x",
  );
  assert.ok(b.results.every((x: any) => x.subject === "Found"));
  assert.equal(
    failed.calls.filter((c) => c.includes("format=metadata")).length,
    3,
  );
});

test("pageSize is passed to Gmail and bounded in the adapter", async () => {
  const r = routed(mailbox([]));
  const g = new GmailTools(config, r.request);
  const search = (pageSize: number) =>
    g.call(
      "123",
      "gmail_search",
      `q${pageSize}`,
      undefined,
      undefined,
      undefined,
      {
        pageSize,
      },
    );
  await search(100);
  assert.match(r.calls.at(-1)!, /maxResults=100/);
  await search(10);
  assert.match(r.calls.at(-1)!, /maxResults=10/);
  const before = r.calls.length;
  for (const bad of [0, 101, 2.5])
    await assert.rejects(
      search(bad),
      /pageSize must be a whole number from 1 to 100/,
    );
  assert.equal(r.calls.length, before);
});

test("calendar dates in a query are sent as Singapore midnight", () => {
  const sgt = (y: number, m: number, d: number) =>
    Date.UTC(y, m - 1, d) / 1000 - 8 * 3600;
  assert.equal(singaporeDates("after:2026/09/01"), `after:${sgt(2026, 9, 1)}`);
  assert.equal(sgt(2026, 9, 1), Date.parse("2026-09-01T00:00:00+08:00") / 1000);
  assert.equal(
    singaporeDates("from:shop before:2026-09-02 receipt"),
    `from:shop before:${sgt(2026, 9, 2)} receipt`,
  );
  // older: and newer: become before: and after:, which Gmail documents for epoch seconds.
  assert.equal(singaporeDates("older:2026/1/5"), `before:${sgt(2026, 1, 5)}`);
  assert.equal(singaporeDates("newer:09/01/2026"), `after:${sgt(2026, 9, 1)}`);
  assert.equal(
    singaporeDates("(after:2026/01/01 OR -before:2025/12/31)"),
    `(after:${sgt(2026, 1, 1)} OR -before:${sgt(2025, 12, 31)})`,
  );
  assert.equal(
    singaporeDates("{after:2026/01/01 newer:2026/02/01}"),
    `{after:${sgt(2026, 1, 1)} after:${sgt(2026, 2, 1)}}`,
  );
  // Relative and numeric forms, invalid dates, non-operators and quoted text are untouched.
  for (const q of [
    "newer_than:7d older_than:1m",
    "after:1788192000",
    "after:2026/02/30",
    "after:2026/13/01",
    "xafter:2026/09/01",
    "after:2026/09/01x",
    'subject:"after:2026/09/01"',
    '"paid before:2026/09/01 or later"',
  ])
    assert.equal(singaporeDates(q), q);
  assert.equal(
    singaporeDates('"before:2026/01/01" after:2026/09/01 "after:2026/09/01"'),
    `"before:2026/01/01" after:${sgt(2026, 9, 1)} "after:2026/09/01"`,
  );
});

test("search sends the rewritten query and echoes what was sent", async () => {
  const r = routed(mailbox(["a1"]));
  const g = new GmailTools(config, r.request);
  const out: any = await g.call(
    "123",
    "gmail_search",
    "from:shop after:2026/09/01",
  );
  const sent = `from:shop after:${Date.parse("2026-09-01T00:00:00+08:00") / 1000}`;
  assert.equal(new URL("https://x" + r.calls[2]).searchParams.get("q"), sent);
  assert.equal(out.query, sent);
  assert.equal(out.requestedQuery, "from:shop after:2026/09/01");
  assert.match(out.dates, /Singapore midnight/);
  // A query with nothing to rewrite is echoed as is, without the extra fields.
  const plainQuery: any = await g.call("123", "gmail_search", "newer_than:30d");
  assert.equal(plainQuery.query, "newer_than:30d");
  assert.equal(plainQuery.requestedQuery, undefined);
  // Gathering opts out and keeps its query text exactly.
  await g.call(
    "123",
    "gmail_search",
    "after:2026/09/01",
    undefined,
    undefined,
    undefined,
    {
      pageSize: 10,
      singaporeDates: false,
    },
  );
  assert.equal(
    new URL(
      "https://x" + r.calls.filter((c) => c.includes("/messages?")).at(-1),
    ).searchParams.get("q"),
    "after:2026/09/01",
  );
});

test("an archived promotion is labelled for the searcher", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: [{ id: "a1", threadId: "fa1" }] }
      : metadata("a1", "Sale", { labelIds: ["CATEGORY_PROMOTIONS"] }),
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "sale in:anywhere",
  );
  assert.equal(out.results[0].category, "promotions");
  assert.equal(out.results[0].folder, "archived");
  assert.equal(out.results[0].unread, false);
});

const emoji = "\u{1F600}";
/** True when no high surrogate is left without its low half, or the reverse. */
function wholePairs(text: string) {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
    text,
  );
}
test("a read never cuts an emoji in half, and its continuation is exact", async () => {
  // The emoji's first half sits at index 19,999, so a plain cut at 20,000 would split it.
  const text = "a".repeat(19_999) + emoji + "b".repeat(30_000);
  const r = single(plain(text));
  const g = new GmailTools(config, r.request);
  const read = (offset?: number) =>
    g.call("123", "gmail_read", "abc", undefined, undefined, undefined, {
      offset,
    }) as Promise<any>;
  const parts: string[] = [];
  let offset: number | undefined;
  for (;;) {
    const out = await read(offset);
    assert.ok(wholePairs(out.text), `offset ${offset}`);
    parts.push(out.text);
    if (!out.truncated) break;
    offset = out.nextOffset;
  }
  assert.equal(parts[0]!.length, 19_999);
  assert.equal(parts.join(""), text);
  // An offset pointing at the emoji's second half starts at its first half instead.
  const inside = await read(20_000);
  assert.equal(inside.offset, 19_999);
  assert.ok(inside.text.startsWith(emoji));
  assert.ok(wholePairs(inside.text));
});

test("share boundaries in a batch read and a thread never split an emoji", async () => {
  // Three bodies share 50,000: 16,666 each, which lands inside the pair below.
  const body = "c".repeat(16_665) + emoji + "d".repeat(30_000);
  const r = routed((url) => {
    const id = url.pathname.split("/").pop()!;
    if (url.pathname.includes("/threads/"))
      return {
        id: "ffa1",
        messages: ["m1", "m2", "m3"].map((m, i) => ({
          id: m,
          threadId: "ffa1",
          internalDate: String(i),
          payload: { headers: [], ...plain(body) },
        })),
      };
    return { id, threadId: `f${id}`, payload: plain(body) };
  });
  const g = new GmailTools(config, r.request);
  const batch: any = await g.call(
    "123",
    "gmail_read",
    "",
    undefined,
    undefined,
    undefined,
    { messageIds: ["a1", "a2", "a3"] },
  );
  const thread: any = await g.call("123", "gmail_thread", "ffa1");
  for (const result of [batch, thread]) {
    // The first share (16,666) ends inside the pair and steps back before it; the
    // others (16,667) end just after it.
    assert.deepEqual(
      result.messages.map((m: any) => m.text.length),
      [16_665, 16_667, 16_667],
    );
    for (const m of result.messages) {
      assert.ok(wholePairs(m.text));
      assert.equal(m.nextOffset, m.text.length);
    }
  }
  // Every result can be stored: no lone surrogate anywhere in it.
  assert.ok(
    wholePairs(JSON.stringify(batch)) && wholePairs(JSON.stringify(thread)),
  );
});

test("trimming an oversized result to fit never splits an emoji", async () => {
  // Control characters serialise as six, so 20,000 of them must be trimmed to fit;
  // emoji are interleaved so any trim point can land inside a pair.
  const text = ("\u0001".repeat(40) + emoji).repeat(600);
  const r = single(plain(text));
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_read",
    "abc",
  );
  assert.ok(out.truncated);
  assert.ok(out.text.length < 20_000);
  assert.ok(wholePairs(out.text));
  assert.equal(out.nextOffset, out.text.length);
  assert.equal(text.slice(0, out.nextOffset), out.text);
  assertProjects(out, "gmail_read");
});

test("header and snippet caps never split an emoji", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: [{ id: "a1", threadId: "fa1" }] }
      : metadata("a1", "s".repeat(159) + emoji, {
          snippet: "n".repeat(119) + emoji,
        }),
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "x",
  );
  assert.equal(out.results[0].subject, "s".repeat(159));
  assert.equal(out.results[0].snippet, "n".repeat(119));
});

test("a thread past 50 messages lists the omitted ones for a batch read", async () => {
  const r = routed(() => ({
    id: "ffa1",
    messages: Array.from({ length: 60 }, (_, i) => ({
      id: `a${i}`,
      threadId: "ffa1",
      internalDate: String(Date.parse("2026-09-01T00:00:00Z") + i * 60_000),
      payload: { headers: [], ...plain(`reply ${i}`) },
    })),
  }));
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_thread",
    "ffa1",
  );
  assert.equal(out.messages.length, 50);
  assert.equal(out.omitted, 10);
  assert.deepEqual(
    out.omittedMessages.map((m: any) => m.id),
    Array.from({ length: 10 }, (_, i) => `a${50 + i}`),
  );
  assert.equal(out.omittedMessages[0].received, "2026-09-01T08:50:00+08:00");
  assert.match(
    out.note,
    /omittedMessages; read them with gmail_read messageIds/,
  );
  assert.ok(
    action.safeParse({
      operation: "gmail_read",
      messageIds: out.omittedMessages.map((m: any) => m.id),
    }).success,
  );
  assertProjects(out, "gmail_thread");
});

test("only an operator at the start of a token is rewritten, never to a non-positive epoch", () => {
  const sgt = Date.parse("2026-01-01T00:00:00+08:00") / 1000;
  for (const q of [
    "foo-before:2026/01/01",
    "x:after:2026/01/01",
    "after:1970/01/01",
    "before:1969/12/31",
  ])
    assert.equal(singaporeDates(q), q);
  assert.equal(singaporeDates("-before:2026/01/01"), `-before:${sgt}`);
  assert.equal(singaporeDates("a -after:2026/01/01"), `a -after:${sgt}`);
  assert.equal(singaporeDates("{-after:2026/01/01}"), `{-after:${sgt}}`);
  // 2 January 1970 is the first Singapore midnight with a positive epoch.
  assert.equal(singaporeDates("after:1970/01/02"), "after:57600");
});

/** A single message whose five full headers all carry `value`, with a 30,000-character body. */
function headerHeavy(value: string, body = "b".repeat(30_000)) {
  return routed(() => ({
    id: "abc",
    threadId: "fabc",
    payload: {
      headers: ["From", "To", "Cc", "Subject", "Date"].map((name) => ({
        name,
        value,
      })),
      ...plain(body),
    },
  }));
}

test("escape-dense maximal headers are shortened so the warning still leads the projection", async () => {
  // Quotes serialise as two characters and control characters as six, so five
  // 20,000-character headers would serialise to 200,000 or 600,000 characters.
  for (const dense of ['"', "\u0001", "h"]) {
    const r = headerHeavy(dense.repeat(25_000));
    const out: any = await new GmailTools(config, r.request).call(
      "123",
      "gmail_read",
      "abc",
    );
    const projected = assertProjects(out, "gmail_read");
    assert.equal(projected.excerpt, undefined);
    // Levelled evenly, all five named, and the body keeps its full 20,000.
    assert.deepEqual(out.headersTruncated, [
      "from",
      "to",
      "cc",
      "subject",
      "date",
    ]);
    assert.equal(new Set(out.headers.map((h: any) => h.value.length)).size, 1);
    assert.ok(out.headers[0].value.length > 0);
    assert.equal(out.text.length, 20_000);
    assert.equal(out.nextOffset, 20_000);
  }
});

test("when the body itself is escape-dense, headers keep their share and the body is cut", async () => {
  const r = headerHeavy("\u0001".repeat(25_000), "\u0001".repeat(30_000));
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_read",
    "abc",
  );
  assertProjects(out, "gmail_read");
  const headers = JSON.stringify(out.headers).length;
  assert.ok(headers <= 40_100 && headers > 38_000, `headers ${headers}`);
  assert.ok(out.text.length > 5_000 && out.text.length < 20_000);
  assert.equal(out.nextOffset, out.text.length);
  assert.equal(out.truncated, true);
});

test("ordinary long recipient lists are returned uncut", async () => {
  const to = Array.from(
    { length: 200 },
    (_, i) => `"Person ${i}" <person${i}@example.com>`,
  ).join(", ");
  assert.ok(to.length > 6000);
  const r = routed(() => ({
    id: "abc",
    threadId: "fabc",
    payload: {
      headers: [
        { name: "To", value: to },
        { name: "Cc", value: to },
      ],
      ...plain("c".repeat(30_000)),
    },
  }));
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_read",
    "abc",
  );
  assert.equal(out.headersTruncated, undefined);
  assert.equal(out.headers.find((h: any) => h.name === "to").value, to);
  assert.equal(out.headers.find((h: any) => h.name === "cc").value, to);
  assert.equal(out.text.length, 20_000);
});
