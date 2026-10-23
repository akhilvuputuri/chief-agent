// Fetches split-adjusted daily bars for the Kronos spike (docs/kronos-trading-experiment.md).
// Usage: node scripts/kronos-spike-bars.mjs AAPL [outputsize] > AAPL.json
// Uses TWELVE_DATA_API_KEY when set, otherwise Twelve Data's public demo key (AAPL only).
// Today's bar is dropped until 16:30 New York time, so an unfinished session never counts.
const [symbol = "AAPL", size = "1200"] = process.argv.slice(2);
const url = new URL("https://api.twelvedata.com/time_series");
url.search = new URLSearchParams({
  symbol,
  interval: "1day",
  outputsize: size,
  order: "asc",
  adjust: "splits",
  apikey: process.env.TWELVE_DATA_API_KEY || "demo",
});
const body = await (await fetch(url)).json();
if (body.status !== "ok") {
  console.error(`Twelve Data: ${body.message ?? "unexpected response"}`);
  process.exit(1);
}
const parts = Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(new Date())
    .map((p) => [p.type, p.value]),
);
const today = `${parts.year}-${parts.month}-${parts.day}`;
const closed = `${parts.hour}:${parts.minute}` >= "16:30";
const bars = body.values
  .filter((v) => closed || v.datetime !== today)
  .map((v) => ({
    datetime: v.datetime,
    open: Number(v.open),
    high: Number(v.high),
    low: Number(v.low),
    close: Number(v.close),
    volume: Number(v.volume),
  }));
process.stdout.write(
  `${JSON.stringify({ symbol, source: "twelvedata", adjust: "splits", bars })}\n`,
);
