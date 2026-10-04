import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { CreditBucket } from "../src/market-credits.js";
import { MarketHistory } from "../src/market-history.js";
import {
  quoteKey,
  type MarketDataProvider,
  type PriceBar,
  type Quote,
  type SymbolHit,
  type SymbolRef,
} from "../src/stock-provider.js";
import {
  RuleDelivery,
  RuleEngine,
  RuleTools,
  met,
  recovered,
  ruleReferences,
  triggerLevel,
} from "../src/stock-rules.js";
import { StockMonitor, WatchlistTools, mutePending } from "../src/stocks.js";
import { readOperations } from "../src/execution.js";
import { action } from "../src/protocol.js";
import { runtimeContext } from "../src/runtime.js";
import { readFeed } from "../src/telegram-feeds.js";

const NY = "America/New_York";
// Thursday 15 January 2026: 10:30 ET in session; the close is 21:00Z.
const OPEN = new Date("2026-01-15T15:30:00Z");
const AFTER_CLOSE = new Date("2026-01-15T21:10:00Z");

/** Weekday dates strictly before `before`, ascending. */
function sessions(count: number, before = "2026-01-15") {
  const out: string[] = [];
  const d = new Date(before + "T00:00:00Z");
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
// Previous close equals the price by default, so daily-drop alerts stay out of the way.
const quote = (price: number, over: Partial<Quote> = {}): Quote => ({
  price,
  prevClose: price,
  providerChangePct: null,
  currency: "USD",
  quoteTime: OPEN,
  tradingDate: "2026-01-15",
  marketOpen: true,
  extended: null,
  delayed: true,
  ...over,
});

/** 300 prior sessions (closes 100, lows 90, highs 110; one 52w low of 80) and monthly bars. */
function history() {
  const daily = sessions(300).map((d) => bar(d, 100, 90, 110));
  daily[200] = bar(daily[200]!.date, 85, 80, 100);
  const monthly = [
    bar("2000-01-01", 10, 5, 12),
    bar("2025-06-01", 100, 90, 120),
    bar("2026-01-01", 100, 1, 500), // current month: may contain today, never used
  ];
  return { daily, monthly };
}

test("rule references exclude today and the current month", () => {
  const { daily, monthly } = history();
  // Today's bar would be a new extreme; it must not move the reference.
  const withToday = [...daily, bar("2026-01-15", 50, 40, 600)];
  const refs = ruleReferences(quote(70), withToday, monthly);
  assert.equal((refs.low_52w as any).value, 80);
  assert.equal((refs.low_52w as any).asOf, daily[200]!.date);
  assert.equal((refs.high_52w as any).value, 110);
  assert.equal((refs.avg_12w as any).value, 100);
  assert.equal((refs.all_time_low as any).value, 5);
  assert.equal((refs.all_time_low as any).source, "since 2000-01");
  assert.equal((refs.all_time_high as any).value, 120);
  assert.equal((refs.prev_close as any).value, 70);
  // Short or stale history is unavailable, never a shorter window.
  const short = ruleReferences(quote(70), daily.slice(-100), monthly);
  assert.equal(short.avg_52w!.value, null);
  assert.match((short.avg_52w as any).reason, /only 100 of 260/);
  const stale = ruleReferences(
    quote(70, { tradingDate: "2026-03-01" }),
    daily,
    monthly,
  );
  assert.match((stale.low_12w as any).reason, /daily history ends/);
  assert.equal(stale.all_time_low!.value, null);
});

test("trigger, condition and 1% re-arm arithmetic", () => {
  assert.equal(triggerLevel("below", 200, 15), 170);
  assert.equal(triggerLevel("above", 100, 10), 110.00000000000001);
  assert(met("below", 169.99, 170) && !met("below", 170, 170));
  assert(met("above", 110.01, 110) && !met("above", 110, 110));
  assert(!recovered("below", 171, 170) && recovered("below", 171.7, 170));
  assert(!recovered("above", 109, 110) && recovered("above", 108.9, 110));
});

class FakeProvider implements MarketDataProvider {
  name = "fake";
  creditsPerMinute = 8;
  supportsExtended = false;
  hits: SymbolHit[] = [];
  quotes_ = new Map<string, Quote>();
  calls = { quotes: 0, history: 0 };
  daily: PriceBar[];
  monthly: PriceBar[];
  constructor() {
    ({ daily: this.daily, monthly: this.monthly } = history());
  }
  async search() {
    return this.hits;
  }
  async quotes(refs: SymbolRef[]) {
    this.calls.quotes++;
    const map = new Map<string, Quote>();
    for (const r of refs) {
      const q = this.quotes_.get(quoteKey(r));
      if (q) map.set(quoteKey(r), q);
    }
    return map;
  }
  async history(_ref: SymbolRef, interval: "1day" | "1month") {
    this.calls.history++;
    return interval === "1day" ? this.daily : this.monthly;
  }
}

async function fixture(now = OPEN) {
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
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'a','rules')",
    [run],
  );
  const provider = new FakeProvider();
  let clock = now;
  const credits = new CreditBucket(8, 800);
  const historyCache = new MarketHistory(provider);
  const engine = new RuleEngine(db, provider.name, credits, historyCache);
  const monitor = new StockMonitor(
    db,
    provider,
    (u) => u === "a",
    () => clock,
    undefined,
    credits,
    engine,
  );
  const watch = new WatchlistTools(db, provider, () => clock, credits);
  const rules = new RuleTools(db, () => clock);
  const sent: any[] = [];
  const delivery = new RuleDelivery(
    db,
    async (_user, payload) => {
      sent.push(payload);
    },
    () => clock,
  );
  const add = async (symbol: string) => {
    provider.hits = [
      {
        symbol,
        name: `${symbol} Inc`,
        exchange: "NASDAQ",
        mic: "XNAS",
        timezone: NY,
        currency: "USD",
        type: "Common Stock",
      },
    ];
    const r: any = await watch.call("a", run, {
      operation: "watchlist_add",
      query: symbol,
    });
    return r.added.id as string;
  };
  const rule = (fields: Record<string, unknown>) =>
    rules.call(
      "a",
      run,
      action.parse({ operation: "stock_rule_add", ...fields }) as any,
    );
  const setQuote = (symbol: string, q: Quote) =>
    provider.quotes_.set(quoteKey({ symbol, mic: "XNAS" }), q);
  const tick = async (at: Date) => {
    clock = at;
    await monitor.tick();
  };
  const alerts = async () =>
    (await db.query("SELECT * FROM watch_rule_alerts ORDER BY created_at"))
      .rows;
  const state = async () =>
    (await db.query("SELECT * FROM watch_rule_states")).rows;
  return {
    db,
    run,
    provider,
    engine,
    rules,
    delivery,
    sent,
    add,
    rule,
    setQuote,
    tick,
    alerts,
    state,
    setNow: (d: Date) => {
      clock = d;
    },
  };
}

