import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { WatchlistTools, StockMonitor, StockDelivery } from "../src/stocks.js";
import {
  ProviderError,
  TwelveDataProvider,
  quoteKey,
  rowToQuote,
  type MarketDataProvider,
  type Quote,
  type SymbolHit,
  type SymbolRef,
} from "../src/stock-provider.js";
import { ensureUser, type Database } from "../src/db.js";
import { runtimeContext } from "../src/runtime.js";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import { marketCalendar, sessionsFor } from "../src/market-calendar.js";
import {
  inWindow,
  upcomingChecks,
  validateWindow,
  windowOccurrence,
} from "../src/watch-window.js";
import { action } from "../src/protocol.js";

const NY = "America/New_York";
const MIC = "XNAS";

class FakeProvider implements MarketDataProvider {
  name = "fake-market-data";
  creditsPerMinute = 8;
  supportsExtended = true;
  hits: SymbolHit[] = [];
  quotes_ = new Map<string, Quote>();
  calls = { search: 0, quotes: 0 };
  batchSizes: number[] = [];
  onQuotes: (() => Promise<void> | void) | null = null;
  fail: { search?: Error; quotes?: Error } = {};
  async search(q: string): Promise<SymbolHit[]> {
    this.calls.search++;
    if (this.fail.search) throw this.fail.search;
    const needle = q.toLowerCase();
    return this.hits.filter(
      (h) =>
        h.symbol.toLowerCase().includes(needle) ||
        h.name.toLowerCase().includes(needle),
    );
  }
  async quotes(
    refs: SymbolRef[],
    opts: { extended?: boolean } = {},
  ): Promise<Map<string, Quote>> {
    this.calls.quotes++;
    this.batchSizes.push(refs.length);
    if (this.onQuotes) await this.onQuotes();
    if (this.fail.quotes) throw this.fail.quotes;
    const map = new Map<string, Quote>();
    for (const r of refs) {
      const q = this.quotes_.get(quoteKey(r));
      if (q) map.set(quoteKey(r), q);
    }
    return map;
  }
}

function quote(over: Partial<Quote> = {}): Quote {
  return {
    price: 100,
    prevClose: 100,
    providerChangePct: 0,
    currency: "USD",
    quoteTime: new Date("2026-01-15T15:30:00Z"),
    tradingDate: "",
    marketOpen: true,
    extended: null,
    delayed: true,
    ...over,
  };
}

const ACME: SymbolHit = {
  symbol: "ACME",
  name: "Acme Corp",
  exchange: "NASDAQ",
  mic: MIC,
  timezone: NY,
  currency: "USD",
  type: "Common Stock",
};

async function fixture(now: Date) {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => /^\d.*sql$/.test(f))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "a");
  await ensureUser(db, "b");
  const run = randomUUID();
  await db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'a','watch stocks')",
    [run],
  );
  const provider = new FakeProvider();
  let clock = now;
  const tools = new WatchlistTools(db, provider, () => clock);
  const monitor = new StockMonitor(
    db,
    provider,
    (u) => u === "a",
    () => clock,
  );
  const sent: { user: string; payload: any }[] = [];
  const delivery = new StockDelivery(db, async (user, payload) => {
    sent.push({ user, payload });
  });
  const setNow = (d: Date) => {
    clock = d;
  };
  const add = async (dropPct?: number) => {
    provider.hits.push(ACME);
    const r = await tools.call("a", run, {
      operation: "watchlist_add",
      query: "ACME",
      dropPct,
    });
    return r.added.id as string;
  };
  const observations = async (itemId: string) =>
    (
      await db.query(
        "SELECT * FROM stock_observations WHERE item_id=$1 ORDER BY observed_at",
        [itemId],
      )
    ).rows;
  const alerts = async (itemId: string) =>
    (
      await db.query(
        "SELECT * FROM stock_alerts WHERE item_id=$1 ORDER BY created_at",
        [itemId],
      )
    ).rows;
  // In-session instant: 10:30 ET on a trading Thursday.
  const OPEN = new Date("2026-01-15T15:30:00Z");
  return {
    pg,
    db,
    run,
    provider,
    tools,
    monitor,
    delivery,
    sent,
    setNow,
    add,
    observations,
    alerts,
    OPEN,
  };
}

test("Nasdaq listing segments use US sessions while unknown/non-US venues remain unsupported", () => {
  for (const mic of ["XNGS", "XNMS", "XNCM"]) {
    assert.deepEqual(marketCalendar(mic), { timezone: NY });
    for (const date of ["2026-01-15", "2026-01-17", "2026-07-03", "2026-11-27"])
      assert.deepEqual(sessionsFor(mic, date), sessionsFor("XNAS", date));
  }
  for (const mic of ["XMEX", "XBOG", "XWAR", "XWBO", "XNDQ", "UNKNOWN", ""])
    assert.equal(marketCalendar(mic), null);
});

test("real-shaped Nasdaq search results retain their segment MIC through add, quote and alert", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  const original = globalThis.fetch;
  const requests: { path: string; mic: string | null }[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push({
      path: url.pathname,
      mic: url.searchParams.get("mic_code"),
    });
    if (url.pathname === "/symbol_search")
      return Response.json({
        data: [
          {
            symbol: "AAPL",
            instrument_name: "Apple Inc",
            exchange: "NASDAQ",
            mic_code: "XNGS",
            exchange_timezone: NY,
            currency: "USD",
            instrument_type: "Common Stock",
          },
          {
            symbol: "AAPL",
            exchange: "BMV",
            mic_code: "XMEX",
            currency: "MXN",
            instrument_type: "Common Stock",
          },
        ],
      });
    assert.equal(url.pathname, "/quote");
    return Response.json({
      symbol: "AAPL",
      currency: "USD",
      close: "90",
      previous_close: "100",
      percent_change: "-10",
      last_quote_at: f.OPEN.getTime() / 1000,
      datetime: "2026-01-15",
      is_market_open: true,
    });
  };
  try {
    const provider = new TwelveDataProvider("test-key");
    const tools = new WatchlistTools(f.db, provider);
    const ambiguous = await tools.call("a", f.run, {
      operation: "watchlist_add",
      query: "AAPL",
    });
    assert.equal(
      ambiguous.needsChoice,
      true,
      "exchange selection stays explicit",
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int AS n FROM watchlist_items"))
        .rows[0].n,
      0,
    );
    const added = await tools.call("a", f.run, {
      operation: "watchlist_add",
      query: "AAPL",
      exchange: "NASDAQ",
      dropPct: 5,
    });
    assert.equal(
      added.added.mic_code,
      "XNGS",
      "persist exact provider identity",
    );
    const monitor = new StockMonitor(
      f.db,
      provider,
      (u) => u === "a",
      () => f.OPEN,
    );
    await monitor.tick();
    assert.deepEqual(
      requests.filter((r) => r.path === "/quote"),
      [{ path: "/quote", mic: "XNGS" }],
    );
    assert.equal((await f.alerts(added.added.id)).length, 1);
    assert.equal((await f.observations(added.added.id))[0].decision, "alerted");
    assert.equal(
      (await tools.call("b", f.run, { operation: "watchlist_list" })).items
        .length,
      0,
    );
  } finally {
    globalThis.fetch = original;
    await f.pg.close();
  }
});

