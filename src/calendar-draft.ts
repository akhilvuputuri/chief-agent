import { z } from "zod";
export const calendarDraft = z
  .object({
    title: z.string().trim().min(1).max(200),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    description: z.string().max(1500).optional(),
    location: z.string().max(300).optional(),
  })
  .strict();
export type CalendarDraft = z.infer<typeof calendarDraft>;
export function validateDraft(input: unknown): CalendarDraft {
  const draft = calendarDraft.parse(input);
  const duration = Date.parse(draft.end) - Date.parse(draft.start);
  if (duration <= 0 || duration > 7 * 86400000)
    throw new Error(
      "Event must end after it starts and last at most seven days",
    );
  return draft;
}
export function calendarPreview(draft: CalendarDraft) {
  const date = (s: string) =>
    new Date(s).toLocaleString("en-SG", {
      timeZone: "Asia/Singapore",
      dateStyle: "full",
      timeStyle: "short",
    });
  return `Create calendar event?\n\n${draft.title}\nStart: ${date(draft.start)}\nEnd: ${date(draft.end)}\nTimezone: Asia/Singapore\nCalendar: primary\n${draft.location ? `Location: ${draft.location}\n` : ""}${draft.description ? `Details: ${draft.description}\n` : ""}\nNo guests or invitations. Approve these exact details within 15 minutes.`;
}