test("an intraday rule alerts once on crossing, re-arms after a 1% recovery, and never touches daily-drop alerts", async () => {
  const f = await fixture();
  const id = await f.add("ACME");
  await f.rule({
    scope: "item",
    itemId: id,
    direction: "below",
    reference: "low_52w",
    basis: "intraday",
    label: "Tell me if ACME makes a new 52-week low",
  });
  f.setQuote("ACME", quote(85));
  await f.tick(OPEN);
  assert.equal((await f.alerts()).length, 0);
  assert.equal((await f.state())[0].last_outcome, "not met");
  f.setQuote(
    "ACME",
    quote(79, { quoteTime: new Date("2026-01-15T16:30:00Z") }),
  );
  await f.tick(new Date("2026-01-15T16:31:00Z"));
  const [alert] = await f.alerts();
  assert.equal(alert.trading_date.toISOString().slice(0, 10), "2026-01-15");
  assert.equal(alert.hold_for_window, false);
  assert.match(alert.payload.reply, /is below its 52-week low/);
  assert.match(alert.payload.reply, /80\.00/);
  assert.match(alert.payload.reply, /not advice/);
  assert.equal((await f.state())[0].armed, false);
  // Still below: no second alert; a 1% recovery past the trigger re-arms.
  f.setQuote(
    "ACME",
    quote(78, { quoteTime: new Date("2026-01-15T16:50:00Z") }),
  );
  await f.tick(new Date("2026-01-15T16:51:00Z"));
  assert.equal((await f.alerts()).length, 1);
  assert.equal((await f.state())[0].last_outcome, "met; waiting to re-arm");
  f.setQuote(
    "ACME",
    quote(80.9, { quoteTime: new Date("2026-01-15T17:10:00Z") }),
  );
  await f.tick(new Date("2026-01-15T17:11:00Z"));
  assert.equal((await f.state())[0].armed, true);
  // History was fetched once for the day (2 credits), not per poll.
  assert.equal(f.provider.calls.history, 2);
  // The daily-drop alerts table is untouched by rules.
  assert.equal(
    (await f.db.query("SELECT count(*)::int n FROM stock_alerts")).rows[0].n,
    0,
  );
});

