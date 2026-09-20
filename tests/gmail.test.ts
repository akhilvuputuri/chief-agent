import test from "node:test";
import assert from "node:assert/strict";
import { GmailTools, plainBody, unreadDigest } from "../src/gmail.js";
import { action } from "../src/protocol.js";
import { toolError } from "../src/tool-errors.js";
import { projectObservation } from "../src/observations.js";
/**
 * Results must survive the model-facing projection intact: above 12,000 serialized
 * characters it is replaced by a bare excerpt, which would drop the untrusted-content
 * warning that the repository requires on every email result.
 */
function assertProjects(result: unknown, operation: string) {
  const size = JSON.stringify(result).length;
  assert.ok(size < 12000, `${operation} serialises to ${size} characters`);
  const projected = projectObservation(operation, result).result;
  assert.equal(projected.truncated === true && !!projected.excerpt, false);
  assert.match(projected.warning, /Untrusted email content/);
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
/** Authorised mock that answers each Gmail endpoint from a route table. */
function routed(routes: (url: URL) => unknown) {
  const calls: string[] = [];
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
      ? { messages: [{ id: "a1", threadId: "fa1" }], resultSizeEstimate: 1 }
      : metadata("a1", long, { snippet: long, labelIds: ["INBOX"] }),
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
  assert.equal(out.hint, undefined);
  assert.match(out.warning, /Untrusted email content/);
  // The metadata request asks only for the four retained headers.
  const fetched = r.calls.find((c) => c.includes("format=metadata"))!;
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
  assert.ok(!r.calls.some((c) => c.includes("settings")));
  assert.ok(!r.calls.some((c) => c.includes("..")));
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
          messages: [{ id: "a1", threadId: "fa1" }],
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

test("a full page of maximal metadata still fits the model projection", async () => {
  const wide = "\u00e9".repeat(500);
  const ids = Array.from({ length: 10 }, (_, i) => `abcdef${i}`);
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? {
          messages: ids.map((id) => ({ id, threadId: `fabcdef${id}` })),
          nextPageToken: "n".repeat(200),
          resultSizeEstimate: 900,
        }
      : metadata(url.pathname.split("/").pop()!, wide, { snippet: wide }),
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "deposit",
  );
  assert.equal(out.results.length, 10);
  assertProjects(out, "gmail_search");
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
          ...plain("b".repeat(5000)),
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
  assert.equal(out.messages[1].text.length, 2500);
  assert.equal(out.messages[1].truncated, true);
  assert.ok(!JSON.stringify(out).includes("should not be returned"));
  assert.match(out.note, /gmail_read/);
  assert.match(out.warning, /Untrusted email content/);
  assert.match(String(r.calls.at(-1)), /\/threads\/ffa1\?format=full/);
});

test("a thread of messages without plain text is still bounded", async () => {
  // The regression this guards: HTML-only messages have an empty plain body, so
  // an accounting that charges only body length never terminates the loop.
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
  assert.equal(out.messages.length, 12);
  assert.equal(out.omitted, 48);
  assert.ok(out.messages.every((m: any) => m.subject.length <= 160));
  assert.ok(out.messages.every((m: any) => m.from.length <= 120));
  assert.ok(!JSON.stringify(out).includes("TTTT"));
  assertProjects(out, "gmail_thread");
});

test("a thread of plain-text messages respects the total character budget", async () => {
  const r = routed(() => ({
    id: "ffa1",
    messages: Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      threadId: "ffa1",
      internalDate: String(i),
      payload: { headers: [], ...plain("c".repeat(4000)) },
    })),
  }));
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_thread",
    "ffa1",
  );
  assert.equal(
    out.messages.reduce((n: number, m: any) => n + m.text.length, 0),
    6000,
  );
  assert.ok(out.omitted > 0);
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
      messages: Array.from({ length: 30 }, (_, i) => ({
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
  assert.equal(out.messages.length, 20);
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

test("the per-turn request budget is enforced and does not cross runs", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: [{ id: "a1", threadId: "fa1" }], resultSizeEstimate: 1 }
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
  const ids = Array.from({ length: 10 }, (_, i) => `b${i}`);
  const r = routed((url) => {
    if (url.pathname.endsWith("/messages"))
      return {
        messages: ids.map((id) => ({ id, threadId: `f${id}` })),
        resultSizeEstimate: 10,
      };
    const id = url.pathname.split("/").pop()!;
    return metadata(id, `Subject ${id}`);
  });
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
  // Every row keeps its own requested identifiers, retrieved or not.
  assert.deepEqual(
    out.results.map((x: any) => x.id),
    ids,
  );
  const short = out.results.filter((x: any) => x.detail);
  assert.ok(short.length > 0);
  assert.match(short[0].detail, /budget/);
  assert.ok(
    out.results
      .filter((x: any) => !x.detail)
      .every((x: any) => x.subject === `Subject ${x.id}`),
  );
});

test("a page degraded by the budget is not cached for a later turn", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
  const r = routed((url) => {
    if (url.pathname.endsWith("/messages"))
      return {
        messages: ids.map((id) => ({ id, threadId: `f${id}` })),
        resultSizeEstimate: 10,
      };
    return metadata(url.pathname.split("/").pop()!, "Complete");
  });
  const g = new GmailTools(config, r.request);
  for (let i = 0; i < 3; i++)
    await g.call("123", "gmail_search", `query ${i}`, undefined, "run-1");
  const partial: any = await g.call(
    "123",
    "gmail_search",
    "deposit",
    undefined,
    "run-1",
  );
  assert.ok(partial.results.some((x: any) => x.detail));
  // A fresh turn with full budget must retry rather than inherit the partial page.
  const complete: any = await g.call(
    "123",
    "gmail_search",
    "deposit",
    undefined,
    "run-2",
  );
  assert.ok(complete.results.every((x: any) => !x.detail));
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

test("a full page with no size estimate still asks the model to narrow", async () => {
  // Gmail omits resultSizeEstimate on some queries; a full page is itself the signal.
  const ids = Array.from({ length: 10 }, (_, i) => `e${i}`);
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: ids.map((id) => ({ id, threadId: `f${id}` })) }
      : metadata(url.pathname.split("/").pop()!, "Hit"),
  );
  const out: any = await new GmailTools(config, r.request).call(
    "123",
    "gmail_search",
    "the",
  );
  assert.equal(out.resultSizeEstimate, undefined);
  assert.match(out.hint, /Narrow with from:/);
});

