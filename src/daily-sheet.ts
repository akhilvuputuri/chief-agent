import type { Database } from "./db.js";
import { googleToken, googleJson, type GoogleConfig } from "./calendar.js";
import { sheetRequests } from "./sheets.js";
import { SerialQueue } from "./security.js";
export class DailySheet {
  private queue = new SerialQueue();
  constructor(
    private db: Database,
    private c: GoogleConfig & { spreadsheetId: string },
  ) {}
  async sync(user: string) {
    if (
      !this.c.owner ||
      user !== this.c.owner ||
      !/^[a-zA-Z0-9_-]+$/.test(this.c.spreadsheetId)
    )
      throw new Error("Daily Sheet is not connected");
    return this.queue.run(user, async () => {
      const snapshot = (
        await this.db.query(
          `SELECT (SELECT COALESCE(jsonb_agg(i ORDER BY updated_at DESC),'[]') FROM daily_items i WHERE user_id=$1) items,(SELECT COALESCE(jsonb_agg(s ORDER BY next_run),'[]') FROM daily_schedules s WHERE user_id=$1) schedules`,
          [user],
        )
      ).rows[0];
      const items = (kind: string) => [
        ["ID", "Title", "Details", "Status", "Due (UTC)", "Updated (UTC)"],
        ...snapshot.items
          .filter((x: any) => x.kind === kind)
          .map((x: any) => [
            x.id,
            x.title,
            x.content,
            x.status,
            x.due_at,
            x.updated_at,
          ]),
      ];
      const tables = [
        items("task"),
        items("note"),
        [
          [
            "ID",
            "Kind",
            "Reminder / label",
            "Schedule (Singapore)",
            "Next run (UTC)",
            "Status",
            "Email included",
            "Calendar included",
            "Last delivered (UTC)",
            "Last error",
          ],
          ...snapshot.schedules.map((x: any) => [
            x.id,
            x.kind,
            x.content,
            x.schedule,
            x.next_run,
            x.status,
            x.include_email,
            x.include_calendar,
            x.last_delivered,
            x.last_error,
          ]),
        ],
      ];
      if (tables.some((t) => t.length > 5000))
        throw new Error("Daily Sheet limit exceeded");
      const token = await googleToken(this.c);
      await googleJson(
        await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${this.c.spreadsheetId}:batchUpdate`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ requests: sheetRequests(tables) }),
            redirect: "error",
            signal: AbortSignal.timeout(25000),
          },
        ),
      );
      return {
        synced: true,
        url: `https://docs.google.com/spreadsheets/d/${this.c.spreadsheetId}/edit`,
        counts: tables.map((t) => t.length - 1),
        note: "One-way viewing mirror; request edits in Telegram.",
      };
    });
  }
}
