import type { Database } from "../db.js";

export type MergeDecision = {
  status: "merge_approved" | "merge_declined";
  duplicate: boolean;
  jobId: string;
};

/** Records the owner's answer to one delivered merge card for one exact PR head. */
export class CodingMergeApprovals {
  constructor(
    private db: Database,
    private allowed: (user: string) => boolean,
    private clock: () => Date,
  ) {}
  async confirm(
    user: string,
    id: string,
    approve: boolean,
    chat: string,
    messageId: number,
  ): Promise<MergeDecision> {
    if (
      !this.allowed(user) ||
      chat !== user ||
      !Number.isSafeInteger(messageId) ||
      messageId <= 0
    )
      throw new Error("Merge confirmation unavailable");
    const event = (
      await this.db.query(
        "SELECT e.payload,e.delivery,j.id AS job_id,j.state,j.stage,j.revision,j.head_sha FROM coding_events e JOIN coding_jobs j ON j.id=e.job_id WHERE e.id=$1 AND j.user_id=$2",
        [id, user],
      )
    ).rows[0];
    const merge = event?.payload?.merge;
    if (
      !event ||
      event.delivery !== "sent" ||
      event.payload.telegramMessageId !== messageId ||
      typeof merge?.head !== "string"
    )
      throw new Error("Merge confirmation unavailable");
    if (event.payload.decision) {
      if ((event.payload.decision === "merge_approved") !== approve)
        throw new Error("Merge was already decided");
      return {
        status: event.payload.decision,
        duplicate: true,
        jobId: event.job_id,
      };
    }
    const status = approve ? "merge_approved" : "merge_declined";
    const result = await this.db.query(
      `WITH changed AS (
        UPDATE coding_jobs SET stage=$3,
          summary=CASE WHEN $4 THEN 'Owner approved merge; re-verifying the exact head before merging' ELSE 'Owner declined merge; the PR stays open' END,
          updated_at=now()
        WHERE id=$1 AND user_id=$2 AND state='pr_ready' AND stage='awaiting_merge_approval'
          AND revision=$5 AND head_sha=$6 AND (lease IS NULL OR lease_until<now())
          AND EXISTS(SELECT 1 FROM coding_events WHERE id=$7 AND job_id=$1 AND delivery='sent' AND NOT(payload ? 'decision')
            AND payload->>'telegramMessageId'=$8 AND (payload->>'confirmUntil')::timestamptz>$9)
        RETURNING id
      ) UPDATE coding_events SET payload=payload || jsonb_build_object('decision',$3::text)
        WHERE id=$7 AND job_id IN (SELECT id FROM changed) RETURNING job_id`,
      [
        event.job_id,
        user,
        status,
        approve,
        merge.revision,
        merge.head,
        id,
        String(messageId),
        this.clock(),
      ],
    );
    if (!result.rows.length)
      throw new Error(
        "Merge card expired or the PR changed; ask Chief for the current coding status",
      );
    return { status, duplicate: false, jobId: event.job_id };
  }
}