test("uncertain writes permit owner-scoped watchlist inspection but still block additions", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    await f.add(5);
    const oldRun = randomUUID();
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,state,stop_reason) VALUES($1,'a','stopped','failed')",
      [oldRun],
    );
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state) VALUES($1,$2,'old-write','calendar_draft','{}',true,'uncertain')",
      [randomUUID(), oldRun],
    );
    let round = 0;
    const assistant = new Assistant(
      f.db,
      new CustomAgent({
        generate: async (input) => {
          round++;
          const observation = input.messages.findLast((m) => m.role === "tool");
          if (round === 2) {
            const result = JSON.parse(observation!.content!).result;
            assert.equal(result.items.length, 1);
            assert.equal(result.items[0].symbol, "ACME");
          }
          if (round === 3) {
            assert.match(
              observation!.content!,
              /An uncertain write requires inspection/,
            );
            return {
              message: {
                role: "assistant",
                content:
                  "The saved watch is visible; the new write is blocked.",
              },
            };
          }
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: randomUUID(),
                  type: "function",
                  function: {
                    name: round === 1 ? "watchlist_list" : "watchlist_add",
                    arguments: JSON.stringify(
                      round === 1 ? {} : { query: "OTHER", dropPct: 5 },
                    ),
                  },
                },
              ],
            },
          };
        },
      }),
      new JobTools(
        f.db,
        { call: async () => ({}) },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        f.tools,
      ),
      { stocks: true },
    );
    const response = await assistant.respondDetailed(
      "a",
      "Show my watchlist and add another stock",
    );
    const calls = (
      await f.db.query(
        "SELECT operation,is_write,state FROM runtime_calls WHERE run_id=$1 ORDER BY started_at",
        [response.runId],
      )
    ).rows;
    assert.deepEqual(calls, [
      { operation: "watchlist_list", is_write: false, state: "success" },
      { operation: "watchlist_add", is_write: true, state: "failed" },
    ]);
    assert.equal(
      f.provider.calls.search,
      1,
      "blocked add never reaches the provider",
    );
    assert.equal(
      (await f.tools.call("b", f.run, { operation: "watchlist_list" })).items
        .length,
      0,
    );
    assert.equal(
      (
        await f.db.query("SELECT state FROM runtime_calls WHERE run_id=$1", [
          oldRun,
        ])
      ).rows[0].state,
      "uncertain",
    );
  } finally {
    await f.pg.close();
  }
});

test("a stuck calendar_draft that saved nothing is cleared, so later writes proceed", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    await f.add(5);
    const oldRun = randomUUID();
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,state,stop_reason) VALUES($1,'a','stopped','failed')",
      [oldRun],
    );
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,started_at) VALUES($1,$2,'old-write','calendar_draft','{}',true,'uncertain',now()-interval '10 minutes')",
      [randomUUID(), oldRun],
    );
    let round = 0;
    const assistant = new Assistant(
      f.db,
      new CustomAgent({
        generate: async (input) => {
          round++;
          const observation = input.messages.findLast((m) => m.role === "tool");
          if (round === 2) {
            const result = JSON.parse(observation!.content!).result;
            assert.equal(result.items.length, 1);
            assert.equal(result.items[0].symbol, "ACME");
          }
          if (round === 3) {
            assert.doesNotMatch(
              observation!.content!,
              /An uncertain write requires inspection/,
            );
            return {
              message: {
                role: "assistant",
                content: "Done.",
              },
            };
          }
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: randomUUID(),
                  type: "function",
                  function: {
                    name: round === 1 ? "watchlist_list" : "watchlist_add",
                    arguments: JSON.stringify(
                      round === 1 ? {} : { query: "OTHER", dropPct: 5 },
                    ),
                  },
                },
              ],
            },
          };
        },
      }),
      new JobTools(
        f.db,
        { call: async () => ({}) },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        f.tools,
      ),
      { stocks: true },
    );
    const response = await assistant.respondDetailed(
      "a",
      "Show my watchlist and add another stock",
    );
    const calls = (
      await f.db.query(
        "SELECT operation,is_write,state FROM runtime_calls WHERE run_id=$1 ORDER BY started_at",
        [response.runId],
      )
    ).rows;
    assert.deepEqual(calls, [
      { operation: "watchlist_list", is_write: false, state: "success" },
      { operation: "watchlist_add", is_write: true, state: calls[1].state },
    ]);
    assert.equal(f.provider.calls.search, 2, "the add reached the provider");
    assert.equal(
      (await f.tools.call("b", f.run, { operation: "watchlist_list" })).items
        .length,
      0,
    );
    assert.equal(
      (
        await f.db.query("SELECT state FROM runtime_calls WHERE run_id=$1", [
          oldRun,
        ])
      ).rows[0].state,
      "failed",
    );
  } finally {
    await f.pg.close();
  }
});

test("watchlist tools add, list, update, settings and remove with owner scope", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    f.provider.hits.push(ACME);
    const added = await f.tools.call("a", f.run, {
      operation: "watchlist_add",
      query: "acme",
      dropPct: 7,
    });
    assert.equal(added.added.symbol, "ACME");
    assert.equal(added.added.mic_code, MIC);
    assert.equal(Number(added.added.drop_pct), 7);
    const list = await f.tools.call("a", f.run, {
      operation: "watchlist_list",
    });
    assert.equal(list.items.length, 1);
    assert.equal(list.provider, "fake-market-data");
    assert.equal(Number(list.settings.default_drop_pct), 5);
    const updated = await f.tools.call("a", f.run, {
      operation: "watchlist_update",
      id: added.added.id,
      dropPct: null,
      status: "paused",
    });
    assert.equal(updated.updated.drop_pct, null);
    assert.equal(updated.updated.status, "paused");
    const settings = await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      defaultDropPct: 3,
      pollMinutes: 30,
      includeExtended: true,
    });
    assert.equal(Number(settings.settings.default_drop_pct), 3);
    assert.equal(Number(settings.settings.poll_minutes), 30);
    assert.equal(settings.settings.include_extended, true);
    // Other owners see nothing.
    const foreign = await f.tools.call("b", randomUUID(), {
      operation: "watchlist_list",
    });
    assert.equal(foreign.items.length, 0);
    const removed = await f.tools.call("a", f.run, {
      operation: "watchlist_remove",
      id: added.added.id,
    });
    assert.equal(removed.removed.symbol, "ACME");
    assert.equal(
      (await f.tools.call("a", f.run, { operation: "watchlist_list" })).items
        .length,
      0,
    );
  } finally {
    await f.pg.close();
  }
});

test("watchlist_add asks before choosing when several exchanges match", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    f.provider.hits.push(
      ACME,
      { ...ACME, exchange: "NYSE", mic: "XNYS", symbol: "ACME" },
      { ...ACME, symbol: "ACMEF", name: "Acme Corp F" },
    );
    const r = await f.tools.call("a", f.run, {
      operation: "watchlist_add",
      query: "ACME",
    });
    assert.equal(r.needsChoice, true);
    assert.equal(r.candidates.length, 2);
    assert.match(r.instruction, /ask the owner/i);
    // Exchange disambiguation resolves without a model round-trip.
    const resolved = await f.tools.call("a", f.run, {
      operation: "watchlist_add",
      query: "ACME",
      exchange: "NYSE",
    });
    assert.equal(resolved.added.exchange, "NYSE");
    assert.equal(resolved.added.mic_code, "XNYS");
    await assert.rejects(
      () =>
        f.tools.call("a", f.run, {
          operation: "watchlist_add",
          query: "ACME",
          exchange: "NYSE",
        }),
      /already on the watchlist/,
    );
  } finally {
    await f.pg.close();
  }
});

