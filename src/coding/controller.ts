import { CodingAutomation } from "./automation.js";
import { codingDiagnostics } from "./diagnostics.js";
import {
  modelPreferences,
  setModelPreference,
  type CodingCatalog,
} from "./model-settings.js";
import { assertSquadCheckpoint } from "./squad-state.js";
import { codingDestination } from "./delivery-routing.js";
import { CodingRequirements, requirementScope } from "./requirements.js";
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
  readonly requirements: CodingRequirements;
  private ticking = false;
  private delivering = false;
  private automation?: CodingAutomation;
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
    private catalog?: CodingCatalog,
    private priceFilters = { input: 2, output: 10 },
  ) {
    this.requirements = new CodingRequirements(db, allowed, clock);
    if (settings.autoMerge && publisher.automation)
      this.automation = new CodingAutomation(
        db,
        publisher.automation(),
        allowed,
        (job) => this.hasReviewerProof(job),
        clock,
      );
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
  async logs(job: CodingJob, raw: unknown) {
    if (!this.allowed(job.user_id)) throw new Error("Owner unavailable");
    return codingDiagnostics(this.db, job.user_id, raw);
  }
  private async hasReviewerProof(job: CodingJob) {
    const call = (
      await this.db.query(
        "SELECT id,state,input,result_box FROM coding_model_calls WHERE job_id=$1 AND attempt_id=$2 AND role='reviewer' ORDER BY created_at DESC,id DESC LIMIT 1",
        [job.id, job.attempt_id],
      )
    ).rows[0];
    if (
      call?.state !== "complete" ||
      !call?.result_box ||
      call.input.tools.some(
        (t: any) =>
          ![
            "file_read",
            "plan_read",
            "command",
            "report",
            "logs_read",
          ].includes(t.name),
      )
    )
      return false;
    const metadata = call.input.messages.find((m: any) => m.role === "user");
    let brief: any;
    try {
      brief = JSON.parse(metadata.content);
    } catch {
      return false;
    }
    const hash = artifactHash(job.result.checkpoint);
    if (
      brief.handoff?.recipient !== "reviewer" ||
      brief.handoff?.candidateHash !== hash ||
      brief.baseSha !== job.base_sha ||
      brief.objective !== scrubTrace(job.objective) ||
      brief.context !== scrubTrace(job.context)
    )
      return false;
    const response = JSON.parse(
      open(this.resultKey(), call.result_box, this.resultScope(job, call.id)),
    );
    if (call.input.requestedModel !== job.settings.reviewerModel) return false;
    return (
      response.message?.tool_calls?.some((c: any) => {
        if (c.function?.name !== "report") return false;
        try {
          const r = JSON.parse(c.function.arguments);
          return (
            r.kind === "APPROVE" && r.summary === job.result.review?.findings
          );
        } catch {
          return false;
        }
      }) ?? false
    );
  }
  async automationTick() {
    await this.automation?.tick();
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
    const state = stored.checkpoint.squadState;
    return {
      ...job,
      plan: stored.checkpoint.plan,
      ...(state
        ? {
            squad: {
              phase: state.phase,
              candidateVersion: state.candidateVersion,
              candidateHash: state.candidateHash,
              toolsUsed: state.toolsUsed,
              member: state.handoff?.recipient,
              findings: state.findings,
              checks: state.checks.map(
                (c: { command: string; exitCode: number }) => ({
                  command: c.command,
                  exitCode: c.exitCode,
                }),
              ),
            },
          }
        : {}),
    };
  }
  async call(user: string, run: string, raw: CodingAction) {
    const a = codingAction.parse(raw);
    if (a.operation === "coding_status") return this.status(user, a.id);
    await this.foreground(user, run);
    if (a.operation === "coding_models") {
      if (
        (a.role === undefined) !== (a.model === undefined) ||
        (a.list && a.model)
      )
        throw new Error(
          "Set one role/model, list choices, or read preferences",
        );
      if (a.model && a.role) {
        if (!this.catalog) throw new Error("Coding model catalog unavailable");
        return setModelPreference(
          this.db,
          user,
          this.settings,
          a.role,
          a.model,
          this.catalog,
          this.priceFilters.input,
          this.priceFilters.output,
        );
      }
      const preferences = await modelPreferences(this.db, user, this.settings);
      return {
        preferences,
        appliesTo: "new jobs only",
        bounded: true,
        notice:
          "The catalog shows up to 100 eligible models; setting an exact ID validates the full live catalog. Running jobs retain their model snapshot.",
        ...(a.list
          ? {
              models: ((await this.catalog?.()) ?? [])
                .filter(
                  (m) =>
                    m.tools &&
                    Number.isFinite(m.inputPrice) &&
                    Number.isFinite(m.outputPrice) &&
                    m.inputPrice >= 0 &&
                    m.outputPrice >= 0 &&
                    m.inputPrice <= this.priceFilters.input &&
                    m.outputPrice <= this.priceFilters.output,
                )
                .slice(0, 100),
            }
          : {}),
      };
    }
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
      const preferred = await modelPreferences(this.db, user, this.settings);
      const selected = {
        ...this.settings,
        leaderModel: this.settings.squad
          ? preferred.leader
          : this.settings.leaderModel,
        model: preferred.coder,
        reviewerModel: preferred.reviewer,
      };
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
          "plan",
          base,
          JSON.stringify(selected),
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
        `WITH changed AS (UPDATE coding_jobs SET state='cancelled',summary='Cancelled by the owner',cleanup=CASE WHEN attempt_id IS NULL THEN cleanup ELSE 'pending' END,updated_at=now() WHERE id=$1 AND user_id=$2 AND state!='cancelled' AND (state!='pr_ready' OR (settings->>'autoMerge'='true' AND stage NOT IN ('merging','release_pending','deployed'))) AND NOT (state='publishing' AND publication_started) RETURNING id)
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
    if (a.operation === "coding_reply" && a.mode === "implement")
      throw new Error(
        "Implementation requires confirmed requirements. Use coding_resume to request the confirmation card, or coding_reply in plan mode to revise requirements.",
      );
    if (
      a.operation === "coding_resume" &&
      job.state === "plan_ready" &&
      job.mode === "plan"
    ) {
      if (job.revision !== a.baseRevision)
        throw new Error("Coding revision changed");
      return this.requirements.request(job, a.requestKey);
    }
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
    if (
      a.operation === "coding_reply" &&
      job.context.length + message.length + 18 > 24000
    )
      throw new Error(
        "Coding follow-up exceeds the supported brief size; prepare a new bounded job",
      );
    assertCodingBrief(
      job.objective,
      a.operation === "coding_reply"
        ? job.context + "\nOwner follow-up: " + message
        : job.context,
    );
    const changed = await this.db.query(
      `WITH changed AS (
      UPDATE coding_jobs SET revision=revision+1,mode=COALESCE($5,mode),context=CASE WHEN $7 THEN context || E'\nOwner follow-up: ' || $4 ELSE context END,state='queued',stage='queued',question='',result=NULL,attempt_id=NULL,sandbox_id=NULL,heartbeat_at=NULL,attempt_deadline=NULL,used_models=0,model_busy=false,publication_started=false,lease=NULL,lease_until=NULL,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND revision=$3 AND state IN ('plan_ready','awaiting_input','paused','failed') AND NOT publication_started AND cleanup IN ('none','complete') AND (lease IS NULL OR lease_until<now()) RETURNING id,revision,mode
    ) INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) SELECT id,revision,$6,$4,mode FROM changed RETURNING job_id`,
      [
        a.id,
        user,
        a.baseRevision,
        message,
        a.operation === "coding_reply" ? "plan" : null,
        a.requestKey,
        a.operation === "coding_reply",
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
    if (job.mode === "implement" && !(await this.requirements.approved(job)))
      throw new Error("Requirements are not approved");
    return job;
  }
  async assignment(job: CodingJob) {
    return {
      protocolVersion: 1,
      ...(job.settings.squad ? { attemptId: job.attempt_id } : {}),
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
    const feedback = (
      await this.db.query(
        "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
        [job.id, `feedback:${job.revision}`],
      )
    ).rows[0]?.payload;
    const activeMs = feedback?.remainingMs ?? job.settings.limits.ms;
    const update = await this.db.query(
      "UPDATE coding_jobs SET heartbeat_at=$3,attempt_deadline=CASE WHEN state='provisioning' THEN $3::timestamptz + ($4::bigint * interval '1 millisecond') ELSE attempt_deadline END,state='running',updated_at=now() WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running') RETURNING id",
      [job.id, job.attempt_id, this.clock(), activeMs],
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
    if (
      job.mode === "implement" &&
      (c.plan !== job.checkpoint.plan ||
        !(await this.requirements.approved(job)))
    )
      throw new Error(
        "Approved requirements are immutable; revise and confirm a new plan first",
      );
    validateFiles(c.files);
    assertSquadCheckpoint(job, c);
    if (canonicalJson(c) === canonicalJson(job.checkpoint))
      return { saved: true };
    const update = await this.db.query(
      `WITH changed AS (UPDATE coding_jobs SET checkpoint=$3::jsonb,updated_at=now() WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running') AND checkpoint=$4::jsonb RETURNING id)
      INSERT INTO coding_events(job_id,event_key,payload,delivery) SELECT id,$5,$6::jsonb,'suppressed' FROM changed ON CONFLICT DO NOTHING RETURNING id`,
      [
        job.id,
        job.attempt_id,
        JSON.stringify(c),
        JSON.stringify(job.checkpoint),
        c.squadState
          ? `squad:${job.attempt_id}:${c.squadState.sequence}`
          : `checkpoint:${randomUUID()}`,
        JSON.stringify(
          c.squadState
            ? { kind: "squad_handoff", state: c.squadState }
            : { kind: "checkpoint" },
        ),
      ],
    );
    if (!update.rows.length) throw new Error("Worker attempt superseded");
    return { saved: true };
  }
  async finish(job: CodingJob, raw: unknown) {
    const r = outcome.parse(raw);
    validateFiles(r.checkpoint.files);
    if (job.settings.squad && r.kind === "candidate") {
      const state = r.checkpoint.squadState;
      if (
        !state ||
        state.phase !== "approved" ||
        canonicalJson(r.checkpoint) !== canonicalJson(job.checkpoint) ||
        canonicalJson(r.checks) !== canonicalJson(state.checks) ||
        canonicalJson(r.review) !== canonicalJson(state.review)
      )
        throw new Error(
          "Squad completion needs its latest acknowledged approved artifact",
        );
    }
    if (
      job.mode === "implement" &&
      (r.checkpoint.plan !== job.checkpoint.plan ||
        !(await this.requirements.approved(job)))
    )
      throw new Error("Implementation needs the exact approved requirements");
    if (
      r.kind === "plan_ready" &&
      (job.mode !== "plan" || !r.checkpoint.plan.trim())
    )
      throw new Error("Planning must produce a non-empty requirement brief");
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
      `WITH changed AS (UPDATE coding_jobs SET state=$3,stage=$3,summary=$4,question=$5,checkpoint=$6::jsonb,result=$7::jsonb,cleanup='pending',model_busy=false,updated_at=now() WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running') AND checkpoint=$10::jsonb RETURNING id)
      INSERT INTO coding_events(job_id,event_key,payload) SELECT id,$8,jsonb_build_object('summary',$4::text,'question',$5::text) || $9::jsonb FROM changed ON CONFLICT DO NOTHING RETURNING id`,
      [
        job.id,
        job.attempt_id,
        state,
        r.summary,
        r.question,
        JSON.stringify(r.checkpoint),
        JSON.stringify(r),
        `${job.attempt_id}:finished`,
        JSON.stringify(
          r.kind === "plan_ready"
            ? {
                requirements: {
                  revision: job.revision,
                  scope: requirementScope({ ...job, checkpoint: r.checkpoint }),
                  artifact: artifactHash(r.checkpoint),
                  plan: r.checkpoint.plan,
                },
              }
            : {},
        ),
        JSON.stringify(job.checkpoint),
      ],
    );
    if (!update.rows.length) throw new Error("Worker attempt superseded");
    return { accepted: true };
  }
  async generate(
    job: CodingJob,
    input: {
      callId: string;
      role: "leader" | "coder" | "reviewer";
      messages: ModelMessage[];
      tools: ToolDefinition[];
    },
  ) {
    if (input.role === "leader" && !job.settings.squad)
      throw new Error("Leader role requires the reviewed squad runtime");
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
          JSON.stringify({
            ...scrubTrace(input),
            requestedModel:
              input.role === "reviewer"
                ? job.settings.reviewerModel
                : input.role === "leader"
                  ? (job.settings.leaderModel ?? job.settings.model)
                  : job.settings.model,
          }),
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
          : input.role === "leader"
            ? (job.settings.leaderModel ?? job.settings.model)
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
          if (
            j.mode === "implement" &&
            !(await this.requirements.approved(j))
          ) {
            await this.stopped(
              j,
              "Requirements must be confirmed before implementation",
              false,
            );
            return;
          }
          const id = await this.provider.create({
            jobId: j.id,
            attemptId: j.attempt_id,
            token: this.token(j.id, j.attempt_id),
            origin: this.origin,
            image: j.settings.image,
            runtime: j.settings.runtime ?? "node",
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
          `WITH changed AS (UPDATE coding_jobs SET state='pr_ready',stage='pr_ready',pr_url=$2,head_sha=$3,summary=$6,updated_at=now() WHERE id=$1 AND state='publishing' RETURNING id)
          INSERT INTO coding_events(job_id,event_key,payload) SELECT id,$4,jsonb_build_object('summary',$6::text,'url',$2::text,'tree',$5::text) FROM changed ON CONFLICT DO NOTHING`,
          [
            j.id,
            published.url,
            published.head,
            `${j.attempt_id}:pr`,
            published.tree ?? null,
            j.settings.autoMerge
              ? "Draft PR prepared; checking CI, Devin and MR feedback before guarded merge."
              : "Draft PR prepared; CI and independent review of its head remain required.",
          ],
        );
        if (j.settings.autoMerge && published.tree) {
          await this.automation?.start(
            { ...fresh, head_sha: published.head, pr_url: published.url },
            published.tree,
          );
        }
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
      target: import("../delivery-routing.js").Destination,
      text: string,
      approvalId?: string,
    ) => Promise<unknown>,
  ) {
    if (this.delivering) return;
    this.delivering = true;
    try {
      const e = (
        await this.db.query(
          `UPDATE coding_events SET delivery='sending' WHERE id=(SELECT e.id FROM coding_events e JOIN coding_jobs j ON j.id=e.job_id WHERE e.delivery='pending' AND (NOT(e.payload ? 'requirements') OR j.state!='plan_ready' OR j.revision!=(e.payload->'requirements'->>'revision')::int OR (j.cleanup IN ('none','complete') AND (j.lease IS NULL OR j.lease_until<now()))) ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT 1) RETURNING *`,
        )
      ).rows[0];
      if (!e) return;
      let attempted = false;
      try {
        const j = (
          await this.db.query("SELECT * FROM coding_jobs WHERE id=$1", [
            e.job_id,
          ])
        ).rows[0];
        const req = e.payload.requirements;
        if (
          !this.allowed(j.user_id) ||
          (req &&
            (j.state !== "plan_ready" ||
              j.mode !== "plan" ||
              j.revision !== req.revision ||
              j.checkpoint.plan !== req.plan ||
              requirementScope(j) !== req.scope ||
              artifactHash(j.checkpoint) !== req.artifact))
        ) {
          await this.db.query(
            "UPDATE coding_events SET delivery='suppressed' WHERE id=$1",
            [e.id],
          );
          return;
        }
        attempted = true;
        const sent = await send(
          j.user_id,
          codingDestination(e.payload),
          [
            `Coding job ${e.job_id}`,
            typeof e.payload.summary === "string"
              ? e.payload.summary.slice(0, 1500)
              : undefined,
            typeof e.payload.question === "string"
              ? e.payload.question.slice(0, 2000)
              : undefined,
            e.payload.url,
            req
              ? `Models: leader ${j.settings.leaderModel ?? j.settings.model}; coder ${j.settings.model}; reviewer ${j.settings.reviewerModel}. Publication: ${j.settings.autoMerge ? "ordinary changes may merge after exact-artifact review and GitHub checks; protected changes stop for explicit review" : "draft PR for owner review"}.`
              : undefined,
            req
              ? `Requirements — revision ${req.revision}\n\n${req.plan}\n\nApprove these requirements, or reply directly to this message with yes. To revise them, tell Chief what to change. Confirmation expires in 15 minutes.`
              : undefined,
          ]
            .filter(Boolean)
            .join("\n\n"),
          req ? e.id : undefined,
        );
        if (req) {
          const receipt = sent as { message_id?: number } | undefined;
          if (
            !Number.isSafeInteger(receipt?.message_id) ||
            receipt!.message_id! <= 0
          )
            throw new Error("Requirement delivery receipt unavailable");
          await this.db.query(
            "UPDATE coding_events SET payload=payload || jsonb_build_object('telegramMessageId',$2::bigint,'confirmUntil',$3::text) WHERE id=$1",
            [
              e.id,
              receipt!.message_id,
              new Date(this.clock().getTime() + 900000).toISOString(),
            ],
          );
        }
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
