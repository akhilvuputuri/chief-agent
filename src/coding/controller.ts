import { ToolValidationError } from "../tool-errors.js";
import { PiSessions } from "./pi-sessions.js";
import { z } from "zod";
import { reviewMetadata, completePlanDelivered } from "./review-proof.js";
import { CodingAutomation } from "./automation.js";
import { codingDiagnostics } from "./diagnostics.js";
import {
  modelPreferences,
  setModelPreference,
  assertEligibleModel,
  type CodingCatalog,
} from "./model-settings.js";
import { assertSquadCheckpoint } from "./squad-state.js";
import { codingDestination } from "./delivery-routing.js";
import {
  StatusMessageGone,
  fitStatus,
  inQuietHours,
  statusLine,
  type QuietHours,
  type StatusAnchor,
  type StatusLine,
} from "./notices.js";
import {
  CodingRequirements,
  requirementScope,
  startCard,
} from "./requirements.js";
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
  modelCallTimeoutMs,
  outputAllowance,
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
  WorkerRefused,
  type SandboxProvider,
  type SandboxRequest,
} from "./provider.js";
import { scrubTrace } from "../trace-scrub.js";
import { storable } from "../storable.js";
import { ownerProgress } from "./progress-text.js";
import { seal, open } from "../secret-box.js";
import { errorFields, opsLog } from "../ops-log.js";
import { ModelError } from "../model.js";
import Anthropic from "@anthropic-ai/sdk";
import { anthropicUsage, type AnthropicPrices } from "../anthropic.js";
import {
  assembleStream,
  messagesRequest,
  piBetas,
  refusal,
  relayedError,
  upstreamFailureCode,
  type CodingAnthropic,
  type MessagesReply,
} from "./pi-messages.js";
import { rejectionReason } from "./rejection-reason.js";
import { CodingModelFailure, type CodingFailureCode } from "./model-failure.js";
import { boxView } from "./box-sandbox.js";
import { runtimeMemory } from "./memory-schema.js";

/**
 * Worker text (plans, findings, check output, summaries) is made storable: Postgres
 * refuses NUL and lone surrogates (journal 155). Code is published byte for byte, a
 * report document is bound to its hash, and review findings are compared with the exact
 * sealed reply, so any of these that is not storable text is refused, never changed.
 * Current Pi workers refuse such files and documents before sending them.
 */
function storableCheckpoint<T extends Checkpoint>(c: T, findings?: string): T {
  const document = c.piState?.reportDocument;
  const exact = {
    patch: c.patch,
    files: c.files,
    findings: findings ?? null,
    // Text the host compares with the document must not lose characters either.
    ...(document
      ? { document, plan: c.plan, reviewFindings: c.piState?.findings ?? null }
      : {}),
  };
  if (canonicalJson(storable(exact)) !== canonicalJson(exact))
    throw new Error("Exact content is not storable text");
  return storable(c);
}

const active = ["provisioning", "running"];
/** Why the host paused an attempt. Only sandbox_stopped and heartbeat_lost are transient. */
export type PauseCause = "sandbox_stopped" | "heartbeat_lost";
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalJson(v)).digest("hex");
/** The longest one Pi attempt runs, inside the box task's four-hour deadline. */
const PI_ATTEMPT_MS = 10_800_000;
/** The identity a Pi worker derives for a phase or session of this job's approved work. */
const piIdentity = (
  job: CodingJob,
  plan: string,
  intent: string,
  value: string,
) =>
  hash({
    objective: job.objective,
    context: job.context,
    plan,
    base: job.base_sha,
    intent,
    hash: value,
  });
/**
 * Progress-only coding notices (`e` a coding_events row, `j` its job), folded into the
 * status message: worker progress, automatic retry/rebase/feedback re-queues, the approved
 * candidate of the job's current attempt (its PR notice follows) and a PR rebuilt at an
 * already announced URL. Questions, approval cards, cancellations, pauses, failures and
 * outcomes are separate messages; so is any notice this list does not name.
 */
const STATUS_NOTICE = `(e.event_key NOT IN ('cancelled','status-message')
  AND NOT (e.payload ? 'requirements' OR e.payload ? 'merge' OR COALESCE(e.payload->>'question','')<>'')
  AND ((e.payload ? 'stage' AND e.payload ? 'key' AND NOT e.payload ? 'url')
    OR e.event_key LIKE 'auto-retry:%' OR e.event_key LIKE 'rebase:%' OR e.event_key LIKE 'mr-feedback:%'
    OR (e.event_key=j.attempt_id::text||':finished' AND j.result->>'kind'='candidate')
    OR (e.event_key LIKE '%:pr' AND EXISTS(SELECT 1 FROM coding_events p WHERE p.job_id=e.job_id AND p.id<>e.id
      AND p.event_key LIKE '%:pr' AND p.created_at<e.created_at AND p.payload->>'url'=e.payload->>'url'))))`;
/** Hours a job may wait before the model must state the owner's explicit request to restart it. */
const STALE_HOURS = 24;
/** Jobs a coding_resume or coding_reply can requeue (with a matching revision). */
const RESTARTABLE =
  "state IN ('plan_ready','awaiting_input','paused','failed') AND NOT publication_started AND cleanup IN ('none','complete') AND (lease IS NULL OR lease_until<now())";
/** Owner-merge PRs stopped for the owner, which coding_resume returns to automation. */
const CONTINUABLE =
  "state='pr_ready' AND settings->>'prWorkflow'='owner_merge' AND stage IN ('manual_review','merge_declined') AND (lease IS NULL OR lease_until<now())";
