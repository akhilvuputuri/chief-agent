/** Static US equity market calendar. Twelve Data's exchange_schedule endpoint is
 * paid-tier only, so session gating uses NYSE's published rules instead: regular
 * 09:30–16:00 ET, pre 04:00–09:30, post close–20:00, weekends and NYSE holidays
 * closed, 13:00 early closes on the day before observed Independence/Christmas
 * days and the day after Thanksgiving. Unscheduled closures (weather, mourning)
 * are inherently unpredictable; the monitor still validates quote freshness. */

export interface ExchangeSessions {
  timezone: string;
  sessions: { open: string; close: string; type: string }[];
}

const NY = "America/New_York";
/** US equity venues that follow the NYSE hours calendar. */
const US_MICS = new Set([
  "XNYS", // NYSE
  "XNAS", // Nasdaq
  "XASE", // NYSE American
  "ARCX", // NYSE Arca
  "BATS", // Cboe BZX
  "IEXG", // IEX
  "XNAS", // (dup guard)
  "XBOS", // Nasdaq BX
  "XPHL", // Nasdaq PHLX
  "XCIS", // National
  "XCHI", // Chicago
]);

export function marketCalendar(mic: string): { timezone: string } | null {
  return US_MICS.has(mic.toUpperCase()) ? { timezone: NY } : null;
}

function dateAt(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function weekday(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay(); // noon avoids zone edges
}
function observed(date: string, { skipSaturday = false } = {}) {
  const d = weekday(date);
  if (d === 6) return skipSaturday ? null : shift(date, -1); // Sat → Friday before
  if (d === 0) return shift(date, 1); // Sun → Monday after
  return date;
}
function shift(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function nthWeekday(year: number, month: number, dow: number, n: number) {
  const first = weekday(dateAt(year, month, 1));
  const day = 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
  return dateAt(year, month, day);
}
function lastWeekday(year: number, month: number, dow: number) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = weekday(dateAt(year, month, days));
  return dateAt(year, month, days - ((last - dow + 7) % 7));
}
/** Gregorian Easter Sunday (Anonymous algorithm). */
function easter(year: number) {
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100,
    d = Math.floor(b / 4),
    e = b % 4,
    f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dateAt(year, month, day);
}
const holidayCache = new Map<number, Set<string>>();
function holidays(year: number): Set<string> {
  let set = holidayCache.get(year);
  if (set) return set;
  set = new Set<string>();
  // NYSE full holidays; Jan 1 falling on Saturday is NOT observed (Dec 31 trades).
  const fixed: [number, number, { skipSaturday?: boolean }?][] = [
    [1, 1, { skipSaturday: true }],
    [6, 19],
    [7, 4],
    [12, 25],
  ];
  for (const [m, dd, opt] of fixed) {
    const h = observed(dateAt(year, m, dd), opt);
    if (h) set.add(h);
  }
  set.add(nthWeekday(year, 1, 1, 3)); // MLK
  set.add(nthWeekday(year, 2, 1, 3)); // Washington's Birthday
  set.add(shift(easter(year), -2)); // Good Friday
  set.add(lastWeekday(year, 5, 1)); // Memorial Day
  set.add(nthWeekday(year, 9, 1, 1)); // Labor Day
  set.add(nthWeekday(year, 11, 4, 4)); // Thanksgiving
  holidayCache.set(year, set);
  return set;
}
function isHoliday(date: string) {
  const year = Number(date.slice(0, 4));
  return holidays(year).has(date) || holidays(year + 1).has(date);
}
/** NYSE 13:00 early closes: Jul 3 and Dec 24 when they trade, and the Friday
 * after Thanksgiving. */
function isEarlyClose(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  if (weekday(date) < 1 || weekday(date) > 5 || isHoliday(date)) return false;
  if ((m === 7 && d === 3) || (m === 12 && d === 24)) return true;
  return weekday(date) === 5 && date === shift(nthWeekday(y!, 11, 4, 4), 1);
}
const PRE = { open: "04:00", close: "09:30", type: "pre" };
const POST_END = "20:00";

/** Sessions for a market date (YYYY-MM-DD in New York time). Empty = closed. */
export function sessionsFor(mic: string, date: string): ExchangeSessions {
  const tz = marketCalendar(mic)?.timezone ?? NY;
  const d = weekday(date);
  if (d === 0 || d === 6 || isHoliday(date))
    return { timezone: tz, sessions: [] };
  const regular = isEarlyClose(date)
    ? { open: "09:30", close: "13:00", type: "regular" }
    : { open: "09:30", close: "16:00", type: "regular" };
  return {
    timezone: tz,
    sessions: [
      PRE,
      regular,
      { open: regular.close, close: POST_END, type: "post" },
    ],
  };
}