test("watchlist mutations are foreground-only and scoped to the owner", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    f.provider.hits.push(ACME);
    await f.db.query("UPDATE work_turns SET background=true WHERE run_id=$1", [
      f.run,
    ]);
    await assert.rejects(
      () =>
        f.tools.call("a", f.run, {
          operation: "watchlist_add",
          query: "ACME",
        }),
      /foreground/,
    );
    await f.db.query("UPDATE work_turns SET background=false WHERE run_id=$1", [
      f.run,
    ]);
    const added = await f.tools.call("a", f.run, {
      operation: "watchlist_add",
      query: "ACME",
    });
    // Owner b cannot mutate a's item.
    const runB = randomUUID();
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'b','x')",
      [runB],
    );
    await assert.rejects(
      () =>
        f.tools.call("b", runB, {
          operation: "watchlist_remove",
          id: added.added.id,
        }),
      /unavailable/,
    );
  } finally {
    await f.pg.close();
  }
});

test("watchlist_add without a configured provider fails cleanly", async () => {
  const pg = new PGlite();
  try {
    for (const file of (await readdir(new URL("../db/", import.meta.url)))
      .filter((f) => /^\d.*sql$/.test(f))
      .sort())
      await pg.exec(
        await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
      );
    const db = pg as unknown as Database;
    await ensureUser(db, "a");
    const run = randomUUID();
    await db.query(
      "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'a','x')",
      [run],
    );
    await assert.rejects(
      () =>
        new WatchlistTools(db).call("a", run, {
          operation: "watchlist_add",
          query: "ACME",
        }),
      /provider is not configured/,
    );
  } finally {
    await pg.close();
  }
});

test("monitor alerts below threshold and suppresses duplicates for the trading day", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ price: 93, prevClose: 100, providerChangePct: -7 }),
    );
    await f.monitor.tick();
    const alerts = await f.alerts(itemId);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].state, "pending");
    assert.equal(
      alerts[0].trading_date.toISOString().slice(0, 10),
      "2026-01-15",
    );
    assert.match(alerts[0].payload.reply, /ACME.*7\.0%/s);
    assert.match(alerts[0].payload.reply, /previous close 100/);
    assert.match(alerts[0].payload.reply, /delayed/);
    assert.match(alerts[0].payload.reply, /yahoo\.com/);
    const obs = await f.observations(itemId);
    assert.equal(obs.at(-1)!.decision, "alerted");
    // Second poll same trading day: no duplicate alert, suppression is logged.
    f.setNow(new Date("2026-01-15T16:30:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 93,
        prevClose: 100,
        providerChangePct: -7,
        quoteTime: new Date("2026-01-15T16:30:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 1);
    const obs2 = await f.observations(itemId);
    assert.equal(obs2.at(-1)!.decision, "suppressed_today");
  } finally {
    await f.pg.close();
  }
});

test("monitor fires only when the drop is strictly more than the threshold", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    // Exactly at the threshold: no alert.
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ price: 95, prevClose: 100, providerChangePct: -5 }),
    );
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 0);
    let obs = await f.observations(itemId);
    assert.equal(obs.at(-1)!.decision, "below_threshold");
    // Above the threshold (smaller drop): also no alert.
    f.setNow(new Date("2026-01-15T15:45:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 97,
        prevClose: 100,
        providerChangePct: -3,
        quoteTime: new Date("2026-01-15T15:45:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 0);
    // Per-item override tightens the threshold.
    await f.tools.call("a", f.run, {
      operation: "watchlist_update",
      id: itemId,
      dropPct: 2,
    });
    f.setNow(new Date("2026-01-15T16:00:00Z"));
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 1);
    obs = await f.observations(itemId);
    assert.equal(obs.at(-1)!.decision, "alerted");
    assert.equal(Number(obs.at(-1)!.detail.threshold), 2);
  } finally {
    await f.pg.close();
  }
});

test("a new trading day can alert again; paused items and settings skip polls", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ price: 93, prevClose: 100, providerChangePct: -7 }),
    );
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 1);
    // Next trading day: new trading_date, alert fires again.
    f.setNow(new Date("2026-01-16T15:30:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 93,
        prevClose: 100,
        providerChangePct: -7,
        quoteTime: new Date("2026-01-16T15:30:00Z"),
        tradingDate: "2026-01-16",
      }),
    );
    await f.monitor.tick();
    const alerts = await f.alerts(itemId);
    assert.equal(alerts.length, 2);
    assert.notEqual(alerts[0].trading_date, alerts[1].trading_date);
    // Pause the item: no provider call and no new rows.
    await f.tools.call("a", f.run, {
      operation: "watchlist_update",
      id: itemId,
      status: "paused",
    });
    const quotesCalls = f.provider.calls.quotes;
    f.setNow(new Date("2026-01-16T16:30:00Z"));
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, quotesCalls);
    // Resume while still breached: alerts once on the next valid observation.
    await f.tools.call("a", f.run, {
      operation: "watchlist_update",
      id: itemId,
      status: "active",
    });
    // 2026-01-19 is MLK Day (closed); resume takes effect on Tuesday 01-20.
    f.setNow(new Date("2026-01-20T15:30:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 93,
        prevClose: 100,
        providerChangePct: -7,
        quoteTime: new Date("2026-01-20T15:30:00Z"),
        tradingDate: "2026-01-20",
      }),
    );
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 3);
  } finally {
    await f.pg.close();
  }
});

test("closed markets and exchange holidays produce market_closed observations without provider quote calls", async () => {
  const f = await fixture(new Date("2026-01-15T22:30:00Z")); // 17:30 ET, after close
  try {
    const itemId = await f.add(5);
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 0);
    let obs = await f.observations(itemId);
    assert.equal(obs.length, 1);
    assert.equal(obs[0].decision, "market_closed");
    // Repeated ticks stay quiet: one market_closed row, no more provider work.
    f.setNow(new Date("2026-01-15T23:00:00Z"));
    await f.monitor.tick();
    obs = await f.observations(itemId);
    assert.equal(
      obs.filter((o: any) => o.decision === "market_closed").length,
      1,
    );
    // Holiday from the built-in calendar: 2026-01-19 is MLK Day.
    f.setNow(new Date("2026-01-19T15:30:00Z"));
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 0);
    obs = await f.observations(itemId);
    assert.equal(obs.at(-1)!.decision, "market_closed");
    // Early close (day after Thanksgiving is 13:00 ET): 17:30 UTC = 12:30 ET
    // is still open on 2026-11-26 Thanksgiving Friday? No — 2026-11-27.
    f.setNow(new Date("2026-11-27T18:30:00Z")); // 13:30 ET, post-early-close
    await f.monitor.tick();
    assert.equal(
      (await f.observations(itemId)).at(-1)!.decision,
      "market_closed",
    );
  } finally {
    await f.pg.close();
  }
});

