import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Database } from "../db.js";
import type { ModelAdapter, ModelMessage, ToolDefinition } from "../model.js";
import {
  codingAction,
  checkpoint,
  outcome,
  workerEvent,
  assertCodingBrief,
  type CodingAction,
  type CodingSettings,
  type Outcome,
} from "./schema.js";
import {
  artifactHash,
  canonicalJson,
  validateFiles,
  type RepositoryPublisher,
} from "./github.js";
import type { SandboxProvider } from "./provider.js";
import { scrubTrace } from "../trace-scrub.js";
import { seal, open } from "../secret-box.js";

const active = ["provisioning", "running"];
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalJson(v)).digest("hex");
export type CodingJob = {
  id: string;
  user_id: string;
  revision: number;
  state: string;
  stage: string;
  base_sha: string;
  settings: CodingSettings;
  objective: string;
  context: string;
  mode: "plan" | "implement";
  checkpoint: ReturnType<typeof checkpoint.parse>;
  attempt_id: string;
  sandbox_id?: string;
  cleanup: string;
  result: Outcome;
  lease: string;
  attempt_deadline: Date;
  heartbeat_at: Date;
  used_models: number;
};

export class CodingController {
  private ticking = false;
  private delivering = false;
  private inFlightModels = new Map<
    string,
    { jobId: string; controller: AbortController }
  >();
  private abortModels(jobId: string) {
    for (const entry of this.inFlightModels.values())
      if (entry.jobId === jobId) entry.controller.abort();
  }
  constructor(
    readonly db: Database,
    readonly settings: CodingSettings,
    private provider: SandboxProvider,
    private publisher: RepositoryPublisher,
    private authKey: string,
    readonly origin: string,
    private allowed: (user: string) => boolean,
    private models: (model: string) => ModelAdapter,
    private clock: () => Date = () => new Date(),
  ) {
    if (!/^[a-f0-9]{64}$/i.test(authKey))
      throw new Error(
        "Coding authentication key must be 64 hexadecimal characters",
      );
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.origin !== origin ||
      url.username ||
      url.password
    )
      throw new Error("Coding origin must be an HTTPS origin");
  }
  token(jobId: string, attemptId: string) {
    return createHmac("sha256", Buffer.from(this.authKey, "hex"))
      .update(`${jobId}:${attemptId}`)
      .digest("hex");
  }
  private resultKey() {
    return createHmac("sha256", Buffer.from(this.authKey, "hex"))
      .update("coding:model-results:v1")
      .digest();
  }
  private resultScope(job: CodingJob, callId: string) {
    return `${job.user_id}:${job.id}:${job.attempt_id}:${callId}`;
  }
  private async foreground(user: string, run: string) {
    if (!this.allowed(user)) throw new Error("Coding owner unavailable");
    if (
      !(
        await this.db.query(
          "SELECT 1 FROM work_turns WHERE user_id=$1 AND run_id=$2 AND NOT background",
          [user, run],
        )
      ).rows.length
    )
      throw new Error(
        "Coding changes require an authenticated foreground owner request",
      );
  }
  async status(user: string, id?: string) {
    if (!this.allowed(user)) throw new Error("Coding owner unavailable");
    const rows = (
      await this.db.query(
        `SELECT id,revision,objective,mode,state,stage,summary,question,base_sha,pr_url,head_sha,cleanup,publication_started,used_models,updated_at FROM coding_jobs WHERE user_id=$1 ${id ? "AND id=$2" : ""} ORDER BY created_at DESC LIMIT 20`,
        id ? [user, id] : [user],
      )
    ).rows;
    if (id && !rows.length) throw new Error("Coding job unavailable");
    if (!id) return rows;
    const job = rows[0];
    const stored = (
      await this.db.query(
        "SELECT checkpoint FROM coding_jobs WHERE user_id=$1 AND id=$2",
        [user, id],
      )
    ).rows[0];
    return { ...job, plan: stored.checkpoint.plan };
  }
  async call(user: string, run: string, raw: CodingAction) {
    const a = codingAction.parse(raw);
    if (a.operation === "coding_status") return this.status(user, a.id);
    await this.foreground(user, run);
    if (a.operation === "coding_start") {
      assertCodingBrief(a.objective, a.context);
      if (!this.settings.image)
        throw new Error("Coding runtime image is not configured");
      const fingerprint = hash({
        objective: a.objective,
        context: a.context,
        mode: a.mode,
      });
      const prior = (
        await this.db.query(
          "SELECT id,request_hash FROM coding_jobs WHERE user_id=$1 AND request_key=$2",
          [user, a.requestKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== fingerprint)
          throw new Error(
            "Coding request key already belongs to a different request",
          );
        return this.status(user, prior.id);
      }
      const base = await this.publisher.resolve();
      if (!/^[a-f0-9]{40}$/.test(base))
        throw new Error("Repository base identity unavailable");
      const id = randomUUID();
      const made = await this.db.query(
        `WITH made AS (
        INSERT INTO coding_jobs(id,user_id,request_key,request_hash,origin_run,thread_id,objective,context,mode,base_sha,settings)
        SELECT $1,$2,$3,$4,$5,(SELECT (metadata->>'threadId')::bigint FROM conversation_inputs WHERE user_id=$2 AND run_id=$5 ORDER BY ordinal LIMIT 1),$6,$7,$8,$9,$10::jsonb
        ON CONFLICT(user_id,request_key) DO NOTHING RETURNING id
      ) INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) SELECT id,1,$3,$6,$8 FROM made RETURNING job_id`,
        [
          id,
          user,
          a.requestKey,
          fingerprint,
          run,
          a.objective,
          a.context,
          a.mode,
          base,
          JSON.stringify(this.settings),
        ],
      );
      if (!made.rows.length) {
        const duplicate = (
          await this.db.query(
            "SELECT id,request_hash FROM coding_jobs WHERE user_id=$1 AND request_key=$2",
            [user, a.requestKey],
          )
        ).rows[0];
        if (duplicate.request_hash !== fingerprint)
          throw new Error("Coding request key conflict");
        return this.status(user, duplicate.id);
      }
      return this.status(user, id);
    }
    if (a.operation === "coding_cancel") {
      const publishing = (
        await this.db.query(
          "SELECT 1 FROM coding_jobs WHERE id=$1 AND user_id=$2 AND state='publishing' AND publication_started",
          [a.id, user],
        )
      ).rows.length;
      if (publishing)
        throw new Error(
          "PR publication is in flight or uncertain; inspect its result before cancelling",
        );
      await this.db.query(
        `WITH changed AS (UPDATE coding_jobs SET state='cancelled',summary='Cancelled by the owner',cleanup=CASE WHEN attempt_id IS NULL THEN cleanup ELSE 'pending' END,updated_at=now() WHERE id=$1 AND user_id=$2 AND state NOT IN ('cancelled','pr_ready') AND NOT (state='publishing' AND publication_started) RETURNING id)
        INSERT INTO coding_events(job_id,event_key,payload) SELECT id,'cancelled',jsonb_build_object('summary','Coding job cancelled; sandbox cleanup is tracked separately.') FROM changed ON CONFLICT DO NOTHING`,
        [a.id, user],
      );
      const current = (
        await this.db.query(
          "SELECT state,publication_started FROM coding_jobs WHERE id=$1 AND user_id=$2",
          [a.id, user],
        )
      ).rows[0];
      if (current?.state === "publishing" && current.publication_started)
        throw new Error(
          "PR publication is in flight or uncertain; inspect its result before cancelling",
        );
      if (current?.state === "cancelled") this.abortModels(a.id);
      return this.status(user, a.id);
    }
    const job = (
      await this.db.query(
        "SELECT * FROM coding_jobs WHERE id=$1 AND user_id=$2",
        [a.id, user],
      )
    ).rows[0];
    if (!job) throw new Error("Coding job unavailable");
    const prior = (
      await this.db.query(
        "SELECT revision,message,mode FROM coding_revisions WHERE job_id=$1 AND request_key=$2",
        [a.id, a.requestKey],
      )
    ).rows[0];
    const message =
      a.operation === "coding_reply" ? a.message : "Explicit resume";
    if (prior) {
      if (
        prior.revision !== a.baseRevision + 1 ||
        prior.message !== message ||
        (a.operation === "coding_reply" && a.mode && prior.mode !== a.mode)
      )
        throw new Error("Coding revision request key conflict");
      return this.status(user, a.id);
    }
    if (job.context.length + message.length + 18 > 24000)
      throw new Error(
        "Coding follow-up exceeds the supported brief size; prepare a new bounded job",
      );
    assertCodingBrief(
      job.objective,
      job.context + "\nOwner follow-up: " + message,
    );
    const changed = await this.db.query(
      `WITH changed AS (
      UPDATE coding_jobs SET revision=revision+1,mode=COALESCE($5,mode),context=context || E'\nOwner follow-up: ' || $4,state='queued',stage='queued',question='',result=NULL,attempt_id=NULL,sandbox_id=NULL,heartbeat_at=NULL,attempt_deadline=NULL,used_models=0,model_busy=false,publication_started=false,lease=NULL,lease_until=NULL,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND revision=$3 AND state IN ('plan_ready','awaiting_input','paused','failed') AND NOT publication_started AND cleanup IN ('none','complete') AND (lease IS NULL OR lease_until<now()) RETURNING id,revision,mode
    ) INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) SELECT id,revision,$6,$4,mode FROM changed RETURNING job_id`,
      [
        a.id,
        user,
        a.baseRevision,
        message,
        a.operation === "coding_reply" ? (a.mode ?? null) : null,
        a.requestKey,
      ],
    );
    if (!changed.rows.length)
      throw new Error(
        "Coding scope changed, job is active, or sandbox cleanup is pending; inspect status before revising",
      );
    return this.status(user, a.id);
  }
  async authenticate(
    id: string,
    token: string,
    includeFinished = false,
  ): Promise<CodingJob> {
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new Error("Invalid worker capability");
    const job = (
      await this.db.query("SELECT * FROM coding_jobs WHERE id=$1", [id])
    ).rows[0] as CodingJob | undefined;
    if (!job?.attempt_id || !this.allowed(job.user_id))
      throw new Error("Invalid worker capability");
    const expected = this.token(id, job.attempt_id);
    if (
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected)) ||
      (!includeFinished &&
        (!active.includes(job.state) ||
          new Date(job.attempt_deadline).getTime() <= this.clock().getTime()))
    )
      throw new Error("Invalid worker capability");
    return job;
  }
  async assignment(job: CodingJob) {
    return {
      id: job.id,
      revision: job.revision,
      objective: job.objective,
      context: job.context,
      mode: job.mode,
      baseSha: job.base_sha,
      settings: job.settings,
      checkpoint: job.checkpoint,
      deadline: new Date(job.attempt_deadline).toISOString(),
      usedModels: job.used_models,
    };
  }
  async heartbeat(job: CodingJob) {
    const update = await this.db.query(
      "UPDATE coding_jobs SET heartbeat_at=$3,attempt_deadline=CASE WHEN state='provisioning' THEN $3::timestamptz + ((settings->'limits'->>'ms')::bigint * interval '1 millisecond') ELSE attempt_deadline END,state='running',updated_at=now() WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running') RETURNING id",
      [job.id, job.attempt_id, this.clock()],
    );
    if (!update.rows.length) throw new Error("Worker attempt superseded");
    return { accepted: true };
  }
  async progress(job: CodingJob, raw: unknown) {
    const e = workerEvent.parse(raw);
    const prior = (
      await this.db.query(
        "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
        [job.id, `${job.attempt_id}:${e.key}`],
      )
    ).rows[0];
    if (prior) {
      if (hash(prior.payload) !== hash(e))
        throw new Error("Progress key conflict");
      return { accepted: true };
    }
    const update = await this.db.query(
      `WITH changed AS (UPDATE coding_jobs SET stage=$3,summary=$4 WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running') RETURNING id)
      INSERT INTO coding_events(job_id,event_key,payload) SELECT id,$5,$6::jsonb FROM changed ON CONFLICT DO NOTHING RETURNING id`,
      [
        job.id,
        job.attempt_id,
        e.stage,
        e.summary,
        `${job.attempt_id}:${e.key}`,
        JSON.stringify(e),
      ],
    );
    return { accepted: !!update.rows.length };
  }
  async save(job: CodingJob, raw: unknown) {
    const c = checkpoint.parse(raw);
    validateFiles(c.files);
    const update = await this.db.query(
      "UPDATE coding_jobs SET checkpoint=$3::jsonb,updated_at=now() WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running') RETURNING id",
      [job.id, job.attempt_id, JSON.stringify(c)],
    );
    if (!update.rows.length) throw new Error("Worker attempt superseded");
    return { saved: true };
  }
  async finish(job: CodingJob, raw: unknown) {
    const r = outcome.parse(raw);
    validateFiles(r.checkpoint.files);
    if (!active.includes(job.state)) {
      if (job.result && hash(job.result) === hash(r)) return { accepted: true };
      throw new Error("Worker attempt superseded");
    }
    if (new Date(job.attempt_deadline).getTime() <= this.clock().getTime())
      throw new Error("Worker allocation expired");
    if (job.mode === "plan" && r.kind === "candidate")
      throw new Error("Plan-only job cannot publish code");
    if (
      r.kind === "candidate" &&
      (r.review?.verdict !== "APPROVE" ||
        r.review.model !== job.settings.reviewerModel ||
        r.review.patchHash !== artifactHash(r.checkpoint) ||
        !r.checkpoint.files.length ||
        ["npm run check", "npm run build", "npm run format:check"].some(
          (cmd) => !r.checks.some((c) => c.command === cmd && c.exitCode === 0),
        ))
    )
      throw new Error(
        "Candidate needs passing checks and review of the exact artifact",
      );
    const state = r.kind === "candidate" ? "publishing" : r.kind;
    const update = await this.db.query(
      `WITH changed AS (UPDATE coding_jobs SET state=$3,stage=$3,summary=$4,question=$5,checkpoint=$6::jsonb,result=$7::jsonb,cleanup='pending',model_busy=false,updated_at=now() WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running') RETURNING id)
      INSERT INTO coding_events(job_id,event_key,payload) SELECT id,$8,jsonb_build_object('summary',$4::text,'question',$5::text) FROM changed ON CONFLICT DO NOTHING RETURNING id`,
      [
        job.id,
        job.attempt_id,
        state,
        r.summary,
        r.question,
        JSON.stringify(r.checkpoint),
        JSON.stringify(r),
        `${job.attempt_id}:finished`,
      ],
    );
    if (!update.rows.length) throw new Error("Worker attempt superseded");
    return { accepted: true };
  }
  async generate(
    job: CodingJob,
    input: {
      callId: string;
      role: "coder" | "reviewer";
      messages: ModelMessage[];
      tools: ToolDefinition[];
    },
  ) {
    const prior = (
      await this.db.query("SELECT * FROM coding_model_calls WHERE id=$1", [
        input.callId,
      ])
    ).rows[0];
    if (prior) {
      if (
        prior.job_id !== job.id ||
        prior.attempt_id !== job.attempt_id ||
        prior.request_hash !== hash(input)
      )
        throw new Error("Model request key conflict");
      if (prior.state !== "complete")
        throw new Error(
          "Earlier model request is pending or uncertain; do not replay it",
        );
      if (!prior.result_box)
        throw new Error(
          "Exact model response unavailable; inspect before continuing",
        );
      return JSON.parse(
        open(
          this.resultKey(),
          prior.result_box,
          this.resultScope(job, input.callId),
        ),
      );
    }
    const cancellation = new AbortController();
    if (this.inFlightModels.has(input.callId))
      throw new Error("Model call is already in flight");
    this.inFlightModels.set(input.callId, {
      jobId: job.id,
      controller: cancellation,
    });
    let admitted = false;
    try {
      const claimed = await this.db.query(
        `WITH claimed AS (UPDATE coding_jobs SET used_models=used_models+1,model_busy=true WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running') AND NOT model_busy AND used_models<$3 AND attempt_deadline>$4 RETURNING id)
      INSERT INTO coding_model_calls(id,job_id,attempt_id,role,request_hash,input) SELECT $5,id,$2,$6,$7,$8::jsonb FROM claimed RETURNING id`,
        [
          job.id,
          job.attempt_id,
          job.settings.limits.models,
          this.clock(),
          input.callId,
          input.role,
          hash(input),
          JSON.stringify(scrubTrace(input)),
        ],
      );
      if (!claimed.rows.length)
        throw new Error(
          "Model allocation unavailable or a request is already in flight",
        );
      admitted = true;
      const live = (
        await this.db.query(
          "SELECT state,attempt_id FROM coding_jobs WHERE id=$1",
          [job.id],
        )
      ).rows[0];
      if (
        cancellation.signal.aborted ||
        !live ||
        !active.includes(live.state) ||
        live.attempt_id !== job.attempt_id ||
        !this.allowed(job.user_id)
      )
        throw new Error("Coding request cancelled before model dispatch");
      const result = await this.models(
        input.role === "reviewer"
          ? job.settings.reviewerModel
          : job.settings.model,
      ).generate({
        messages: input.messages,
        tools: input.tools,
        reasoning: job.settings.effort,
        signal: AbortSignal.any([
          cancellation.signal,
          AbortSignal.timeout(
            Math.max(
              1,
              Math.min(
                120000,
                new Date(job.attempt_deadline).getTime() -
                  this.clock().getTime(),
              ),
            ),
          ),
        ]),
        cacheKey: `coding:${job.id}:${job.revision}:${input.role}`,
      });
      await this.db.query(
        "UPDATE coding_model_calls SET state='complete',result=$2::jsonb,result_box=$3 WHERE id=$1",
        [
          input.callId,
          JSON.stringify(scrubTrace(result)),
          seal(
            this.resultKey(),
            JSON.stringify(result),
            this.resultScope(job, input.callId),
          ),
        ],
      );
      await this.db.query(
        "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,$2,$3::jsonb,'suppressed')",
        [
          job.id,
          `${job.attempt_id}:model:${randomUUID()}`,
          JSON.stringify({
            kind: "model_usage",
            role: input.role,
            model: result.model,
            usage: result.usage,
            provider: result.provider,
          }),
        ],
      );
      return result;
    } catch (error) {
      await this.db.query(
        "UPDATE coding_model_calls SET state='uncertain' WHERE id=$1 AND state='pending'",
        [input.callId],
      );
      throw error;
    } finally {
      this.inFlightModels.delete(input.callId);
      if (admitted)
        await this.db.query(
          "UPDATE coding_jobs SET model_busy=false WHERE id=$1 AND attempt_id=$2",
          [job.id, job.attempt_id],
        );
    }
  }
  private async stopped(j: CodingJob, summary: string, attempted = true) {
    this.abortModels(j.id);
    await this.db.query(
      `WITH changed AS (UPDATE coding_jobs SET state='paused',summary=$3,cleanup=CASE WHEN $5 THEN 'pending' ELSE 'none' END,model_busy=false,updated_at=now() WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running') RETURNING id)
      INSERT INTO coding_events(job_id,event_key,payload) SELECT id,$4,jsonb_build_object('summary',$3::text) FROM changed ON CONFLICT DO NOTHING`,
      [j.id, j.attempt_id, summary, `${j.attempt_id}:paused`, attempted],
    );
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    let j: CodingJob | undefined;
    try {
      j = (
        await this.db.query(
          `UPDATE coding_jobs SET lease=$1,lease_until=now()+interval '3 minutes' WHERE id=(SELECT id FROM coding_jobs WHERE (state IN ('provisioning','running','publishing') OR cleanup='pending') AND (lease IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
          [randomUUID()],
        )
      ).rows[0];
      if (!j) {
        j = (
          await this.db.query(
            `UPDATE coding_jobs SET state='provisioning',stage='provisioning',attempt_id=$1,heartbeat_at=$2,attempt_deadline=$3,cleanup='pending',lease=$4,lease_until=now()+interval '3 minutes' WHERE id=(SELECT id FROM coding_jobs WHERE state='queued' AND NOT EXISTS(SELECT 1 FROM coding_jobs WHERE state IN ('provisioning','running','publishing') OR cleanup='pending') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
            [
              randomUUID(),
              this.clock(),
              new Date(
                this.clock().getTime() + this.settings.limits.ms + 300000,
              ),
              randomUUID(),
            ],
          )
        ).rows[0];
        if (!j) return;
        if (!this.allowed(j.user_id)) {
          await this.stopped(
            j,
            "Owner access was revoked before sandbox creation",
            false,
          );
          return;
        }
        try {
          const id = await this.provider.create({
            jobId: j.id,
            attemptId: j.attempt_id,
            token: this.token(j.id, j.attempt_id),
            origin: this.origin,
            image: j.settings.image,
            timeoutMinutes: Math.max(
              5,
              Math.ceil(j.settings.limits.ms / 60000) + 5,
            ),
          });
          await this.db.query(
            "UPDATE coding_jobs SET sandbox_id=$3 WHERE id=$1 AND attempt_id=$2",
            [j.id, j.attempt_id, id],
          );
        } catch {
          await this.stopped(
            j,
            "Sandbox provisioning acknowledgement is uncertain; reconciling before any new attempt",
          );
        }
        return;
      }
      if (!j.sandbox_id) {
        const found = await this.provider.find(j.attempt_id);
        if (found) {
          await this.db.query(
            "UPDATE coding_jobs SET sandbox_id=$3 WHERE id=$1 AND attempt_id=$2",
            [j.id, j.attempt_id, found],
          );
          j.sandbox_id = found;
        } else {
          await this.stopped(
            j,
            "Sandbox identity could not be reconciled; inspect the provider before resuming",
          );
          return;
        }
      }
      const state = await this.provider.inspect(j.sandbox_id);
      if (active.includes(j.state)) {
        if (state === "terminal")
          await this.stopped(
            j,
            "Sandbox stopped before a result was recorded; saved work is retained",
          );
        else if (
          !this.allowed(j.user_id) ||
          new Date(j.attempt_deadline).getTime() <= this.clock().getTime() ||
          this.clock().getTime() - new Date(j.heartbeat_at).getTime() > 180000
        )
          await this.stopped(
            j,
            "Worker allocation expired or heartbeat was lost; saved work is retained",
          );
        return;
      }
      if (j.cleanup === "pending") {
        if (state === "running") {
          await this.provider.terminate(j.sandbox_id);
          return;
        }
        await this.db.query(
          "UPDATE coding_jobs SET cleanup='complete' WHERE id=$1 AND attempt_id=$2",
          [j.id, j.attempt_id],
        );
      }
      if (j.state === "publishing" && this.allowed(j.user_id)) {
        // Check state again before publication; cancel cannot authorise a new publish.
        const fresh = (
          await this.db.query(
            "UPDATE coding_jobs SET publication_started=true WHERE id=$1 AND state='publishing' RETURNING *",
            [j.id],
          )
        ).rows[0];
        if (!fresh) return;
        const published = await this.publisher.publish(fresh);
        await this.db.query(
          `WITH changed AS (UPDATE coding_jobs SET state='pr_ready',stage='pr_ready',pr_url=$2,head_sha=$3,summary='Draft PR prepared; CI and independent review of its head remain required',updated_at=now() WHERE id=$1 AND state='publishing' RETURNING id)
          INSERT INTO coding_events(job_id,event_key,payload) SELECT id,$4,jsonb_build_object('summary','Draft PR prepared; CI and independent review remain required.','url',$2::text) FROM changed ON CONFLICT DO NOTHING`,
          [j.id, published.url, published.head, `${j.attempt_id}:pr`],
        );
      } else if (j.state === "publishing") {
        await this.db.query(
          "UPDATE coding_jobs SET state='paused',summary='Owner access revoked; inspect any uncertain PR publication before resuming',updated_at=now() WHERE id=$1 AND state='publishing'",
          [j.id],
        );
      }
    } finally {
      try {
        if (j)
          await this.db.query(
            "UPDATE coding_jobs SET lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2",
            [j.id, j.lease],
          );
      } finally {
        this.ticking = false;
      }
    }
  }
  async recoverDelivery() {
    await this.db.query(
      "UPDATE coding_events SET delivery='uncertain' WHERE delivery='sending'",
    );
  }
  async deliver(
    send: (
      user: string,
      thread: number | undefined,
      text: string,
    ) => Promise<unknown>,
  ) {
    if (this.delivering) return;
    this.delivering = true;
    try {
      const e = (
        await this.db.query(
          `UPDATE coding_events SET delivery='sending' WHERE id=(SELECT e.id FROM coding_events e JOIN coding_jobs j ON j.id=e.job_id WHERE e.delivery='pending' ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT 1) RETURNING *`,
        )
      ).rows[0];
      if (!e) return;
      let attempted = false;
      try {
        const j = (
          await this.db.query(
            "SELECT user_id,thread_id FROM coding_jobs WHERE id=$1",
            [e.job_id],
          )
        ).rows[0];
        if (!this.allowed(j.user_id)) {
          await this.db.query(
            "UPDATE coding_events SET delivery='suppressed' WHERE id=$1",
            [e.id],
          );
          return;
        }
        attempted = true;
        await send(
          j.user_id,
          j.thread_id ? Number(j.thread_id) : undefined,
          [
            `Coding job ${e.job_id}`,
            typeof e.payload.summary === "string"
              ? e.payload.summary.slice(0, 1500)
              : undefined,
            typeof e.payload.question === "string"
              ? e.payload.question.slice(0, 2000)
              : undefined,
            e.payload.url,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        await this.db.query(
          "UPDATE coding_events SET delivery='sent' WHERE id=$1",
          [e.id],
        );
      } catch {
        await this.db.query(
          "UPDATE coding_events SET delivery=$2 WHERE id=$1",
          [e.id, attempted ? "uncertain" : "pending"],
        );
      }
    } finally {
      this.delivering = false;
    }
  }
}