test("an oversized result keeps its warning at the front of the excerpt", async () => {
  // Escaping can double the serialised size, so trimming keeps the result whole;
  // if a projection ever excerpts one anyway, the warning must still lead it.
  const quotes = '"'.repeat(500);
  const ids = Array.from({ length: 10 }, (_, i) => `d${i}`);
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
  );
  assert.ok(out.nextPageToken.length <= 1000);
  assertProjects(out, "gmail_search");
  assert.ok(out.omitted > 0, "trimmed rows are counted");
  const excerpt = JSON.stringify(out).slice(0, 200);
  assert.match(excerpt, /Untrusted email content/);
});

test("a thread of snippet-only messages is charged for the snippets it returns", async () => {
  // The original defect: the snippet stand-in was returned without being charged.
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
  assert.equal(
    out.messages.reduce((n: number, m: any) => n + m.text.length, 0),
    6000,
  );
  assert.ok(out.omitted > 0);
  // A snippet stand-in is not something gmail_read can improve on.
  assert.ok(out.messages.every((m: any) => m.bodyless === true));
  assert.ok(out.messages.every((m: any) => m.truncated === false));
});

test("a caller without a run identifier shares one bounded bucket", async () => {
  const r = routed((url) =>
    url.pathname.endsWith("/messages")
      ? { messages: [{ id: "a1", threadId: "fa1" }], resultSizeEstimate: 1 }
      : metadata("a1", "Unattributed"),
  );
  const g = new GmailTools(config, r.request);
  for (let i = 0; i < 20; i++)
    await g.call("123", "gmail_search", `unattributed ${i}`);
  // Twenty searches at two requests each exhaust the shared bucket, not 220 requests.
  assert.ok(r.calls.filter((c) => c.includes("/messages")).length <= 40);
  await assert.rejects(
    g.call("123", "gmail_read", "abc"),
    /budget for this turn is used/,
  );
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
