import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  Bearer,
  LibraryClient,
  LibraryError,
  singaporeDay,
} from "../src/library-client.js";
import { MemoryPacing } from "../src/library-pacing.js";
import { ToolValidationError } from "../src/tool-errors.js";

const denylist =
  /401|403|429|502|503|504|ETIMEDOUT|ECONNRESET|expired|credential|authorization|unavailable|not found|already used/i;

function harness(
  respond: (
    url: URL,
    init: RequestInit,
    n: number,
  ) => Response | Promise<Response>,
) {
  let now = Date.UTC(2026, 8, 20, 4, 0, 0);
  const calls: { url: URL; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const opened: string[] = [];
  const pacing = new MemoryPacing(() => now);
  const client = new LibraryClient({
    pacing,
    now: () => now,
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    request: (async (input: any, init: any) => {
      const url = new URL(input);
      calls.push({ url, init });
      return respond(url, init, calls.length);
    }) as typeof fetch,
    onBreakerOpen: async (_until, reason) => {
      opened.push(reason);
    },
  });
  return {
    client,
    pacing,
    calls,
    sleeps,
    opened,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}
const ok = (body: unknown) => Response.json(body);
const any = z.unknown();

test("reads are serialised with a two-second gap and writes wait a minute after the last write", async () => {
  const h = harness(() => ok({}));
  await Promise.all([
    h.client.call("libraryInfo", { schema: any, context: "turn" }),
    h.client.call("libraryInfo", { schema: any, context: "turn" }),
  ]);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.sleeps, [2000]);
  const bearer = new Bearer("secret-token");
  await h.client.call("loanCreate", {
    params: { cardId: "c", titleId: "1" },
    body: { period: 21 },
    bearer,
    schema: any,
    context: "background",
  });
  await assert.rejects(
    h.client.call("holdCreate", {
      params: { cardId: "c", titleId: "2" },
      bearer,
      schema: any,
      context: "turn",
    }),
    (e: any) => e instanceof LibraryError && e.kind === "paced",
  );
  await h.client.call("holdCreate", {
    params: { cardId: "c", titleId: "2" },
    bearer,
    schema: any,
    context: "background",
  });
  assert.equal(h.sleeps.at(-1), 60000);
  assert.equal(h.calls.length, 4);
  assert.equal(
    (h.calls[2]!.init.headers as Record<string, string>).authorization,
    "Bearer secret-token",
  );
  assert.equal(
    (h.calls[0]!.init.headers as Record<string, string>).authorization,
    undefined,
  );
  assert.equal(h.calls[0]!.init.redirect, "error");
  assert.ok(h.calls[0]!.init.signal instanceof AbortSignal);
});

test("the daily ceiling stops reads at 180 and every refusal is counted without a request", async () => {
  const h = harness(() => ok({}));
  for (let i = 0; i < 180; i++)
    await h.client.call("libraryInfo", { schema: any, context: "turn" });
  await assert.rejects(
    h.client.call("libraryInfo", { schema: any, context: "turn" }),
    (e: any) => e instanceof ToolValidationError && !denylist.test(e.message),
  );
  assert.equal(h.calls.length, 180);
  assert.equal(
    h.pacing.records.filter((r) => r.outcome === "refused").length,
    1,
  );
  assert.equal((await h.client.usage()).callsToday, 180);
  assert.equal(singaporeDay(h.now()), "2026-09-20");
});

test("a whoa 403 opens the breaker once and later calls make no request", async () => {
  const h = harness(
    () => new Response(JSON.stringify({ result: "whoa" }), { status: 403 }),
  );
  await assert.rejects(
    h.client.call("libraryInfo", { schema: any, context: "turn" }),
    (e: any) => e.kind === "throttled" && !denylist.test(e.message),
  );
  await assert.rejects(
    h.client.call("libraryInfo", { schema: any, context: "turn" }),
    (e: any) => e.kind === "paced" && /paused until \d\d:\d\d/.test(e.message),
  );
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.opened, ["throttle"]);
  const until = (await h.pacing.breaker())!.until;
  assert.equal(until - h.now(), 24 * 3600000);
});

