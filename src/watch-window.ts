/** Owner-local monitoring windows for the stock watchlist. A window is a daily
 * Singapore-time span (optionally limited to weekdays) intersected with the
 * exchange session: the monitor fetches quotes, and alerts are delivered, only
 * while both are open. An end earlier than the start runs past midnight and
 * belongs to the day it starts on; "24:00" means midnight at the end of the day. */
import { ToolValidationError } from "./tool-errors.js";
import { marketCalendar, sessionsFor } from "./market-calendar.js";

export const WINDOW_TZ = "Asia/Singapore";
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];
export interface MonitoringWindow {
  start: string;
  end: string;
  days?: Day[] | null;
}

const START = /^([01]\d|2[0-3]):[0-5]\d$/;
const END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const minutesOf = (hhmm: string) =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Normalizes tool input; throws a model-readable error for an unusable window. */
export function validateWindow(w: MonitoringWindow): MonitoringWindow {
  if (!START.test(w.start))
    throw new ToolValidationError(
      `Window start "${w.start}" must be HH:MM between 00:00 and 23:59 Singapore time`,
    );
  if (!END.test(w.end))
    throw new ToolValidationError(
      `Window end "${w.end}" must be HH:MM, or 24:00 for midnight at the end of the day`,
    );
  if (minutesOf(w.start) === minutesOf(w.end) % 1440 && w.end !== "24:00")
    throw new ToolValidationError(
      "Window start and end are the same; use 00:00-24:00 to monitor all day",
    );
  const days = w.days?.length ? DAYS.filter((d) => w.days!.includes(d)) : null;
  return { start: w.start, end: w.end, days: days?.length === 7 ? null : days };
}

/** The window that applies to an item: its own override, else the owner default. */
export function effectiveWindow(row: {
  window_start?: string | null;
  window_end?: string | null;
  window_days?: Day[] | null;
  default_window_start?: string | null;
  default_window_end?: string | null;
  default_window_days?: Day[] | null;
}): (MonitoringWindow & { source: "item" | "default" }) | null {
  if (row.window_start && row.window_end)
    return {
      start: row.window_start,
      end: row.window_end,
      days: row.window_days ?? null,
      source: "item",
    };
  if (row.default_window_start && row.default_window_end)
    return {
      start: row.default_window_start,
      end: row.default_window_end,
      days: row.default_window_days ?? null,
      source: "default",
    };
  return null;
}

const localFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: WINDOW_TZ,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function local(at: Date) {
  const p = Object.fromEntries(
    localFormat.formatToParts(at).map((x) => [x.type, x.value]),
  );
  return {
    day: p.weekday!.toLowerCase().slice(0, 3) as Day,
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}
const previousDay = (d: Day) => DAYS[(DAYS.indexOf(d) + 6) % 7]!;

/** True when `at` falls inside the window; no window means always. */
export function inWindow(w: MonitoringWindow | null, at: Date) {
  if (!w) return true;
  const { day, minutes } = local(at);
  const start = minutesOf(w.start);
  const end = w.end === "24:00" ? 1440 : minutesOf(w.end);
  const on = (d: Day) => !w.days || w.days.includes(d);
  if (start < end) return on(day) && minutes >= start && minutes < end;
  return (
    (on(day) && minutes >= start) || (on(previousDay(day)) && minutes < end)
  );
}

export function describeWindow(w: MonitoringWindow | null) {
  if (!w) return "no time window (whole exchange session)";
  const days = w.days?.length
    ? w.days.map((d) => d[0]!.toUpperCase() + d.slice(1)).join(", ")
    : "every day";
  return `${w.start}-${w.end} Singapore time, ${days}`;
}

/** UTC instant of a wall-clock time in a zone (two-pass offset correction). */
function zonedInstant(date: string, hhmm: string, tz: string) {
  const [y, mo, d] = date.split("-").map(Number);
  const wall = Date.UTC(
    y!,
    mo! - 1,
    d!,
    ...(hhmm.split(":").map(Number) as [number, number]),
  );
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(
      fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]),
    );
    const seen = Date.UTC(
      +p.year!,
      +p.month! - 1,
      +p.day!,
      +p.hour!,
      +p.minute!,
    );
    guess += wall - seen;
  }
  return guess;
}
function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
function formatSpan(open: number, close: number) {
  const a = local(new Date(open));
  const b = local(new Date(close));
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const [, mm, dd] = a.date.split("-");
  const month = MONTHS[Number(mm) - 1];
  const day = a.day[0]!.toUpperCase() + a.day.slice(1);
  const end =
    b.date === a.date
      ? hhmm(b.minutes)
      : b.minutes === 0 && b.date === shiftDate(a.date, 1)
        ? "24:00"
        : `${b.day[0]!.toUpperCase() + b.day.slice(1)} ${hhmm(b.minutes)}`;
  return `${day} ${Number(dd)} ${month} ${hhmm(a.minutes)}-${end} SGT`;
}

/** Window occurrences as UTC intervals for Singapore dates around `date`. */
function windowIntervals(w: MonitoringWindow | null, date: string) {
  if (!w) return [[-Infinity, Infinity]] as [number, number][];
  const out: [number, number][] = [];
  for (let offset = -2; offset <= 2; offset++) {
    const d = shiftDate(date, offset);
    const day = DAYS[(new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7]!;
    if (w.days && !w.days.includes(day)) continue;
    const start = zonedInstant(d, w.start, WINDOW_TZ);
    const overnight =
      w.end === "24:00" || minutesOf(w.end) <= minutesOf(w.start);
    const end = zonedInstant(
      overnight ? shiftDate(d, 1) : d,
      w.end === "24:00" ? "00:00" : w.end,
      WINDOW_TZ,
    );
    out.push([start, end]);
  }
  return out;
}

/** The [start, end) instants of the window occurrence containing `at`, or
 * null when there is no window or `at` is outside it. */
export function windowOccurrence(w: MonitoringWindow | null, at: Date) {
  if (!w) return null;
  const t = at.getTime();
  return (
    windowIntervals(w, local(at).date).find(([s, e]) => s <= t && t < e) ?? null
  );
}

/** The next periods (Singapore time) when an item on `mic` is actually checked:
 * exchange sessions intersected with the window. Confirmations show this so the
 * owner sees the combined effect instead of two rules to combine mentally. */
export function upcomingChecks(
  w: MonitoringWindow | null,
  mic: string,
  sessionTypes: string[],
  from: Date,
  count = 3,
) {
  const tz = marketCalendar(mic)?.timezone;
  if (!tz) return [];
  const spans: [number, number][] = [];
  const today = local(from).date;
  for (let offset = -1; offset < 21 && spans.length <= count; offset++) {
    const date = shiftDate(today, offset);
    for (const s of sessionsFor(mic, date).sessions) {
      if (!sessionTypes.includes(s.type)) continue;
      const a = Math.max(zonedInstant(date, s.open, tz), from.getTime());
      const b = zonedInstant(date, s.close, tz);
      for (const [ws, we] of windowIntervals(w, date)) {
        const open = Math.max(a, ws);
        const close = Math.min(b, we);
        if (close <= open) continue;
        const last = spans.at(-1);
        // Adjacent pre/regular/post sessions read as one period.
        if (last && last[1] === open) last[1] = close;
        else spans.push([open, close]);
      }
    }
  }
  return spans
    .sort((x, y) => x[0] - y[0])
    .slice(0, count)
    .map(([a, b]) => formatSpan(a, b));
}