/** Why coding_cancel left a job as it was, and what the owner can do instead. */
export function cancelRefusal(job: {
  state: string;
  stage?: string | null;
  pr_url?: string | null;
  merge_flow?: string | null;
}) {
  if (job.state === "pr_ready") {
    if (job.stage === "merged_on_github" || job.stage === "closed_on_github")
      return `Nothing to cancel: this job's PR (${job.pr_url}) was already ${job.stage === "merged_on_github" ? "merged" : "closed"} on GitHub, so the job is finished. It holds no worker and needs nothing from the owner.`;
    if (
      job.stage === "merging" ||
      job.stage === "release_pending" ||
      job.stage === "deployed"
    )
      return `Not cancelled: this job's PR is already ${job.stage === "merging" ? "merging" : "merged"} (stage ${job.stage}), so the job cannot be cancelled. Report its stage from coding_status; undoing a merged change needs a new job.`;
    const pr = job.pr_url ? ` (${job.pr_url})` : "";
    return `Not cancelled: this job already published a PR${pr}, so it stays pr_ready with that PR. Chief has no tool to close pull requests. Tell the owner it was not cancelled. ${
      job.stage === "merge_approved"
        ? "The owner already approved its merge, so Chief will merge it; to stop that, the owner closes the PR on GitHub now."
        : job.merge_flow === "owner_merge"
          ? "To abandon it, the owner closes the PR on GitHub; it never merges without the owner's tap on its Merge card."
          : "To abandon it, the owner closes the PR on GitHub; it is a draft PR that only the owner can merge there."
    } Once the PR is merged or closed on GitHub, Chief marks this job finished.`;
  }
  return `Not cancelled: the job is ${job.state}${job.stage ? ` (stage ${job.stage})` : ""}. Read coding_status and retry only if its state changed.`;
}
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
    // Per-attempt operational ceiling. Pi attempts run in EC2 boxes, whose task deadline is
    // four hours; three hours leaves ample room for the worker's start inside it. (It was
    // 40 minutes under CodeBuild's 45-minute cap.) Legacy runtimes keep their allocation.
    return Math.min(
      job.settings.limits.ms,
      job.settings.runtime === "pi" ? PI_ATTEMPT_MS : job.settings.limits.ms,
    );
  }
  private automation?: CodingAutomation;
  /** Resolves when a job's current Pi model call frees its slot. */
  private piSlots = new Map<string, Promise<void>>();
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
    /** Pi jobs call Claude only through this direct Anthropic route (journal 190). */
    private anthropic?: CodingAnthropic,
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
        // The sealed result is the message Anthropic returned (journal 190).
        if (
          response.content?.some(
            (b: any) =>
              b?.type === "tool_use" &&
              b.name === "report" &&
              b.input?.kind === "review" &&
              b.input.verdict === "APPROVE" &&
              b.input.detail === document.detail,
          )
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
        `SELECT id,revision,objective,mode,state,stage,summary,question,base_sha,pr_url,head_sha,cleanup,publication_started,used_models,settings->'limits' AS limits,settings->>'leaderModel' AS leader_model,settings->>'model' AS coder_model,settings->>'reviewerModel' AS reviewer_model,settings->>'prWorkflow' AS merge_flow,updated_at,checkpoint->'runtimeMemory' AS runtime_memory,checkpoint->'squadState'->>'phase' AS runtime_phase,(SELECT max(created_at) FROM coding_events e WHERE e.job_id=coding_jobs.id AND e.payload->>'kind' IN ('squad_handoff','checkpoint')) AS checkpoint_at FROM coding_jobs WHERE user_id=$1 ${id ? "AND id=$2" : ""} ORDER BY created_at DESC LIMIT 20`,
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
        "SELECT checkpoint,attempt_id,sandbox_id FROM coding_jobs WHERE user_id=$1 AND id=$2",
        [user, id],
      )
    ).rows[0];
    // Only a `box:` attempt has a box view; a job on an older sandbox keeps its old output.
    const box = await boxView(this.db, stored.sandbox_id, user);
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
      ...(box ? { box } : {}),
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
      /** The status the worker got back: the host's own, or Anthropic's when relayed. */
      httpStatus: number;
      /** A fixed reason code for a generic rejection (src/coding/rejection-reason.ts). */
      reason?: string;
      elapsedMs?: number;
      callId?: string;
      timeoutKind?: "first_output" | "idle" | "total";
      responseId?: string;
      finishReason?: "length" | "content_filter";
      providerStatus?: number;
      providerFailure?: "empty" | "malformed" | "refusal";
      refusalCategory?: string;
    },
  ) {
    opsLog("coding.request_rejected", "warn", {
      taskId: job.id,
      phase: failure.phase,
      errorCode: failure.code,
      httpStatus: failure.httpStatus,
      ...(failure.reason ? { reason: failure.reason } : {}),
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
        JSON.stringify(
          storable({ kind: "worker_request_rejected", ...failure }),
        ),
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
      this.assertDirectPiModels(
        {
          runtime: this.settings.runtime,
          model: a.model,
          reviewerModel: a.model,
        },
        "No setting was changed.",
      );
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
    if (a.operation === "coding_job_update") return this.updateJob(user, a);
    if (a.operation === "coding_models") {
      const preferences = await modelPreferences(this.db, user, this.settings);
      return {
        preferences,
        appliesTo: "new jobs only",
        bounded: true,
        notice:
          "The catalog shows up to 100 eligible models; setting an exact ID validates the full live catalog. Existing jobs keep their models unless changed with coding_job_update.",
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
      if (!this.settings.image)
        throw new Error("Coding runtime image is not configured");
      const fingerprint = hash({
        objective: a.objective,
        context: a.context,
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
        // Only the legacy squad has a leader; a Pi job is one coder and one reviewer (journal 191).
        leaderModel: this.settings.squad
          ? preferred.leader
          : this.settings.runtime === "pi"
            ? undefined
            : this.settings.leaderModel,
        model: preferred.coder,
        reviewerModel: preferred.reviewer,
      };
      if (selected.leaderModel === undefined) delete selected.leaderModel;
      this.assertDirectPiModels(selected, "No job was started.");
      // Agent publication is snapshotted only when the separate agent App is configured.
      if (selected.agentGit && !this.agentGit) delete selected.agentGit;
      const id = randomUUID();
      // The job waits for the owner's Start (journal 191): no box, no model and no tick work
      // until then. Its first Start card is written in the same statement.
      const waiting = {
        id,
        objective: a.objective,
        context: a.context,
        revision: 1,
        checkpoint: { plan: "", patch: "", summary: "", files: [] },
      } as unknown as CodingJob;
      const made = await this.db.query(
        `WITH made AS (
        INSERT INTO coding_jobs(id,user_id,request_key,request_hash,origin_run,thread_id,objective,context,mode,state,stage,summary,checkpoint,base_sha,settings)
        SELECT $1,$2,$3,$4,$5,(SELECT (metadata->>'threadId')::bigint FROM conversation_inputs WHERE user_id=$2 AND run_id=$5 ORDER BY ordinal LIMIT 1),$6,$7,'plan','plan_ready','awaiting_start','Waiting for the owner to tap Start',$8::jsonb,$9,$10::jsonb
        ON CONFLICT(user_id,request_key) DO NOTHING RETURNING id
      ), revised AS (
        INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) SELECT id,1,$3,$6,'plan' FROM made RETURNING job_id
      ) INSERT INTO coding_events(job_id,event_key,payload) SELECT job_id,'requirements:1:start',$11::jsonb FROM revised RETURNING job_id`,
        [
          id,
          user,
          a.requestKey,
          fingerprint,
          run,
          a.objective,
          a.context,
          JSON.stringify(waiting.checkpoint),
          base,
          JSON.stringify(selected),
          JSON.stringify(startCard(waiting)),
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
      // Its PR may already be gone on GitHub, which finishes the job. A failed read changes nothing.
      const parked = (
        await this.db.query(
          "SELECT * FROM coding_jobs WHERE id=$1 AND user_id=$2 AND state='pr_ready'",
          [a.id, user],
        )
      ).rows[0] as (CodingJob & { summary: string }) | undefined;
      // A stop after Chief's own merge is about the release, so closing the PR cannot help.
      const ownMerge =
        parked && ["manual_review", "merge_declined"].includes(parked.stage)
          ? (
              await this.db.query(
                "SELECT payload->>'mergeSha' AS sha FROM coding_events WHERE job_id=$1 AND event_key LIKE 'automation:%' AND payload ? 'mergeSha' LIMIT 1",
                [a.id],
              )
            ).rows[0]?.sha
          : undefined;
      if (ownMerge)
        throw new ToolValidationError(
          `Not cancelled: this job's PR already merged as ${ownMerge} (${parked!.summary}), so there is nothing to cancel or close. Explain the reason; the release must be inspected separately.`,
        );
      if (
        parked &&
        (await this.automation?.settleOutside(parked).catch((error) => {
          opsLog("coding.parked_check_failed", "warn", {
            ref: a.id,
            ...errorFields(error),
          });
          return false;
        }))
      )
        return this.status(user, a.id);
      // Only a running attempt needs its sandbox cleaned up. A paused job's cleanup is
      // already settled, and reopening it would occupy the one-active-worker slot.
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
        `WITH changed AS (UPDATE coding_jobs SET state='cancelled',summary='Cancelled by the owner',cleanup=CASE WHEN attempt_id IS NOT NULL AND state IN ('provisioning','running','publishing') THEN 'pending' ELSE cleanup END,updated_at=now() WHERE id=$1 AND user_id=$2 AND state!='cancelled' AND (state!='pr_ready' OR (settings->>'autoMerge'='true' AND stage NOT IN ('merging','release_pending','deployed','merged_on_github','closed_on_github'))) AND NOT (state='publishing' AND publication_started) RETURNING id)
        INSERT INTO coding_events(job_id,event_key,payload) SELECT id,'cancelled',jsonb_build_object('summary','Coding job cancelled; its coding box is cleaned up separately.') FROM changed ON CONFLICT DO NOTHING`,
        [a.id, user],
      );
      const current = (
        await this.db.query(
          "SELECT state,stage,pr_url,publication_started,settings->>'prWorkflow' AS merge_flow FROM coding_jobs WHERE id=$1 AND user_id=$2",
          [a.id, user],
        )
      ).rows[0];
      if (current?.state === "publishing" && current.publication_started)
        throw new ToolValidationError(
          "PR publication is in flight or uncertain; inspect its result before cancelling",
        );
      if (current?.state === "cancelled") this.abortModels(a.id);
      // Nothing changed: say why, so the job is never reported as cancelled while it is not.
      else if (current) throw new ToolValidationError(cancelRefusal(current));
      return this.status(user, a.id);
    }
    const job = (
      await this.db.query(
        "SELECT * FROM coding_jobs WHERE id=$1 AND user_id=$2",
        [a.id, user],
      )
    ).rows[0];
    if (!job) throw new Error("Coding job unavailable");
    if (
      a.operation === "coding_reply" &&
      job.state === "pr_ready" &&
      job.settings.prWorkflow === "owner_merge"
    )
      return this.requestPrChanges(user, job, a);
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
    // re-runs every merge gate. Real holds re-park with their reason.
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
      await this.assertFreshOrConfirmed(job, a, CONTINUABLE);
      const released = await this.db.query(
        `WITH changed AS (UPDATE coding_jobs SET stage='awaiting_ci',summary='Owner asked to continue; re-checking the PR',updated_at=now() WHERE id=$1 AND user_id=$2 AND state='pr_ready' AND stage=$3 AND revision=$4 AND (lease IS NULL OR lease_until<now()) RETURNING id),
        -- The waits restart now, so an old stop time does not re-park the job on its first check.
        waits AS (UPDATE coding_events SET payload=jsonb_set(payload,'{waitingSince}',to_jsonb($6::text)) WHERE job_id IN (SELECT id FROM changed) AND event_key='automation:'||$4::int RETURNING job_id)
        INSERT INTO coding_events(job_id,event_key,payload,delivery) SELECT id,$5,jsonb_build_object('summary','Owner asked to continue; the PR returns to automatic checks and the Merge card.','previousStage',$3::text),'suppressed' FROM changed RETURNING job_id`,
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
      if (prior.revision !== a.baseRevision + 1 || prior.message !== message)
        throw new ToolValidationError("Coding revision request key conflict");
      return this.status(user, a.id);
    }
    await this.assertFreshOrConfirmed(job, a, RESTARTABLE);
    // A message from the owner is appended to the request, and the job waits for a new Start
    // card: the old card's scope no longer matches, so it cannot start the changed request.
    // After Start this is interim (journal 191): a stopped job returns to a Start card.
    // The worker's session and review identities hash the request, so a changed request starts
    // its build phase afresh: the files, patch and tool count are kept, the review and session
    // state is not (otherwise review recovery would refuse the changed identity).
    const pi = job.checkpoint.piState;
    const followUp =
      a.operation === "coding_reply"
        ? ({
            ...job,
            revision: job.revision + 1,
            context: `${job.context}\nOwner follow-up: ${message}`,
            checkpoint: pi
              ? {
                  ...job.checkpoint,
                  piState: {
                    version: 1,
                    toolsUsed: pi.toolsUsed,
                    ...(pi.mrFeedback ? { mrFeedback: pi.mrFeedback } : {}),
                  },
                }
              : job.checkpoint,
          } as CodingJob)
        : undefined;
    const changed = followUp
      ? await this.db.query(
          `WITH changed AS (
      UPDATE coding_jobs SET revision=revision+1,mode='plan',context=$5,checkpoint=$10::jsonb,state='plan_ready',stage='awaiting_start',summary='Waiting for the owner to tap Start',question='',result=NULL,attempt_id=NULL,sandbox_id=NULL,heartbeat_at=NULL,attempt_deadline=NULL,used_models=0,model_busy=false,publication_started=false,lease=NULL,lease_until=NULL,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND revision=$3 AND context=$8 AND checkpoint=$9::jsonb AND ${RESTARTABLE} RETURNING id,revision,mode
    ), revised AS (
      INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) SELECT id,revision,$6,$4,mode FROM changed RETURNING job_id
    ) INSERT INTO coding_events(job_id,event_key,payload) SELECT job_id,'requirements:'||($3::int+1)||':'||$6,$7::jsonb FROM revised RETURNING job_id`,
          [
            a.id,
            user,
            a.baseRevision,
            message,
            followUp.context,
            a.requestKey,
            JSON.stringify(startCard(followUp)),
            job.context,
            JSON.stringify(job.checkpoint),
            JSON.stringify(followUp.checkpoint),
          ],
        )
      : await this.db.query(
          `WITH changed AS (
      UPDATE coding_jobs SET revision=revision+1,state='queued',stage='queued',question='',result=NULL,attempt_id=NULL,sandbox_id=NULL,heartbeat_at=NULL,attempt_deadline=NULL,used_models=0,model_busy=false,publication_started=false,lease=NULL,lease_until=NULL,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND revision=$3 AND state!='plan_ready' AND mode='implement' AND ${RESTARTABLE} RETURNING id,revision,mode
    ) INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) SELECT id,revision,$5,$4,mode FROM changed RETURNING job_id`,
          [a.id, user, a.baseRevision, message, a.requestKey],
        );
    if (!changed.rows.length)
      // Nothing was written: a precondition, not an uncertain action, so the turn can continue.
      throw new ToolValidationError(
        job.state !== "pr_ready"
          ? "Coding scope changed, job is active, or sandbox cleanup is pending; inspect status before revising"
          : job.stage === "merged_on_github" || job.stage === "closed_on_github"
            ? `This job is finished: ${job.summary} Start a new job for further work.`
            : job.settings.prWorkflow === "owner_merge" &&
                (job.stage === "manual_review" ||
                  job.stage === "merge_declined")
              ? `This job's PR stopped for owner attention (${job.summary}). If the owner asks to continue, use coding_resume on this job: it re-runs the merge checks; holds that still apply (operator steps, exhausted allocation) come back with their reason.`
              : job.stage === "manual_review" || job.stage === "merge_declined"
                ? `This job's PR stopped for owner attention (${job.summary}). It will not continue automatically and Chief cannot merge it in this state; explain the reason, then the owner can act on GitHub or start a new job.`
                : job.settings.prWorkflow === "owner_merge"
                  ? "This job already has a PR and continues on its own: Chief handles Devin and MR feedback, re-runs checks and review, then sends the owner a Merge / Keep open card. Main moving does not change it; only a merge conflict sends the change back to the coder. Nothing to resume or revise; report its stage from coding_status."
                  : job.settings.autoMerge
                    ? "This job already has a PR and continues through its automatic merge workflow; report its stage from coding_status."
                    : "This job already has a draft PR; it predates the owner-merge workflow, so it can only be merged on GitHub or replaced by a new job.",
      );
    return this.status(user, a.id);
  }
  /** The checkpoint state that restarts the current step, when that step's model changed. */
  private freshSession(
    job: CodingJob,
    next: CodingSettings,
    requestKey: string,
  ) {
    const pi = job.checkpoint.piState;
    if (!pi?.sessionScope) return undefined;
    // An earlier report failure would hold the new model to finishing a session it never saw.
    const { reportFailure: _earlier, ...kept } = pi;
    if (pi.phase === "review") {
      const candidate = pi.reviewCandidate;
      const round = pi.reviewRound;
      if (
        job.settings.reviewerModel === next.reviewerModel ||
        // A rejected candidate goes to the coder's repair session next, not to a review.
        (pi.reportDocument?.kind === "review" &&
          pi.reportDocument.verdict === "REQUEST_CHANGES") ||
        !candidate ||
        !round ||
        round >= 1000
      )
        return undefined;
      // The host binds a review session to its candidate and round, so a fresh one is a new round.
      return {
        ...kept,
        reviewRound: round + 1,
        sessionScope: piIdentity(
          job,
          job.checkpoint.plan,
          "review-session",
          `${candidate.hash}:${round + 1}`,
        ),
      };
    }
    const changed =
      pi.phase === "build" &&
      job.mode === "implement" &&
      job.settings.model !== next.model;
    return changed
      ? { ...kept, sessionScope: hash([pi.sessionScope, requestKey]) }
      : undefined;
  }
  /**
   * The owner changes who carries out a stopped job, or how long it may run. The requirements
   * are untouched, so their approval stands. A session under a changed model starts fresh on
   * the same files, because continuing another model's session is untested.
   */
  private async updateJob(
    user: string,
    a: Extract<CodingAction, { operation: "coding_job_update" }>,
  ) {
    const job = (
      await this.db.query(
        "SELECT * FROM coding_jobs WHERE id=$1 AND user_id=$2",
        [a.id, user],
      )
    ).rows[0] as CodingJob | undefined;
    if (!job) throw new Error("Coding job unavailable");
    const key = `settings:${a.requestKey}`;
    const request = hash(a);
    const prior = (
      await this.db.query(
        "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
        [job.id, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.payload.request !== request)
        throw new ToolValidationError("Coding update request key conflict");
      return this.status(user, a.id);
    }
    if (job.revision !== a.baseRevision)
      throw new ToolValidationError(
        "Coding revision changed; read coding_status and retry with the current revision",
      );
    if (a.leaderModel && !job.settings.squad)
      throw new ToolValidationError("This job has no leader model to change");
    if (
      a.upgradeWorker &&
      (job.settings.runtime !== "pi" ||
        this.settings.runtime !== "pi" ||
        !this.settings.image)
    )
      throw new ToolValidationError("Only a Pi coding job can change worker");
    const next = {
      ...job.settings,
      ...(a.leaderModel ? { leaderModel: a.leaderModel } : {}),
      ...(a.coderModel ? { model: a.coderModel } : {}),
      ...(a.reviewerModel ? { reviewerModel: a.reviewerModel } : {}),
      // Only to the image new jobs use: the boxes accept it, and it is the reviewed one.
      ...(a.upgradeWorker ? { image: this.settings.image } : {}),
      limits: { ...job.settings.limits, ...a.limits },
    };
    if (job.settings.runtime === "pi" && (a.limits?.ms ?? 0) > PI_ATTEMPT_MS)
      throw new ToolValidationError(
        "That time limit is above the most one attempt can run",
      );
    const changes = [
      ...(job.settings.squad
        ? [
            [
              "Planner",
              job.settings.leaderModel ?? job.settings.model,
              next.leaderModel ?? next.model,
            ],
          ]
        : []),
      ["Coder", job.settings.model, next.model],
      ["Reviewer", job.settings.reviewerModel, next.reviewerModel],
      ["Time limit (ms)", job.settings.limits.ms, next.limits.ms],
      ["Model calls", job.settings.limits.models, next.limits.models],
      ["Tool calls", job.settings.limits.tools, next.limits.tools],
      ["Worker image", job.settings.image.slice(-12), next.image.slice(-12)],
    ].filter(([, from, to]) => from !== to);
    if (!changes.length)
      throw new ToolValidationError("The job already has these settings");
    if (
      Math.max(
        job.checkpoint.piState?.toolsUsed ?? 0,
        job.checkpoint.squadState?.toolsUsed ?? 0,
      ) > next.limits.tools
    )
      throw new ToolValidationError(
        "The tool-call limit is below what this job has already used",
      );
    for (const model of [a.leaderModel, a.coderModel, a.reviewerModel]) {
      if (!model) continue;
      if (!this.catalog) throw new Error("Coding model catalog unavailable");
      await assertEligibleModel(
        model,
        this.catalog,
        this.priceFilters.input,
        this.priceFilters.output,
      );
    }
    this.assertDirectPiModels(next, "The job was not changed.");
    // Pi's own catalogue gives each Claude model's window (journal 190); none is snapshotted.
    delete (next as { contextWindows?: unknown }).contextWindows;
    const piState = this.freshSession(job, next, a.requestKey);
    const restarted = !!piState;
    const checkpoint = piState
      ? { ...job.checkpoint, piState }
      : job.checkpoint;
    const approved =
      job.mode === "implement" && (await this.requirements.approved(job));
    // A job waiting for Start shows its models on the Start card, so a model change replaces
    // the card: the revision moves on, and the card the owner saw can no longer start it.
    const waiting = job.state === "plan_ready" && job.mode === "plan";
    const recard =
      waiting &&
      (next.model !== job.settings.model ||
        next.reviewerModel !== job.settings.reviewerModel);
    const updated = await this.db.query(
      `WITH changed AS (
        UPDATE coding_jobs SET settings=$4::jsonb,checkpoint=$5::jsonb,revision=revision+CASE WHEN $10::boolean THEN 1 ELSE 0 END
        WHERE id=$1 AND user_id=$2 AND revision=$3 AND ${RESTARTABLE} AND settings=$6::jsonb AND checkpoint=$7::jsonb RETURNING id,revision
      ), revised AS (
        INSERT INTO coding_revisions(job_id,revision,request_key,message,mode)
        SELECT id,revision,$8::text,'Owner changed the models before Start','plan' FROM changed WHERE $10::boolean RETURNING job_id
      ), card AS (
        INSERT INTO coding_events(job_id,event_key,payload)
        SELECT id,'requirements:'||revision||':'||$8::text,$11::jsonb FROM changed WHERE $10::boolean RETURNING job_id
      ) INSERT INTO coding_events(job_id,event_key,payload)
        SELECT id,$8::text,$9::jsonb FROM changed RETURNING job_id`,
      [
        job.id,
        user,
        job.revision,
        JSON.stringify(next),
        JSON.stringify(checkpoint),
        JSON.stringify(job.settings),
        JSON.stringify(job.checkpoint),
        key,
        JSON.stringify({
          kind: "settings_change",
          request,
          changes: changes.map(([field, from, to]) => ({ field, from, to })),
          sessionRestarted: restarted,
          summary: `Job settings changed at your request. ${changes
            .map(([field, from, to]) => `${field}: ${from} → ${to}`)
            .join(
              "; ",
            )}.${restarted ? " That step restarts in a fresh session; finished work is kept." : ""}${approved ? " Your Start of the request still stands." : ""}${
            waiting
              ? recard
                ? " A new Start card follows; tap Start on it to begin."
                : " The job still waits for you to tap Start."
              : " The job stays stopped until you resume it."
          }`,
        }),
        recard,
        JSON.stringify(
          startCard({ ...job, revision: job.revision + 1, checkpoint }),
        ),
      ],
    );
    if (!updated.rows.length)
      throw new ToolValidationError(
        "Only a stopped job with no pending cleanup or publication can change; inspect status",
      );
    opsLog("coding.settings_changed", "info", { ref: job.id });
    return this.status(user, a.id);
  }
  /**
   * The owner asks for changes to an open owner-merge PR. The request joins the PR's next
   * review-feedback round, so the coder fixes it on the same PR within the approved scope,
   * and the PR returns to checks, review and the Merge card. A merged or finished PR
   * cannot change.
   */
  private async requestPrChanges(
    user: string,
    job: CodingJob,
    a: Extract<CodingAction, { operation: "coding_reply" }>,
  ) {
    const key = `owner-feedback:${a.requestKey}`;
    const prior = (
      await this.db.query(
        "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
        [job.id, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.payload.text !== a.message)
        throw new ToolValidationError("Coding revision request key conflict");
      return this.status(user, job.id);
    }
    const parked = [
      "awaiting_merge_approval",
      "merge_approved",
      "manual_review",
      "merge_declined",
    ];
    const open = ["pr_ready", "readying", "awaiting_ci", ...parked];
    if (!open.includes(job.stage))
      throw new ToolValidationError(
        `This job's PR is ${job.stage.replaceAll("_", " ")} and can no longer change. Start a new coding job for further changes.`,
      );
    if (job.revision !== a.baseRevision)
      throw new ToolValidationError(
        "Coding revision changed; read coding_status and retry with the current revision",
      );
    // Refuse now what the feedback round could never deliver, rather than park the PR on it.
    const handled =
      (
        await this.db.query(
          "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
          [job.id, `automation:${job.revision}`],
        )
      ).rows[0]?.payload?.handled?.length ?? 0;
    // Requests already waiting share the next round with this one.
    const waiting = (
      await this.db.query(
        "SELECT payload->>'text' AS text FROM coding_events WHERE job_id=$1 AND event_key LIKE 'owner-feedback:%' AND NOT payload ? 'deliveredRound'",
        [job.id],
      )
    ).rows.map((r: { text: string }) => r.text);
    const queuedLength = waiting.reduce((n, text) => n + text.length + 20, 0);
    const refusal =
      a.message.length > 7000
        ? "The request is too long for one feedback round; shorten it to under 7,000 characters"
        : queuedLength + a.message.length > 7000
          ? "Earlier requests already fill the next round of fixes; send this after that round, or shorten it"
          : (job.checkpoint.piState?.mrFeedback?.round ?? 0) >= 3
            ? "This PR has already had three rounds of fixes, so it cannot take another; start a new coding job for further changes"
            : job.used_models >= job.settings.limits.models ||
                (job.checkpoint.piState?.toolsUsed ?? 0) >=
                  job.settings.limits.tools
              ? "This job has used its model or tool allowance, so it cannot take another round of fixes; start a new coding job"
              : handled + waiting.length >= 200
                ? "This PR has handled too much feedback to take more; start a new coding job"
                : undefined;
    if (refusal) throw new ToolValidationError(`Nothing changed: ${refusal}.`);
    if (parked.includes(job.stage))
      await this.assertFreshOrConfirmed(
        job,
        a,
        `state='pr_ready' AND stage=ANY(ARRAY['${parked.join("','")}'])`,
      );
    const merged = (
      await this.db.query(
        "SELECT 1 FROM coding_events WHERE job_id=$1 AND event_key LIKE 'automation:%' AND payload ? 'mergeSha' LIMIT 1",
        [job.id],
      )
    ).rows.length;
    if (merged)
      throw new ToolValidationError(
        "This job's PR already merged, so it cannot change. Start a new coding job for further changes.",
      );
    const recorded = await this.db.query(
      `WITH changed AS (
        UPDATE coding_jobs SET stage=CASE WHEN stage=ANY($5::text[]) THEN 'awaiting_ci' ELSE stage END,
          summary=CASE WHEN stage=ANY($5::text[]) THEN 'The owner asked for changes; the coder will fix them on this PR, then checks and review run again' ELSE summary END,
          updated_at=now()
        WHERE id=$1 AND user_id=$2 AND state='pr_ready' AND revision=$3 AND stage=$4 AND (lease IS NULL OR lease_until<now()) RETURNING id
      ), waits AS (
        UPDATE coding_events SET payload=jsonb_set(payload,'{waitingSince}',to_jsonb($8::text))
        WHERE job_id IN (SELECT id FROM changed) AND event_key='automation:'||$3::int AND $4=ANY($5::text[]) RETURNING job_id
      ) INSERT INTO coding_events(job_id,event_key,payload,delivery)
        SELECT id,$6,jsonb_build_object('kind','owner_feedback','text',$7::text,'revision',$3::int),'suppressed' FROM changed RETURNING job_id`,
      [
        job.id,
        user,
        job.revision,
        job.stage,
        parked,
        key,
        a.message,
        this.clock().toISOString(),
      ],
    );
    if (!recorded.rows.length)
      throw new ToolValidationError(
        "The job changed or is being processed right now; read coding_status and retry",
      );
    return this.status(user, job.id);
  }
  /**
   * Work that has waited more than a day restarts only on the owner's explicit request in
   * the current conversation (20 October: a three-day-old parked job was resumed while
   * answering an unrelated question, and held the worker slot until the owner cancelled
   * it). The model states that request with confirmStale. The host's own transient retry
   * (autoRetryOnce) does not come through here. Only a job the following update could
   * restart (`restartable`, at the caller's revision) is gated, so any other job gets the
   * update's own precondition reason instead of a misleading request for confirmation.
   */
  private async assertFreshOrConfirmed(
    job: CodingJob,
    a: { operation: string; baseRevision: number; confirmStale?: boolean },
    restartable: string,
  ) {
    if (a.confirmStale === true) return;
    const waiting = (
      await this.db.query(
        `SELECT updated_at FROM coding_jobs WHERE id=$1 AND revision=$2 AND ${restartable} AND updated_at < now() - interval '${STALE_HOURS} hours'`,
        [job.id, a.baseRevision],
      )
    ).rows[0];
    if (!waiting) return;
    const since = new Date(waiting.updated_at).toISOString().slice(0, 10);
    throw new ToolValidationError(
      `Nothing changed: this coding job has been waiting since ${since}, more than ${STALE_HOURS} hours, so ${a.operation} needs the owner's explicit request to restart it. Ask the owner whether to resume this specific job. Repeat the call with confirmStale: true only if the owner explicitly asked, in this conversation, to resume or answer this job.`,
    );
  }
  async authenticate(
    id: string,
    token: string,
    includeFinished = false,
  ): Promise<CodingJob> {
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new WorkerRefused("Invalid worker capability");
    const job = (
      await this.db.query("SELECT * FROM coding_jobs WHERE id=$1", [id])
    ).rows[0] as CodingJob | undefined;
    if (!job?.attempt_id || !this.allowed(job.user_id))
      throw new WorkerRefused("Invalid worker capability");
    const expected = this.token(id, job.attempt_id);
    if (
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected)) ||
      (!includeFinished &&
        (!active.includes(job.state) ||
          new Date(job.attempt_deadline).getTime() <= this.clock().getTime()))
    )
      throw new WorkerRefused("Invalid worker capability");
    // Nothing runs before the owner's Start, and a build needs the owner's approval of the
    // exact request (journal 191).
    if (job.mode !== "implement" || !(await this.requirements.approved(job)))
      throw new WorkerRefused("The owner has not started this request");
    if (!job.sandbox_id && (!includeFinished || active.includes(job.state))) {
      if (job.state === "provisioning")
        throw new SandboxAcknowledgementPending();
      throw new WorkerRefused("Invalid worker capability");
    }
    return job;
  }
  /** Pi jobs call Claude directly at Anthropic (journal 190): refuse a model without that route. */
  private assertDirectPiModels(
    settings: Pick<CodingSettings, "runtime" | "model" | "reviewerModel">,
    outcome: string,
  ) {
    if (settings.runtime !== "pi") return;
    for (const model of new Set([settings.model, settings.reviewerModel]))
      if (!this.anthropic?.route(model))
        throw new ToolValidationError(
          `Coding jobs call Claude directly at Anthropic, and ${model} is not a Claude model Chief calls directly (config/model-policy.json lists them, such as anthropic/claude-opus-5.5 and anthropic/claude-sonnet-5.5). ${outcome}`,
        );
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
    // Workers strictly validate settings: native model ids travel beside them and host-only workflow stays home.
    const {
      contextWindows: _unused,
      prWorkflow: _hostOnly,
      autoRetryTransientOnce: _hostRetry,
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
      ...(job.settings.runtime === "pi"
        ? {
            nativeModels: Object.fromEntries(
              [job.settings.model, job.settings.reviewerModel].flatMap(
                (model) => {
                  const route = this.anthropic?.route(model);
                  return route ? [[model, route.nativeModel]] : [];
                },
              ),
            ),
          }
        : {}),
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
    const reported = storable(workerEvent.parse(raw));
    // Stored and shown in owner-facing words; deterministic, so a retry still matches.
    const e = { ...reported, summary: ownerProgress(reported.summary) };
    const prior = (
      await this.db.query(
        "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
        [job.id, `${job.attempt_id}:${e.key}`],
      )
    ).rows[0];
    if (prior) {
      // A record stored before the owner wording existed holds the raw report.
      if (
        hash(prior.payload) !== hash(e) &&
        hash(prior.payload) !== hash(reported)
      )
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
        ["kite run check", "kite run build", "kite run format:check"].some(
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
        piIdentity(job, c.plan, intent, value);
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
    if (
      document?.kind === "review" &&
      document.verdict === "REQUEST_CHANGES" &&
      document.detail !== c.piState?.findings
    )
      throw new Error("Review document must match the saved findings");
  }
  async save(job: CodingJob, raw: unknown) {
    const c = storableCheckpoint(checkpoint.parse(raw));
    this.validateReportCheckpoint(job, c);
    if (
      job.mode === "implement" &&
      (c.plan !== job.checkpoint.plan ||
        !(await this.requirements.approved(job)))
    )
      throw new Error(
        "The started request is immutable; a change needs a new Start first",
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
    // The checked candidate is about to be reviewed: measure whether a rebase reproduced the
    // reviewed artifact. Measurement only; it never changes the save.
    if (c.piState?.phase === "review" && c.piState.reviewCandidate)
      await this.noteRebasedCandidate(
        job,
        c.piState.reviewCandidate.hash,
      ).catch(() => {});
    return { saved: true };
  }
  /**
   * Detection only (journal 115): records, once per rebased revision, whether the first
   * candidate sent to review is byte-identical to the artifact the previous revision's
   * review approved (same artifact hash: identical whole-file contents and identical diff).
   * Review still runs; reusing the earlier approval needs a worker change and an owner
   * decision on the review exception, because the reviewer saw the change against the old
   * base.
   */
  private async noteRebasedCandidate(job: CodingJob, candidate: string) {
    const carried = (
      await this.db.query(
        "SELECT payload->>'carriedArtifact' AS artifact FROM coding_events WHERE job_id=$1 AND event_key=$2",
        [job.id, `rebase-approval:${job.revision}`],
      )
    ).rows[0]?.artifact;
    if (typeof carried !== "string" || !/^[a-f0-9]{64}$/.test(carried)) return;
    const identical = carried === candidate;
    const recorded = await this.db.query(
      "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,$2,$3::jsonb,'suppressed') ON CONFLICT DO NOTHING RETURNING id",
      [
        job.id,
        `rebase-candidate:${job.revision}`,
        JSON.stringify({
          kind: "rebase_candidate",
          identical,
          candidate,
          carriedArtifact: carried,
        }),
      ],
    );
    if (recorded.rows.length)
      // `matched`: the rebased candidate is byte-identical to the reviewed artifact.
      opsLog("coding.rebase_candidate", "info", {
        taskId: job.id,
        revision: job.revision,
        matched: identical,
      });
  }
  async finish(job: CodingJob, raw: unknown) {
    const parsed = outcome.parse(raw);
    const r = storable({
      ...parsed,
      checkpoint: storableCheckpoint(
        parsed.checkpoint,
        parsed.review?.findings,
      ),
    });
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
    if (!active.includes(job.state)) {
      if (job.result && hash(job.result) === hash(r)) return { accepted: true };
      throw new Error("Worker attempt superseded");
    }
    if (new Date(job.attempt_deadline).getTime() <= this.clock().getTime())
      throw new Error("Worker allocation expired");
    if (
      r.kind === "candidate" &&
      (r.review?.verdict !== "APPROVE" ||
        r.review.model !== job.settings.reviewerModel ||
        r.review.patchHash !== artifactHash(r.checkpoint) ||
        !r.checkpoint.files.length ||
        !!r.published !== !!(job.settings.agentGit && this.agentGit) ||
        ["kite run check", "kite run build", "kite run format:check"].some(
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
        "{}",
        JSON.stringify(job.checkpoint),
      ],
    );
    if (!update.rows.length) throw new Error("Worker attempt superseded");
    // The attempt is over: its agent token no longer has a purpose.
    await this.revokeAgentToken(job.attempt_id);
    return { accepted: true };
  }
  /**
   * One Pi model call (journal 190): the request goes to Anthropic as Pi built it, apart from
   * the model, effort and output cap this job decides, and Anthropic's stream comes back to
   * the worker unchanged. The host keeps its own copy of the stream to record the call.
   */
  async piMessages(
    job: CodingJob,
    role: "coder" | "reviewer",
    raw: unknown,
    request: {
      betas?: string | string[];
      version?: string | string[];
      purpose?: string | string[];
      /** Aborts when the worker's connection closes. */
      signal: AbortSignal;
    },
  ): Promise<MessagesReply> {
    const refuse = async (error: unknown) => {
      await this.recordRejection(job, {
        phase: "model",
        code: "worker_request_rejected",
        httpStatus: 400,
        reason: rejectionReason(error),
      }).catch(() => false);
      return refusal(
        error instanceof Error
          ? error.message
          : "Coding request rejected; inspect job state before retrying",
      );
    };
    const selected =
      role === "reviewer" ? job.settings.reviewerModel : job.settings.model;
    let body: Record<string, unknown>;
    let betas: string[];
    let route: ReturnType<CodingAnthropic["route"]>;
    let purpose: "agent" | "compaction" | undefined;
    try {
      if (job.settings.runtime !== "pi")
        throw new Error("Native Pi endpoint requires a Pi job");
      route = this.anthropic?.route(selected);
      if (!route)
        throw new Error("Pi coding model has no direct Anthropic route");
      if (
        request.purpose !== undefined &&
        request.purpose !== "agent" &&
        request.purpose !== "compaction"
      )
        throw new Error("Invalid model request purpose");
      purpose = request.purpose;
      betas = piBetas(request.betas);
      body = messagesRequest(raw, {
        model: route.nativeModel,
        effort: job.settings.effort,
        maxTokens: outputAllowance(job.settings, role),
      });
    } catch (error) {
      return refuse(error);
    }
    // One call at a time per job: a request that arrives while the previous call is still
    // finishing waits for its slot instead of being refused.
    await this.piSlots.get(job.id);
    // A worker that hung up while waiting gets nothing, and costs no allowance or call record.
    if (request.signal.aborted)
      return refuse(
        new Error("Coding request cancelled before model dispatch"),
      );
    const callId = randomUUID();
    const claimed = await this.db.query(
      `WITH claimed AS (UPDATE coding_jobs SET used_models=used_models+1,model_busy=true WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running') AND NOT model_busy AND used_models<$3 AND attempt_deadline>$4 RETURNING id)
      INSERT INTO coding_model_calls(id,job_id,attempt_id,role,request_hash,input) SELECT $5,id,$2,$6,$7,$8::jsonb FROM claimed RETURNING id`,
      [
        job.id,
        job.attempt_id,
        job.settings.limits.models,
        this.clock(),
        callId,
        role,
        // The exact request, serialised once for its hash (no key-sorted copy).
        createHash("sha256").update(JSON.stringify(body)).digest("hex"),
        // The readable copy; the request itself goes to Anthropic exactly.
        JSON.stringify(
          storable({
            ...(purpose ? { purpose } : {}),
            requestedModel: selected,
            request: scrubTrace(body),
          }),
        ),
      ],
    );
    if (!claimed.rows.length) {
      // Say which condition refused the slot, so a pause can be diagnosed.
      const now = (
        await this.db.query(
          "SELECT state,attempt_id,model_busy,used_models,attempt_deadline FROM coding_jobs WHERE id=$1",
          [job.id],
        )
      ).rows[0];
      return refuse(
        new Error(
          !now ||
            !active.includes(now.state) ||
            now.attempt_id !== job.attempt_id
            ? "Coding attempt is no longer active"
            : new Date(now.attempt_deadline).getTime() <= this.clock().getTime()
              ? "Coding attempt deadline has passed"
              : now.used_models >= job.settings.limits.models
                ? "Model allocation exhausted"
                : "Another model request is already in flight",
        ),
      );
    }
    const started = Date.now();
    const cancellation = new AbortController();
    this.inFlightModels.set(callId, {
      jobId: job.id,
      controller: cancellation,
    });
    let freeSlot!: () => void;
    const slot = new Promise<void>((resolve) => (freeSlot = resolve));
    this.piSlots.set(job.id, slot);
    const deadline = AbortSignal.timeout(
      Math.max(
        1,
        new Date(job.attempt_deadline).getTime() - this.clock().getTime(),
      ),
    );
    const signal = AbortSignal.any([
      cancellation.signal,
      deadline,
      request.signal,
    ]);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      this.inFlightModels.delete(callId);
      try {
        await this.db.query(
          "UPDATE coding_jobs SET model_busy=false WHERE id=$1 AND attempt_id=$2",
          [job.id, job.attempt_id],
        );
      } finally {
        if (this.piSlots.get(job.id) === slot) this.piSlots.delete(job.id);
        freeSlot();
      }
    };
    const fail = async (
      code: CodingFailureCode,
      details: {
        httpStatus?: number;
        providerStatus?: number;
        responseId?: string;
      } = {},
    ) => {
      await this.db.query(
        "UPDATE coding_model_calls SET state='uncertain' WHERE id=$1 AND state='pending'",
        [callId],
      );
      const { httpStatus, ...rest } = details;
      await this.recordRejection(job, {
        phase: "model",
        code,
        httpStatus: httpStatus ?? details.providerStatus ?? 400,
        elapsedMs: Date.now() - started,
        callId,
        // The attempt's deadline bounds the whole call.
        ...(code === "model_timeout" ? { timeoutKind: "total" as const } : {}),
        ...rest,
      }).catch(() => false);
    };
    const abortCode = (): CodingFailureCode =>
      cancellation.signal.aborted
        ? "model_cancelled"
        : deadline.aborted
          ? "model_timeout"
          : "model_disconnected";
    let response: Response;
    try {
      const live = (
        await this.db.query(
          "SELECT state,attempt_id FROM coding_jobs WHERE id=$1",
          [job.id],
        )
      ).rows[0];
      if (
        signal.aborted ||
        !live ||
        !active.includes(live.state) ||
        live.attempt_id !== job.attempt_id ||
        !this.allowed(job.user_id)
      ) {
        try {
          await fail("model_cancelled");
        } finally {
          await release();
        }
        return refusal("Coding request cancelled before model dispatch");
      }
      const version = Array.isArray(request.version)
        ? request.version[0]
        : request.version;
      response = await this.anthropic!.send(
        body,
        {
          betas,
          ...(version && /^\d{4}-\d{2}-\d{2}$/.test(version)
            ? { version }
            : {}),
        },
        signal,
      );
    } catch (error) {
      try {
        if (
          error instanceof Anthropic.APIError &&
          !(error instanceof Anthropic.APIConnectionError) &&
          typeof error.status === "number"
        ) {
          await fail(upstreamFailureCode(error.status, error.type), {
            providerStatus: error.status,
          });
          return relayedError(error);
        }
        if (signal.aborted) {
          await fail(abortCode());
          return refusal("Coding model generation cancelled");
        }
        await fail("model_disconnected", { httpStatus: 502 });
        // A transport failure before any reply: Pi's own retry decides whether to send again.
        return refusal("Model provider connection error", 502);
      } finally {
        await release();
      }
    }
    if (!response.body) {
      try {
        await fail("model_provider_failed", { httpStatus: 502 });
      } finally {
        await release();
      }
      return refusal("Model provider returned no stream", 502);
    }
    const [toWorker, toHost] = response.body.tee();
    void this.recordPiStream(job, {
      callId,
      role,
      purpose,
      selected,
      prices: route.prices,
      started,
      body: toHost,
      signal,
      abortCode,
      fail,
      release,
    }).catch((error) =>
      opsLog("coding.model_record_failed", "warn", {
        taskId: job.id,
        ...errorFields(error),
      }),
    );
    const headers: Record<string, string> = {
      "content-type":
        response.headers.get("content-type") ?? "text/event-stream",
    };
    const requestId = response.headers.get("request-id");
    if (requestId) headers["request-id"] = requestId;
    return { status: response.status, headers, body: toWorker };
  }
  /** Records one relayed Pi call from the host's copy of the stream. */
  private async recordPiStream(
    job: CodingJob,
    call: {
      callId: string;
      role: "leader" | "coder" | "reviewer";
      purpose?: "agent" | "compaction";
      selected: string;
      prices: AnthropicPrices;
      started: number;
      body: ReadableStream<Uint8Array>;
      signal: AbortSignal;
      abortCode: () => CodingFailureCode;
      fail: (
        code: CodingFailureCode,
        details?: {
          httpStatus?: number;
          providerStatus?: number;
          responseId?: string;
        },
      ) => Promise<void>;
      release: () => Promise<void>;
    },
  ) {
    let bytes = 0;
    let responseId: string | undefined;
    let progressSavedAt = Date.now();
    const progress = () => {
      if (Date.now() - progressSavedAt < 10000) return;
      progressSavedAt = Date.now();
      void this.db
        .query(
          `INSERT INTO coding_events(job_id,event_key,payload,delivery) SELECT id,$3,$4::jsonb,'suppressed' FROM coding_jobs WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running')`,
          [
            job.id,
            job.attempt_id,
            `${job.attempt_id}:model-progress:${randomUUID()}`,
            JSON.stringify(
              storable({
                kind: "model_progress",
                role: call.role,
                callId: call.callId,
                responseId,
                provider: "Anthropic",
                elapsedMs: Date.now() - call.started,
                receivedBytes: bytes,
              }),
            ),
          ],
        )
        .catch(() => {});
    };
    const counted = call.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          controller.enqueue(chunk);
          progress();
        },
      }),
    );
    try {
      const { message, complete, error } = await assembleStream(
        counted,
        (event) => {
          if (event.type === "message_start")
            responseId = event.message.id?.slice(0, 160);
        },
      );
      // A stream that reached message_stop finished, whatever happened afterwards (the worker
      // closing its finished connection aborts the signal too).
      const aborted = !complete && call.signal.aborted;
      const abortCode = aborted ? call.abortCode() : undefined;
      // The stream is over: free the slot before recording, so Pi's next request is not refused.
      await call.release();
      const usage = message?.usage
        ? anthropicUsage(message, call.prices)
        : undefined;
      if (complete && message && !aborted) {
        await this.db.query(
          "UPDATE coding_model_calls SET state='complete',result=$2::jsonb,result_box=$3 WHERE id=$1",
          [
            call.callId,
            // The readable copy; the sealed copy and the worker's stream stay exact.
            JSON.stringify(storable(scrubTrace(message))),
            seal(
              this.resultKey(),
              JSON.stringify(message),
              this.resultScope(job, call.callId),
            ),
          ],
        );
      } else {
        const apiError =
          error instanceof Anthropic.APIError ? error : undefined;
        await call.fail(
          abortCode
            ? abortCode
            : apiError
              ? upstreamFailureCode(apiError.status, apiError.type)
              : "model_disconnected",
          { httpStatus: 200, ...(responseId ? { responseId } : {}) },
        );
      }
      // A started generation is billed whether or not it finished.
      if (usage)
        await this.db.query(
          "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,$2,$3::jsonb,'suppressed')",
          [
            job.id,
            `${job.attempt_id}:model:${randomUUID()}`,
            JSON.stringify(
              storable({
                kind: "model_usage",
                role: call.role,
                ...(call.purpose ? { purpose: call.purpose } : {}),
                model: call.selected,
                usage,
                provider: "Anthropic",
                ...(complete && !aborted ? {} : { incomplete: true }),
              }),
            ),
          ],
        );
    } finally {
      await call.release();
    }
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
    // Pi jobs reach Claude through piMessages; this route serves the legacy workers.
    if (job.settings.runtime === "pi")
      throw new Error("Pi jobs use the Messages route");
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
    let received = false;
    const started = Date.now();
    const requestedModel =
      input.role === "reviewer"
        ? job.settings.reviewerModel
        : input.role === "leader"
          ? (job.settings.leaderModel ?? job.settings.model)
          : job.settings.model;
    const enhanced = job.settings.harnessVersion === 2;
    const allowance = outputAllowance(job.settings, input.role);
    const total = AbortSignal.timeout(
      Math.max(
        1,
        Math.min(
          // Bounds the whole call. The 90-second idle timeout stops a silent stream, but any
          // received bytes re-arm it (on the direct route, the API's thinking-phase pings do), so
          // a stream that only keeps sending pings is stopped by this limit alone.
          enhanced ? modelCallTimeoutMs(allowance) : 120000,
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
         RETURNING id)
      INSERT INTO coding_model_calls(id,job_id,attempt_id,role,request_hash,input) SELECT $5,id,$2,$6,$7,$8::jsonb FROM claimed RETURNING id`,
        [
          job.id,
          job.attempt_id,
          job.settings.limits.models,
          this.clock(),
          input.callId,
          input.role,
          hash(input),
          // The readable copy; the request hash and provider request stay exact.
          JSON.stringify(
            storable({
              ...scrubTrace(input),
              requestedModel:
                input.role === "reviewer"
                  ? job.settings.reviewerModel
                  : input.role === "leader"
                    ? (job.settings.leaderModel ?? job.settings.model)
                    : job.settings.model,
            }),
          ),
        ],
      );
      if (!claimed.rows.length) {
        // Say which condition refused the slot, so a pause can be diagnosed.
        const now = (
          await this.db.query(
            "SELECT state,attempt_id,model_busy,used_models,attempt_deadline FROM coding_jobs WHERE id=$1",
            [job.id],
          )
        ).rows[0];
        throw new Error(
          !now ||
            !active.includes(now.state) ||
            now.attempt_id !== job.attempt_id
            ? "Coding attempt is no longer active"
            : new Date(now.attempt_deadline).getTime() <= this.clock().getTime()
              ? "Coding attempt deadline has passed"
              : now.used_models >= job.settings.limits.models
                ? "Model allocation exhausted"
                : "Another model request is already in flight",
        );
      }
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
      const result = await this.models(requestedModel).generate({
        messages: input.messages,
        tools: input.tools,
        reasoning: job.settings.effort,
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
                    JSON.stringify(
                      storable({
                        kind: "model_progress",
                        role: input.role,
                        callId: input.callId,
                        responseId,
                        provider: value.provider?.slice(0, 100),
                        elapsedMs: Date.now() - started,
                        receivedBytes: value.bytes,
                      }),
                    ),
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
          // The readable copy; the sealed copy and the worker's response stay exact.
          JSON.stringify(storable(scrubTrace(result))),
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
          JSON.stringify(
            storable({
              kind: "model_usage",
              role: input.role,
              model: result.model,
              usage: result.usage,
              provider: result.provider,
            }),
          ),
        ],
      );
      return result;
    } catch (error) {
      await this.db.query(
        "UPDATE coding_model_calls SET state='uncertain' WHERE id=$1 AND state='pending'",
        [input.callId],
      );
      // A complete response that the adapter then refused (a refusal, an incomplete or empty
      // answer) was still billed: record its usage, marked incomplete, like a completed call's.
      const billed =
        error instanceof ModelError &&
        error.diagnostics.usage &&
        typeof error.diagnostics.usage === "object"
          ? error.diagnostics
          : undefined;
      if (admitted && !received && billed)
        await this.db
          .query(
            "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,$2,$3::jsonb,'suppressed')",
            [
              job.id,
              `${job.attempt_id}:model:${randomUUID()}`,
              JSON.stringify(
                storable({
                  kind: "model_usage",
                  role: input.role,
                  model: requestedModel,
                  usage: billed.usage,
                  provider: billed.provider,
                  incomplete: true,
                  ...(typeof billed.failureCode === "string"
                    ? { failureCode: billed.failureCode.slice(0, 40) }
                    : {}),
                }),
              ),
            ],
          )
          // Best-effort accounting: a failed insert must not replace the model error being
          // handled here, which is still classified and recorded below.
          .catch(() => {});
      if (admitted && !received) {
        let code: CodingFailureCode | undefined;
        if (cancellation.signal.aborted) code = "model_cancelled";
        else if (total.aborted || idle.signal.aborted) {
          code = "model_timeout";
          if (total.aborted) timeoutKind = "total";
        } else if (enhanced && error instanceof ModelError) {
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
              error.diagnostics.failureCode === "malformed" ||
              error.diagnostics.failureCode === "refusal")
              ? { providerFailure: error.diagnostics.failureCode }
              : {}),
            // So a paused job can say the model declined, and in which category.
            ...(error instanceof ModelError &&
            error.diagnostics.failureCode === "refusal" &&
            typeof error.diagnostics.refusalCategory === "string" &&
            /^[a-z][a-z0-9_]{0,59}$/.test(error.diagnostics.refusalCategory)
              ? { refusalCategory: error.diagnostics.refusalCategory }
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
   * without a stated reason or lose its heartbeat, or the worker itself paused when its
   * last model request was rejected as a provider 429 or 5xx (no model call completed after
   * the rejection, so the fault ended the run), or a gateway restart cut off its model call.
   * Re-queues through the same guarded update as
   * coding_resume, keyed auto-retry:<attempt> so it is idempotent, and never again for a
   * revision that an automatic retry created. Jobs with a PR, publication, pending cleanup,
   * leases and revoked owners are left for the owner.
   */
  async autoRetryOnce() {
    if (this.settings.autoRetryTransientOnce === false) return;
    const candidates = (
      await this.db.query(
        `SELECT j.* FROM coding_jobs j
         WHERE j.state='paused' AND NOT j.publication_started AND j.pr_url IS NULL AND j.cleanup IN ('none','complete')
           AND (j.lease IS NULL OR j.lease_until<now()) AND j.attempt_id IS NOT NULL
           AND j.updated_at < now() - interval '2 minutes' AND j.updated_at > now() - interval '1 day'
           AND NOT EXISTS(SELECT 1 FROM coding_revisions v WHERE v.job_id=j.id AND v.revision=j.revision
             AND v.request_key LIKE 'auto-retry:%')
           AND NOT EXISTS(SELECT 1 FROM coding_revisions v WHERE v.job_id=j.id
             AND v.request_key='auto-retry:'||j.attempt_id::text)
           -- The owner changed this job while it was stopped, and was told it stays stopped.
           AND NOT EXISTS(SELECT 1 FROM coding_events s WHERE s.job_id=j.id
             AND s.event_key LIKE 'settings:%' AND s.created_at>=j.updated_at)
           AND (EXISTS(SELECT 1 FROM coding_events e WHERE e.job_id=j.id
                  AND e.event_key=j.attempt_id::text||':paused'
                  AND e.payload->>'cause' IN ('sandbox_stopped','heartbeat_lost'))
             OR (j.result->>'kind'='paused' AND EXISTS(SELECT 1 FROM coding_events e WHERE e.job_id=j.id
                  AND e.event_key=j.attempt_id::text||':finished')
               -- Judge only the latest rejection: an older fault is never a fallback.
               AND (SELECT (p.payload->>'code'='gateway_restart'
                         OR p.payload->>'code'='model_rate_limited' AND p.payload->>'providerStatus'='429'
                         OR p.payload->>'code'='model_transient_failure'
                            AND p.payload->>'providerStatus' IN ('500','502','503','504'))
                       AND NOT (p.payload ? 'timeoutKind' OR p.payload ? 'finishReason' OR p.payload ? 'providerFailure')
                       AND NOT EXISTS(SELECT 1 FROM coding_model_calls c WHERE c.job_id=j.id
                         AND c.attempt_id=j.attempt_id AND c.state='complete' AND c.created_at>p.created_at)
                    FROM coding_events p WHERE p.job_id=j.id
                      AND p.event_key LIKE j.attempt_id::text||':request-rejected:%'
                      AND p.payload->>'kind'='worker_request_rejected'
                    ORDER BY p.created_at DESC,p.id DESC LIMIT 1)))
         ORDER BY j.updated_at`,
      )
    ).rows as CodingJob[];
    // Unbounded on purpose (pauses from the last day): revoked owners must not crowd out others.
    const j = candidates.find((c) => this.allowed(c.user_id));
    if (!j) return;
    const key = `auto-retry:${j.attempt_id}`;
    const message =
      "Automatic retry after a transient fault (the sandbox stopped, its heartbeat was lost, or the model provider failed temporarily)";
    const retried = await this.db.query(
      `WITH changed AS (
      UPDATE coding_jobs SET revision=revision+1,state='queued',stage='queued',question='',result=NULL,attempt_id=NULL,sandbox_id=NULL,heartbeat_at=NULL,attempt_deadline=NULL,used_models=0,model_busy=false,publication_started=false,lease=NULL,lease_until=NULL,summary='Retrying once automatically after a transient fault',updated_at=now()
      WHERE id=$1 AND revision=$2 AND state='paused' AND NOT publication_started AND cleanup IN ('none','complete') AND (lease IS NULL OR lease_until<now())
        AND settings=$5::jsonb
        AND NOT EXISTS(SELECT 1 FROM coding_events s WHERE s.job_id=$1 AND s.event_key LIKE 'settings:%' AND s.created_at>=coding_jobs.updated_at) RETURNING id,revision,mode
    ), revised AS (
      INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) SELECT id,revision,$3,$4,mode FROM changed RETURNING job_id
    ) INSERT INTO coding_events(job_id,event_key,payload) SELECT job_id,$3,jsonb_build_object('summary','Retrying once automatically after a transient fault. If it pauses again, it will wait for you.') FROM revised RETURNING job_id`,
      [j.id, j.revision, key, message, JSON.stringify(j.settings)],
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
            "Owner access was revoked before the coding box was started",
            false,
          );
          return;
        }
        try {
          // No box starts before the owner's Start of the exact request (journal 191).
          if (
            j.mode !== "implement" ||
            !(await this.requirements.approved(j))
          ) {
            await this.stopped(
              j,
              "The owner must tap Start on the current request before any work",
              false,
            );
            return;
          }
          const request: SandboxRequest = {
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
          };
          // A job snapshotted with a worker image no sandbox runs any more (one from before
          // EC2 boxes, or one retired from the coding profile) is paused before anything is
          // launched, so it never blocks the queue.
          if (this.provider.accepts && !this.provider.accepts(request)) {
            await this.stopped(
              j,
              "This job's worker image is no longer run by the coding sandbox (it predates EC2 boxes or has been retired); start a new coding job to continue",
              false,
            );
            return;
          }
          const id = await this.provider.create(request);
          await this.db.query(
            "UPDATE coding_jobs SET sandbox_id=$3 WHERE id=$1 AND attempt_id=$2",
            [j.id, j.attempt_id, id],
          );
        } catch {
          await this.stopped(
            j,
            "Starting the coding box gave an uncertain answer; checking before any new attempt",
          );
        }
        return;
      }
      if (!j.sandbox_id) {
        const found = await this.provider.find(
          j.attempt_id,
          active.includes(j.state)
            ? Math.max(5, Math.ceil(this.activeMs(j) / 60000) + 5)
            : undefined,
        );
        if (found) {
          await this.db.query(
            "UPDATE coding_jobs SET sandbox_id=$3 WHERE id=$1 AND attempt_id=$2",
            [j.id, j.attempt_id, found],
          );
          j.sandbox_id = found;
        } else if (this.provider.authoritativeFind) {
          // The provider's own record says nothing was launched for this attempt, so there
          // is nothing to clean up; the job pauses for the owner without blocking the queue.
          await this.stopped(
            j,
            "The coding box never started; resume to try again",
            false,
          );
          await this.db.query(
            "UPDATE coding_jobs SET cleanup='complete',summary=CASE WHEN state='paused' THEN 'The coding box never started; resume to try again' ELSE summary END,updated_at=now() WHERE id=$1 AND attempt_id=$2 AND sandbox_id IS NULL AND cleanup='pending' AND state NOT IN ('provisioning','running','publishing')",
            [j.id, j.attempt_id],
          );
          return;
        } else {
          await this.stopped(
            j,
            "The coding box could not be identified; an operator must inspect it before resuming",
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
            .catch(() => null); // unknown, not "no stated reason"
          const expired =
            new Date(j.attempt_deadline).getTime() <= this.clock().getTime();
          const exitNote = await this.provider
            .exitNote?.(j.sandbox_id)
            .catch(() => undefined);
          await this.stopped(
            j,
            reason ??
              (expired
                ? "The coding box stopped without a result after its time ran out; the cause is unconfirmed, and saved work is retained"
                : `The coding box stopped before a result was recorded${exitNote ? ` (${exitNote})` : ""}; saved work is retained`),
            true,
            undefined,
            // Only a confirmed absence of a provider reason is transient.
            reason === undefined && !expired ? "sandbox_stopped" : undefined,
          );
        } else if (
          new Date(j.attempt_deadline).getTime() <= this.clock().getTime()
        )
          await this.stopped(
            j,
            state === "terminal"
              ? "The coding box stopped without a result after its time ran out; the cause is unconfirmed, and saved work is retained"
              : "Coding time ran out while the coding box was still working; saved work is retained",
          );
        else if (state === "terminal")
          await this.stopped(
            j,
            "The coding box stopped before a result was recorded; saved work is retained",
            true,
            undefined,
            "sandbox_stopped",
          );
        else if (
          this.clock().getTime() - new Date(j.heartbeat_at).getTime() >
          180000 +
            // Before the first heartbeat, a provider may need longer to boot (a cold box).
            (j.state === "provisioning"
              ? (this.provider.startupGraceMs?.(j.sandbox_id) ?? 0)
              : 0)
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
          // A PR that is not the reviewed artifact is never retried or recorded. The owner is
          // told, since the status message last said the change was being published.
          await this.db.query(
            `WITH changed AS (UPDATE coding_jobs SET state='paused',stage='paused',publication_started=false,summary=$2,updated_at=now() WHERE id=$1 AND state='publishing' RETURNING id)
            INSERT INTO coding_events(job_id,event_key,payload) SELECT id,$3,jsonb_build_object('summary',$2::text) FROM changed ON CONFLICT DO NOTHING`,
            [
              j.id,
              "Agent PR does not match the independently reviewed artifact; inspect it, then resume to republish the reviewed candidate or cancel",
              `publication-paused:${j.revision}:${j.attempt_id}`,
            ],
          );
          return;
        }
        await this.db.query(
          `WITH changed AS (UPDATE coding_jobs SET state='pr_ready',stage='pr_ready',pr_url=$2,head_sha=$3,summary=$6,updated_at=now() WHERE id=$1 AND state='publishing' RETURNING id)
          INSERT INTO coding_events(job_id,event_key,payload) SELECT id,$4,jsonb_build_object('summary',$6::text,'url',$2::text,'tree',$5::text,'coderSummary',$7::text) FROM changed ON CONFLICT DO NOTHING`,
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
            // The approved candidate's notice is folded into the status message, so the coder's
            // summary travels with the PR notice (journal 115).
            typeof fresh.result?.summary === "string"
              ? fresh.result.summary
              : null,
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
    // Status leases are left alone: an overlapping gateway may still hold one. A lease left
    // by a stopped process expires within two minutes, and until then it delays only that
    // job's progress (the claim skips it).
  }
  /**
   * After a gateway restart no model call is in flight: a call cut off mid-way never ran
   * its cleanup. Its result is unknown, so it becomes uncertain (never replayed), and the
   * job's model slot is freed so the worker, which survives in its box, can continue.
   * Runs before the worker routes open.
   */
  async recoverModels() {
    // A call this restart cut off is recorded, so the pause it causes can be retried once.
    await this.db.query(
      `WITH interrupted AS (UPDATE coding_model_calls SET state='uncertain' WHERE state='pending' RETURNING id,job_id,attempt_id)
       INSERT INTO coding_events(job_id,event_key,payload,delivery)
       SELECT job_id,attempt_id::text||':request-rejected:'||id::text,
         jsonb_build_object('kind','worker_request_rejected','phase','model','code','gateway_restart','callId',id::text),'suppressed'
       FROM interrupted WHERE attempt_id IS NOT NULL ON CONFLICT DO NOTHING`,
    );
    await this.db.query(
      "UPDATE coding_jobs SET model_busy=false WHERE model_busy",
    );
  }
  /**
   * Delivers the coding outbox, one claim per call (journal 115). Progress-only notices are
   * folded into one status message per job, edited in place until a separate notice for that
   * job (question, approval card, failure or outcome) goes out; the next progress then starts
   * a new status message below it. In quiet hours, progress that would need a new message
   * waits, while edits of a current status message (which do not notify) continue. Pending
   * cancellations for one owner become one summary. Notices claimed together share one
   * outcome: a send whose outcome is unknown makes all of them `uncertain`, never replayed.
   */
  async deliver(
    send: (
      user: string,
      target: import("../delivery-routing.js").Destination,
      text: string,
      approval?: import("./delivery.js").CodingApproval,
      /** Text shown as written, never parsed as markup. */
      plain?: string,
    ) => Promise<unknown>,
    options: {
      /** Edits a status message in place; without it, each progress run is a new message. */
      edit?: (
        user: string,
        messageId: number,
        text: string,
      ) => Promise<unknown>;
      quietHours?: QuietHours;
    } = {},
  ) {
    if (this.delivering) return;
    this.delivering = true;
    try {
      const quiet = inQuietHours(this.clock(), options.quietHours);
      const e = (
        await this.db.query(
          `UPDATE coding_events SET delivery='sending' WHERE id=(SELECT e.id FROM coding_events e JOIN coding_jobs j ON j.id=e.job_id WHERE e.delivery='pending' AND (NOT(e.payload ? 'requirements') OR j.state!='plan_ready' OR j.revision!=(e.payload->'requirements'->>'revision')::int OR (j.cleanup IN ('none','complete') AND (j.lease IS NULL OR j.lease_until<now())))
           AND NOT (e.event_key='cancelled' AND e.created_at>now()-interval '15 seconds')
           AND NOT ($1::boolean AND ${STATUS_NOTICE} AND NOT ($2::boolean AND EXISTS(SELECT 1 FROM coding_events s WHERE s.job_id=e.job_id AND s.event_key='status-message' AND s.payload->>'current'='true')))
           AND NOT (${STATUS_NOTICE} AND EXISTS(SELECT 1 FROM coding_events s WHERE s.job_id=e.job_id AND s.event_key='status-message' AND (s.payload->>'leaseUntil')::timestamptz>now()))
           ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT 1) RETURNING *`,
          [quiet, !!options.edit],
        )
      ).rows[0];
      if (!e) return;
      const ctx = { claimed: [e.id as string], attempted: false };
      try {
        const j = (
          await this.db.query("SELECT * FROM coding_jobs WHERE id=$1", [
            e.job_id,
          ])
        ).rows[0];
        const req = e.payload.requirements;
        const merge = e.payload.merge;
        const status =
          (
            await this.db.query(
              `SELECT ${STATUS_NOTICE} AS status FROM coding_events e JOIN coding_jobs j ON j.id=e.job_id WHERE e.id=$1`,
              [e.id],
            )
          ).rows[0]?.status === true;
        if (
          !this.allowed(j.user_id) ||
          // Progress after the owner cancelled the job is noise.
          (status && j.state === "cancelled") ||
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
        if (status) {
          await this.deliverStatus(e, j, send, options, quiet, ctx);
          return;
        }
        if (e.event_key === "cancelled") {
          await this.deliverCancellations(e, j, send, ctx);
          return;
        }
        await this.closeStatus(e.id);
        const id = (model: string) => Array.from(model).slice(0, 60).join("");
        // Telegram counts UTF-16 units, so emoji-heavy text is cut by units, not characters.
        const units = (text: string, max: number) => {
          let out = "";
          for (const ch of Array.from(text)) {
            if (out.length + ch.length > max) break;
            out += ch;
          }
          return out;
        };
        // The Start card (journal 191): the goal, who builds and reviews it, one Start button.
        // The goal and model ids are the owner's and the profile's text: cut first, then sent
        // as written, so neither markup in them nor a cut through it changes the card.
        const goal = String(j.objective)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 2)
          .join("\n");
        const caption = req ? "**Ready to start**" : undefined;
        const plain = req
          ? `${units(goal, 300)}\n\nCoder: ${id(j.settings.model)}. Reviewer: ${id(j.settings.reviewerModel)}.`
          : undefined;
        // Without the owner-merge workflow no Merge card repeats the coder's summary, so the
        // first PR notice carries it (bounded like the Merge card).
        const coderSummary =
          !req &&
          !merge &&
          e.event_key.endsWith(":pr") &&
          j.settings.prWorkflow !== "owner_merge"
            ? typeof e.payload.coderSummary === "string"
              ? e.payload.coderSummary
              : e.event_key === `${j.attempt_id}:pr`
                ? j.result?.summary
                : undefined
            : undefined;
        ctx.attempted = true;
        const sent = await send(
          j.user_id,
          codingDestination(e.payload),
          caption ??
            [
              `Coding job ${e.job_id}`,
              typeof e.payload.summary === "string"
                ? e.payload.summary.slice(0, 1500)
                : undefined,
              typeof e.payload.question === "string"
                ? e.payload.question.slice(0, 2000)
                : undefined,
              e.payload.url,
              typeof coderSummary === "string" && coderSummary
                ? `Coder's own summary (not verified by Chief): ${Array.from(coderSummary).slice(0, 800).join("")}`
                : undefined,
            ]
              .filter(Boolean)
              .join("\n\n"),
          req
            ? { kind: "requirements", id: e.id }
            : merge
              ? { kind: "merge", id: e.id }
              : undefined,
          plain,
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
        await this.markSent(ctx.claimed);
        // Close again after the send: with overlapping gateways, another process may have
        // taken the lease and opened a new status message between the first close and the
        // send. Needs no lease; the notice is already sent, so a failure here changes nothing.
        await this.closeStatus(e.id).catch(() => {});
      } catch {
        await this.db.query(
          "UPDATE coding_events SET delivery=$2 WHERE id=ANY($1::uuid[]) AND delivery='sending'",
          [ctx.claimed, ctx.attempted ? "uncertain" : "pending"],
        );
      }
    } finally {
      this.delivering = false;
    }
  }
  private async markSent(ids: string[]) {
    await this.db.query(
      "UPDATE coding_events SET delivery='sent' WHERE id=ANY($1::uuid[]) AND delivery='sending'",
      [ids],
    );
  }
  /**
   * A separate notice ends the job's current status message; later progress goes below it.
   * It takes no lease, so it never waits; `closedAt` lets a status delivery already in
   * flight see the close and not reopen the message (`saveStatus`).
   */
  private async closeStatus(eventId: string) {
    await this.db.query(
      `INSERT INTO coding_events(job_id,event_key,payload,delivery) SELECT job_id,'status-message',jsonb_build_object('current',false,'lines','[]'::jsonb,'total',0,'separateAt',created_at::text,'closedAt',clock_timestamp()::text),'suppressed' FROM coding_events WHERE id=$1
       ON CONFLICT(job_id,event_key) DO UPDATE SET payload=coding_events.payload || jsonb_build_object('current',false,'closedAt',clock_timestamp()::text,'separateAt',GREATEST((coding_events.payload->>'separateAt')::timestamptz,(EXCLUDED.payload->>'separateAt')::timestamptz)::text)`,
      [eventId],
    );
  }
  /**
   * Saves the anchor under this delivery's lease. Keeps `separateAt`; a missing messageId
   * clears the old one. A close at or after the lease was taken stays closed, and a save
   * whose lease has been lost (expired and taken by another process) writes nothing.
   */
  private async saveStatus(
    job: string,
    anchor: StatusAnchor,
    lease: string,
  ): Promise<boolean> {
    return (
      (
        await this.db.query(
          `UPDATE coding_events SET payload=(payload - 'messageId') || $2::jsonb
         || CASE WHEN (payload->>'closedAt')::timestamptz>=(payload->>'leasedAt')::timestamptz THEN '{"current":false}'::jsonb ELSE '{}'::jsonb END
       WHERE job_id=$1 AND event_key='status-message' AND payload->>'lease'=$3 RETURNING id`,
          [job, JSON.stringify(anchor), lease],
        )
      ).rows.length === 1
    );
  }
  /** Folds the job's run of pending progress, up to its next separate notice, into its status message. */
  private async deliverStatus(
    e: any,
    j: CodingJob,
    send: (
      user: string,
      target: import("../delivery-routing.js").Destination,
      text: string,
    ) => Promise<unknown>,
    options: {
      edit?: (
        user: string,
        messageId: number,
        text: string,
      ) => Promise<unknown>;
    },
    quiet: boolean,
    ctx: { claimed: string[]; attempted: boolean },
  ) {
    // One deliverer per job's status message, even across overlapping gateway processes:
    // the anchor's read, edit or send, and save happen under a short lease on its row.
    const lease = randomUUID();
    const leased = (
      await this.db.query(
        `INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,'status-message',jsonb_build_object('current',false,'lines','[]'::jsonb,'total',0,'lease',$2::text,'leaseUntil',(now()+interval '2 minutes')::text,'leasedAt',clock_timestamp()::text),'suppressed')
         ON CONFLICT(job_id,event_key) DO UPDATE SET payload=coding_events.payload || jsonb_build_object('lease',$2::text,'leaseUntil',(now()+interval '2 minutes')::text,'leasedAt',clock_timestamp()::text)
         WHERE NOT (coding_events.payload ? 'leaseUntil') OR (coding_events.payload->>'leaseUntil')::timestamptz<now() RETURNING id`,
        [e.job_id, lease],
      )
    ).rows.length;
    if (!leased) {
      // Another deliverer holds it; nothing was attempted, so these wait for the next tick.
      await this.db.query(
        "UPDATE coding_events SET delivery='pending' WHERE id=ANY($1::uuid[]) AND delivery='sending'",
        [ctx.claimed],
      );
      return;
    }
    try {
      await this.foldStatus(e, j, send, options, quiet, ctx, lease);
    } finally {
      await this.db.query(
        "UPDATE coding_events SET payload=payload - 'lease' - 'leaseUntil' WHERE job_id=$1 AND event_key='status-message' AND payload->>'lease'=$2",
        [e.job_id, lease],
      );
    }
  }
  private async foldStatus(
    e: any,
    j: CodingJob,
    send: (
      user: string,
      target: import("../delivery-routing.js").Destination,
      text: string,
    ) => Promise<unknown>,
    options: {
      edit?: (
        user: string,
        messageId: number,
        text: string,
      ) => Promise<unknown>;
    },
    quiet: boolean,
    ctx: { claimed: string[]; attempted: boolean },
    lease: string,
  ) {
    const following = (
      await this.db.query(
        `SELECT e.id,${STATUS_NOTICE} AS status FROM coding_events e JOIN coding_jobs j ON j.id=e.job_id
         WHERE e.job_id=$1 AND e.delivery='pending' AND e.created_at>=(SELECT created_at FROM coding_events WHERE id=$2)
         ORDER BY e.created_at,e.id LIMIT 50`,
        [e.job_id, e.id],
      )
    ).rows;
    const run: string[] = [];
    for (const r of following) {
      if (r.status !== true) break;
      run.push(r.id);
    }
    if (run.length) {
      const more = new Set(
        (
          await this.db.query(
            "UPDATE coding_events SET delivery='sending' WHERE id=ANY($1::uuid[]) AND delivery='pending' RETURNING id",
            [run],
          )
        ).rows.map((r: { id: string }) => r.id),
      );
      ctx.claimed.push(...run.filter((id) => more.has(id)));
    }
    // Progress held over quiet hours is superseded by a separate notice already sent after it.
    const superseded = new Set(
      (
        await this.db.query(
          `UPDATE coding_events e SET delivery='suppressed' FROM coding_events s
           WHERE e.id=ANY($1::uuid[]) AND e.delivery='sending' AND s.job_id=e.job_id AND s.event_key='status-message'
           AND s.payload ? 'separateAt' AND e.created_at<=(s.payload->>'separateAt')::timestamptz RETURNING e.id`,
          [ctx.claimed],
        )
      ).rows.map((r: { id: string }) => r.id),
    );
    ctx.claimed = ctx.claimed.filter((id) => !superseded.has(id));
    if (!ctx.claimed.length) return;
    const fresh: StatusLine[] = (
      await this.db.query(
        "SELECT event_key,payload,created_at FROM coding_events WHERE id=ANY($1::uuid[]) ORDER BY created_at,id",
        [ctx.claimed],
      )
    ).rows.map((r: any) => ({
      at: new Date(r.created_at).toISOString(),
      text: statusLine(r.event_key, r.payload),
    }));
    const anchor = (
      await this.db.query(
        "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='status-message'",
        [e.job_id],
      )
    ).rows[0]?.payload as StatusAnchor | undefined;
    const current =
      options.edit &&
      anchor?.current === true &&
      Number.isSafeInteger(anchor.messageId) &&
      anchor.messageId! > 0
        ? anchor
        : undefined;
    const total = (current?.total ?? 0) + fresh.length;
    // Oldest lines go first until the text is one Telegram message, so it stays editable.
    const { lines, text } = fitStatus(
      e.job_id,
      [...(current?.lines ?? []), ...fresh],
      total,
    );
    if (current) {
      // The intended text is saved first: if this edit fails or its outcome is lost, the next edit shows it.
      const saved = await this.saveStatus(
        e.job_id,
        {
          messageId: current.messageId,
          current: true,
          lines,
          total,
        },
        lease,
      );
      if (!saved) {
        // The lease was lost (expired and taken by another process): nothing was attempted.
        await this.db.query(
          "UPDATE coding_events SET delivery='pending' WHERE id=ANY($1::uuid[]) AND delivery='sending'",
          [ctx.claimed],
        );
        return;
      }
      ctx.attempted = true;
      try {
        await options.edit!(j.user_id, current.messageId!, text);
        await this.markSent(ctx.claimed);
        return;
      } catch (error) {
        if (!(error instanceof StatusMessageGone)) throw error;
        // Telegram refused the edit, so nothing changed; a new status message replaces it.
        ctx.attempted = false;
        await this.saveStatus(
          e.job_id,
          { current: false, lines, total },
          lease,
        );
      }
    }
    if (quiet) {
      // A new message would notify the owner at night: hold the run until quiet hours end.
      await this.db.query(
        "UPDATE coding_events SET delivery='pending' WHERE id=ANY($1::uuid[]) AND delivery='sending'",
        [ctx.claimed],
      );
      return;
    }
    ctx.attempted = true;
    const receipt = (await send(
      j.user_id,
      codingDestination(e.payload),
      text,
    )) as { message_id?: number } | undefined;
    const id = receipt?.message_id;
    const saved = await this.saveStatus(
      e.job_id,
      Number.isSafeInteger(id) && id! > 0
        ? { messageId: id, current: true, lines, total }
        : { current: false, lines, total },
      lease,
    );
    // The message went out but its id was not recorded: it is an orphan, never edited again.
    if (!saved)
      opsLog("coding.status_lease_lost", "warn", {
        taskId: e.job_id,
        messages: ctx.claimed.length,
      });
    await this.markSent(ctx.claimed);
  }
  /** One summary for the owner's pending cancellations instead of one notice per job. */
  private async deliverCancellations(
    e: any,
    j: CodingJob,
    send: (
      user: string,
      target: import("../delivery-routing.js").Destination,
      text: string,
    ) => Promise<unknown>,
    ctx: { claimed: string[]; attempted: boolean },
  ) {
    const others = (
      await this.db.query(
        `UPDATE coding_events e SET delivery='sending' FROM coding_jobs j
         WHERE j.id=e.job_id AND j.user_id=$1 AND e.event_key='cancelled' AND e.delivery='pending' AND e.id<>$2
         RETURNING e.id,e.job_id`,
        [j.user_id, e.id],
      )
    ).rows as { id: string; job_id: string }[];
    ctx.claimed.push(...others.map((r) => r.id));
    const jobs = [e.job_id as string, ...others.map((r) => r.job_id)];
    const objectives = new Map<string, string>(
      (
        await this.db.query(
          "SELECT id,objective FROM coding_jobs WHERE id=ANY($1::uuid[]) AND user_id=$2",
          [jobs, j.user_id],
        )
      ).rows.map((r: { id: string; objective: string }) => [
        r.id,
        Array.from(String(r.objective).split("\n")[0]!.trim())
          .slice(0, 80)
          .join(""),
      ]),
    );
    ctx.attempted = true;
    await send(
      j.user_id,
      codingDestination(e.payload),
      jobs.length === 1
        ? `Coding job ${e.job_id}\n\n${String(e.payload.summary ?? "").slice(0, 1500)}`
        : `**${jobs.length} coding jobs cancelled**\n${jobs.map((id) => `• ${objectives.get(id) || "Coding job"} (job ${id})`).join("\n")}\n\nTheir coding boxes are cleaned up separately.`,
    );
    await this.markSent(ctx.claimed);
  }
}
