import { z } from "zod";
import { ToolValidationError } from "./tool-errors.js";
// A YYYY-MM-DD date (all-day) or an ISO date-time with a UTC offset (timed);
// validateDraft checks which one each event needs.
const moment = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/,
  );
const dateTime = z.string().datetime({ offset: true });
const date = z.string().date();
export const calendarDraft = z
  .object({
    title: z.string().trim().min(1).max(200),
    start: moment,
    end: moment,
    allDay: z.boolean().optional(),
    description: z.string().max(1500).optional(),
    location: z.string().max(300).optional(),
  })
  .strict();
export type CalendarDraft = z.infer<typeof calendarDraft>;
// Every rejection here happens before anything is saved, so it is a definite non-mutation.
export function validateDraft(input: unknown): CalendarDraft {
  const draft = calendarDraft.parse(input);
  if (draft.allDay) {
    if (
      !date.safeParse(draft.start).success ||
      !date.safeParse(draft.end).success
    )
      throw new ToolValidationError(
        "An all-day event takes start and end as YYYY-MM-DD dates; end is its last day",
      );
    if (draft.end < draft.start)
      throw new ToolValidationError(
        "An all-day event's last day must be on or after its first day",
      );
    return draft;
  }
  if (
    !dateTime.safeParse(draft.start).success ||
    !dateTime.safeParse(draft.end).success
  )
    throw new ToolValidationError(
      "A timed event takes start and end with a UTC offset; set allDay for a date-only event",
    );
  if (Date.parse(draft.end) <= Date.parse(draft.start))
    throw new ToolValidationError("Event must end after it starts");
  return draft;
}
/** The exclusive end date Google Calendar expects for an all-day event's inclusive last day. */
export function dayAfter(day: string) {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
export function calendarPreview(draft: CalendarDraft) {
  const when = draft.allDay
    ? (() => {
        const day = (s: string) =>
          new Date(`${s}T00:00:00Z`).toLocaleDateString("en-SG", {
            timeZone: "UTC",
            dateStyle: "full",
          });
        const days =
          (Date.parse(draft.end) - Date.parse(draft.start)) / 86400000 + 1;
        return `All day, ${days} day${days === 1 ? "" : "s"}\nFirst day: ${day(draft.start)}\nLast day: ${day(draft.end)}`;
      })()
    : (() => {
        const date = (s: string) =>
          new Date(s).toLocaleString("en-SG", {
            timeZone: "Asia/Singapore",
            dateStyle: "full",
            timeStyle: "short",
          });
        return `Start: ${date(draft.start)}\nEnd: ${date(draft.end)}`;
      })();
  return `Create calendar event?\n\n${draft.title}\n${when}\nTimezone: Asia/Singapore\nCalendar: primary\n${draft.location ? `Location: ${draft.location}\n` : ""}${draft.description ? `Details: ${draft.description}\n` : ""}\nNo guests or invitations. Approve these exact details within 15 minutes.`;
}