test("a close-based rule is checked once after the close and its alert is held for the monitoring window", async () => {
  const f = await fixture();
  const id = await f.add("ACME");
  // Monitoring hours 20:00–24:00 SGT (12:00–16:00Z): the close at 21:00Z is outside.
  await f.db.query(
    "UPDATE watchlist_items SET window_start='20:00',window_end='24:00',window_days=NULL WHERE id=$1",
    [id],
  );
  await f.rule({
    scope: "item",
    itemId: id,
    direction: "below",
    reference: "avg_52w",
    marginPct: 10,
    basis: "close",
    label: "Tell me if ACME closes 10% below its 52-week average",
  });
  // During the session nothing is evaluated for a close rule.
  f.setQuote("ACME", quote(80));
  await f.tick(OPEN);
  assert.equal((await f.state()).length, 0);
  // After the close: one closing fetch with the final regular-session quote.
  f.setQuote(
    "ACME",
    quote(89.5, {
      marketOpen: false,
      quoteTime: new Date("2026-01-15T21:00:00Z"),
    }),
  );
  const before = f.provider.calls.quotes;
  await f.tick(AFTER_CLOSE);
  assert.equal(f.provider.calls.quotes, before + 1);
  const [alert] = await f.alerts();
  assert.equal(alert.hold_for_window, true);
  assert.match(alert.payload.reply, /closed 10% below its 52-week average/);
  assert.equal(
    (await f.state())[0].last_closing_date.toISOString().slice(0, 10),
    "2026-01-15",
  );
  // Done for the day: no further closing fetch.
  await f.tick(new Date("2026-01-15T22:30:00Z"));
  assert.equal(f.provider.calls.quotes, before + 1);
  // Held while the window is closed, delivered when it opens.
  await f.delivery.tick();
  assert.equal(f.sent.length, 0);
  f.setNow(new Date("2026-01-16T12:30:00Z"));
  await f.delivery.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].ruleId, alert.rule_id);
  // The alert is readable as a Markets feed reference.
  const feed: any = await readFeed(f.db, "a", "markets", alert.id);
  assert.equal(JSON.parse(feed.content).id, alert.id);
});

test("below-cost rules use fresh IBKR holdings under the current grant, matched by provider symbol and currency", async () => {
  const f = await fixture();
  const id = await f.add("BRK.B");
  const connectedAt = new Date("2026-01-15T00:00:00Z");
  await f.db.query(
    "INSERT INTO brokerage_connections(id,user_id,provider,state,token_box,connected_at) VALUES($1,'a','ibkr','connected','\\x00',$2)",
    [randomUUID(), connectedAt],
  );
  const sync = randomUUID();
  await f.db.query(
    "INSERT INTO portfolio_syncs(id,user_id,provider,reason,status,started_at,finished_at,position_count) VALUES($1,'a','ibkr','schedule','complete',$2,$2,1)",
    [sync, new Date("2026-01-15T14:00:00Z")],
  );
  await f.db.query(
    "INSERT INTO portfolio_positions(sync_id,user_id,contract_id,symbol,asset_class,currency,quantity,average_price) VALUES($1,'a',72063691,'BRK B','STK','USD',15,471.35)",
    [sync],
  );
  const added: any = await f.rule({
    scope: "holdings",
    direction: "below",
    reference: "avg_cost",
    basis: "intraday",
    label: "Tell me when any holding drops below my buy price",
  });
  assert.deepEqual(added.coverage.monitored, ["BRK.B"]);
  f.setQuote("BRK.B", quote(470));
  await f.tick(OPEN);
  const [alert] = await f.alerts();
  assert.match(alert.payload.reply, /is below your IBKR average cost\./);
  assert.match(alert.payload.reply, /471\.35/);
  // Stale holdings (over 26 hours) are not used.
  await f.db.query("DELETE FROM watch_rule_alerts");
  await f.db.query("UPDATE watch_rule_states SET armed=true");
  f.setQuote(
    "BRK.B",
    quote(470, {
      tradingDate: "2026-01-16",
      quoteTime: new Date("2026-01-16T17:00:00Z"),
    }),
  );
  await f.tick(new Date("2026-01-16T17:00:00Z"));
  // Holdings scope no longer applies when holdings are stale: nothing evaluated or alerted.
  assert.equal((await f.alerts()).length, 0);
  void id;
});

