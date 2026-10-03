import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { CreditBucket } from "../src/market-credits.js";
import {
  parseBars,
  quoteKey,
  TwelveDataProvider,
  type MarketDataProvider,
  type PriceBar,
  type Quote,
  type SymbolRef,
} from "../src/stock-provider.js";
import { computeStats } from "../src/stock-stats.js";
import { StockLookup } from "../src/stock-lookup.js";
import { readOperations } from "../src/execution.js";
import { runtimeContext } from "../src/runtime.js";
import { action } from "../src/protocol.js";
import { domainOf } from "../src/tool-domains.js";

/** Consecutive weekday dates ending the day before `last`, ascending. */
function sessions(count: number, last = "2026-10-02") {
  const out: string[] = [];
  const d = new Date(last + "T00:00:00Z");
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
      out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}
const bar = (
  date: string,
  close: number,
  low = close,
  high = close,
): PriceBar => ({
  date,
  open: close,
  high,
  low,
  close,
});
const quote = (price: number, extra: Partial<Quote> = {}): Quote => ({
  price,
  prevClose: 100,
  providerChangePct: null,
  currency: "USD",
  quoteTime: new Date("2026-10-02T15:00:00Z"),
  tradingDate: "2026-10-02",
  marketOpen: true,
  extended: null,
  delayed: true,
  ...extra,
});

test("statistics: averages use completed sessions; ranges and all-time include today's price", () => {
  // 300 completed sessions: closes 1..300, then today's bar.
  const days = sessions(300);
  const daily = days.map((d, i) => bar(d, i + 1, i + 0.5, i + 1.5));
  daily.push(bar("2026-10-02", 250, 40, 260));
  const monthly = [
    bar("1980-12-01", 0.5, 0.1, 0.6),
    bar("2026-10-01", 250, 40, 301),
  ];
  const s = computeStats({ quote: quote(250), daily, monthly });
  // 12w = mean of the last 60 completed closes (241..300) = 270.5
  assert.deepEqual(s.averages["12w"], {
    value: 270.5,
    sessions: 60,
    fromPct: -7.58,
  });
  // 52w = mean of closes 41..300 = 170.5
  assert.equal((s.averages["52w"] as any).value, 170.5);
  // 12w range spans the last 60 completed bars plus today's bar (low 40) and price.
  assert.equal((s.ranges["12w"] as any).low, 40);
  assert.equal((s.ranges["12w"] as any).lowDate, "2026-10-02");
  assert.equal((s.ranges["12w"] as any).high, 300.5);
  assert.equal((s.allTime as any).low, 0.1);
  assert.equal((s.allTime as any).since, "1980-12-01");
  assert.equal((s.allTime as any).high, 301);
  assert.equal(s.dayChangePct, 150);
  // A new all-time low today is reported as today's.
  const fresh = computeStats({ quote: quote(0.05), daily, monthly });
  assert.equal((fresh.allTime as any).low, 0.05);
  assert.equal((fresh.allTime as any).lowDate, "2026-10-02");
  assert.equal((fresh.allTime as any).fromLowPct, 0);
});

test("statistics: too little history is null with a reason, never a shorter window", () => {
  const daily = sessions(100).map((d) => bar(d, 10));
  const s = computeStats({ quote: quote(10), daily, monthly: [] });
  assert.equal((s.averages["12w"] as any).value, 10);
  assert.deepEqual(s.averages["52w"], {
    value: null,
    reason: "only 100 of 260 sessions of history",
  });
  assert.equal((s.ranges["26w"] as any).value, null);
  assert.equal((s.allTime as any).value, null);
  assert.equal(
    (
      computeStats({ quote: quote(10), daily: null, monthly: null }).averages[
        "12w"
      ] as any
    ).reason,
    "daily history unavailable",
  );
  assert.throws(() => computeStats({ quote: quote(0), daily, monthly: [] }));
});

