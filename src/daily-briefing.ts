import type { Database } from "./db.js";
import type { Delivery } from "./answer.js";
import { unreadDigest } from "./gmail.js";

type BriefingJob = {
  id: string;
  user_id: string;
  content: string;
  include_calendar: boolean;
  include_email: boolean;
};
type Deps = {
  db: Database;
  calendar: { list(user: string, from: string, to: string): Promise<any> };
  gmail: {
    call(
      user: string,
      operation: "gmail_search",
      query: string,
      account: undefined,
      key: string,
    ): Promise<unknown>;
  };
  now?: () => Date;
};
const sgt = { timeZone: "Asia/Singapore" } as const;

/**
 * A briefing is built when it is sent: it leads with the schedule's own words and lists the
 * owner's live open to-dos inline, so "review my to-do list" arrives with the list itself.
 * Before 18 October it sent a generic "Daily brief" with the tasks behind the Sections tab
 * and dropped the schedule's text. Calendar and email stay optional sections.
 */
export async function buildBriefing(
  j: BriefingJob,
  deps: Deps,
): Promise<Delivery> {
  const now = deps.now?.() ?? new Date();
  const sections: NonNullable<Delivery["sections"]> = [];
  const tasks = (
    await deps.db.query(
      `SELECT title,due_at FROM daily_items WHERE user_id=$1 AND kind='task' AND status='open' ORDER BY due_at NULLS LAST,created_at LIMIT 10`,
      [j.user_id],
    )
  ).rows;
  const taskList = tasks.length
    ? tasks
        .map(
          (t) =>
            `• ${t.title}${t.due_at ? " — due " + new Date(t.due_at).toLocaleString("en-SG", sgt) : ""}`,
        )
        .join("\n")
    : "No open tasks.";
  sections.push({ title: "Open tasks (up to 10)", body: taskList });
  if (j.include_calendar) {
    try {
      const r = await deps.calendar.list(
        j.user_id,
        now.toISOString(),
        new Date(now.getTime() + 86400000).toISOString(),
      );
      sections.push({
        title: "Calendar — next 24 hours (up to 8)",
        body: r.events.length
          ? r.events
              .slice(0, 8)
              .map(
                (e: any) =>
                  `• ${e.title} — ${e.start?.dateTime ?? e.start?.date}`,
              )
              .join("\n") +
            (r.truncated || r.events.length > 8
              ? "\nMore events available in Calendar."
              : "")
          : "No events.",
      });
    } catch {
      sections.push({
        title: "Calendar",
        body: "Calendar unavailable; reconnect or enable Calendar API.",
      });
    }
  }
  if (j.include_email) {
    try {
      const r: any = await deps.gmail.call(
        j.user_id,
        "gmail_search",
        "in:inbox is:unread newer_than:1d",
        undefined,
        `briefing:${j.id}:${now.getTime()}`,
      );
      const lines = unreadDigest(r);
      sections.push({
        title: "Unread inbox — past 24 hours (up to 5)",
        body: lines.join("\n") || "No matching messages.",
      });
    } catch {
      sections.push({
        title: "Gmail",
        body: "Gmail unavailable; existing read-only authorization may need renewal.",
      });
    }
  }
  // Cut by grapheme (what the owner sees as one character) so no emoji, including joined
  // family or flag sequences, is ever split, and mark the cut.
  const graphemes = Array.from(
    new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
      j.content.trim(),
    ),
    (g) => g.segment,
  );
  const lead =
    graphemes.length > 300
      ? graphemes.slice(0, 299).join("") + "…"
      : graphemes.join("");
  const others = sections.slice(1).map((s) => s.title);
  return {
    reply: [
      `${lead} — ${now.toLocaleDateString("en-SG", sgt)}`,
      `Open tasks:\n${taskList}`,
      others.length ? `Open Sections for ${others.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    sections,
  };
}