test("session boundary: closed before 09:30 ET and polls at 09:30", async () => {
  const f = await fixture(new Date("2026-01-15T14:10:00Z")); // 09:10 ET
  try {
    const itemId = await f.add(5);
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ price: 90, prevClose: 100, providerChangePct: -10 }),
    );
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 0);
    assert.equal((await f.alerts(itemId)).length, 0);
    f.setNow(new Date("2026-01-15T14:30:00Z")); // 09:30 ET, first pollable minute
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 90,
        prevClose: 100,
        providerChangePct: -10,
        quoteTime: new Date("2026-01-15T14:30:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 1);
    assert.equal((await f.alerts(itemId)).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("stale, missing and invalid quotes never alert", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    // Stale: quote is 40 minutes old, beyond the 2*poll (30-minute) window.
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 50,
        prevClose: 100,
        providerChangePct: -50,
        quoteTime: new Date("2026-01-15T14:50:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 0);
    assert.equal((await f.observations(itemId)).at(-1)!.decision, "stale");
    // A stale quote still counts as a poll.
    const before = f.provider.calls.quotes;
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, before);
    // Missing quote row.
    f.setNow(new Date("2026-01-15T15:50:00Z"));
    f.provider.quotes_.clear();
    await f.monitor.tick();
    assert.equal((await f.observations(itemId)).at(-1)!.decision, "invalid");
    // Missing previous close.
    f.setNow(new Date("2026-01-15T16:10:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 90,
        prevClose: 0,
        providerChangePct: -10,
        quoteTime: new Date("2026-01-15T16:10:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 0);
    assert.equal((await f.observations(itemId)).at(-1)!.decision, "invalid");
  } finally {
    await f.pg.close();
  }
});

test("split-sized moves without provider corroboration are suppressed as suspect", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    // Computed -50% but provider reports -2%: looks like a split artifact.
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ price: 50, prevClose: 100, providerChangePct: -2 }),
    );
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 0);
    assert.equal((await f.observations(itemId)).at(-1)!.decision, "suspect");
    // Corroborated crash does alert.
    f.setNow(new Date("2026-01-15T15:50:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 50,
        prevClose: 100,
        providerChangePct: -50,
        quoteTime: new Date("2026-01-15T15:50:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("provider errors back off per item and recover", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    f.provider.fail.quotes = new Error("rate limited");
    await f.monitor.tick();
    let item = (
      await f.db.query("SELECT * FROM watchlist_items WHERE id=$1", [itemId])
    ).rows[0];
    assert.equal(item.error_count, 1);
    assert.ok(item.next_retry_at);
    assert.equal((await f.observations(itemId)).at(-1)!.decision, "error");
    // Inside the backoff window the item is not polled again.
    f.setNow(new Date("2026-01-15T15:40:00Z"));
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 1);
    // After backoff expires, failure count grows the delay.
    f.setNow(new Date("2026-01-15T15:50:00Z"));
    await f.monitor.tick();
    item = (
      await f.db.query("SELECT * FROM watchlist_items WHERE id=$1", [itemId])
    ).rows[0];
    assert.equal(item.error_count, 2);
    // Recovery clears the error state.
    f.provider.fail.quotes = undefined;
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 99,
        prevClose: 100,
        providerChangePct: -1,
        quoteTime: new Date("2026-01-16T15:30:00Z"),
        tradingDate: "2026-01-16",
      }),
    );
    f.setNow(new Date("2026-01-16T15:30:00Z"));
    await f.monitor.tick();
    item = (
      await f.db.query("SELECT * FROM watchlist_items WHERE id=$1", [itemId])
    ).rows[0];
    assert.equal(item.error_count, 0);
    assert.equal(item.next_retry_at, null);
  } finally {
    await f.pg.close();
  }
});

test("extended hours need opt-in and use the extended quote", async () => {
  const f = await fixture(new Date("2026-01-15T13:00:00Z")); // 08:00 ET pre-market
  try {
    const itemId = await f.add(5);
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 100,
        prevClose: 100,
        providerChangePct: 0,
        marketOpen: false,
        extended: {
          price: 90,
          changePct: -10,
          time: new Date("2026-01-15T13:00:00Z"),
        },
        quoteTime: new Date("2026-01-15T13:00:00Z"),
      }),
    );
    // Without opt-in the pre-market window is still closed for the item.
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 0);
    assert.equal(
      (await f.observations(itemId)).at(-1)!.decision,
      "market_closed",
    );
    await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      includeExtended: true,
    });
    f.setNow(new Date("2026-01-15T13:20:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 100,
        prevClose: 100,
        providerChangePct: 0,
        marketOpen: false,
        extended: {
          price: 90,
          changePct: -10,
          time: new Date("2026-01-15T13:20:00Z"),
        },
        quoteTime: new Date("2026-01-15T13:20:00Z"),
      }),
    );
    await f.monitor.tick();
    const alerts = await f.alerts(itemId);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].payload.reply, /extended session/);
  } finally {
    await f.pg.close();
  }
});

test("delivery sends pending alerts once and marks failures uncertain, surviving restart", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ price: 90, prevClose: 100, providerChangePct: -10 }),
    );
    await f.monitor.tick();
    // Simulate a crash mid-send, then a recovered delivery instance.
    await f.db.query("UPDATE stock_alerts SET state='sending'");
    const sent2: { user: string; payload: any }[] = [];
    const recovered = new StockDelivery(f.db, async (user, payload) => {
      sent2.push({ user, payload });
    });
    await recovered.recover();
    let rows = await f.alerts(itemId);
    assert.equal(rows[0].state, "uncertain");
    // Operator replays uncertain alerts to pending; delivery then sends once.
    await f.db.query("UPDATE stock_alerts SET state='pending'");
    await recovered.tick();
    assert.equal(sent2.length, 1);
    assert.equal(sent2[0].user, "a");
    assert.match(sent2[0].payload.reply, /ACME/);
    rows = await f.alerts(itemId);
    assert.equal(rows[0].state, "sent");
    await recovered.tick();
    assert.equal(sent2.length, 1);
    // A failing send never retries automatically.
    const failing = new StockDelivery(f.db, async () => {
      throw new Error("telegram down");
    });
    await f.db.query("UPDATE stock_alerts SET state='pending'");
    await failing.tick();
    assert.equal((await f.alerts(itemId))[0].state, "uncertain");
  } finally {
    await f.pg.close();
  }
});

test("watchlist tools are only offered when a market-data provider is configured", () => {
  const base = {
    web: false,
    gmail: false,
    calendar: false,
    library: false,
    libraryAccount: false,
    preparationSheet: false,
    dailySheet: false,
    canvases: false,
  };
  const off = runtimeContext(base, null);
  assert.equal(
    JSON.parse(off.context).operations.filter((o: string) =>
      o.startsWith("watchlist_"),
    ).length,
    0,
  );
  assert.equal(
    off.tools.filter((t: any) => t.name.startsWith("watchlist_")).length,
    0,
  );
  const on = runtimeContext({ ...base, stocks: true }, null);
  assert.deepEqual(
    on.tools
      .map((t: any) => t.name)
      .filter((n: string) => n.startsWith("watchlist_"))
      .sort(),
    [
      "watchlist_add",
      "watchlist_list",
      "watchlist_remove",
      "watchlist_settings",
      "watchlist_update",
    ],
  );
});