test("bars are validated, sorted and never silently gapped", () => {
  const ok = parseBars([
    { datetime: "2026-10-02", open: "2", high: "3", low: "1", close: "2" },
    { datetime: "2026-10-01", open: "2", high: "3", low: "1", close: "2" },
  ]);
  assert.deepEqual(
    ok.map((b) => b.date),
    ["2026-10-01", "2026-10-02"],
  );
  for (const bad of [
    [{ datetime: "x", open: 1, high: 1, low: 1, close: 1 }],
    [{ datetime: "2026-10-01", open: 1, high: 1, low: 2, close: 1 }],
    [{ datetime: "2026-10-01", open: 1, high: 1, low: 1, close: "n/a" }],
    [
      { datetime: "2026-10-01", open: 1, high: 1, low: 1, close: 1 },
      { datetime: "2026-10-01", open: 1, high: 1, low: 1, close: 1 },
    ],
    null,
  ])
    assert.throws(() => parseBars(bad));
});

test("Twelve Data history requests split-adjusted ascending bars on the exact listing", async () => {
  const seen: URL[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    seen.push(new URL(String(input)));
    return new Response(
      JSON.stringify({
        status: "ok",
        values: [
          {
            datetime: "1980-12-01",
            open: "0.12",
            high: "0.16",
            low: "0.11",
            close: "0.15",
          },
        ],
      }),
    );
  }) as typeof fetch;
  try {
    const bars = await new TwelveDataProvider("k").history(
      { symbol: "AAPL", mic: "XNGS" },
      "1month",
      5000,
    );
    assert.equal(bars[0]!.low, 0.11);
  } finally {
    globalThis.fetch = original;
  }
  const u = seen[0]!;
  assert.equal(u.pathname, "/time_series");
  for (const [k, v] of Object.entries({
    symbol: "AAPL",
    mic_code: "XNGS",
    interval: "1month",
    outputsize: "5000",
    order: "asc",
    adjust: "splits",
  }))
    assert.equal(u.searchParams.get(k), v);
});

test("the credit bucket keeps lookups out of the monitor's daily reserve and resets by minute and UTC day", () => {
  const b = new CreditBucket(8, 800);
  const t = new Date("2026-10-03T23:59:10Z");
  b.spend(6, t); // monitor
  assert.equal(b.tryTake(3, t, 300), false); // only 2 left this minute
  assert.equal(b.tryTake(2, t, 300), true);
  const next = new Date("2026-10-03T23:59:30Z");
  assert.equal(b.available(next), 0);
  const later = new Date("2026-10-03T23:59:59Z");
  assert.equal(b.available(later), 0);
  // Daily reserve: at 495 used, a 6-credit lookup would breach 800-300.
  const d = new Date("2026-10-04T05:00:00Z");
  const c = new CreditBucket(1000, 800);
  c.spend(495, d);
  assert.equal(c.tryTake(6, d, 300), false);
  assert.equal(c.tryTake(5, d, 300), true);
  // Next UTC day resets the daily count.
  assert.equal(c.tryTake(6, new Date("2026-10-05T00:00:01Z"), 300), true);
});

class FakeProvider implements MarketDataProvider {
  readonly name = "fake";
  readonly creditsPerMinute = 8;
  readonly supportsExtended = false;
  calls = { search: 0, quotes: 0, history: 0 };
  hits = [
    {
      symbol: "AAPL",
      name: "Apple Inc",
      exchange: "NASDAQ",
      mic: "XNGS",
      timezone: "America/New_York",
      currency: "USD",
      type: "Common Stock",
    },
  ];
  async search() {
    this.calls.search++;
    return this.hits;
  }
  async quotes(refs: SymbolRef[]) {
    this.calls.quotes++;
    return new Map(refs.map((r) => [quoteKey(r), quote(250)]));
  }
  async history(_ref: SymbolRef, interval: "1day" | "1month") {
    this.calls.history++;
    return interval === "1day"
      ? sessions(300).map((d, i) => bar(d, i + 1))
      : [bar("1980-12-01", 0.5, 0.1, 0.6)];
  }
}

