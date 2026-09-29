import { randomUUID } from "node:crypto";
import { type Database, event } from "./db.js";
import {
  CalendarNotSentError,
  CalendarTools,
  GoogleAuthError,
  GoogleHttpError,
} from "./calendar.js";
import { validateDraft, calendarPreview } from "./calendar-draft.js";
import { ToolValidationError } from "./tool-errors.js";
type Decision = { status: string; url?: string; reason?: string };
// An approval is claimed only before it expires, its insert is sent only within
// ATTEMPT_WINDOW_MS of the claim, and the insert itself times out after 20s. Five
// minutes after expiry no attempt can still be in flight, so a missing
// deterministic event ID then means it was never created.
const ATTEMPT_WINDOW_MS = 60_000;
const UNRESOLVED = "payload->>'execution' IN ('creating','uncertain')";
const PAST_ATTEMPTS = "expires_at < now() - interval '5 minutes'";
/** The recorded outcome of an approved attempt, or null while unresolved. */
function recorded(payload: any): Decision | null {
  if (payload.execution === "created")
    return { status: "created", url: payload.result?.url };
  if (payload.execution === "failed")
    return { status: "failed", reason: payload.failure?.code };
  if (payload.execution === "deleted") return { status: "deleted" };
  return null;
}
/** A bounded error category for logs; never provider text. */
function cause(e: unknown) {
  return {
    cause:
      e instanceof GoogleHttpError
        ? "http"
        : e instanceof GoogleAuthError
          ? e.kind
          : (e as Error)?.name === "TimeoutError"
            ? "timeout"
            : "error",
    httpStatus: e instanceof GoogleHttpError ? e.status : undefined,
  };
}
export class CalendarActions {
  constructor(
    private db: Database,
    private calendar: Pick<CalendarTools, "create" | "findCreated">,
    private owner: string,
    private clock: () => number = () => performance.now(),
  ) {}
  async draft(user: string, run: string, input: unknown) {
    if (!this.owner || user !== this.owner)
      throw new Error("Calendar is not connected for this user");
    const draft = validateDraft(input);
    const unresolved = (
      await this.db.query(
        "SELECT * FROM approvals WHERE user_id=$1 AND operation='calendar_create' AND status='approved' AND payload->>'execution' IN ('creating','uncertain') ORDER BY created_at",
        [user],
      )
    ).rows;
    for (const previous of unresolved) {
      const settled = await this.settle(previous).catch(async (e) => {
        await event(this.db, user, previous.run_id, "calendar.check_failed", {
          id: previous.id,
          ...cause(e),
        });
        return null;
      });
      if (settled?.status === "failed" || settled?.status === "deleted")
        continue;
      throw new ToolValidationError(
        settled?.status === "created"
          ? "A previous approved Calendar event was found in Google Calendar and is now recorded as created. No new draft was saved; confirm with the owner before drafting another."
          : settled
            ? "A previous approved Calendar event has an uncertain outcome. No new draft was saved. It is checked again automatically from 20 minutes after it was drafted; ask the owner to try again then, or use its Telegram Check status button."
            : "A previous approved Calendar event has an uncertain outcome and checking Google Calendar for it failed. No new draft was saved. Use its Telegram Check status button or request operator inspection before trying again.",
      );
    }
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
  async decide(user: string, id: string, approve: boolean): Promise<Decision> {
    if (!this.owner || user !== this.owner)
      throw new Error("Calendar is not connected for this user");
    // Measured before the claim is sent: the claim commits after this instant and
    // before expiry, so however late its response arrives, no insert is sent
    // later than ATTEMPT_WINDOW_MS after expiry.
    const sendBy = this.clock() + ATTEMPT_WINDOW_MS;
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
      return recorded(previous.payload) ?? this.settle(previous);
    }
    await event(this.db, user, claimed.run_id, "calendar.approval_decided", {
      id,
      approved: approve,
    });
    if (!approve) return { status: "denied" };
    try {
      // create() validates the stored draft before sending, so a rejection there is also not sent.
      const result = await this.calendar.create(
        user,
        id,
        claimed.payload.draft,
        sendBy,
      );
      return await this.record(claimed, result);
    } catch (e) {
      if (e instanceof CalendarNotSentError) {
        // Nothing reached the Calendar API, so this is a definite non-creation, not an uncertain write.
        const reason = e.reason;
        const saved = await this.db.query(
          "UPDATE approvals SET payload=payload || $3::jsonb WHERE id=$1 AND user_id=$2 AND payload->>'execution'='creating' RETURNING id",
          [
            id,
            user,
            JSON.stringify({ execution: "failed", failure: { code: reason } }),
          ],
        );
        // Another process settled the row; report what was recorded.
        if (!saved.rows[0]) return this.current(claimed);
        await event(this.db, user, claimed.run_id, "calendar.not_sent", {
          id,
          reason,
        });
        return { status: "failed", reason };
      }
      const marked = await this.db.query(
        "UPDATE approvals SET payload=jsonb_set(payload,'{execution}','\"uncertain\"'::jsonb) WHERE id=$1 AND user_id=$2 AND payload->>'execution'='creating' RETURNING id",
        [id, user],
      );
      // A settlement already recorded a terminal outcome; never reopen it.
      if (!marked.rows[0]) return this.current(claimed);
      await event(this.db, user, claimed.run_id, "calendar.uncertain", {
        id,
        ...cause(e),
      });
      return { status: "uncertain" };
    }
  }
  /**
   * Read-only reconciliation of an approved attempt by its deterministic event
   * ID. Never replays a possibly completed POST. Absence counts as a definite
   * non-creation only once no attempt can still be in flight.
   */
  private async settle(approval: any): Promise<Decision> {
    const found = await this.calendar.findCreated(
      approval.user_id,
      approval.id,
    );
    // Created, then deleted by the owner in Google Calendar: settled, never recreated.
    if (found?.status === "cancelled")
      return this.conclude(approval, { execution: "deleted" }, "deleted", "");
    if (found) return this.record(approval, found);
    return this.conclude(
      approval,
      { execution: "failed", failure: { code: "not_found" } },
      "absent",
      `AND ${PAST_ATTEMPTS}`,
    );
  }
  private async conclude(
    approval: any,
    outcome: Record<string, unknown>,
    state: string,
    guard: string,
  ): Promise<Decision> {
    const saved = await this.db.query(
      `UPDATE approvals SET payload=payload || $3::jsonb WHERE id=$1 AND user_id=$2 AND ${UNRESOLVED} ${guard} RETURNING payload`,
      [approval.id, approval.user_id, JSON.stringify(outcome)],
    );
    if (saved.rows[0]) {
      await event(
        this.db,
        approval.user_id,
        approval.run_id,
        "calendar.reconciled",
        { id: approval.id, state },
      );
      return recorded(saved.rows[0].payload)!;
    }
    // Still inside the attempt window, or another check settled it first.
    return this.current(approval);
  }
  /** The approval's recorded outcome, or uncertain while it is unresolved. */
  private async current(approval: any): Promise<Decision> {
    const row = (
      await this.db.query(
        "SELECT payload FROM approvals WHERE id=$1 AND user_id=$2",
        [approval.id, approval.user_id],
      )
    ).rows[0];
    return (row && recorded(row.payload)) ?? { status: "uncertain" };
  }
  private async record(approval: any, result: any): Promise<Decision> {
    if (result.id !== approval.id.replaceAll("-", ""))
      throw new Error("Unexpected created event identity");
    const url =
      typeof result.htmlLink === "string" &&
      /^https:\/\/(calendar\.google\.com|www\.google\.com)\//.test(
        result.htmlLink,
      )
        ? result.htmlLink
        : undefined;
    const saved = await this.db.query(
      `WITH saved AS (
        UPDATE approvals SET payload=payload || $4::jsonb WHERE id=$1 AND user_id=$2 AND ${UNRESOLVED} RETURNING id
      ), receipt AS (
        INSERT INTO tool_receipts(id,user_id,run_id,task_id,operation,status,details)
        SELECT $1,$2,$3,(SELECT task_id FROM work_turns WHERE run_id=$3),'calendar_create','success',$5::jsonb FROM saved
        ON CONFLICT(id) DO NOTHING
      ) INSERT INTO events(user_id,run_id,type,data) SELECT $2,$3,'calendar.created',$5::jsonb FROM saved RETURNING id`,
      [
        approval.id,
        approval.user_id,
        approval.run_id,
        JSON.stringify({
          execution: "created",
          result: { id: result.id, url },
        }),
        JSON.stringify({ id: result.id, url, approvalId: approval.id }),
      ],
    );
    // Already recorded (a duplicate callback, or a settlement that won): report that.
    if (!saved.rows[0]) return this.current(approval);
    return { status: "created", url };
  }
}
