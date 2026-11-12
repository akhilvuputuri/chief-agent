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
  /** The owner's Start: a tap on the delivered card or a yes reply to it. There is no decline. */
  async confirm(user: string, id: string, chat: string, messageId: number) {
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
      if (event.payload.decision !== "approved")
        throw new Error("Requirements were already decided");
      return { status: "approved", jobId: event.id, duplicate: true };
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
      UPDATE coding_jobs SET mode='implement',revision=revision+1,state='queued',stage='queued',
        summary='Started by the owner; implementation queued',result=NULL,attempt_id=NULL,sandbox_id=NULL,
        heartbeat_at=NULL,attempt_deadline=NULL,used_models=0,model_busy=false,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND revision=$3 AND state='plan_ready' AND mode='plan' AND cleanup IN ('none','complete')
        AND (lease IS NULL OR lease_until<now()) AND checkpoint=$4::jsonb AND objective=$9 AND context=$10 AND base_sha=$11 AND settings=$12::jsonb
        AND EXISTS(SELECT 1 FROM coding_events WHERE id=$5 AND job_id=$1 AND delivery='sent' AND NOT(payload ? 'decision') AND payload->>'telegramMessageId'=$6 AND (payload->>'confirmUntil')::timestamptz>$7)
      RETURNING id,revision
    ), decided AS (
      UPDATE coding_events SET payload=payload || jsonb_build_object('decision','approved','approvedScope',$8::text)
      WHERE id=$5 AND job_id IN (SELECT id FROM changed) RETURNING job_id
    ), recorded AS (
      INSERT INTO coding_revisions(job_id,revision,request_key,message,mode)
      SELECT id,revision,$5::text,'Owner started the exact delivered request','implement' FROM changed
      RETURNING job_id
    ) SELECT job_id FROM decided`,
      [
        job.id,
        user,
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
    return { status: "approved", jobId: job.id, duplicate: false };
  }
  async replyId(user: string, messageId: number) {
    return (
      await this.db.query(
        "SELECT e.id FROM coding_events e JOIN coding_jobs j ON j.id=e.job_id WHERE j.user_id=$1 AND e.payload->>'telegramMessageId'=$2 AND e.payload ? 'requirements' ORDER BY e.created_at DESC LIMIT 1",
        [user, String(messageId)],
      )
    ).rows[0]?.id as string | undefined;
  }
  async confirmReply(user: string, chat: string, messageId: number) {
    const event = (
      await this.db.query(
        "SELECT e.id FROM coding_events e JOIN coding_jobs j ON j.id=e.job_id WHERE j.user_id=$1 AND e.payload->>'telegramMessageId'=$2 AND e.payload ? 'requirements' ORDER BY e.created_at DESC LIMIT 1",
        [user, String(messageId)],
      )
    ).rows[0];
    return event ? this.confirm(user, event.id, chat, messageId) : undefined;
  }
}