async function fixture(now = new Date("2026-10-02T15:00:00Z")) {
  const pg = new PGlite();
  for (const name of (await readdir(new URL("../db/", import.meta.url)))
    .filter((n) => /^\d.*sql$/.test(n))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + name, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "owner");
  const provider = new FakeProvider();
  const credits = new CreditBucket(8, 800);
  let clock = now;
  const lookup = new StockLookup(db, provider, credits, () => clock);
  return {
    db,
    provider,
    credits,
    lookup,
    at: (d: Date) => {
      clock = d;
    },
  };
}

test("lookup answers with provenance and caches history for the trading day", async () => {
  const f = await fixture();
  const first: any = await f.lookup.call("owner", {
    operation: "stock_lookup",
    query: "AAPL",
  });
  assert.equal(first.instrument.symbol, "AAPL");
  assert.equal(first.stats.allTime.since, "1980-12-01");
  assert.equal(first.source.provider, "fake");
  assert.match(first.note, /not buy or sell advice/);
  assert.deepEqual(f.provider.calls, { search: 1, quotes: 1, history: 2 });
  assert.equal(f.credits.usedToday(new Date("2026-10-02T15:00:00Z")), 4);
  // Two minutes later: the quote refreshes, history is reused.
  f.at(new Date("2026-10-02T15:02:00Z"));
  await f.lookup.call("owner", { operation: "stock_lookup", query: "AAPL" });
  // Same day: the resolved symbol and the history are reused; only the quote refreshes.
  assert.deepEqual(f.provider.calls, { search: 1, quotes: 2, history: 2 });
});

test("a watched stock resolves without a search; ambiguity and non-US listings are refused", async () => {
  const f = await fixture();
  const id = randomUUID();
  await f.db.query(
    `INSERT INTO watchlist_items(id,user_id,symbol,name,exchange,mic_code,exchange_timezone,currency)
     VALUES($1,'owner','AAPL','Apple Inc','NASDAQ','XNGS','America/New_York','USD')`,
    [id],
  );
  await f.lookup.call("owner", { operation: "stock_lookup", query: "aapl" });
  await f.lookup.call("owner", { operation: "stock_lookup", id });
  assert.equal(f.provider.calls.search, 0);
  f.provider.hits = [
    { ...f.provider.hits[0]!, symbol: "SHOP", exchange: "NYSE", mic: "XNYS" },
    {
      ...f.provider.hits[0]!,
      symbol: "SHOP",
      exchange: "TSX",
      mic: "XTSE",
      currency: "CAD",
    },
  ];
  const choice: any = await f.lookup.call("owner", {
    operation: "stock_lookup",
    query: "SHOP",
  });
  assert.equal(choice.needsChoice, true);
  assert.equal(choice.candidates.length, 2);
  await assert.rejects(
    f.lookup.call("owner", {
      operation: "stock_lookup",
      query: "SHOP",
      exchange: "TSX",
    }),
    /only US listings/,
  );
  await assert.rejects(
    f.lookup.call("owner", { operation: "stock_lookup", id: randomUUID() }),
    /No watched stock/,
  );
});

test("lookups report busy instead of taking credits the monitor already used this minute", async () => {
  const f = await fixture();
  f.credits.spend(7, new Date("2026-10-02T15:00:00Z")); // the monitor's batch
  const busy: any = await f.lookup.call("owner", {
    operation: "stock_lookup",
    query: "AAPL",
  });
  assert.equal(busy.status, "busy");
  assert(busy.retryAfterSeconds > 0);
  assert.deepEqual(f.provider.calls, { search: 1, quotes: 0, history: 0 });
});

test("stock_lookup is a read operation available only with market data", () => {
  assert(readOperations.has("stock_lookup"));
  assert.equal(domainOf("stock_lookup"), "watchlist");
  assert.equal(
    action.parse({ operation: "stock_lookup", query: "AAPL" }).operation,
    "stock_lookup",
  );
  const on = runtimeContext({ stocks: true }, null);
  assert(on.tools.some((t) => t.name === "stock_lookup"));
  const off = runtimeContext({ stocks: false }, null);
  assert(!off.tools.some((t) => t.name === "stock_lookup"));
});