test("end to end: add, poll, queue, deliver", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ price: 89, prevClose: 100, providerChangePct: -11 }),
    );
    await f.monitor.tick();
    await f.delivery.tick();
    assert.equal(f.sent.length, 1);
    assert.equal((await f.alerts(itemId))[0].state, "sent");
    // Observability: the observation captured quote, reference close and verdict.
    const obs = (await f.observations(itemId)).at(-1)!;
    assert.equal(Number(obs.price), 89);
    assert.equal(Number(obs.prev_close), 100);
    assert.equal(obs.decision, "alerted");
    assert.equal(obs.market_state, "regular");
  } finally {
    await f.pg.close();
  }
});

test("pausing an item mutes its queued alert", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ price: 90, prevClose: 100, providerChangePct: -10 }),
    );
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId))[0].state, "pending");
    await f.tools.call("a", f.run, {
      operation: "watchlist_update",
      id: itemId,
      status: "paused",
    });
    assert.equal((await f.alerts(itemId))[0].state, "muted");
    await f.delivery.tick();
    assert.equal(f.sent.length, 0);
  } finally {
    await f.pg.close();
  }
});

test("a non-retryable provider error pauses the item instead of backing off", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    f.provider.fail.quotes = new ProviderError(
      "plan does not include this symbol",
      false,
    );
    await f.monitor.tick();
    const item = (
      await f.db.query("SELECT * FROM watchlist_items WHERE id=$1", [itemId])
    ).rows[0];
    assert.equal(item.status, "paused");
    assert.equal(item.next_retry_at, null);
    assert.equal(
      (await f.observations(itemId)).at(-1)!.detail.paused,
      "non-retryable provider error",
    );
    // A paused item is never polled again.
    f.setNow(new Date("2026-01-15T16:00:00Z"));
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 1);
  } finally {
    await f.pg.close();
  }
});

test("quote freshness uses the last-update time, not the interval open", () => {
  // Twelve Data's `timestamp`/`datetime` describe the interval open (day open
  // under the default 1day interval); freshness must use last_quote_at.
  const q = rowToQuote({
    symbol: "ACME",
    close: "90",
    previous_close: "100",
    percent_change: "-10",
    currency: "USD",
    datetime: "2026-01-15",
    timestamp: new Date("2026-01-15T14:30:00Z").getTime() / 1000, // day open
    last_quote_at: new Date("2026-01-15T17:30:00Z").getTime() / 1000, // last update
    is_market_open: true,
  });
  assert.equal(q.quoteTime.toISOString(), "2026-01-15T17:30:00.000Z");
});

test("a pause landing mid-poll suppresses the alert instead of queueing it", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ price: 90, prevClose: 100, providerChangePct: -10 }),
    );
    // Owner hits pause while the quote request is in flight.
    f.provider.onQuotes = () =>
      f.tools.call("a", f.run, {
        operation: "watchlist_update",
        id: itemId,
        status: "paused",
      });
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 0);
    assert.equal(
      (await f.observations(itemId)).at(-1)!.detail.reason,
      "paused during poll",
    );
    await f.delivery.tick();
    assert.equal(f.sent.length, 0);
  } finally {
    await f.pg.close();
  }
});

test("delivery claim rechecks pause state instead of trusting the queue", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ price: 90, prevClose: 100, providerChangePct: -10 }),
    );
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId))[0].state, "pending");
    // A pause path that bypassed the queue (direct status flip) still cannot
    // deliver: the claim rechecks monitoring state and mutes the row.
    await f.db.query("UPDATE watchlist_items SET status='paused' WHERE id=$1", [
      itemId,
    ]);
    await f.delivery.tick();
    assert.equal(f.sent.length, 0);
    assert.equal((await f.alerts(itemId))[0].state, "muted");
  } finally {
    await f.pg.close();
  }
});

test("batches never exceed the provider's per-minute credit budget", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    f.provider.creditsPerMinute = 8;
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      f.provider.hits = [{ ...ACME, symbol: `S${i}` }];
      const r = await f.tools.call("a", f.run, {
        operation: "watchlist_add",
        query: `S${i}`,
        dropPct: 5,
      });
      ids.push(r.added.id);
      f.provider.quotes_.set(
        `${MIC}:S${i}`,
        quote({ price: 90, prevClose: 100, providerChangePct: -10 }),
      );
    }
    await f.monitor.tick();
    // First tick can spend at most 8 credits → first batch of 8 only.
    assert.deepEqual(f.provider.batchSizes, [8]);
    // The provider refills at the minute boundary, not continuously — 20s
    // later is still the same minute, so no credits are available yet.
    f.setNow(new Date("2026-01-15T15:30:20Z"));
    await f.monitor.tick();
    assert.deepEqual(f.provider.batchSizes, [8]);
    // Past the boundary the remaining 2 items are fetched.
    f.setNow(new Date("2026-01-15T15:31:05Z"));
    await f.monitor.tick();
    assert.deepEqual(f.provider.batchSizes, [8, 2]);
    for (const id of ids) assert.equal((await f.alerts(id)).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("adding a symbol on an exchange without a calendar is rejected", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    f.provider.hits = [
      { ...ACME, symbol: "SGL", exchange: "SGX", mic: "XSES", currency: "SGD" },
    ];
    await assert.rejects(
      () =>
        f.tools.call("a", f.run, {
          operation: "watchlist_add",
          query: "SGL",
        }),
      /US market calendar/,
    );
  } finally {
    await f.pg.close();
  }
});

test("extended opt-in is refused when the plan lacks prepost data", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    f.provider.supportsExtended = false;
    await assert.rejects(
      () =>
        f.tools.call("a", f.run, {
          operation: "watchlist_settings",
          includeExtended: true,
        }),
      /prepost/,
    );
  } finally {
    await f.pg.close();
  }
});

test("malformed provider timestamps fail closed as stale", () => {
  const q = rowToQuote({
    symbol: "ACME",
    close: "90",
    previous_close: "100",
    currency: "USD",
    last_quote_at: "not-a-number",
    is_market_open: true,
  });
  assert.equal(q.quoteTime.getTime(), 0);
});

test("watchlist_remove during an in-flight poll aborts the chunk safely", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ price: 90, prevClose: 100, providerChangePct: -10 }),
    );
    // Owner deletes the watch while the quote request is in flight — the
    // enqueue recheck finds no row and skips without FK violations.
    f.provider.onQuotes = () =>
      f.tools.call("a", f.run, {
        operation: "watchlist_remove",
        id: itemId,
      });
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 0);
    await f.delivery.tick();
    assert.equal(f.sent.length, 0);
  } finally {
    await f.pg.close();
  }
});

test("post-market: a fresh extended quote is validated on its own timestamp", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      includeExtended: true,
    });
    // 18:00 ET post-market: the regular quote stopped updating at the 16:00
    // close, but the extended quote is fresh — it must still alert.
    f.setNow(new Date("2026-01-15T23:00:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 100,
        prevClose: 100,
        providerChangePct: 0,
        marketOpen: false,
        quoteTime: new Date("2026-01-15T21:00:00Z"), // regular 16:00 ET close
        extended: {
          price: 90,
          changePct: -10,
          time: new Date("2026-01-15T23:00:00Z"),
        },
      }),
    );
    await f.monitor.tick();
    const alerts = await f.alerts(itemId);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].payload.reply, /extended session/);
  } finally {
    await f.pg.close();
  }
});