test("rule tools validate, report coverage, list state, pause and remove; only foreground turns change rules", async () => {
  const f = await fixture();
  const id = await f.add("ACME");
  await assert.rejects(
    f.rule({
      scope: "item",
      direction: "below",
      reference: "low_52w",
      basis: "intraday",
      label: "x",
    }),
    /itemId/,
  );
  await assert.rejects(
    f.rule({
      scope: "item",
      itemId: randomUUID(),
      direction: "below",
      reference: "low_52w",
      basis: "intraday",
      label: "x",
    }),
    /not on the watchlist/,
  );
  await assert.rejects(
    f.rule({
      scope: "watchlist",
      direction: "below",
      reference: "avg_cost",
      basis: "intraday",
      label: "x",
    }),
    /Average cost only exists for holdings/,
  );
  const added: any = await f.rule({
    scope: "item",
    itemId: id,
    direction: "below",
    reference: "high_52w",
    marginPct: 15,
    basis: "close",
    label: "Tell me if ACME closes 15% below its 52-week high",
  });
  assert.equal(
    added.meaning,
    "closes 15% below 52-week high, alert on crossing",
  );
  await assert.rejects(
    f.rule({
      scope: "item",
      itemId: id,
      direction: "below",
      reference: "high_52w",
      marginPct: 15,
      basis: "close",
      label: "dup",
    }),
    /identical rule/,
  );
  const holdings: any = await f.rule({
    scope: "holdings",
    direction: "below",
    reference: "avg_cost",
    basis: "intraday",
    label: "below my buy price",
  });
  assert.equal(holdings.coverage.holdingsUnavailable, "ibkr_not_connected");
  // Background turns cannot change rules.
  const bg = randomUUID();
  await f.db.query(
    "INSERT INTO work_turns(run_id,user_id,request,background) VALUES($1,'a','bg',true)",
    [bg],
  );
  await assert.rejects(
    f.rules.call("a", bg, {
      operation: "stock_rule_remove",
      id: added.rule.id,
    }),
    /foreground/,
  );
  // Another owner cannot see or change them.
  assert.equal(
    ((await f.rules.call("b", bg, { operation: "stock_rule_list" })) as any)
      .rules.length,
    0,
  );
  const listed: any = await f.rules.call("a", f.run, {
    operation: "stock_rule_list",
  });
  assert.equal(listed.rules.length, 2);
  // Pausing mutes a queued alert.
  await f.db.query(
    "INSERT INTO watch_rule_alerts(id,user_id,rule_id,item_id,trading_date,payload) VALUES($1,'a',$2,$3,'2026-01-15','{}')",
    [randomUUID(), added.rule.id, id],
  );
  await f.rules.call("a", f.run, {
    operation: "stock_rule_update",
    id: added.rule.id,
    status: "paused",
  });
  assert.equal((await f.alerts())[0].state, "muted");
  await f.rules.call("a", f.run, {
    operation: "stock_rule_remove",
    id: added.rule.id,
  });
  assert.equal((await f.alerts()).length, 0);
});