test("the bucket never reopens a past minute when a stale monitor timestamp interleaves with a lookup", () => {
  const b = new CreditBucket(8, 800);
  const stale = new Date("2026-10-02T14:00:59.900Z"); // the monitor's tick-start clock
  b.spend(8, stale);
  assert.equal(b.tryTake(3, new Date("2026-10-02T14:01:00.500Z"), 300), true);
  // The monitor's next chunk still carries the old timestamp: it must not refill 14:00.
  assert.equal(b.available(stale), 5);
  b.spend(5, stale);
  assert.equal(b.tryTake(1, new Date("2026-10-02T14:01:01Z"), 300), false);
  assert.equal(b.available(new Date("2026-10-02T14:02:00Z")), 8);
});

test("statistics: a recent extreme carries its daily date, stale history is refused, closed sessions count", () => {
  const days = sessions(300);
  const daily = days.map((d) => bar(d, 100, 90, 110));
  daily[daily.length - 10] = bar(daily[daily.length - 10]!.date, 150, 90, 200);
  const peakDay = daily[daily.length - 10]!.date;
  const month = peakDay.slice(0, 7) + "-01";
  const monthly = [bar("1980-12-01", 1, 0.5, 2), bar(month, 150, 90, 200)];
  const s = computeStats({ quote: quote(100), daily, monthly });
  assert.equal((s.allTime as any).high, 200);
  assert.equal((s.allTime as any).highDate, peakDay);
  assert.equal((s.ranges["52w"] as any).highDate, peakDay);
  // History that stopped weeks ago is not presented as current.
  const old = sessions(300, "2026-09-01").map((d) => bar(d, 100));
  assert.match(
    (
      computeStats({ quote: quote(100), daily: old, monthly }).averages[
        "12w"
      ] as any
    ).reason,
    /daily history ends/,
  );
  // On a closed day (weekend, after the close) the quote date's bar is complete.
  const friday = [
    ...sessions(59, "2026-10-02").map((d) => bar(d, 10)),
    bar("2026-10-02", 1000),
  ];
  const open = computeStats({ quote: quote(10), daily: friday, monthly: [] });
  const closed = computeStats({
    quote: quote(10, { marketOpen: false }),
    daily: friday,
    monthly: [],
  });
  // While the session is open, the quote date's bar is excluded (59 completed closes of 10).
  assert.equal((open.averages["12w"] as any).value, 10);
  assert.equal((closed.averages["12w"] as any).value, 26.5); // (59*10 + 1000) / 60
});

test("a failed history series degrades to null figures and is not re-billed the same day", async () => {
  const f = await fixture();
  const original = f.provider.history.bind(f.provider);
  f.provider.history = (async (ref: SymbolRef, interval: "1day" | "1month") => {
    if (interval === "1month") {
      f.provider.calls.history++;
      throw new Error("bad bar");
    }
    return original(ref, interval);
  }) as any;
  const r: any = await f.lookup.call("owner", {
    operation: "stock_lookup",
    query: "AAPL",
  });
  assert.equal(r.stats.allTime.value, null);
  assert.notEqual(r.stats.averages["12w"].value, null);
  f.at(new Date("2026-10-02T15:05:00Z"));
  await f.lookup.call("owner", { operation: "stock_lookup", query: "AAPL" });
  assert.equal(f.provider.calls.history, 2);
});

test("when the daily reserve is the reason, busy asks to retry after the UTC reset", async () => {
  const f = await fixture(new Date("2026-10-02T15:00:00Z"));
  // 504 credits used: past the 800 - 300 reserve line.
  for (let m = 0; m < 72; m++)
    f.credits.spend(7, new Date(Date.UTC(2026, 9, 2, 12, m)));
  const busy: any = await f.lookup.call("owner", {
    operation: "stock_lookup",
    query: "AAPL",
  });
  assert.equal(busy.status, "busy");
  assert.equal(busy.retryAfterSeconds, 9 * 3600);
  assert.match(busy.note, /08:00 Singapore/);
});
