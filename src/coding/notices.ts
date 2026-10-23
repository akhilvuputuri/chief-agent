import { formatTelegram } from "../telegram-format.js";

/**
 * Owner-facing shape of coding notices (journal 115). Progress-only notices are folded into
 * one status message per stretch of work and edited in place; questions, approval cards,
 * failures and outcomes stay separate messages so they notify the owner. Progress that
 * would start a new message waits out the owner's quiet hours.
 */

/** Telegram refused an edit because the status message is gone or can no longer be edited. */
export class StatusMessageGone extends Error {
  constructor() {
    super("Coding status message can no longer be edited");
  }
}

/** Minutes after midnight in Asia/Singapore; the window may wrap past midnight. */
export type QuietHours = { start: number; end: number };

const clock = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** "23:00-08:00" in Asia/Singapore time; empty or a zero-length window turns quiet hours off. */
export function parseQuietHours(value: string): QuietHours | undefined {
  if (!value) return undefined;
  const m = clock.exec(value);
  if (!m) throw new Error("Quiet hours must look like 23:00-08:00");
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return start === end ? undefined : { start, end };
}

export const quietHoursPattern =
  /^$|^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

const singapore = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Singapore",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function singaporeClock(at: Date) {
  return singapore.format(at);
}

export function inQuietHours(now: Date, quiet: QuietHours | undefined) {
  if (!quiet) return false;
  const [h, m] = singaporeClock(now).split(":").map(Number) as [number, number];
  const n = h * 60 + m;
  return quiet.start < quiet.end
    ? n >= quiet.start && n < quiet.end
    : n >= quiet.start || n < quiet.end;
}

/** One progress line in a status message. `at` is the notice's creation time (ISO). */
export type StatusLine = { at: string; text: string };
/** Durable record of a job's current status message (a suppressed `status-message` event). */
export type StatusAnchor = {
  messageId?: number;
  /** False once a separate notice for the job was sent: the next progress starts a new message. */
  current: boolean;
  lines: StatusLine[];
  total: number;
};

/** The most recent lines a status message shows; older ones are counted, not repeated. */
export const STATUS_LINES = 10;
// Ten bounded lines keep the edited text inside one Telegram message.
const LINE_CHARACTERS = 200;

/** Progress text for one folded notice; the event's own words, bounded. */
export function statusLine(
  eventKey: string,
  payload: { summary?: unknown; url?: unknown },
): string {
  const summary = typeof payload.summary === "string" ? payload.summary : "";
  const text = eventKey.endsWith(":pr")
    ? `PR updated: ${String(payload.url ?? "")}`
    : eventKey.endsWith(":finished")
      ? `Independent review approved; publishing. Coder's own summary: ${summary}`
      : summary || "Progress update";
  return Array.from(text.replace(/\s+/g, " ").trim())
    .slice(0, LINE_CHARACTERS)
    .join("");
}

export function renderStatus(
  jobId: string,
  lines: StatusLine[],
  total: number,
) {
  const shown = lines.slice(-STATUS_LINES);
  const hidden = Math.max(0, total - shown.length);
  return [
    `**Coding job ${jobId}: progress**`,
    ...(hidden ? [`(${hidden} earlier update${hidden === 1 ? "" : "s"})`] : []),
    ...shown.map((l) => `• ${singaporeClock(new Date(l.at))} ${l.text}`),
    "",
    "This message updates in place. Questions, approvals and results arrive as separate messages.",
  ].join("\n");
}

/**
 * Bounds a status message to one Telegram message: Telegram splits by UTF-16 length, so
 * emoji-heavy lines can outgrow the line count bound. The oldest lines are dropped first.
 */
export function fitStatus(
  jobId: string,
  candidates: StatusLine[],
  total: number,
) {
  let lines = candidates.slice(-STATUS_LINES);
  let text = renderStatus(jobId, lines, total);
  while (lines.length > 1 && formatTelegram(text).length !== 1) {
    lines = lines.slice(1);
    text = renderStatus(jobId, lines, total);
  }
  return { lines, text };
}