test("a failed quote request still consumes its credits", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      f.provider.hits = [{ ...ACME, symbol: `S${i}` }];
      const r = await f.tools.call("a", f.run, {
        operation: "watchlist_add",
        query: `S${i}`,
        dropPct: 5,
      });
      ids.push(r.added.id);
    }
    // The 8-symbol request times out — the provider may have billed it anyway,
    // so the remaining 2 items must wait for the next minute window.
    f.provider.fail.quotes = new ProviderError("request timed out", true);
    await f.monitor.tick();
    f.provider.fail.quotes = undefined;
    f.setNow(new Date("2026-01-15T15:30:40Z")); // still the same minute window
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 1);
    // Past the boundary, the allowance is back and the leftovers poll.
    f.setNow(new Date("2026-01-15T15:31:05Z"));
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 2);
    assert.deepEqual(f.provider.batchSizes, [8, 2]);
  } finally {
    await f.pg.close();
  }
});

test("an extended-hours alert is stored under the extended session's trading date", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      includeExtended: true,
    });
    // Friday 2026-01-16, 08:00 ET pre-market. The provider's regular fields
    // still describe Thursday's close; the extended quote is fresh.
    f.setNow(new Date("2026-01-16T13:00:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 100,
        prevClose: 100,
        providerChangePct: 0,
        marketOpen: false,
        quoteTime: new Date("2026-01-15T21:00:00Z"),
        tradingDate: "2026-01-15",
        extended: {
          price: 90,
          changePct: -10,
          time: new Date("2026-01-16T13:00:00Z"),
        },
      }),
    );
    await f.monitor.tick();
    const alerts = await f.alerts(itemId);
    assert.equal(alerts.length, 1);
    assert.equal(
      alerts[0].trading_date.toISOString().slice(0, 10),
      "2026-01-16",
    );
    assert.match(alerts[0].payload.reply, /2026-01-16/);
    // A second breach in the same extended session suppresses as today.
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("Twelve Data body error codes decide whether a failure is retryable", async () => {
  // The provider can report errors with HTTP 200 and the real status in the
  // body's `code`. Credit exhaustion must back off, not pause the watch.
  const original = globalThis.fetch;
  const failure = async (body: object, status = 200) => {
    globalThis.fetch = async () => Response.json(body, { status });
    try {
      await new TwelveDataProvider("test-key").quotes([
        { symbol: "ACME", mic: MIC },
      ]);
    } catch (error) {
      assert.ok(error instanceof ProviderError);
      return error;
    }
    assert.fail("expected a provider error");
  };
  try {
    const exhausted = await failure({
      code: 429,
      message: "You have run out of API credits for the current minute.",
      status: "error",
    });
    assert.equal(exhausted.retryable, true);
    assert.match(exhausted.message, /run out of API credits/);
    const fault = await failure({
      code: 500,
      message: "internal error",
      status: "error",
    });
    assert.equal(fault.retryable, true);
    for (const code of [400, 401, 403, 404])
      assert.equal(
        (await failure({ code, message: "denied", status: "error" })).retryable,
        false,
      );
    assert.equal((await failure({}, 429)).retryable, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("monitoring windows: validation, overnight spans, 24:00 and weekday ownership", () => {
  assert.throws(
    () => validateWindow({ start: "24:00", end: "02:00" }),
    /start/,
  );
  assert.throws(() => validateWindow({ start: "9:00", end: "17:00" }), /start/);
  assert.throws(() => validateWindow({ start: "09:00", end: "09:00" }), /same/);
  assert.deepEqual(
    validateWindow({ start: "09:00", end: "17:00", days: ["fri", "mon"] }),
    { start: "09:00", end: "17:00", days: ["mon", "fri"] },
  );
  // All seven days is the same as no day filter.
  assert.equal(
    validateWindow({
      start: "00:00",
      end: "24:00",
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    }).days,
    null,
  );
  const sgt = (iso: string) => new Date(`${iso}+08:00`);
  const evening = { start: "20:00", end: "24:00" };
  assert.equal(inWindow(evening, sgt("2026-09-28T23:59")), true);
  assert.equal(inWindow(evening, sgt("2026-09-29T00:00")), false);
  assert.equal(inWindow(evening, sgt("2026-09-28T19:59")), false);
  // An overnight window belongs to the day it starts: Fri 22:00 → Sat 02:00.
  const overnight = { start: "22:00", end: "02:00", days: ["fri"] as any };
  assert.equal(inWindow(overnight, sgt("2026-10-02T23:00")), true); // Fri
  assert.equal(inWindow(overnight, sgt("2026-10-03T01:30")), true); // Sat early
  assert.equal(inWindow(overnight, sgt("2026-10-03T23:00")), false); // Sat late
  assert.equal(inWindow(overnight, sgt("2026-10-02T01:30")), false); // Fri early
  assert.equal(inWindow(null, sgt("2026-10-03T03:00")), true);
});

test("upcoming checks intersect the SGT window with US sessions across DST", () => {
  const evening = { start: "20:00", end: "24:00" };
  // Sunday 27 Sep 2026, 21:30 SGT: US daylight time, open is 21:30 SGT.
  assert.deepEqual(
    upcomingChecks(
      evening,
      "XNGS",
      ["regular"],
      new Date("2026-09-27T13:30:00Z"),
    ),
    [
      "Mon 28 Sep 21:30-24:00 SGT",
      "Tue 29 Sep 21:30-24:00 SGT",
      "Wed 30 Sep 21:30-24:00 SGT",
    ],
  );
  // January: US standard time, open is 22:30 SGT; MLK Day (19 Jan) is skipped.
  assert.deepEqual(
    upcomingChecks(
      evening,
      "XNAS",
      ["regular"],
      new Date("2026-01-17T00:00:00Z"),
    ),
    [
      "Tue 20 Jan 22:30-24:00 SGT",
      "Wed 21 Jan 22:30-24:00 SGT",
      "Thu 22 Jan 22:30-24:00 SGT",
    ],
  );
  // No window: the whole regular session, which runs past SGT midnight.
  assert.deepEqual(
    upcomingChecks(
      null,
      "XNAS",
      ["regular"],
      new Date("2026-09-27T13:30:00Z"),
      1,
    ),
    ["Mon 28 Sep 21:30-Tue 04:00 SGT"],
  );
});

test("the owner's window: hourly checks from the open until midnight SGT, silent after", async () => {
  // Thu 15 Jan 2026 10:30 ET = 23:30 SGT, inside the 20:00-24:00 window.
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    const itemId = await f.add(5);
    const confirmed = await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      pollMinutes: 60,
      window: { start: "20:00", end: "24:00" },
    });
    assert.match(confirmed.window, /20:00-24:00 Singapore time/);
    assert.match(confirmed.window, /still down past its threshold/);
    assert.equal(confirmed.items[0].windowSource, "default");
    assert.match(confirmed.items[0].nextChecks[0], /23:30-24:00 SGT$/);
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ price: 97, prevClose: 100, providerChangePct: -3 }),
    );
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 1);
    assert.equal(
      (await f.observations(itemId)).at(-1)!.decision,
      "below_threshold",
    );
    // 00:30 SGT Friday: the US session is open but the window is closed. A
    // drop now is not fetched, logged once, and never alerted.
    f.setNow(new Date("2026-01-15T16:30:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 90,
        prevClose: 100,
        providerChangePct: -10,
        quoteTime: new Date("2026-01-15T16:30:00Z"),
      }),
    );
    await f.monitor.tick();
    f.setNow(new Date("2026-01-15T18:30:00Z"));
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 1);
    assert.equal((await f.alerts(itemId)).length, 0);
    const gated = (await f.observations(itemId)).filter(
      (o: any) => o.decision === "outside_window",
    );
    assert.equal(gated.length, 1);
    assert.equal(gated[0].market_state, "open");
    // Friday 22:30 SGT: window and session reopen; the stock is still down
    // for that trading day, so the first check alerts immediately even
    // though the last real poll was less than a day ago.
    f.setNow(new Date("2026-01-16T14:30:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 93,
        prevClose: 100,
        providerChangePct: -7,
        quoteTime: new Date("2026-01-16T14:30:00Z"),
        tradingDate: "2026-01-16",
      }),
    );
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 2);
    const alerts = await f.alerts(itemId);
    assert.equal(alerts.length, 1);
    assert.equal(
      alerts[0].trading_date.toISOString().slice(0, 10),
      "2026-01-16",
    );
  } finally {
    await f.pg.close();
  }
});

