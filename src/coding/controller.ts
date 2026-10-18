import { ToolValidationError } from "../tool-errors.js";
import { PiSessions } from "./pi-sessions.js";
import { z } from "zod";
import { reviewMetadata, completePlanDelivered } from "./review-proof.js";
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
import { CodingMergeApprovals } from "./merge-approvals.js";
import type { AgentGitHubTokens, AgentToken } from "./agent-github.js";
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
  type Checkpoint,
  type Outcome,
} from "./schema.js";
import {
  AgentPublicationMismatch,
  artifactHash,
  canonicalJson,
  validateFiles,
  type RepositoryPublisher,
} from "./github.js";
import {
  SandboxAcknowledgementPending,
  SandboxTimeoutMismatch,
  type SandboxProvider,
} from "./provider.js";
import { scrubTrace } from "../trace-scrub.js";
import { seal, open } from "../secret-box.js";
import { errorFields, opsLog } from "../ops-log.js";
import { ModelError } from "../model.js";
import { CodingModelFailure, type CodingFailureCode } from "./model-failure.js";
import { runtimeMemory } from "./memory-schema.js";

const active = ["provisioning", "running"];
/** Why the host paused an attempt. Only sandbox_stopped and heartbeat_lost are transient. */
export type PauseCause = "sandbox_stopped" | "heartbeat_lost";
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
  readonly merges: CodingMergeApprovals;
  private ticking = false;
  private delivering = false;
  private activeMs(job: CodingJob) {
    // Per-attempt operational ceiling; preserve historical settings and require
    // explicit owner resumption. Legacy runtimes retain their original allocation.
    return Math.min(
      job.settings.limits.ms,
      job.settings.runtime === "pi" ? 2_400_000 : job.settings.limits.ms,
    );
  }
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
    legacyAutomationEnabled = false,
    private agentGit?: {
      tokens: AgentGitHubTokens;
      author: { name: string; email: string };
    },
  ) {
    this.requirements = new CodingRequirements(db, allowed, clock);
    this.merges = new CodingMergeApprovals(db, allowed, clock);
    if (
      (settings.autoMerge || settings.prWorkflow || legacyAutomationEnabled) &&
      publisher.automation
    )
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
  /** Pi approval: the acknowledged review document must match a sealed reviewer response in this attempt. */
  private async hasPiReviewerProof(job: CodingJob) {
    const document = job.result?.checkpoint?.piState?.reportDocument;
    if (
      document?.kind !== "review" ||
      document.verdict !== "APPROVE" ||
      document.detail !== job.result?.review?.findings
    )
      return false;
    const calls = (
      await this.db.query(
        "SELECT id,result_box FROM coding_model_calls WHERE job_id=$1 AND attempt_id=$2 AND role='reviewer' AND state='complete' AND result_box IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT $3",
        [job.id, job.attempt_id, job.settings.limits.models],
      )
    ).rows;
    for (const call of calls) {
      try {
        const response = JSON.parse(
          open(
            this.resultKey(),
            call.result_box,
            this.resultScope(job, call.id),
          ),
        );
        if (
          response.message?.tool_calls?.some((c: any) => {
            if (c.function?.name !== "report") return false;
            const r = JSON.parse(c.function.arguments);
            return (
              r.kind === "review" &&
              r.verdict === "APPROVE" &&
              r.detail === document.detail
            );
          })
        )
          return true;
      } catch {
        /* An unreadable journal entry is not approval. */
      }
    }
    return false;
  }
  async logs(job: CodingJob, raw: unknown) {
    if (!this.allowed(job.user_id)) throw new Error("Owner unavailable");
    return codingDiagnostics(this.db, job.user_id, raw);
  }
  private async hasReviewerProof(job: CodingJob) {
    if (job.settings.runtime === "pi") return this.hasPiReviewerProof(job);
    const calls = (
      await this.db.query(
        "SELECT id,state,input,result_box FROM coding_model_calls WHERE job_id=$1 AND attempt_id=$2 AND role='reviewer' ORDER BY created_at DESC,id DESC LIMIT $3",
        [job.id, job.attempt_id, job.settings.limits.models],
      )
    ).rows;
    const call = calls[0];
    if (call?.state !== "complete" || !call.result_box) return false;
    const handoff = reviewMetadata(call.input, job);
    if (
      !handoff ||
      !completePlanDelivered(
        calls
          .filter(
            (c) =>
              c.state === "complete" &&
              reviewMetadata(c.input, job) === handoff,
          )
          .map((c) => c.input),
        job.result.checkpoint.plan,
      )
    )
      return false;
    const response = JSON.parse(
      open(this.resultKey(), call.result_box, this.resultScope(job, call.id)),
    );
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
      throw new ToolValidationError(
        "Coding changes require an authenticated foreground owner request",
      );
  }
  async status(user: string, id?: string) {
    if (!this.allowed(user)) throw new Error("Coding owner unavailable");
    const rows = (
      await this.db.query(
        `SELECT id,revision,objective,mode,state,stage,summary,question,base_sha,pr_url,head_sha,cleanup,publication_started,used_models,settings->'limits' AS limits,settings->>'prWorkflow' AS merge_flow,updated_at,checkpoint->'runtimeMemory' AS runtime_memory,checkpoint->'squadState'->>'phase' AS runtime_phase,(SELECT max(created_at) FROM coding_events e WHERE e.job_id=coding_jobs.id AND e.payload->>'kind' IN ('squad_handoff','checkpoint')) AS checkpoint_at FROM coding_jobs WHERE user_id=$1 ${id ? "AND id=$2" : ""} ORDER BY created_at DESC LIMIT 20`,
        id ? [user, id] : [user],
      )
    ).rows;
    for (const row of rows) {
      const parsed = runtimeMemory.safeParse(row.runtime_memory);
      if (parsed.success) {
        const member =
          row.runtime_phase === "coding"
            ? "coder"
            : row.runtime_phase === "reviewing"
              ? "reviewer"
              : "leader";
        const memory = parsed.data[member];
        row.runtime = memory
          ? {
              member,
              checkpointAt: row.checkpoint_at,
              lastProgressAt: memory.lastProgressAt,
              workerModelCalls: memory.modelCalls,
              workerToolsUsed: memory.toolsUsed,
              compactions: memory.compactions,
              nudges: memory.nudges,
              resets: memory.resets,
              notebook: memory.notes,
              evidenceCount: memory.receipts.length,
              notice:
                "Worker-reported observations, not verified completion. used_models is the host-admitted shared counter; notebook claims do not satisfy checks or review.",
            }
          : { member, checkpointAt: row.checkpoint_at };
      }
      delete row.runtime_memory;
      delete row.runtime_phase;
      row.mergeFlow = row.merge_flow ?? "draft_only";
      delete row.merge_flow;
    }
    if (id && !rows.length) throw new Error("Coding job unavailable");
    if (!id) return rows;
    const job = rows[0];
    const stored = (
      await this.db.query(
        "SELECT checkpoint,attempt_id FROM coding_jobs WHERE user_id=$1 AND id=$2",
        [user, id],
      )
    ).rows[0];
    const state = stored.checkpoint.squadState;
    const rejection = (
      await this.db.query(
        `SELECT payload,created_at FROM coding_events WHERE job_id=$1
         AND event_key LIKE $2 AND payload->>'kind'='worker_request_rejected'
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [id, `${stored.attempt_id}:request-rejected:%`],
      )
    ).rows[0];
    const modelProgress = (
      await this.db.query(
        `SELECT payload,created_at FROM coding_events WHERE job_id=$1 AND event_key LIKE $2 AND payload->>'kind'='model_progress' ORDER BY created_at DESC,id DESC LIMIT 1`,
        [id, `${stored.attempt_id}:model-progress:%`],
      )
    ).rows[0];
    return {
      ...job,
      plan: stored.checkpoint.plan,
      ...(stored.checkpoint.piState?.reportDocument
        ? {
            reportDocument: {
              version: 1,
              hash: stored.checkpoint.piState.reportDocument.hash,
              kind: stored.checkpoint.piState.reportDocument.kind,
              characters:
                stored.checkpoint.piState.reportDocument.detail.length,
            },
          }
        : {}),
      ...(stored.checkpoint.piState?.reportFailure
        ? { reportFailure: stored.checkpoint.piState.reportFailure }
        : {}),
      ...(modelProgress
        ? {
            modelProgress: {
              ...modelProgress.payload,
              at: modelProgress.created_at,
            },
          }
        : {}),
      ...(rejection
        ? { lastFailure: { ...rejection.payload, at: rejection.created_at } }
        : {}),
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
  /** Fixed host error categories only; never persist raw exceptions or request data. */
  async recordRejection(
    job: CodingJob,
    failure: {
      phase:
        | "assignment"
        | "heartbeat"
        | "progress"
        | "checkpoint"
        | "finish"
        | "model"
        | "logs";
      code:
        | "invalid_worker_payload"
        | "model_provider_failed"
        | "worker_request_rejected"
        | "model_context_limit"
        | CodingFailureCode;
      httpStatus: 409 | 413;
      elapsedMs?: number;
      callId?: string;
      timeoutKind?: "first_output" | "idle" | "total";
      responseId?: string;
      finishReason?: "length" | "content_filter";
      providerStatus?: number;
      providerFailure?: "empty" | "malformed";
    },
  ) {
    opsLog("coding.request_rejected", "warn", {
      taskId: job.id,
      phase: failure.phase,
      errorCode: failure.code,
      httpStatus: failure.httpStatus,
    });
    const recorded = await this.db.query(
      `INSERT INTO coding_events(job_id,event_key,payload,delivery)
       SELECT id,$3,$4::jsonb,'suppressed' FROM coding_jobs
       WHERE id=$1 AND attempt_id=$2
       AND (state IN ('provisioning','running') OR ($5='finish' AND state!='queued')) RETURNING id`,
      [
        job.id,
        job.attempt_id,
        `${job.attempt_id}:request-rejected:${randomUUID()}`,
        JSON.stringify({ kind: "worker_request_rejected", ...failure }),
        failure.phase,
      ],
    );
    return recorded.rows.length === 1;
  }
  async call(user: string, run: string, raw: CodingAction) {
    const a = codingAction.parse(raw);
    if (a.operation === "coding_status") return this.status(user, a.id);
    await this.foreground(user, run);
    if (a.operation === "coding_model_set") {
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
    if (a.operation === "coding_models") {
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
          throw new ToolValidationError(
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
        leaderModel:
          this.settings.squad || this.settings.runtime === "pi"
            ? preferred.leader
            : this.settings.leaderModel,
        model: preferred.coder,
        reviewerModel: preferred.reviewer,
      };
      const contextWindows = await this.contextWindows(selected);
      if (contextWindows) Object.assign(selected, { contextWindows });
      // Agent publication is snapshotted only when the separate agent App is configured.
      if (selected.agentGit && !this.agentGit) delete selected.agentGit;
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
          throw new ToolValidationError("Coding request key conflict");
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
        throw new ToolValidationError(
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
        throw new ToolValidationError(
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
      throw new ToolValidationError(
        "Implementation requires confirmed requirements. Use coding_resume to request the confirmation card, or coding_reply in plan mode to revise requirements.",
      );
    if (
      a.operation === "coding_resume" &&
      job.state === "plan_ready" &&
      job.mode === "plan"
    ) {
      if (job.revision !== a.baseRevision)
        throw new ToolValidationError("Coding revision changed");
      return this.requirements.request(job, a.requestKey);
    }
    // Owner asks to continue a parked owner-merge PR: return it to the automation, which
    // re-runs every merge gate (and rebases onto main if needed). Real holds re-park with their reason.
    // A retried identical continue request is answered from its record, whatever the stage is now.
    if (
      a.operation === "coding_resume" &&
      job.state === "pr_ready" &&
      (
        await this.db.query(
          "SELECT 1 FROM coding_events WHERE job_id=$1 AND event_key=$2",
          [job.id, `continue:${a.requestKey}`],
        )
      ).rows.length
    )
      return this.status(user, a.id);
    if (
      a.operation === "coding_resume" &&
      job.state === "pr_ready" &&
      job.settings.prWorkflow === "owner_merge" &&
      (job.stage === "manual_review" || job.stage === "merge_declined")
    ) {
      if (job.revision !== a.baseRevision)
        throw new ToolValidationError(
          "Coding revision changed; read coding_status and retry with the current revision",
        );
      const automation = (
        await this.db.query(
          "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
          [job.id, `automation:${job.revision}`],
        )
      ).rows[0]?.payload;
      // A PR that already merged needs its release inspected, not another pass through the gates.
      if (automation?.mergeSha)
        throw new ToolValidationError(
          `This job's PR already merged as ${automation.mergeSha} (${job.summary}); it cannot continue. Explain the reason; the release must be inspected separately.`,
        );
      const released = await this.db.query(
        `WITH changed AS (UPDATE coding_jobs SET stage='awaiting_ci',summary='Owner asked to continue; re-checking the PR and rebasing onto main if needed',updated_at=now() WHERE id=$1 AND user_id=$2 AND state='pr_ready' AND stage=$3 AND revision=$4 AND (lease IS NULL OR lease_until<now()) RETURNING id),
        -- The waits restart now, so an old stop time does not re-park the job on its first check.
        waits AS (UPDATE coding_events SET payload=jsonb_set(payload,'{waitingSince}',to_jsonb($6::text)) WHERE job_id IN (SELECT id FROM changed) AND event_key='automation:'||$4::int RETURNING job_id)
        INSERT INTO coding_events(job_id,event_key,payload,delivery) SELECT id,$5,jsonb_build_object('summary','Owner asked to continue; the PR returns to automatic checks, rebase and the Merge card.','previousStage',$3::text),'suppressed' FROM changed RETURNING job_id`,
        [
          job.id,
          user,
          job.stage,
          job.revision,
          `continue:${a.requestKey}`,
          this.clock().toISOString(),
        ],
      );
      if (!released.rows.length)
        throw new ToolValidationError(
          "The job changed or is being processed right now; read coding_status and retry",
        );
      return this.status(user, a.id);
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
        throw new ToolValidationError("Coding revision request key conflict");
      return this.status(user, a.id);
    }
    if (
      a.operation === "coding_reply" &&
      job.context.length + message.length + 18 > 24000
    )
      throw new ToolValidationError(
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
      // Nothing was written: a precondition, not an uncertain action, so the turn can continue.
      throw new ToolValidationError(
        job.state !== "pr_ready"
          ? "Coding scope changed, job is active, or sandbox cleanup is pending; inspect status before revising"
          : job.settings.prWorkflow === "owner_merge" &&
              (job.stage === "manual_review" || job.stage === "merge_declined")
            ? `This job's PR stopped for owner attention (${job.summary}). If the owner asks to continue, use coding_resume on this job: it re-runs the merge checks and rebases if needed; holds that still apply (protected files, exhausted allocation, two rebases) come back with their reason.`
            : job.stage === "manual_review" || job.stage === "merge_declined"
              ? `This job's PR stopped for owner attention (${job.summary}). It will not continue automatically and Chief cannot merge it in this state; explain the reason, then the owner can act on GitHub or start a new job.`
              : job.settings.prWorkflow === "owner_merge"
                ? "This job already has a PR and continues on its own: Chief handles Devin and MR feedback, rebases onto main when it moves, re-runs checks and review, then sends the owner a Merge / Keep open card. Nothing to resume or revise; report its stage from coding_status."
                : job.settings.autoMerge
                  ? "This job already has a PR and continues through its automatic merge workflow; report its stage from coding_status."
                  : "This job already has a draft PR; it predates the owner-merge workflow, so it can only be merged on GitHub or replaced by a new job.",
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
    if (!job.sandbox_id && (!includeFinished || active.includes(job.state))) {
      if (job.state === "provisioning")
        throw new SandboxAcknowledgementPending();
      throw new Error("Invalid worker capability");
    }
    return job;
  }
  /** Snapshots catalog context windows for selected Pi models; missing metadata is omitted, never guessed. */
  private async contextWindows(settings: CodingSettings) {
    if (settings.runtime !== "pi" || !this.catalog) return undefined;
    const ids = new Set([
      settings.leaderModel ?? settings.model,
      settings.model,
      settings.reviewerModel,
    ]);
    let found: Record<string, number> = {};
    let errorCode = "metadata_missing";
    try {
      found = Object.fromEntries(
        (await this.catalog())
          .filter(
            (m) =>
              ids.has(m.id) &&
              Number.isSafeInteger(m.contextWindow) &&
              m.contextWindow! >= 1024 &&
              m.contextWindow! <= 100_000_000,
          )
          .map((m) => [m.id, m.contextWindow!]),
      );
    } catch {
      errorCode = "catalog_unavailable";
    }
    // Pi falls back to its own catalog, or 32k for uncatalogued models; make that visible.
    for (const model of ids)
      if (found[model] === undefined)
        opsLog("coding.context_window_unavailable", "warn", {
          model,
          errorCode,
        });
    return Object.keys(found).length ? found : undefined;
  }
  private agentTokens = new Map<string, AgentToken>();
  /** Issues the attempt's single-repository agent token; never for plans, other jobs or unapproved work. */
  async githubToken(job: CodingJob) {
    if (
      !this.agentGit ||
      !job.settings.agentGit ||
      job.mode !== "implement" ||
      job.state !== "running" ||
      !this.allowed(job.user_id) ||
      !(await this.requirements.approved(job)) ||
      new Date(job.attempt_deadline).getTime() <= this.clock().getTime()
    )
      throw new Error("Agent GitHub access unavailable for this attempt");
    const cached = this.agentTokens.get(job.attempt_id);
    if (
      cached &&
      Date.parse(cached.expiresAt) - this.clock().getTime() > 600000
    )
      return cached;
    const issued = await this.agentGit.tokens.issue();
    this.agentTokens.set(job.attempt_id, issued);
    opsLog("coding.agent_token_issued", "info", { taskId: job.id });
    return issued;
  }
  private async revokeAgentToken(attempt: string | null | undefined) {
    const issued = attempt ? this.agentTokens.get(attempt) : undefined;
    if (!issued || !attempt) return;
    this.agentTokens.delete(attempt);
    await this.agentGit?.tokens.revoke(issued.token);
  }
  async assignment(job: CodingJob) {
    // Workers strictly validate settings: windows travel beside them and host-only workflow stays home.
    const {
      contextWindows,
      prWorkflow: _hostOnly,
      agentGit,
      ...settings
    } = job.settings;
    return {
      protocolVersion: 1,
      ...(job.settings.squad || job.settings.runtime === "pi"
        ? { attemptId: job.attempt_id }
        : {}),
      id: job.id,
      revision: job.revision,
      objective: job.objective,
      context: job.context,
      mode: job.mode,
      baseSha: job.base_sha,
      settings,
      ...(contextWindows ? { contextWindows } : {}),
      ...(agentGit && this.agentGit && job.mode === "implement"
        ? {
            agentGit: {
              repository: job.settings.repository,
              branch: `chief/coding-${job.id}`,
              author: this.agentGit.author,
            },
          }
        : {}),
      checkpoint: job.checkpoint,
      deadline: new Date(job.attempt_deadline).toISOString(),
      usedModels: job.used_models,
    };
  }
  piSessionAppend(job: CodingJob, raw: unknown) {
    return new PiSessions(this.db, this.resultKey()).append(job, raw);
  }
  piSessionRead(job: CodingJob, scope: string, offset: number) {
    return new PiSessions(this.db, this.resultKey()).read(job, scope, offset);
  }
  async heartbeat(job: CodingJob) {
    const feedback = (
      await this.db.query(
        "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
        [job.id, `feedback:${job.revision}`],
      )
    ).rows[0]?.payload;
    const activeMs = Math.min(
      feedback?.remainingMs ?? job.settings.limits.ms,
      this.activeMs(job),
    );
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
  private validateReportCheckpoint(job: CodingJob, c: Checkpoint) {
    const document = c.piState?.reportDocument;
    if (
      job.settings.runtime !== "pi" &&
      (document ||
        c.piState?.reportFailure ||
        (c.piState?.findings?.length ?? 0) > 6000)
    )
      throw new Error("Pi report state requires the Pi runtime");
    if (c.piState?.phase === "review") {
      const candidate = c.piState.reviewCandidate;
      if (
        job.settings.runtime !== "pi" ||
        job.mode !== "implement" ||
        !c.files.length ||
        !c.piState.reviewRound ||
        !candidate ||
        candidate.hash !== artifactHash(c) ||
        ["npm run check", "npm run build", "npm run format:check"].some(
          (command) =>
            !candidate.checks.some(
              (check) => check.command === command && check.exitCode === 0,
            ),
        )
      )
        throw new Error(
          "Review recovery requires the exact checked Pi candidate",
        );
      const identity = (intent: string, value: string) =>
        createHash("sha256")
          .update(
            canonicalJson({
              objective: job.objective,
              context: job.context,
              plan: c.plan,
              base: job.base_sha,
              intent,
              hash: value,
            }),
          )
          .digest("hex");
      if (
        c.piState.scopeIdentity !== identity("review", candidate.hash) ||
        c.piState.sessionScope !==
          identity(
            "review-session",
            `${candidate.hash}:${c.piState.reviewRound}`,
          )
      )
        throw new Error(
          "Review session must match the candidate, scope and round",
        );
    }
    if (document?.kind === "plan" && document.detail !== c.plan)
      throw new Error("Plan document must match the complete saved plan");
    if (
      document?.kind === "review" &&
      document.verdict === "REQUEST_CHANGES" &&
      document.detail !== c.piState?.findings
    )
      throw new Error("Review document must match the saved findings");
  }
  async save(job: CodingJob, raw: unknown) {
    const c = checkpoint.parse(raw);
    this.validateReportCheckpoint(job, c);
    if (
      job.mode === "implement" &&
      (c.plan !== job.checkpoint.plan ||
        !(await this.requirements.approved(job)))
    )
      throw new Error(
        "Approved requirements are immutable; revise and confirm a new plan first",
      );
    validateFiles(c.files);
    if (
      job.settings.runtime === "pi" &&
      (!c.piState ||
        c.piState.toolsUsed < (job.checkpoint.piState?.toolsUsed ?? 0) ||
        c.piState.toolsUsed > job.settings.limits.tools ||
        c.squadState ||
        c.runtimeMemory)
    )
      throw new Error("Pi checkpoint allocation/state is invalid");
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
    this.validateReportCheckpoint(job, r.checkpoint);
    if (
      job.settings.runtime !== "pi" &&
      (r.review?.findings.length ?? 0) > 8000
    )
      throw new Error("Legacy review findings exceed the supported bound");
    validateFiles(r.checkpoint.files);
    const reported = r.checkpoint.piState?.reportDocument;
    if (
      r.kind === "candidate" &&
      reported &&
      (reported.kind !== "review" ||
        reported.verdict !== "APPROVE" ||
        reported.detail !== r.review?.findings)
    )
      throw new Error(
        "Candidate verdict must match the acknowledged complete review document",
      );
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
        !!r.published !== !!(job.settings.agentGit && this.agentGit) ||
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
    // The attempt is over: its agent token no longer has a purpose.
    await this.revokeAgentToken(job.attempt_id);
    return { accepted: true };
  }
  async generate(
    job: CodingJob,
    input: {
      callId: string;
      role: "leader" | "coder" | "reviewer";
      messages: ModelMessage[];
      tools: ToolDefinition[];
      maxOutputTokens?: number;
      purpose?: "agent" | "compaction";
      retryOf?: string;
    },
  ) {
    if (
      input.retryOf !== undefined &&
      (job.settings.runtime !== "pi" ||
        !z.string().uuid().safeParse(input.retryOf).success)
    )
      throw new Error("Invalid generation recovery parent");
    if (
      input.maxOutputTokens !== undefined &&
      (job.settings.runtime !== "pi" ||
        !Number.isSafeInteger(input.maxOutputTokens) ||
        input.maxOutputTokens < 1)
    )
      throw new Error("Invalid per-call output allowance");
    if (
      input.purpose !== undefined &&
      (job.settings.runtime !== "pi" ||
        !["agent", "compaction"].includes(input.purpose))
    )
      throw new Error("Invalid model request purpose");
    if (
      input.role === "leader" &&
      !job.settings.squad &&
      job.settings.runtime !== "pi"
    )
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
    if (input.retryOf) {
      const parent = (
        await this.db.query(
          `SELECT p.* FROM coding_model_calls p WHERE p.id=$1 AND p.job_id=$2 AND p.attempt_id=$3 AND p.state='uncertain'
         AND NOT (p.input ? 'retryOf') AND EXISTS (
           SELECT 1 FROM coding_events e WHERE e.job_id=p.job_id
           AND e.payload->>'kind'='worker_request_rejected' AND e.payload->>'callId'=p.id::text
           AND ((e.payload->>'code'='model_rate_limited' AND e.payload->>'providerStatus'='429')
             OR (e.payload->>'code'='model_transient_failure' AND e.payload->>'providerStatus' IN ('500','502','503','504')))
           AND NOT (e.payload ? 'timeoutKind' OR e.payload ? 'finishReason' OR e.payload ? 'providerFailure'))`,
          [input.retryOf, job.id, job.attempt_id],
        )
      ).rows[0];
      const original = { ...input, callId: input.retryOf };
      delete original.retryOf;
      if (!parent || parent.request_hash !== hash(original))
        throw new Error("Generation recovery parent or payload does not match");
    }
    const cancellation = new AbortController();
    if (this.inFlightModels.has(input.callId))
      throw new Error("Model call is already in flight");
    this.inFlightModels.set(input.callId, {
      jobId: job.id,
      controller: cancellation,
    });
    let admitted = false;
    let received = false;
    const started = Date.now();
    const enhanced =
      job.settings.harnessVersion === 2 || job.settings.runtime === "pi";
    const total = AbortSignal.timeout(
      Math.max(
        1,
        Math.min(
          enhanced ? 300000 : 120000,
          new Date(job.attempt_deadline).getTime() - this.clock().getTime(),
        ),
      ),
    );
    const idle = new AbortController();
    let timeoutKind: "first_output" | "idle" | "total" = "first_output";
    let responseId: string | undefined;
    let progressSavedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => idle.abort(), ms);
      timer.unref();
    };
    if (enhanced) arm(120000);
    try {
      const claimed = await this.db.query(
        `WITH claimed AS (UPDATE coding_jobs SET used_models=used_models+1,model_busy=true WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running') AND NOT model_busy AND used_models<$3 AND attempt_deadline>$4
         AND ($9::text IS NULL OR NOT EXISTS (SELECT 1 FROM coding_model_calls WHERE job_id=$1 AND attempt_id=$2 AND input->>'retryOf'=$9)) RETURNING id)
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
          input.retryOf ?? null,
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
        ...(job.settings.runtime === "pi"
          ? {
              requireComplete: true,
              maxOutputTokens: Math.min(
                input.maxOutputTokens ?? job.settings.maxOutputTokens ?? 8000,
                job.settings.maxOutputTokens ?? 8000,
              ),
            }
          : {}),
        signal: AbortSignal.any([cancellation.signal, total, idle.signal]),
        ...(enhanced
          ? {
              stream: true,
              onProgress: async (value: {
                responseId?: string;
                provider?: string;
                bytes: number;
              }) => {
                if (
                  received ||
                  cancellation.signal.aborted ||
                  total.aborted ||
                  idle.signal.aborted
                )
                  return;
                timeoutKind = "idle";
                responseId = value.responseId?.slice(0, 160);
                arm(90000);
                if (Date.now() - progressSavedAt < 10000) return;
                progressSavedAt = Date.now();
                const telemetryWrite = this.db.query(
                  `INSERT INTO coding_events(job_id,event_key,payload,delivery) SELECT id,$3,$4::jsonb,'suppressed' FROM coding_jobs WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running')`,
                  [
                    job.id,
                    job.attempt_id,
                    `${job.attempt_id}:model-progress:${randomUUID()}`,
                    JSON.stringify({
                      kind: "model_progress",
                      role: input.role,
                      callId: input.callId,
                      responseId,
                      provider: value.provider?.slice(0, 100),
                      elapsedMs: Date.now() - started,
                      receivedBytes: value.bytes,
                    }),
                  ],
                );
                // Optional telemetry must not hold the stream reader indefinitely.
                let telemetryTimer: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([
                  telemetryWrite.catch(() => {}),
                  new Promise<void>((resolve) => {
                    telemetryTimer = setTimeout(resolve, 1000);
                    telemetryTimer.unref();
                  }),
                ]);
                if (telemetryTimer) clearTimeout(telemetryTimer);
              },
            }
          : {}),
        cacheKey: `coding:${job.id}:${job.revision}:${input.role}`,
      });
      received = true;
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
            ...(input.purpose ? { purpose: input.purpose } : {}),
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
      if (admitted && !received) {
        let code: CodingFailureCode | undefined;
        if (cancellation.signal.aborted) code = "model_cancelled";
        else if (total.aborted || idle.signal.aborted) {
          code = "model_timeout";
          if (total.aborted) timeoutKind = "total";
        } else if (
          (enhanced || job.settings.runtime === "pi") &&
          error instanceof ModelError
        ) {
          code =
            error.diagnostics.failureCode === "incomplete" ||
            error.diagnostics.finishReason === "length"
              ? "model_incomplete"
              : error.diagnostics.httpStatus === 429
                ? "model_rate_limited"
                : ["transport", "disconnected"].includes(
                      String(error.diagnostics.failureCode),
                    )
                  ? "model_disconnected"
                  : error.transient &&
                      (Number(error.diagnostics.httpStatus) >= 500 ||
                        ["provider", "empty"].includes(
                          String(error.diagnostics.failureCode),
                        ))
                    ? "model_transient_failure"
                    : "model_provider_failed";
        }
        if (code)
          throw new CodingModelFailure(code, {
            elapsedMs: Date.now() - started,
            callId: input.callId,
            ...(error instanceof ModelError &&
            (error.diagnostics.failureCode === "empty" ||
              error.diagnostics.failureCode === "malformed")
              ? { providerFailure: error.diagnostics.failureCode }
              : {}),
            ...(code === "model_timeout" ? { timeoutKind } : {}),
            ...(responseId ? { responseId } : {}),
            ...(error instanceof ModelError &&
            Number.isInteger(error.diagnostics.httpStatus) &&
            Number(error.diagnostics.httpStatus) >= 400 &&
            Number(error.diagnostics.httpStatus) <= 599
              ? { providerStatus: Number(error.diagnostics.httpStatus) }
              : {}),
            ...(["length", "content_filter"].includes(
              String(
                error instanceof ModelError
                  ? error.diagnostics.finishReason
                  : "",
              ),
            )
              ? {
                  finishReason: (error as ModelError).diagnostics
                    .finishReason as "length" | "content_filter",
                }
              : {}),
          });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.inFlightModels.delete(input.callId);
      if (admitted)
        await this.db.query(
          "UPDATE coding_jobs SET model_busy=false WHERE id=$1 AND attempt_id=$2",
          [job.id, job.attempt_id],
        );
    }
  }
  private async stopped(
    j: CodingJob,
    summary: string,
    attempted = true,
    sandboxId?: string,
    /** Only the transient causes in TRANSIENT_PAUSES make a pause eligible for the one automatic retry. */
    cause?: PauseCause,
  ) {
    this.abortModels(j.id);
    await this.db.query(
      `WITH changed AS (UPDATE coding_jobs SET state=CASE WHEN state IN ('provisioning','running') THEN 'paused' ELSE state END,summary=CASE WHEN state IN ('provisioning','running') THEN $3 ELSE summary END,sandbox_id=COALESCE($6::text,sandbox_id),cleanup=CASE WHEN state IN ('provisioning','running') THEN CASE WHEN $5 THEN 'pending' ELSE 'none' END ELSE cleanup END,model_busy=false,updated_at=now() WHERE id=$1 AND attempt_id=$2 AND (state IN ('provisioning','running') OR ($6::text IS NOT NULL AND state IN ('paused','cancelled') AND cleanup='pending')) RETURNING id,state)
      INSERT INTO coding_events(job_id,event_key,payload) SELECT id,$4,jsonb_build_object('summary',$3::text) || CASE WHEN $7::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cause',$7::text) END FROM changed WHERE state='paused' ON CONFLICT DO NOTHING`,
      [
        j.id,
        j.attempt_id,
        summary,
        `${j.attempt_id}:paused`,
        attempted,
        sandboxId ?? null,
        cause ?? null,
      ],
    );
  }
  /** Revokes agent tokens whose attempt is no longer running (timeout, stop, cancel, crash). */
  private async sweepAgentTokens() {
    for (const attempt of [...this.agentTokens.keys()]) {
      const live = await this.db.query(
        "SELECT 1 FROM coding_jobs WHERE attempt_id=$1 AND state IN ('provisioning','running')",
        [attempt],
      );
      if (!live.rows.length) await this.revokeAgentToken(attempt);
    }
  }
  /**
   * The owner's one automatic retry for a classified transient pause (owner-approved
   * 17 October 2026; AGENTS.md exception). Eligible pauses: the host saw the sandbox stop
   * without a stated reason or lose its heartbeat, or the worker paused after its latest
   * model request was rejected as a provider 429 or 5xx (the same predicate generation
   * recovery trusts). Re-queues through the same guarded update as coding_resume, keyed
   * auto-retry:<attempt> so it is idempotent, and never again for a revision that an
   * automatic retry created. Publication, pending cleanup, leases and revoked owners block it.
   */
  async autoRetryOnce() {
    if (this.settings.autoRetryTransientOnce === false) return;
    const j = (
      await this.db.query(
        `SELECT j.* FROM coding_jobs j
         WHERE j.state='paused' AND NOT j.publication_started AND j.cleanup IN ('none','complete')
           AND (j.lease IS NULL OR j.lease_until<now()) AND j.attempt_id IS NOT NULL
           AND j.updated_at < now() - interval '2 minutes' AND j.updated_at > now() - interval '1 day'
           AND NOT EXISTS(SELECT 1 FROM coding_revisions v WHERE v.job_id=j.id AND v.revision=j.revision
             AND v.request_key LIKE 'auto-retry:%')
           AND NOT EXISTS(SELECT 1 FROM coding_revisions v WHERE v.job_id=j.id
             AND v.request_key='auto-retry:'||j.attempt_id::text)
           AND (EXISTS(SELECT 1 FROM coding_events e WHERE e.job_id=j.id
                  AND e.event_key=j.attempt_id::text||':paused'
                  AND e.payload->>'cause' IN ('sandbox_stopped','heartbeat_lost'))
             OR (EXISTS(SELECT 1 FROM coding_events e WHERE e.job_id=j.id
                  AND e.event_key=j.attempt_id::text||':finished')
               AND (SELECT (p.payload->>'code'='model_rate_limited' AND p.payload->>'providerStatus'='429'
                         OR p.payload->>'code'='model_transient_failure'
                            AND p.payload->>'providerStatus' IN ('500','502','503','504'))
                       AND NOT (p.payload ? 'timeoutKind' OR p.payload ? 'finishReason' OR p.payload ? 'providerFailure')
                    FROM coding_events p WHERE p.job_id=j.id
                      AND p.event_key LIKE j.attempt_id::text||':request-rejected:%'
                      AND p.payload->>'kind'='worker_request_rejected'
                    ORDER BY p.created_at DESC,p.id DESC LIMIT 1)))
         ORDER BY j.updated_at LIMIT 1`,
      )
    ).rows[0] as CodingJob | undefined;
    if (!j || !this.allowed(j.user_id)) return;
    const key = `auto-retry:${j.attempt_id}`;
    const message =
      "Automatic retry after a transient fault (the sandbox stopped, its heartbeat was lost, or the model provider failed temporarily)";
    const retried = await this.db.query(
      `WITH changed AS (
      UPDATE coding_jobs SET revision=revision+1,state='queued',stage='queued',question='',result=NULL,attempt_id=NULL,sandbox_id=NULL,heartbeat_at=NULL,attempt_deadline=NULL,used_models=0,model_busy=false,publication_started=false,lease=NULL,lease_until=NULL,summary='Retrying once automatically after a transient fault',updated_at=now()
      WHERE id=$1 AND revision=$2 AND state='paused' AND NOT publication_started AND cleanup IN ('none','complete') AND (lease IS NULL OR lease_until<now()) RETURNING id,revision,mode
    ), revised AS (
      INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) SELECT id,revision,$3,$4,mode FROM changed RETURNING job_id
    ) INSERT INTO coding_events(job_id,event_key,payload) SELECT job_id,$3,jsonb_build_object('summary','Retrying once automatically after a transient fault. If it pauses again, it will wait for you.') FROM revised RETURNING job_id`,
      [j.id, j.revision, key, message],
    );
    if (retried.rows.length) opsLog("coding.auto_retry", "info", { ref: j.id });
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    await this.sweepAgentTokens().catch(() => {});
    await this.autoRetryOnce().catch((error) =>
      opsLog("coding.auto_retry_failed", "warn", errorFields(error)),
    );
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
              Math.ceil(this.activeMs(j) / 60000) + 5,
            ),
          });
          await this.db.query(
            "UPDATE coding_jobs SET sandbox_id=$3 WHERE id=$1 AND attempt_id=$2",
            [j.id, j.attempt_id, id],
          );
        } catch (error) {
          if (error instanceof SandboxTimeoutMismatch) {
            // Preserve the created identity and revoke dispatch atomically.
            await this.stopped(j, error.message, true, error.sandboxId);
          } else {
            await this.stopped(
              j,
              "Sandbox provisioning acknowledgement is uncertain; reconciling before any new attempt",
            );
          }
        }
        return;
      }
      if (!j.sandbox_id) {
        let found: string | undefined;
        try {
          found = await this.provider.find(
            j.attempt_id,
            active.includes(j.state)
              ? Math.max(5, Math.ceil(this.activeMs(j) / 60000) + 5)
              : undefined,
          );
        } catch (error) {
          if (
            error instanceof SandboxTimeoutMismatch &&
            active.includes(j.state)
          ) {
            await this.stopped(j, error.message, true, error.sandboxId);
            return;
          }
          throw error;
        }
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
        if (!this.allowed(j.user_id))
          await this.stopped(j, "Owner access revoked; saved work is retained");
        else if (state === "terminal" && this.provider.terminalReason) {
          const reason = await this.provider
            .terminalReason(j.sandbox_id)
            .catch(() => undefined);
          const expired =
            new Date(j.attempt_deadline).getTime() <= this.clock().getTime();
          await this.stopped(
            j,
            reason ??
              (expired
                ? "Sandbox exited without a result and its allocated deadline has expired; stopping cause is unconfirmed, saved work is retained"
                : "Sandbox stopped before a result was recorded; saved work is retained"),
            true,
            undefined,
            // A provider-stated reason is not classified as transient.
            reason || expired ? undefined : "sandbox_stopped",
          );
        } else if (
          new Date(j.attempt_deadline).getTime() <= this.clock().getTime()
        )
          await this.stopped(
            j,
            state === "terminal"
              ? "Sandbox exited without a result and its allocated deadline has expired; stopping cause is unconfirmed, saved work is retained"
              : "Allocated coding time expired while the sandbox was still active; saved work is retained",
          );
        else if (state === "terminal")
          await this.stopped(
            j,
            "Sandbox stopped before a result was recorded; saved work is retained",
            true,
            undefined,
            "sandbox_stopped",
          );
        else if (
          this.clock().getTime() - new Date(j.heartbeat_at).getTime() >
          180000
        )
          await this.stopped(
            j,
            "Worker heartbeat was lost before verified completion; saved work is retained",
            true,
            undefined,
            "heartbeat_lost",
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
        let published: { url: string; head: string; tree?: string };
        try {
          published =
            fresh.settings.agentGit && fresh.result?.published
              ? await this.publisher.verifyAgentPublication!(
                  fresh,
                  fresh.result.published,
                )
              : await this.publisher.publish(fresh);
        } catch (error) {
          if (!(error instanceof AgentPublicationMismatch)) throw error;
          // A PR that is not the reviewed artifact is never retried or recorded.
          await this.db.query(
            "UPDATE coding_jobs SET state='paused',stage='paused',publication_started=false,summary=$2,updated_at=now() WHERE id=$1 AND state='publishing'",
            [
              j.id,
              "Agent PR does not match the independently reviewed artifact; inspect it, then resume to republish the reviewed candidate or cancel",
            ],
          );
          return;
        }
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
              : j.settings.prWorkflow
                ? "Draft PR prepared; collecting CI, Devin and MR feedback before asking the owner to merge."
                : "Draft PR prepared; CI and independent review of its head remain required.",
          ],
        );
        if ((j.settings.autoMerge || j.settings.prWorkflow) && published.tree) {
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
      approval?: import("./delivery.js").CodingApproval,
      document?: import("./delivery.js").CodingDocument,
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
        const merge = e.payload.merge;
        if (
          !this.allowed(j.user_id) ||
          (merge &&
            (j.state !== "pr_ready" ||
              j.stage !== "awaiting_merge_approval" ||
              j.revision !== merge.revision ||
              j.head_sha !== merge.head)) ||
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
        const attachment =
          req && j.settings.runtime === "pi"
            ? {
                filename: `coding-plan-r${req.revision}.md`,
                content: `# Coding requirements — revision ${req.revision}\n\n## Original request\n${j.objective}\n\n## Context\n${j.context}\n\n## Complete plan\n${req.plan}\n\n## Execution\nPlanner: ${j.settings.leaderModel ?? j.settings.model}\nCoder: ${j.settings.model}\nReviewer: ${j.settings.reviewerModel}\nDraft PR for owner review.\n\nScope: ${req.scope}\nJob: ${e.job_id}\n`,
              }
            : undefined;
        const summaryPreview = Array.from(String(j.summary ?? ""))
          .slice(0, 180)
          .join("");
        const caption = attachment
          ? `**Coding plan — revision ${req.revision}**\n\n${summaryPreview}\n\nThe complete plan and original request are attached. Review the document, then approve the requirements or request changes. You can also reply yes directly to this message. Confirmation stays valid for 24 hours.\n\nJob: ${e.job_id}`
          : undefined;
        attempted = true;
        const sent = await send(
          j.user_id,
          codingDestination(e.payload),
          caption ??
            [
              req
                ? `**Coding plan — revision ${req.revision}**`
                : `Coding job ${e.job_id}`,
              !req && typeof e.payload.summary === "string"
                ? e.payload.summary.slice(0, 1500)
                : undefined,
              typeof e.payload.question === "string"
                ? e.payload.question.slice(0, 2000)
                : undefined,
              e.payload.url,
              req ? req.plan : undefined,
              req
                ? `**Execution**\nLeader: ${j.settings.leaderModel ?? j.settings.model}\nCoder: ${j.settings.model}\nReviewer: ${j.settings.reviewerModel}\n${j.settings.autoMerge ? "Ordinary changes may merge after exact-artifact review and GitHub checks; protected changes stop for explicit review." : "Draft PR for owner review."}\n\nApprove this scope, or reply directly to this message with yes. To revise it, tell Chief what to change. Confirmation stays valid for 24 hours.\nJob: ${e.job_id}`
                : undefined,
            ]
              .filter(Boolean)
              .join("\n\n"),
          req
            ? { kind: "requirements", id: e.id }
            : merge
              ? { kind: "merge", id: e.id }
              : undefined,
          attachment,
        );
        if (req || merge) {
          const receipt = sent as { message_id?: number } | undefined;
          if (
            !Number.isSafeInteger(receipt?.message_id) ||
            receipt!.message_id! <= 0
          )
            throw new Error("Requirement delivery receipt unavailable");
          // A merge card stays valid only while the job remains at that exact head.
          await this.db.query(
            "UPDATE coding_events SET payload=payload || jsonb_build_object('telegramMessageId',$2::bigint,'confirmUntil',$3::text) WHERE id=$1",
            [
              e.id,
              receipt!.message_id,
              new Date(
                this.clock().getTime() + (merge ? 7 * 86400000 : 86400000),
              ).toISOString(),
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