test("without credits for history, rules wait instead of fetching; daily notify repeats per trading day", async () => {
  const f = await fixture();
  const id = await f.add("ACME");
  await f.rule({
    scope: "item",
    itemId: id,
    direction: "below",
    reference: "prev_close",
    marginPct: 5,
    basis: "intraday",
    notify: "daily",
    label: "Remind me daily while ACME is 5% below yesterday's close",
  });
  await f.rule({
    scope: "item",
    itemId: id,
    direction: "below",
    reference: "all_time_low",
    basis: "intraday",
    label: "all-time low",
  });
  f.setQuote("ACME", quote(90, { prevClose: 100 }));
  // watchlist_add's search used 1 credit this minute; leave exactly 1 for the monitor's
  // quote, so the rule engine finds no credits for history.
  (f.engine as any).credits.spend(6, OPEN);
  await f.tick(OPEN);
  const states = await f.state();
  assert(
    states.some(
      (s) => s.last_outcome === "references pending: market-data credits",
    ),
  );
  assert.equal(f.provider.calls.history, 0);
  // prev_close needs no history: it alerted.
  assert.equal((await f.alerts()).length, 1);
  // Next trading day, still true: the daily rule alerts again.
  f.setQuote(
    "ACME",
    quote(90, {
      prevClose: 100,
      tradingDate: "2026-01-16",
      quoteTime: new Date("2026-01-16T15:30:00Z"),
    }),
  );
  await f.tick(new Date("2026-01-16T15:30:00Z"));
  assert.equal(
    (await f.alerts()).filter((a) => a.payload.reply.includes("previous close"))
      .length,
    2,
  );
});

test("rule tools are gated with market data and only listing is a read", () => {
  assert(readOperations.has("stock_rule_list"));
  for (const op of ["stock_rule_add", "stock_rule_update", "stock_rule_remove"])
    assert(!readOperations.has(op));
  const on = runtimeContext({ stocks: true }, null);
  assert(on.tools.some((t) => t.name === "stock_rule_add"));
  const off = runtimeContext({ stocks: false }, null);
  assert(!off.tools.some((t) => t.name.startsWith("stock_rule_")));
});

test("history for many synchronized stocks loads from leftover credits and every rule still alerts", async () => {
  const f = await fixture(new Date("2026-01-15T14:00:00Z"));
  const symbols = ["AA", "BB", "CC", "DD", "EE", "FF", "GG", "HH"];
  for (const s of symbols) {
    await f.add(s);
    f.setQuote(s, quote(79));
  }
  await f.rule({
    scope: "watchlist",
    direction: "below",
    reference: "low_52w",
    basis: "intraday",
    label: "Tell me when any watched stock makes a new 52-week low",
  });
  // The open: all 8 quotes are due together and use the whole minute.
  await f.tick(OPEN);
  assert.equal((await f.alerts()).length, 0);
  // Quiet ticks spend leftover credits on history and re-run with the same quotes.
  for (let m = 1; m <= 3; m++)
    await f.tick(new Date(OPEN.getTime() + m * 60000));
  assert.equal((await f.alerts()).length, 8);
  assert.equal(f.provider.calls.history, 16);
});

test("a delayed pre-close quote is not taken as the close; the final quote is, even with a long cadence", async () => {
  const f = await fixture();
  const id = await f.add("ACME");
  await f.db.query(
    "INSERT INTO stock_settings(user_id,poll_minutes) VALUES('a',240) ON CONFLICT(user_id) DO UPDATE SET poll_minutes=240",
  );
  await f.rule({
    scope: "item",
    itemId: id,
    direction: "below",
    reference: "prev_close",
    marginPct: 5,
    basis: "close",
    label: "Tell me if ACME closes 5% below yesterday",
  });
  // Last session poll at 15:30 ET; the next cadence poll would be 19:30 ET.
  f.setQuote(
    "ACME",
    quote(100, { prevClose: 100, quoteTime: new Date("2026-01-15T20:30:00Z") }),
  );
  await f.tick(new Date("2026-01-15T20:30:00Z"));
  // 16:05 ET: the delayed feed still returns 15:50.
  f.setQuote(
    "ACME",
    quote(90, {
      prevClose: 100,
      marketOpen: false,
      quoteTime: new Date("2026-01-15T20:50:00Z"),
    }),
  );
  await f.tick(new Date("2026-01-15T21:05:00Z"));
  assert.equal((await f.alerts()).length, 0);
  // The attempt is visible, and the day is not marked done.
  const [waiting] = await f.state();
  assert.equal(
    waiting.last_outcome,
    "waiting for the final close quote (attempt 1)",
  );
  assert.equal(waiting.last_closing_date, null);
  // 10 minutes later the final quote arrives and is accepted.
  f.setQuote(
    "ACME",
    quote(94, {
      prevClose: 100,
      marketOpen: false,
      quoteTime: new Date("2026-01-15T21:00:00Z"),
    }),
  );
  await f.tick(new Date("2026-01-15T21:16:00Z"));
  const [alert] = await f.alerts();
  assert.match(alert.payload.reply, /closed 5% below its previous close/);
  assert.match(alert.payload.reply, /Price 94\.00/);
});