test("a drop that recovers while the window is closed is never reported", async () => {
  const f = await fixture(new Date("2026-01-15T16:30:00Z")); // 00:30 SGT, outside
  try {
    const itemId = await f.add(5);
    await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      window: { start: "20:00", end: "24:00" },
    });
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ price: 90, prevClose: 100, providerChangePct: -10 }),
    );
    await f.monitor.tick();
    f.setNow(new Date("2026-01-16T14:30:00Z")); // reopen, recovered
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 101,
        prevClose: 100,
        providerChangePct: 1,
        quoteTime: new Date("2026-01-16T14:30:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 1);
    assert.equal((await f.alerts(itemId)).length, 0);
    assert.equal(
      (await f.observations(itemId)).at(-1)!.decision,
      "below_threshold",
    );
  } finally {
    await f.pg.close();
  }
});

test("a gated check does not delay the first poll after the session opens", async () => {
  const f = await fixture(new Date("2026-01-15T14:10:00Z")); // 09:10 ET, closed
  try {
    const itemId = await f.add(5);
    await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      pollMinutes: 60,
    });
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 0);
    f.setNow(new Date("2026-01-15T14:30:00Z")); // 09:30 ET, 20 min later
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 90,
        prevClose: 100,
        providerChangePct: -10,
        quoteTime: new Date("2026-01-15T14:30:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 1);
    assert.equal((await f.alerts(itemId)).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("item windows override the default; null follows it again; settings null clears", async () => {
  const f = await fixture(new Date("2026-01-15T16:30:00Z")); // 00:30 SGT Fri
  try {
    const itemId = await f.add(5);
    await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      window: { start: "20:00", end: "24:00" },
    });
    const own = await f.tools.call("a", f.run, {
      operation: "watchlist_update",
      id: itemId,
      window: { start: "21:00", end: "02:00", days: ["thu"] },
    });
    assert.equal(own.updated.monitoringWindow.source, "item");
    assert.match(own.window, /21:00-02:00 Singapore time, Thu/);
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 97,
        prevClose: 100,
        quoteTime: new Date("2026-01-15T16:30:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 1); // Thursday's overnight window
    const back = await f.tools.call("a", f.run, {
      operation: "watchlist_update",
      id: itemId,
      window: null,
    });
    assert.equal(back.updated.monitoringWindow.source, "default");
    f.setNow(new Date("2026-01-15T17:45:00Z"));
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 1); // default window is closed
    const cleared = await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      window: null,
    });
    assert.match(cleared.window, /cleared/);
    assert.equal(cleared.settings.window_start, null);
    const listed = await f.tools.call("a", f.run, {
      operation: "watchlist_list",
    });
    assert.equal(listed.items[0].monitoringWindow, null);
    await assert.rejects(
      f.tools.call("a", f.run, {
        operation: "watchlist_settings",
        window: { start: "10:00", end: "10:00" },
      }),
      /same/,
    );
  } finally {
    await f.pg.close();
  }
});

test("an alert queued before the window closes is muted rather than sent late", async () => {
  const f = await fixture(new Date("2026-01-15T15:59:50Z")); // 23:59:50 SGT
  try {
    const itemId = await f.add(5);
    await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      window: { start: "20:00", end: "24:00" },
    });
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 90,
        prevClose: 100,
        providerChangePct: -10,
        quoteTime: new Date("2026-01-15T15:59:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId))[0].state, "pending");
    const late = new StockDelivery(
      f.db,
      async (user, payload) => {
        f.sent.push({ user, payload });
      },
      () => new Date("2026-01-15T16:00:05Z"),
    );
    await late.tick();
    assert.equal(f.sent.length, 0);
    assert.equal((await f.alerts(itemId))[0].state, "muted");
    assert.equal(
      (await f.observations(itemId)).at(-1)!.decision,
      "outside_window",
    );
    // Same trading day, window closed: nothing re-queues.
    f.setNow(new Date("2026-01-15T17:00:00Z"));
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId)).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("an alert still pending from an earlier window occurrence is muted, not sent at the next opening", async () => {
  const f = await fixture(new Date("2026-01-15T15:59:50Z")); // Thu 23:59:50 SGT
  try {
    const itemId = await f.add(5);
    await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      window: { start: "20:00", end: "24:00" },
    });
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 90,
        prevClose: 100,
        providerChangePct: -10,
        quoteTime: new Date("2026-01-15T15:59:00Z"),
      }),
    );
    await f.monitor.tick();
    // The gateway was down until Friday's window: the row is still pending.
    await f.db.query("UPDATE stock_alerts SET created_at=$2 WHERE item_id=$1", [
      itemId,
      new Date("2026-01-15T15:59:50Z"),
    ]);
    const late = new StockDelivery(
      f.db,
      async (user, payload) => {
        f.sent.push({ user, payload });
      },
      () => new Date("2026-01-16T14:30:00Z"), // Fri 22:30 SGT, window open
    );
    await late.tick();
    assert.equal(f.sent.length, 0);
    assert.equal((await f.alerts(itemId))[0].state, "muted");
  } finally {
    await f.pg.close();
  }
});

test("a rejected window leaves the other requested settings unchanged", async () => {
  const f = await fixture(new Date("2026-01-15T15:30:00Z"));
  try {
    await f.add(5);
    await assert.rejects(
      f.tools.call("a", f.run, {
        operation: "watchlist_settings",
        pollMinutes: 60,
        window: { start: "09:00", end: "09:00" },
      }),
      /same/,
    );
    const listed = await f.tools.call("a", f.run, {
      operation: "watchlist_list",
    });
    assert.equal(listed.settings.poll_minutes, 15);
    // A valid combined request applies both, and omitting window keeps it.
    await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      pollMinutes: 60,
      window: { start: "20:00", end: "24:00", days: ["mon", "tue"] },
    });
    const kept = await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      defaultDropPct: 4,
    });
    assert.equal(kept.settings.poll_minutes, 60);
    assert.equal(kept.settings.window_start, "20:00");
    assert.deepEqual(kept.settings.window_days, ["mon", "tue"]);
  } finally {
    await f.pg.close();
  }
});