test("HTTP 429 pauses for an hour and is never retried", async () => {
  const h = harness(() => new Response("", { status: 429 }));
  await assert.rejects(
    h.client.call("mediaSearch", { schema: any, context: "turn" }),
    (e: any) => e.kind === "throttled",
  );
  assert.equal(h.calls.length, 1);
  assert.equal((await h.pacing.breaker())!.until - h.now(), 3600000);
});

test("transient failures retry reads twice with jittered gaps, never writes, and the wording stays neutral", async () => {
  const h = harness(() => new Response("bad gateway", { status: 503 }));
  await assert.rejects(
    h.client.call("libraryInfo", { schema: any, context: "turn" }),
    (e: any) =>
      e instanceof ToolValidationError &&
      e.kind === "transient" &&
      !denylist.test(e.message) &&
      !(e instanceof TypeError),
  );
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.sleeps, [3000, 8000]);
  const before = h.calls.length;
  await assert.rejects(
    h.client.call("loanCreate", {
      params: { cardId: "c", titleId: "1" },
      bearer: new Bearer("t"),
      schema: any,
      context: "background",
    }),
  );
  assert.equal(h.calls.length, before + 1);
});

test("five consecutive transient failures trip a thirty-minute breaker", async () => {
  const h = harness(() => new Response("", { status: 502 }));
  await assert.rejects(
    h.client.call("libraryInfo", { schema: any, context: "turn" }),
  );
  await assert.rejects(
    h.client.call("libraryInfo", { schema: any, context: "turn" }),
  );
  assert.equal(h.calls.length, 5);
  await assert.rejects(
    h.client.call("libraryInfo", { schema: any, context: "turn" }),
    (e: any) => e.kind === "paced",
  );
  assert.equal(h.calls.length, 5);
});

test("4xx rejections and unauthenticated answers are not retried and leak nothing", async () => {
  const bearer = new Bearer("very-secret");
  const h = harness((url) =>
    url.pathname === "/chip/sync"
      ? new Response("", { status: 401 })
      : new Response(JSON.stringify({ errorCode: "HoldLimit", message: "x" }), {
          status: 400,
        }),
  );
  await assert.rejects(
    h.client.call("chipSync", { bearer, schema: any, context: "turn" }),
    (e: any) =>
      e.kind === "unauthenticated" &&
      !e.message.includes("very-secret") &&
      !e.message.includes("libbyapp"),
  );
  await assert.rejects(
    h.client.call("holdCreate", {
      params: { cardId: "c", titleId: "9" },
      bearer,
      schema: any,
      context: "background",
    }),
    (e: any) =>
      e.kind === "rejected" && e.code === "HoldLimit" && e.status === 400,
  );
  assert.equal(h.calls.length, 2);
  assert.equal(`${bearer}`, "[REDACTED]");
  assert.equal(JSON.stringify({ bearer }), '{"bearer":"[REDACTED]"}');
  await assert.rejects(
    h.client.call("chipSync", { schema: any, context: "turn" }),
    (e: any) => e.kind === "unauthenticated",
  );
  assert.equal(h.calls.length, 2);
});

test("oversized and malformed bodies are refused safely", async () => {
  const big = "x".repeat(70 * 1024);
  const h = harness((url) =>
    url.pathname.endsWith("/availability")
      ? new Response(big, { status: 200 })
      : new Response("{not json", { status: 200 }),
  );
  await assert.rejects(
    h.client.call("mediaAvailability", {
      query: { titleIds: "1" },
      schema: any,
      context: "turn",
    }),
    (e: any) => e.kind === "invalid_response" && /too large/.test(e.message),
  );
  await assert.rejects(
    h.client.call("libraryInfo", { schema: any, context: "turn" }),
    (e: any) => e.kind === "transient",
  );
});
