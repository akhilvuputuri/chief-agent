import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../db.js";
import { ToolValidationError } from "../tool-errors.js";
import type { CodingJob } from "./controller.js";
import { artifactHash, canonicalJson } from "./github.js";

/**
 * Confirmation authority is a delivered owner message, never a model tool argument.
 * An approval covers what the owner read: the request (objective and context, with every
 * follow-up sent before Start). Who carries it out (models, limits, image) and the base commit
 * are not part of it; merge rules are enforced at the merge gate and the Merge card. The plan
 * field is always empty since the planner was removed (journal 191); it stays in the hash so
 * the scope of a job stays one formula.
 */
export function requirementScope(job: CodingJob) {
  return createHash("sha256")
    .update(
      canonicalJson({
        id: job.id,
        objective: job.objective,
        context: job.context,
        plan: job.checkpoint.plan,
      }),
    )
    .digest("hex");
}
/** The Start card for the job's current request and revision. */
export function startCard(job: CodingJob) {
  return {
    summary: "Ready to start. Tap Start, or send more to add to the request.",
    requirements: {
      revision: job.revision,
      scope: requirementScope(job),
      artifact: artifactHash(job.checkpoint),
      plan: job.checkpoint.plan,
    },
  };
}
export class CodingRequirements {
  constructor(
    private db: Database,
    private allowed: (user: string) => boolean,
    private clock: () => Date,
  ) {}
  async approved(job: CodingJob) {
    if (!this.allowed(job.user_id)) return false;
    return !!(
      await this.db.query(
        "SELECT 1 FROM coding_events WHERE job_id=$1 AND payload->>'decision'='approved' AND payload->>'approvedScope'=$2 LIMIT 1",
        [job.id, requirementScope(job)],
      )
    ).rows.length;
  }
  /** Sends a fresh Start card for a job waiting for Start, for example after one expired. */
  async request(job: CodingJob, key: string) {
    if (
      !this.allowed(job.user_id) ||
      job.state !== "plan_ready" ||
      job.mode !== "plan"
    )
      throw new ToolValidationError("This job is not waiting for Start");
    const payload = startCard(job);
    const result = await this.db.query(
      "INSERT INTO coding_events(id,job_id,event_key,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(job_id,event_key) DO NOTHING RETURNING id",
      [
        randomUUID(),
        job.id,
        `requirements:${job.revision}:${key}`,
        JSON.stringify(payload),
      ],
    );
    const id =
      result.rows[0]?.id ??
      (
        await this.db.query(
          "SELECT id FROM coding_events WHERE job_id=$1 AND event_key=$2",
          [job.id, `requirements:${job.revision}:${key}`],
        )
      ).rows[0].id;
    return {
      approvalRequired: true,
      approvalId: id,
      jobId: job.id,
      revision: job.revision,
      instruction:
        "A new Start card is on its way. The owner starts the job with its Start button or by replying yes directly to that message. Model calls cannot start a job.",
    };
  }
  async confirm(
    user: string,
    id: string,
    approve: boolean,
    chat: string,
    messageId: number,
  ) {
    if (
      !this.allowed(user) ||
      chat !== user ||
      !Number.isSafeInteger(messageId) ||
      messageId <= 0
    )
      throw new Error("Requirement confirmation unavailable");
    const event = (
      await this.db.query(
        "SELECT e.payload,e.delivery,j.* FROM coding_events e JOIN coding_jobs j ON j.id=e.job_id WHERE e.id=$1 AND j.user_id=$2",
        [id, user],
      )
    ).rows[0];
    if (
      !event ||
      event.delivery !== "sent" ||
      event.payload.telegramMessageId !== messageId ||
      !event.payload.requirements
    )
      throw new Error("Requirement confirmation unavailable");
    if (requirementScope(event) !== event.payload.requirements.scope)
      throw new Error("Requirements changed");
    if (event.payload.decision) {
      if ((event.payload.decision === "approved") !== approve)
        throw new Error("Requirements were already decided");
      return {
        status: event.payload.decision === "approved" ? "approved" : "revise",
        jobId: event.id,
        duplicate: true,
      };
    }
    const job = event as CodingJob;
    const requirement = event.payload.requirements;
    if (
      job.state !== "plan_ready" ||
      job.mode !== "plan" ||
      job.revision !== requirement.revision ||
      job.checkpoint.plan !== requirement.plan ||
      requirementScope(job) !== requirement.scope ||
      requirement.artifact !== artifactHash(job.checkpoint) ||
      !Number.isFinite(new Date(event.payload.confirmUntil).getTime()) ||
      new Date(event.payload.confirmUntil).getTime() <= this.clock().getTime()
    )
      throw new Error(
        "The request changed or this Start card expired; ask Chief for a fresh one",
      );
    const result = await this.db.query(
      `WITH changed AS (
      UPDATE coding_jobs SET mode=CASE WHEN $3 THEN 'implement' ELSE mode END,
        revision=revision+1,
        state=CASE WHEN $3 THEN 'queued' ELSE state END,stage=CASE WHEN $3 THEN 'queued' ELSE stage END,
        summary=CASE WHEN $3 THEN 'Started by the owner; implementation queued' ELSE 'Not started; tell Chief what to change' END,
        result=CASE WHEN $3 THEN NULL ELSE result END,
        attempt_id=CASE WHEN $3 THEN NULL ELSE attempt_id END,sandbox_id=CASE WHEN $3 THEN NULL ELSE sandbox_id END,
        heartbeat_at=CASE WHEN $3 THEN NULL ELSE heartbeat_at END,attempt_deadline=CASE WHEN $3 THEN NULL ELSE attempt_deadline END,
        used_models=CASE WHEN $3 THEN 0 ELSE used_models END,model_busy=false,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND revision=$4 AND state='plan_ready' AND mode='plan' AND cleanup IN ('none','complete')
        AND (lease IS NULL OR lease_until<now()) AND checkpoint=$5::jsonb AND objective=$10 AND context=$11 AND base_sha=$12 AND settings=$13::jsonb
        AND EXISTS(SELECT 1 FROM coding_events WHERE id=$6 AND job_id=$1 AND delivery='sent' AND NOT(payload ? 'decision') AND payload->>'telegramMessageId'=$7 AND (payload->>'confirmUntil')::timestamptz>$8)
      RETURNING id,revision
    ), decided AS (
      UPDATE coding_events SET payload=payload || jsonb_build_object('decision',CASE WHEN $3 THEN 'approved' ELSE 'revise' END,'approvedScope',$9::text)
      WHERE id=$6 AND job_id IN (SELECT id FROM changed) RETURNING job_id
    ), recorded AS (
      INSERT INTO coding_revisions(job_id,revision,request_key,message,mode)
      SELECT id,revision,$6::text,CASE WHEN $3 THEN 'Owner started the exact delivered request' ELSE 'Owner asked for changes before Start' END,CASE WHEN $3 THEN 'implement' ELSE 'plan' END FROM changed
      RETURNING job_id
    ) SELECT job_id FROM decided`,
      [
        job.id,
        user,
        approve,
        job.revision,
        JSON.stringify(job.checkpoint),
        id,
        String(messageId),
        this.clock(),
        requirementScope(job),
        job.objective,
        job.context,
        job.base_sha,
        JSON.stringify(job.settings),
      ],
    );
    if (!result.rows.length)
      throw new Error(
        "Requirements changed or cleanup is pending; inspect status",
      );
    return {
      status: approve ? "approved" : "revise",
      jobId: job.id,
      duplicate: false,
    };
  }
  async replyId(user: string, messageId: number) {
    return (
      await this.db.query(
        "SELECT e.id FROM coding_events e JOIN coding_jobs j ON j.id=e.job_id WHERE j.user_id=$1 AND e.payload->>'telegramMessageId'=$2 AND e.payload ? 'requirements' ORDER BY e.created_at DESC LIMIT 1",
        [user, String(messageId)],
      )
    ).rows[0]?.id as string | undefined;
  }
  async confirmReply(
    user: string,
    chat: string,
    messageId: number,
    approve: boolean,
  ) {
    const event = (
      await this.db.query(
        "SELECT e.id FROM coding_events e JOIN coding_jobs j ON j.id=e.job_id WHERE j.user_id=$1 AND e.payload->>'telegramMessageId'=$2 AND e.payload ? 'requirements' ORDER BY e.created_at DESC LIMIT 1",
        [user, String(messageId)],
      )
    ).rows[0];
    return event
      ? this.confirm(user, event.id, approve, chat, messageId)
      : undefined;
  }
}