test("at the open a stale previous-session quote is retried after 15 minutes, not a whole hour", async () => {
  const f = await fixture(new Date("2026-01-15T14:10:00Z")); // 09:10 ET, closed
  try {
    const itemId = await f.add(5);
    await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      pollMinutes: 60,
    });
    await f.monitor.tick(); // gated: market closed
    // 09:30 ET: the delayed feed still returns yesterday's closing quote.
    f.setNow(new Date("2026-01-15T14:30:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 90,
        prevClose: 100,
        providerChangePct: -10,
        quoteTime: new Date("2026-01-14T21:00:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal((await f.observations(itemId)).at(-1)!.decision, "stale");
    f.setNow(new Date("2026-01-15T14:40:00Z")); // too soon
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 1);
    f.setNow(new Date("2026-01-15T14:45:00Z")); // 15 minutes later
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 90,
        prevClose: 100,
        providerChangePct: -10,
        quoteTime: new Date("2026-01-15T14:30:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 2);
    assert.equal((await f.alerts(itemId)).length, 1);
    // A later stale quote (not the first after a gate) waits the full interval.
    f.setNow(new Date("2026-01-15T15:45:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({ quoteTime: new Date("2026-01-15T12:00:00Z") }),
    );
    await f.monitor.tick();
    f.setNow(new Date("2026-01-15T16:00:00Z"));
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 3);
  } finally {
    await f.pg.close();
  }
});

test("an alert muted only by a window gap is re-armed when the window reopens the same trading day", async () => {
  // Window 00:00-23:00 SGT leaves 23:00-24:00 closed inside the US session.
  const f = await fixture(new Date("2026-01-15T14:59:50Z")); // 22:59:50 SGT, 09:59 ET
  try {
    const itemId = await f.add(5);
    await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      window: { start: "00:00", end: "23:00" },
    });
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 90,
        prevClose: 100,
        providerChangePct: -10,
        quoteTime: new Date("2026-01-15T14:59:00Z"),
      }),
    );
    await f.monitor.tick();
    const late = new StockDelivery(
      f.db,
      async (user, payload) => {
        f.sent.push({ user, payload });
      },
      () => new Date("2026-01-15T15:00:05Z"), // 23:00:05 SGT
    );
    await late.tick();
    assert.equal((await f.alerts(itemId))[0].state, "muted");
    // 00:00 SGT = 11:00 ET, same US trading day, still down: alert again.
    f.setNow(new Date("2026-01-15T16:00:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 91,
        prevClose: 100,
        providerChangePct: -9,
        quoteTime: new Date("2026-01-15T16:00:00Z"),
      }),
    );
    await f.monitor.tick();
    const rows = await f.alerts(itemId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "pending");
    const reopened = new StockDelivery(
      f.db,
      async (user, payload) => {
        f.sent.push({ user, payload });
      },
      () => new Date("2026-01-15T16:00:10Z"),
    );
    await reopened.tick();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!.payload.reply, /9\.0%/);
    // A pause-muted alert still keeps the day silent (existing contract).
    await f.db.query(
      "UPDATE stock_alerts SET state='muted',payload=payload-'windowMuted' WHERE item_id=$1",
      [itemId],
    );
    f.setNow(new Date("2026-01-15T17:00:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 91,
        prevClose: 100,
        providerChangePct: -9,
        quoteTime: new Date("2026-01-15T17:00:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal(
      (await f.observations(itemId)).at(-1)!.decision,
      "suppressed_today",
    );
  } finally {
    await f.pg.close();
  }
});

test("the window schema accepts days: null", () => {
  const parsed = action.parse({
    operation: "watchlist_settings",
    window: { start: "20:00", end: "24:00", days: null },
  }) as any;
  assert.equal(validateWindow(parsed.window).days, null);
});

test("an all-day window spans midnight: an alert queued at 23:59:59 is still sent at 00:00:05", async () => {
  const f = await fixture(new Date("2026-01-15T15:59:59Z")); // 23:59:59 SGT
  try {
    const itemId = await f.add(5);
    await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      window: { start: "00:00", end: "24:00" },
    });
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 90,
        prevClose: 100,
        providerChangePct: -10,
        quoteTime: new Date("2026-01-15T15:59:00Z"),
      }),
    );
    await f.monitor.tick();
    await f.db.query("UPDATE stock_alerts SET created_at=$2 WHERE item_id=$1", [
      itemId,
      new Date("2026-01-15T15:59:59Z"),
    ]);
    const after = new StockDelivery(
      f.db,
      async (user, payload) => {
        f.sent.push({ user, payload });
      },
      () => new Date("2026-01-15T16:00:05Z"),
    );
    await after.tick();
    assert.equal(f.sent.length, 1);
    // A day-filtered window does not join across midnight.
    const [s, e] = windowOccurrence(
      { start: "00:00", end: "24:00", days: ["fri"] },
      new Date("2026-01-15T16:00:05Z"),
    )!;
    assert.equal(new Date(s).toISOString(), "2026-01-15T16:00:00.000Z");
    assert.equal(new Date(e).toISOString(), "2026-01-16T16:00:00.000Z");
  } finally {
    await f.pg.close();
  }
});

test("a pause withdraws re-arm eligibility from a window-muted alert", async () => {
  const f = await fixture(new Date("2026-01-15T14:59:50Z")); // 22:59:50 SGT
  try {
    const itemId = await f.add(5);
    await f.tools.call("a", f.run, {
      operation: "watchlist_settings",
      window: { start: "00:00", end: "23:00" },
    });
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 90,
        prevClose: 100,
        providerChangePct: -10,
        quoteTime: new Date("2026-01-15T14:59:00Z"),
      }),
    );
    await f.monitor.tick();
    await new StockDelivery(
      f.db,
      async () => {},
      () => new Date("2026-01-15T15:00:05Z"),
    ).tick();
    assert.equal((await f.alerts(itemId))[0].payload.windowMuted, "true");
    // Pause and resume before the window reopens the same trading day.
    await f.tools.call("a", f.run, {
      operation: "watchlist_update",
      id: itemId,
      status: "paused",
    });
    await f.tools.call("a", f.run, {
      operation: "watchlist_update",
      id: itemId,
      status: "active",
    });
    assert.equal((await f.alerts(itemId))[0].payload.windowMuted, undefined);
    f.setNow(new Date("2026-01-15T16:00:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 90,
        prevClose: 100,
        providerChangePct: -10,
        quoteTime: new Date("2026-01-15T16:00:00Z"),
      }),
    );
    await f.monitor.tick();
    assert.equal((await f.alerts(itemId))[0].state, "muted");
    assert.equal(
      (await f.observations(itemId)).at(-1)!.decision,
      "suppressed_today",
    );
  } finally {
    await f.pg.close();
  }
});
