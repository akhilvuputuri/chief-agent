import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { WatchlistTools, StockMonitor, StockDelivery } from "../src/stocks.js";
import {
  ProviderError,
  quoteKey,
  type MarketDataProvider,
  type Quote,
  type SymbolHit,
  type SymbolRef,
  type ExchangeSessions,
} from "../src/stock-provider.js";
import { ensureUser, type Database } from "../src/db.js";
import { runtimeContext } from "../src/runtime.js";

const NY = "America/New_York";
const MIC = "XNAS";

class FakeProvider implements MarketDataProvider {
  name = "fake-market-data";
  hits: SymbolHit[] = [];
  quotes_ = new Map<string, Quote>();
  calls = { search: 0, quotes: 0, schedule: 0 };
  fail: { search?: Error; quotes?: Error; schedule?: Error } = {};
  extraSessions: { open: string; close: string; type: string }[] = [];
  closedDates = new Set<string>();
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
  async quotes(refs: SymbolRef[]): Promise<Map<string, Quote>> {
    this.calls.quotes++;
    if (this.fail.quotes) throw this.fail.quotes;
    const map = new Map<string, Quote>();
    for (const r of refs) {
      const q = this.quotes_.get(quoteKey(r));
      if (q) map.set(quoteKey(r), q);
    }
    return map;
  }
  async schedule(mic: string, date: string): Promise<ExchangeSessions> {
    this.calls.schedule++;
    if (this.fail.schedule) throw this.fail.schedule;
    if (this.closedDates.has(date)) return { timezone: NY, sessions: [] };
    return {
      timezone: NY,
      sessions: [
        { open: "09:30", close: "16:00", type: "regular" },
        ...this.extraSessions,
      ],
    };
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
  const tools = new WatchlistTools(db, provider);
  let clock = now;
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
    f.setNow(new Date("2026-01-19T15:30:00Z"));
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 93,
        prevClose: 100,
        providerChangePct: -7,
        quoteTime: new Date("2026-01-19T15:30:00Z"),
        tradingDate: "2026-01-19",
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
    // Holiday: schedule returns no sessions at all.
    f.provider.closedDates.add("2026-01-19");
    f.setNow(new Date("2026-01-19T15:30:00Z"));
    await f.monitor.tick();
    assert.equal(f.provider.calls.quotes, 0);
    obs = await f.observations(itemId);
    assert.equal(obs.at(-1)!.decision, "market_closed");
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
    f.provider.extraSessions.push({
      open: "04:00",
      close: "09:30",
      type: "pre",
    });
    const itemId = await f.add(5);
    f.provider.quotes_.set(
      `${MIC}:ACME`,
      quote({
        price: 100,
        prevClose: 100,
        providerChangePct: 0,
        marketOpen: false,
        extended: { price: 90, changePct: -10 },
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
        extended: { price: 90, changePct: -10 },
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
