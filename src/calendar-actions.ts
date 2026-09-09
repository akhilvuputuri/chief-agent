import { randomUUID } from "node:crypto";
import { type Database, event } from "./db.js";
import { CalendarTools } from "./calendar.js";
import { validateDraft, calendarPreview } from "./calendar-draft.js";
export class CalendarActions {
  constructor(
    private db: Database,
    private calendar: Pick<CalendarTools, "create" | "findCreated">,
    private owner: string,
  ) {}
  async draft(user: string, run: string, input: unknown) {
    if (!this.owner || user !== this.owner)
      throw new Error("Calendar is not connected for this user");
    const draft = validateDraft(input);
    const uncertain = (
      await this.db.query(
        "SELECT id FROM approvals WHERE user_id=$1 AND operation='calendar_create' AND status='approved' AND payload->>'execution' IN ('creating','uncertain') LIMIT 1",
        [user],
      )
    ).rows[0];
    if (uncertain)
      throw new Error(
        "A calendar write has an uncertain outcome. Use its Telegram Check status button or request operator inspection before drafting another event.",
      );
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO approvals(id,user_id,run_id,operation,payload) VALUES($1,$2,$3,'calendar_create',$4::jsonb)",
      [id, user, run, JSON.stringify({ draft, execution: "not_started" })],
    );
    return {
      approvalId: id,
      status: "awaiting_approval",
      preview: calendarPreview(draft),
      note: "Only saved a draft. The user must approve the exact event using the Telegram button. No event exists yet.",
    };
  }
  async decide(user: string, id: string, approve: boolean) {
    if (!this.owner || user !== this.owner)
      throw new Error("Calendar is not connected for this user");
    const claimed = (
      await this.db.query(
        "UPDATE approvals SET status=$3,payload=jsonb_set(payload,'{execution}',$4::jsonb) WHERE id=$1 AND user_id=$2 AND operation='calendar_create' AND status='pending' AND expires_at>now() RETURNING *",
        [
          id,
          user,
          approve ? "approved" : "denied",
          JSON.stringify(approve ? "creating" : "not_started"),
        ],
      )
    ).rows[0];
    if (!claimed) {
      const previous = (
        await this.db.query(
          "SELECT * FROM approvals WHERE id=$1 AND user_id=$2 AND operation='calendar_create'",
          [id, user],
        )
      ).rows[0];
      if (!previous || previous.status !== "approved" || !approve)
        throw new Error("Approval unavailable, expired, or already used");
      if (previous.payload.execution === "created")
        return { status: "created", url: previous.payload.result?.url };
      // Read-only reconciliation. Never replay a possibly completed POST.
      const found = await this.calendar.findCreated(user, id);
      if (!found) return { status: "uncertain" };
      return this.record(previous, found);
    }
    await event(this.db, user, claimed.run_id, "calendar.approval_decided", {
      id,
      approved: approve,
    });
    if (!approve) return { status: "denied" };
    try {
      const result = await this.calendar.create(
        user,
        id,
        validateDraft(claimed.payload.draft),
      );
      return await this.record(claimed, result);
    } catch {
      await this.db.query(
        "UPDATE approvals SET payload=jsonb_set(payload,'{execution}','\"uncertain\"'::jsonb) WHERE id=$1 AND user_id=$2 AND payload->>'execution'<>'created'",
        [id, user],
      );
      return { status: "uncertain" };
    }
  }
  private async record(approval: any, result: any) {
    if (result.id !== approval.id.replaceAll("-", ""))
      throw new Error("Unexpected created event identity");
    const url =
      typeof result.htmlLink === "string" &&
      /^https:\/\/(calendar\.google\.com|www\.google\.com)\//.test(
        result.htmlLink,
      )
        ? result.htmlLink
        : undefined;
    await this.db.query(
      "UPDATE approvals SET payload=payload || $3::jsonb WHERE id=$1 AND user_id=$2",
      [
        approval.id,
        approval.user_id,
        JSON.stringify({
          execution: "created",
          result: { id: result.id, url },
        }),
      ],
    );
    await this.db.query(
      "INSERT INTO tool_receipts(id,user_id,run_id,task_id,operation,status,details) VALUES($1,$2,$3,(SELECT task_id FROM work_turns WHERE run_id=$3),'calendar_create','success',$4::jsonb) ON CONFLICT(id) DO NOTHING",
      [
        approval.id,
        approval.user_id,
        approval.run_id,
        JSON.stringify({ id: result.id, url, approvalId: approval.id }),
      ],
    );
    await event(
      this.db,
      approval.user_id,
      approval.run_id,
      "calendar.created",
      { approvalId: approval.id, eventId: result.id },
    );
    return { status: "created", url };
  }
}