test("close rules also run for extended-hours stocks polled after the close", async () => {
  const f = await fixture();
  f.provider.supportsExtended = true;
  const id = await f.add("ACME");
  await f.db.query(
    "INSERT INTO stock_settings(user_id,include_extended) VALUES('a',true) ON CONFLICT(user_id) DO UPDATE SET include_extended=true",
  );
  await f.rule({
    scope: "item",
    itemId: id,
    direction: "above",
    reference: "prev_close",
    basis: "close",
    label: "Tell me if ACME closes above yesterday",
  });
  f.setQuote(
    "ACME",
    quote(110, {
      prevClose: 100,
      marketOpen: false,
      quoteTime: new Date("2026-01-15T21:00:00Z"),
      extended: {
        price: 111,
        changePct: 11,
        time: new Date("2026-01-15T21:09:00Z"),
      },
    }),
  );
  await f.tick(AFTER_CLOSE);
  const [alert] = await f.alerts();
  assert.match(alert.payload.reply, /closed above its previous close/);
  assert.match(alert.payload.reply, /Price 110\.00/);
});

test("pausing stock alerts also mutes queued rule alerts, and held alerts never block deliverable ones", async () => {
  const f = await fixture();
  const held = await f.add("HELD");
  await f.db.query(
    "UPDATE watchlist_items SET window_start='01:00',window_end='02:00' WHERE id=$1",
    [held],
  );
  const open = await f.add("OPEN");
  const ruleId = (
    (await f.rule({
      scope: "watchlist",
      direction: "below",
      reference: "prev_close",
      basis: "intraday",
      label: "x",
    })) as any
  ).rule.id;
  for (let d = 1; d <= 25; d++)
    await f.db.query(
      "INSERT INTO watch_rule_alerts(id,user_id,rule_id,item_id,trading_date,hold_for_window,payload,created_at) VALUES($1,'a',$2,$3,$4,true,'{}',$5)",
      [
        randomUUID(),
        ruleId,
        held,
        `2025-12-${String(d).padStart(2, "0")}`,
        new Date(OPEN.getTime() - 3600_000),
      ],
    );
  const deliverable = randomUUID();
  await f.db.query(
    "INSERT INTO watch_rule_alerts(id,user_id,rule_id,item_id,trading_date,payload) VALUES($1,'a',$2,$3,'2026-01-15','{\"reply\":\"x\"}')",
    [deliverable, ruleId, open],
  );
  f.setNow(OPEN);
  await f.delivery.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].alertId, deliverable);
  // "Pause all stock alerts" (mutePending) also mutes queued rule alerts.
  await mutePending(f.db, "a");
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM watch_rule_alerts WHERE state='pending'",
      )
    ).rows[0].n,
    0,
  );
});

test("a stock with no final close quote stops after bounded attempts, visibly", async () => {
  const f = await fixture();
  const id = await f.add("THIN");
  await f.rule({
    scope: "item",
    itemId: id,
    direction: "below",
    reference: "prev_close",
    basis: "close",
    label: "thin close",
  });
  // The last trade was at 15:55 ET: never stamped at the close.
  f.setQuote(
    "THIN",
    quote(90, {
      prevClose: 100,
      marketOpen: false,
      quoteTime: new Date("2026-01-15T20:55:00Z"),
    }),
  );
  const before = f.provider.calls.quotes;
  for (let m = 5; m <= 180; m += 5)
    await f.tick(new Date(Date.parse("2026-01-15T21:00:00Z") + m * 60000));
  // Six attempts (at least 10 minutes apart), then the day is closed visibly.
  assert.equal(f.provider.calls.quotes - before, 6);
  const [state] = await f.state();
  assert.equal(state.last_outcome, "close not confirmed: no final quote");
  assert.equal(
    state.last_closing_date.toISOString().slice(0, 10),
    "2026-01-15",
  );
  assert.equal((await f.alerts()).length, 0);
});
