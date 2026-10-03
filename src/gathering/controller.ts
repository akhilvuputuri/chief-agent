import { createHash, randomUUID } from "node:crypto";
import { atomicMutation, transaction } from "../db-transaction.js";
import type { Database } from "../db.js";
import type { GmailTools } from "../gmail.js";
import { ToolValidationError } from "../tool-errors.js";
import { publicHttps } from "../security.js";
import { FileVault, type PreparedFile } from "./vault.js";
import {
  datesIn,
  issuerTerms,
  invoiceFacts,
  productEvidence,
  issuerIdentity,
  type InvoiceFacts,
} from "./facts.js";
import {
  scopeSchema,
  type GatherScope,
  type GatherAction,
  type GatherTarget,
} from "./schema.js";
import type { GatheringBrowsers } from "./sessions.js";
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const safeText = (s: unknown, max = 120) =>
  String(s ?? "")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[payment number omitted]")
    .replace(
      /\b(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}\b/g,
      "[credential omitted]",
    )
    .slice(0, max);
const monthRange = (month: string) => ({
  start: month + "-01",
  end: new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1))
    .toISOString()
    .slice(0, 10),
});
export type Collection = {
  id: string;
  user_id: string;
  task_id: string;
  task_revision: number;
  scope: GatherScope;
  state: string;
  task_status: string;
  turn_revision?: number;
  evidence_revision: number;
};
export class Gathering {
  constructor(
    readonly db: Database,
    readonly vault: FileVault,
    private gmail?: Pick<
      GmailTools,
      "call" | "attachmentInfo" | "attachmentBytes"
    >,
    readonly browsers?: GatheringBrowsers,
    private origin = "",
  ) {}
  private async turn(user: string, run: string) {
    const row = (
      await this.db.query(
        "SELECT * FROM work_turns WHERE user_id=$1 AND run_id=$2",
        [user, run],
      )
    ).rows[0];
    if (!row)
      throw new ToolValidationError(
        "Gathering needs an authenticated owner turn",
      );
    return row;
  }
  async collection(user: string, id: string): Promise<Collection> {
    const row = (
      await this.db.query(
        "SELECT c.*,t.status task_status FROM gather_collections c JOIN work_tasks t ON t.id=c.task_id AND t.user_id=c.user_id WHERE c.id=$1 AND c.user_id=$2",
        [id, user],
      )
    ).rows[0];
    if (!row) throw new ToolValidationError("Collection is unavailable");
    row.scope = scopeSchema.parse(row.scope);
    return row;
  }
  async assigned(user: string, run: string, id: string, targetKey?: string) {
    const c = await this.collection(user, id),
      turn = await this.turn(user, run);
    if (
      turn.task_id !== c.task_id ||
      turn.revision !== c.task_revision ||
      !["active", "queued", "running"].includes(c.task_status) ||
      c.state !== "active"
    )
      throw new ToolValidationError(
        "Collection is not active in this turn; inspect it and use /continue after resolving a pause",
      );
    const target = targetKey
      ? c.scope.targets.find((t) => t.key === targetKey)
      : undefined;
    if (targetKey && !target)
      throw new ToolValidationError("Target is outside this collection");
    return { c, turn, target: target! };
  }
  private mutation(sql: string, values: unknown[], keyPosition = 3) {
    return atomicMutation(this.db, sql, values, {
      collectionId: String(values[0]),
      user: String(values[1]),
      requestKey: String(values[keyPosition]),
    });
  }
  private async prior(user: string, id: string, key: string, value: unknown) {
    const old = (
      await this.db.query(
        "SELECT m.request_hash,m.result,m.scope_revision,c.task_revision FROM gather_mutations m JOIN gather_collections c ON c.id=m.collection_id AND c.user_id=m.user_id WHERE m.collection_id=$1 AND m.user_id=$2 AND m.request_key=$3",
        [id, user, key],
      )
    ).rows[0];
    if (!old) return undefined;
    if (old.request_hash !== hash(value))
      throw new ToolValidationError(
        "Request key was already used for different gathering data",
      );
    const revisionResult =
      (value as { operation?: string }).operation === "gather_revise";
    if (old.task_revision !== old.scope_revision + (revisionResult ? 1 : 0))
      throw new ToolValidationError(
        "This mutation belongs to a superseded scope; inspect the current collection and use a new request key",
      );
    return { ...old.result, duplicate: true };
  }
  private lockSql = `SELECT c.id FROM work_tasks t JOIN gather_collections c ON c.task_id=t.id JOIN work_turns w ON w.task_id=t.id AND w.user_id=t.user_id
    WHERE c.id=$1 AND c.user_id=$2 AND w.run_id=$3 AND t.revision=c.task_revision AND w.revision=t.revision
      AND t.status IN ('active','queued','running') AND c.state='active' FOR UPDATE OF t,c`;
  private async recordAttempt(
    user: string,
    run: string,
    c: Collection,
    targetKey: string,
    kind: string,
    state: string,
    metadata: unknown,
  ) {
    const id = randomUUID();
    const row = (
      await this.db.query(
        `WITH authorized AS (${this.lockSql})
      INSERT INTO gather_attempts(id,user_id,collection_id,target_key,kind,state,metadata,scope_revision)
      SELECT $4::uuid,$2,$1,$5,$6,$7,$8::jsonb,$9::integer FROM authorized RETURNING id`,
        [
          c.id,
          user,
          run,
          id,
          targetKey,
          kind,
          state,
          JSON.stringify(metadata),
          c.task_revision,
        ],
      )
    ).rows[0];
    if (!row)
      throw new ToolValidationError(
        "Collection scope changed; inspect it before continuing",
      );
    return id;
  }
  private async source(
    user: string,
    run: string,
    c: Collection,
    t: GatherTarget,
    kind: GatherScope["sources"][number],
  ) {
    if (!c.scope.sources.includes(kind))
      throw new ToolValidationError(
        "This source was not authorized for the collection",
      );
    for (const preferred of c.scope.sources.slice(
      0,
      c.scope.sources.indexOf(kind),
    )) {
      const attempted = (
        await this.db.query(
          "SELECT 1 FROM gather_attempts WHERE collection_id=$1 AND user_id=$2 AND target_key=$3 AND kind=$4 AND scope_revision=$5 LIMIT 1",
          [
            c.id,
            user,
            t.key,
            preferred === "email" ? "search" : preferred,
            c.task_revision,
          ],
        )
      ).rows.length;
      if (attempted) continue;
      if (preferred === "provided" && !c.scope.providedFiles.length) {
        await this.recordAttempt(user, run, c, t.key, "provided", "success", {
          available: 0,
        });
        continue;
      }
      throw new ToolValidationError(
        `Try the requested ${preferred} source for this target before ${kind}`,
      );
    }
  }
  private async start(
    user: string,
    run: string,
    a: Extract<GatherAction, { operation: "gather_start" }>,
  ) {
    const { operation, requestKey, ...raw } = a,
      scope = scopeSchema.parse(raw),
      turn = await this.turn(user, run);
    if (
      turn.background ||
      (
        await this.db.query(
          "SELECT 1 FROM events WHERE user_id=$1 AND run_id=$2 AND type='agent.child_started'",
          [user, run],
        )
      ).rows.length
    )
      throw new ToolValidationError(
        "Only the owner-facing coordinator can start a collection",
      );
    const prior = (
      await this.db.query(
        "SELECT id,task_id,request_hash FROM gather_collections WHERE user_id=$1 AND request_key=$2",
        [user, requestKey],
      )
    ).rows[0];
    if (prior) {
      if (turn.task_id && turn.task_id !== prior.task_id)
        throw new ToolValidationError(
          "Collection is outside this turn assignment",
        );
      if (prior.request_hash !== hash(scope))
        throw new ToolValidationError(
          "Request key was already used for a different collection",
        );
      return { ...(await this.status(user, prior.id)), duplicate: true };
    }
    if (turn.task_id)
      throw new ToolValidationError(
        "This turn is bound to another task; preserve its scope and start gathering in a new owner request",
      );
    if (scope.sources.includes("email") && !this.gmail)
      throw new ToolValidationError(
        "Email is not connected; choose another source",
      );
    if (scope.sources.includes("browser") && !this.browsers)
      throw new ToolValidationError(
        "Authenticated browsing is not connected; choose another source",
      );
    for (const fileId of scope.providedFiles) {
      const row = (
        await this.db.query(
          "SELECT 1 FROM file_artifacts WHERE id=$1 AND user_id=$2",
          [fileId, user],
        )
      ).rows.length;
      if (!row || !turn.request.includes(fileId))
        throw new ToolValidationError(
          "Provided files must belong to this owner and be referenced in this owner request",
        );
    }
    const id = randomUUID(),
      task = randomUUID();
    const rows = (
      await this.db.query(
        `WITH owner_turn AS (SELECT * FROM work_turns WHERE run_id=$1 AND user_id=$2 AND task_id IS NULL AND NOT background FOR UPDATE),
      made_task AS (INSERT INTO work_tasks(id,user_id,objective,request,delivery_context)
        SELECT $3::uuid,$2,$4,request,jsonb_build_object('source','gathering','collectionId',$5::uuid::text,'threadId',(SELECT metadata->'threadId' FROM conversation_inputs WHERE user_id=$2 AND run_id=$1 ORDER BY ordinal LIMIT 1),'inputId',(SELECT id FROM conversation_inputs WHERE user_id=$2 AND run_id=$1 ORDER BY ordinal LIMIT 1)) FROM owner_turn RETURNING id),
      made_collection AS (INSERT INTO gather_collections(id,user_id,task_id,task_revision,request_key,request_hash,scope) SELECT $5::uuid,$2,id,1,$6,$7,$8::jsonb FROM made_task RETURNING id),
      scope_history AS (INSERT INTO gather_scope_history(collection_id,user_id,revision,scope,run_id) SELECT id,$2,1,$8::jsonb,$1 FROM made_collection),
      targets AS (INSERT INTO gather_targets(collection_id,user_id,key) SELECT c.id,$2,x->>'key' FROM made_collection c,jsonb_array_elements($8::jsonb->'targets') x),
      steps AS (INSERT INTO work_steps(task_id,key,title,verification,expected_operation) SELECT t.id,x->>'key',(x->>'label')||' — '||(x->>'month'),'action','gather_match' FROM made_task t,jsonb_array_elements($8::jsonb->'targets') x),
      revision AS (INSERT INTO work_revisions(task_id,revision,request,objective) SELECT t.id,1,w.request,$4 FROM made_task t,owner_turn w)
      UPDATE work_turns SET task_id=t.id,revision=1 FROM made_task t WHERE run_id=$1 AND user_id=$2 RETURNING task_id`,
        [
          run,
          user,
          task,
          scope.objective,
          id,
          requestKey,
          hash(scope),
          JSON.stringify(scope),
        ],
      )
    ).rows;
    if (!rows.length)
      throw new ToolValidationError("Task scope changed; inspect current work");
    return this.status(user, id);
  }
  private async revise(
    user: string,
    run: string,
    a: Extract<GatherAction, { operation: "gather_revise" }>,
  ) {
    const c = await this.collection(user, a.id),
      turn = await this.turn(user, run);
    if (
      turn.background ||
      (
        await this.db.query(
          "SELECT 1 FROM events WHERE user_id=$1 AND run_id=$2 AND type='agent.child_started'",
          [user, run],
        )
      ).rows.length
    )
      throw new ToolValidationError(
        "Only an owner follow-up can revise gathering",
      );
    if (turn.task_id && turn.task_id !== c.task_id)
      throw new ToolValidationError(
        "Collection is outside this turn assignment",
      );
    const old = await this.prior(user, a.id, a.requestKey, a);
    if (old) return old;
    if (
      c.task_revision !== a.baseRevision ||
      ["done", "cancelled", "running"].includes(c.task_status) ||
      (turn.task_id && turn.task_id !== c.task_id)
    )
      throw new ToolValidationError(
        "Collection is running, complete, cancelled or its scope changed; inspect it before revising",
      );
    const { operation, id, baseRevision, requestKey, ...raw } = a,
      scope = scopeSchema.parse(raw);
    for (const fileId of scope.providedFiles)
      if (
        !c.scope.providedFiles.includes(fileId) &&
        (!turn.request.includes(fileId) ||
          !(
            await this.db.query(
              "SELECT 1 FROM file_artifacts WHERE id=$1 AND user_id=$2",
              [fileId, user],
            )
          ).rows.length)
      )
        throw new ToolValidationError(
          "New provided files must be referenced in this owner follow-up",
        );
    const result = (
      await this.mutation(
        `WITH eligible AS (
      SELECT c.id,t.id task_id FROM work_tasks t JOIN gather_collections c ON c.task_id=t.id JOIN work_turns w ON w.run_id=$3 AND w.user_id=t.user_id
      WHERE c.id=$1 AND c.user_id=$2 AND c.task_revision=$4 AND t.revision=$4 AND t.status IN ('active','queued','paused') AND t.lease IS NULL
      AND NOT w.background AND (w.task_id IS NULL OR w.task_id=t.id) AND NOT EXISTS(SELECT 1 FROM runtime_runs r WHERE r.task_id=t.id AND r.user_id=$2 AND r.id<>$3 AND r.state='running') FOR UPDATE OF t,c,w
    ), mutation AS (INSERT INTO gather_mutations(collection_id,user_id,request_key,request_hash,result) SELECT $1,$2,$5,$6,'{}'::jsonb FROM eligible ON CONFLICT DO NOTHING RETURNING collection_id),
    task AS (UPDATE work_tasks SET revision=revision+1,objective=$7,request=request||E'\nOwner follow-up: '||$9,status='active',pause_reason=NULL,updated_at=now() WHERE id=(SELECT task_id FROM eligible) AND EXISTS(SELECT 1 FROM mutation) RETURNING id,revision,request),
    revised AS (UPDATE gather_collections SET task_revision=$4+1,scope=$8::jsonb,evidence_revision=evidence_revision+1,updated_at=now() WHERE id=$1 AND user_id=$2 AND EXISTS(SELECT 1 FROM task) RETURNING task_id,task_revision),
    history AS (INSERT INTO gather_scope_history(collection_id,user_id,revision,scope,run_id) SELECT $1,$2,task_revision,$8::jsonb,$3 FROM revised),
    work_history AS (INSERT INTO work_revisions(task_id,revision,request,objective) SELECT id,revision,$9,$7 FROM task),
    old_targets AS (UPDATE gather_targets SET active=EXISTS(SELECT 1 FROM jsonb_array_elements($8::jsonb->'targets') x WHERE x->>'key'=gather_targets.key),state='pending',reason=NULL,coverage_checked=false,coverage_source=NULL,coverage_note=NULL WHERE collection_id=$1 AND user_id=$2 AND EXISTS(SELECT 1 FROM revised)),
    targets AS (INSERT INTO gather_targets(collection_id,user_id,key,active) SELECT $1,$2,x->>'key',true FROM revised,jsonb_array_elements($8::jsonb->'targets') x WHERE NOT EXISTS(SELECT 1 FROM gather_targets WHERE collection_id=$1 AND key=x->>'key') ON CONFLICT DO NOTHING),
    retired_steps AS (UPDATE work_steps SET status=CASE WHEN status='done' THEN status ELSE 'blocked' END,result=CASE WHEN status='done' THEN result ELSE 'Removed by owner scope revision; prior files and receipts are retained.' END WHERE task_id=(SELECT task_id FROM revised) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($8::jsonb->'targets') x WHERE x->>'key'=work_steps.key)),
    steps AS (INSERT INTO work_steps(task_id,key,title,verification,expected_operation) SELECT task_id,x->>'key',(x->>'label')||' — '||(x->>'month'),'action','gather_match' FROM revised,jsonb_array_elements($8::jsonb->'targets') x ON CONFLICT(task_id,key) DO UPDATE SET title=EXCLUDED.title,status='pending',result='',proofs='{}'),
    sessions AS (UPDATE gather_browser_sessions SET state='closed',encrypted_state=NULL,generation=generation+1 WHERE collection_id=$1 AND user_id=$2 AND EXISTS(SELECT 1 FROM revised)),
    bound AS (UPDATE work_turns SET task_id=(SELECT task_id FROM revised),revision=$4+1 WHERE run_id=$3 AND user_id=$2 AND EXISTS(SELECT 1 FROM revised))
    SELECT jsonb_build_object('revised',true,'collectionId',$1::text,'revision',$4+1) AS result FROM mutation WHERE EXISTS(SELECT 1 FROM revised)`,
        [
          id,
          user,
          run,
          baseRevision,
          requestKey,
          hash(a),
          scope.objective,
          JSON.stringify(scope),
          turn.request,
        ],
        4,
      )
    ).rows[0]?.result;
    if (result) await this.browsers?.closeCollection(user, id);
    return result ?? (await this.lostMutation(user, id, requestKey, a));
  }
  /** Only the authenticated owner UI can attest account identity; no model tool exposes this method. */
  async verifyTarget(
    user: string,
    id: string,
    targetKey: string,
    artifactId: string,
    revision: number,
  ) {
    return transaction(this.db, async (db) => {
      const c = (
        await db.query(
          "SELECT c.* FROM work_tasks t JOIN gather_collections c ON c.task_id=t.id AND c.user_id=t.user_id WHERE c.id=$1 AND c.user_id=$2 AND c.task_revision=$3 AND t.revision=$3 AND c.state='active' AND t.status NOT IN ('cancelled','done') FOR UPDATE OF t,c",
          [id, user, revision],
        )
      ).rows[0];
      const target = c?.scope.targets.find(
        (t: GatherTarget) => t.key === targetKey,
      );
      if (
        !target ||
        !(
          await db.query(
            "SELECT g.facts FROM gather_candidates g JOIN gather_attempts a ON a.id=g.attempt_id AND a.user_id=g.user_id WHERE g.collection_id=$1 AND g.user_id=$2 AND g.target_key=$3 AND g.artifact_id=$4 AND a.scope_revision=$5",
            [id, user, targetKey, artifactId, revision],
          )
        ).rows.length
      )
        throw new ToolValidationError(
          "This candidate or account scope changed; reopen the invoice view",
        );
      const candidate = (
        await db.query(
          "SELECT facts FROM gather_candidates WHERE collection_id=$1 AND user_id=$2 AND target_key=$3 AND artifact_id=$4",
          [id, user, targetKey, artifactId],
        )
      ).rows[0];
      if (productEvidence(candidate.facts, target.label) === "conflict")
        throw new ToolValidationError(
          "This PDF explicitly identifies a different product; revise the target or supply the correct invoice",
        );
      await db.query(
        "INSERT INTO gather_target_verifications(collection_id,target_key,user_id,artifact_id,scope_revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [id, targetKey, user, artifactId, revision],
      );
      return {
        verified: true,
        product: target.label,
        accountLabel: target.accountLabel,
      };
    });
  }
  async status(user: string, id?: string, offset = 0, full = false) {
    if (!id) {
      const rows = (
        await this.db.query(
          "SELECT c.id,c.task_id,left(c.scope->>'objective',240) objective,c.state,t.status task_status,c.created_at FROM gather_collections c JOIN work_tasks t ON t.id=c.task_id AND t.user_id=c.user_id WHERE c.user_id=$1 ORDER BY c.created_at DESC,c.id LIMIT 11 OFFSET $2",
          [user, offset],
        )
      ).rows;
      return {
        collections: rows.slice(0, 10),
        nextOffset: rows.length > 10 ? offset + 10 : null,
      };
    }
    const c = await this.collection(user, id),
      states = (
        await this.db.query(
          "SELECT key,state,reason,coverage_checked,coverage_source,coverage_note FROM gather_targets WHERE collection_id=$1 AND user_id=$2 AND active ORDER BY key",
          [id, user],
        )
      ).rows;
    const items = (
      await this.db.query(
        "SELECT i.target_key,i.artifact_id,i.match_date::text date,i.date_basis,a.name,a.bytes FROM gather_items i JOIN file_artifacts a ON a.id=i.artifact_id AND a.user_id=i.user_id WHERE i.collection_id=$1 AND i.user_id=$2 AND i.scope_revision=$3 ORDER BY i.target_key,a.name,a.id",
        [id, user, c.task_revision],
      )
    ).rows;
    const candidates = (
      await this.db.query(
        "SELECT c.target_key,c.artifact_id,c.facts,a.name,a.bytes,EXISTS(SELECT 1 FROM gather_target_verifications v WHERE v.collection_id=c.collection_id AND v.target_key=c.target_key AND v.user_id=c.user_id AND v.artifact_id=c.artifact_id AND v.scope_revision=$3) target_verified FROM gather_candidates c JOIN gather_attempts p ON p.id=c.attempt_id AND p.user_id=c.user_id JOIN file_artifacts a ON a.id=c.artifact_id AND a.user_id=c.user_id WHERE c.collection_id=$1 AND c.user_id=$2 AND p.scope_revision=$3 ORDER BY c.target_key,a.name,a.id",
        [id, user, c.task_revision],
      )
    ).rows;
    const browsers = (
      await this.db.query(
        "SELECT id,target_key,origin,state,expires_at FROM gather_browser_sessions WHERE collection_id=$1 AND user_id=$2 AND state<>'closed' AND expires_at>now() ORDER BY id",
        [id, user],
      )
    ).rows;
    const targetRows = c.scope.targets.map((t) => ({
      ...t,
      ...states.find((s) => s.key === t.key),
      files: full
        ? items.filter((i) => i.target_key === t.key)
        : items.filter((i) => i.target_key === t.key).slice(0, 5),
      fileCount: items.filter((i) => i.target_key === t.key).length,
      candidates: candidates
        .filter((i) => i.target_key === t.key)
        .slice(0, full ? 100 : 5)
        .map((i) => ({
          ...i,
          targetConflict: productEvidence(i.facts, t.label) === "conflict",
          needsTargetVerification:
            !!t.accountLabel ||
            productEvidence(i.facts, t.label) === "ambiguous",
          facts: full
            ? i.facts
            : {
                productLabels: i.facts.productLabels,
                invoiceDates: i.facts.invoiceDates,
                serviceMonths: i.facts.serviceMonths,
                issuerLabels: i.facts.issuerLabels,
                invoiceHeading: i.facts.invoiceHeading,
                selectableText: i.facts.selectableText,
                truncated: i.facts.truncated,
              },
        })),
    }));
    const counts = {
      expected: states.length,
      covered: states.filter((s) => s.state === "covered").length,
      blocked: states.filter((s) => s.state === "blocked").length,
      pending: states.filter((s) => s.state === "pending").length,
      files: new Set(items.map((i) => i.artifact_id)).size,
    };
    const rows = full ? targetRows : targetRows.slice(offset, offset + 10);
    const out = {
      id,
      taskId: c.task_id,
      revision: c.task_revision,
      objective: c.scope.objective,
      state: c.task_status === "cancelled" ? "cancelled" : c.state,
      taskState: c.task_status,
      counts,
      sources: c.scope.sources,
      mailboxes: c.scope.mailboxes,
      providedFiles: c.scope.providedFiles,
      targets: rows,
      browsers,
      nextOffset:
        !full && offset + rows.length < targetRows.length
          ? offset + rows.length
          : null,
      view: `${this.origin}/miniapp/?view=gathering&gather=${id}`,
      notice:
        "Coverage means files matched to the requested targets using recorded document clues. It is not a census of every account or a certification of invoice authenticity. Missing targets remain explicit. Invoice gathering does not save or change subscription records.",
    };
    if (!full)
      while (out.targets.length > 1 && JSON.stringify(out).length > 11000) {
        out.targets.pop();
        out.nextOffset = offset + out.targets.length;
      }
    return out;
  }
  async progress(user: string, id: string, targetKey: string, offset = 0) {
    const c = await this.collection(user, id);
    if (!c.scope.targets.some((t) => t.key === targetKey))
      throw new ToolValidationError("Target is outside this collection");
    const rows = (
      await this.db.query(
        "SELECT id,kind,state,metadata,created_at FROM gather_attempts WHERE collection_id=$1 AND user_id=$2 AND target_key=$3 AND scope_revision=$4 ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET $5",
        [id, user, targetKey, c.task_revision, offset],
      )
    ).rows;
    const attempts = rows.slice(0, 20);
    const result = {
      collectionId: id,
      targetKey,
      revision: c.task_revision,
      attempts,
      nextOffset: rows.length > 20 ? offset + 20 : null,
      notice:
        "Recorded scoped attempts and pagination references. Reuse completed inspections and captured files; these are source records, not independent invoice authentication.",
    };
    while (
      result.attempts.length > 1 &&
      JSON.stringify(result).length > 11000
    ) {
      result.attempts.pop();
      result.nextOffset = offset + result.attempts.length;
    }
    return result;
  }
  private async readScope(user: string, run: string, id: string | undefined) {
    const child = (
      await this.db.query(
        "SELECT 1 FROM events WHERE user_id=$1 AND run_id=$2 AND type='agent.child_started' LIMIT 1",
        [user, run],
      )
    ).rows.length;
    if (!child) return;
    if (!id)
      throw new ToolValidationError(
        "An agent may read only its assigned collection",
      );
    const c = await this.collection(user, id),
      turn = await this.turn(user, run);
    if (turn.task_id !== c.task_id || turn.revision !== c.task_revision)
      throw new ToolValidationError(
        "Collection is outside this agent's current assignment",
      );
  }
  async call(user: string, run: string, a: GatherAction): Promise<any> {
    if (a.operation === "gather_start") return this.start(user, run, a);
    if (a.operation === "gather_revise") return this.revise(user, run, a);
    if (a.operation === "gather_status") {
      await this.readScope(user, run, a.id);
      return this.status(user, a.id, a.offset);
    }
    if (a.operation === "gather_progress") {
      await this.readScope(user, run, a.id);
      return this.progress(user, a.id, a.targetKey, a.offset);
    }
    // Retries may be returned after completion, but never outside the original task/revision.
    const replayCollection = await this.collection(user, a.id);
    const replayTurn = await this.turn(user, run);
    if (
      replayTurn.task_id !== replayCollection.task_id ||
      replayTurn.revision !== replayCollection.task_revision
    )
      throw new ToolValidationError(
        "Collection is not active in this turn's assignment",
      );
    if ("requestKey" in a) {
      const old = await this.prior(user, a.id, a.requestKey, a);
      if (old) return old;
    }
    if (
      a.operation === "gather_finish" &&
      (await this.collection(user, a.id)).state === "complete"
    )
      return { complete: true, collectionId: a.id };
    const { c, target: t } = await this.assigned(
      user,
      run,
      a.id,
      "targetKey" in a ? a.targetKey : undefined,
    );
    if (a.operation === "gather_search") {
      await this.source(user, run, c, t, "email");
      if (!c.scope.mailboxes.includes(a.account) || !this.gmail)
        throw new ToolValidationError("This mailbox is not authorized");
      const range = monthRange(t.month),
        start = new Date(range.start + "T00:00:00Z"),
        end = new Date(range.end + "T00:00:00Z");
      start.setUTCDate(start.getUTCDate() - 35);
      end.setUTCDate(end.getUTCDate() + 35);
      const terms = issuerTerms(t.label)
        .map((x) => '"' + x.replace(/["\\{}()]/g, "") + '"')
        .join(" ");
      const query =
        `after:${Math.floor(start.getTime() / 1000)} before:${Math.floor(end.getTime() / 1000)} {${terms}} {invoice receipt billing statement} filename:pdf ${a.query}`.trim();
      if (
        a.pageToken &&
        !(
          await this.db.query(
            "SELECT 1 FROM gather_attempts WHERE collection_id=$1 AND user_id=$2 AND target_key=$3 AND scope_revision=$4 AND kind='search' AND state='success' AND metadata->>'account'=$5 AND metadata->>'nextPageToken'=$6 AND metadata->>'queryHash'=$7",
            [
              c.id,
              user,
              t.key,
              c.task_revision,
              a.account,
              a.pageToken,
              hash(query),
            ],
          )
        ).rows.length
      )
        throw new ToolValidationError(
          "Pagination must come from this same scoped search",
        );
      try {
        const result = (await this.gmail.call(
          user,
          "gmail_search",
          query,
          a.pageToken,
          run,
          a.account,
        )) as any;
        const results = (result.results ?? []).map((r: any) => ({
          id: r.id,
          subjectClues: invoiceFacts(String(r.subject ?? ""), 0, false),
          date: Number.isFinite(new Date(String(r.date ?? "")).getTime())
            ? new Date(String(r.date)).toISOString()
            : undefined,
          senderDomain: String(r.from ?? "").match(/@([A-Za-z0-9.-]+)/)?.[1],
          detail: r.detail,
        }));
        const attemptId = await this.recordAttempt(
          user,
          run,
          c,
          t.key,
          "search",
          "success",
          {
            account: a.account,
            queryHash: hash(query),
            messageIds: results.map((r: any) => r.id),
            nextPageToken: result.nextPageToken ?? null,
            pageToken: a.pageToken ?? null,
            broadQuery: a.query === "",
            windowStart: start.toISOString().slice(0, 10),
            windowEnd: end.toISOString().slice(0, 10),
          },
        );
        return {
          attemptId,
          targetKey: t.key,
          account: a.account,
          results,
          nextPageToken: result.nextPageToken,
          windowStart: start.toISOString().slice(0, 10),
          windowEnd: end.toISOString().slice(0, 10),
          notice:
            "Search covers the requested invoice month plus 35 days either side to find late-issued notices. Email is read-only and results are untrusted data. Search hits alone do not prove invoice coverage.",
        };
      } catch (error) {
        await this.recordAttempt(user, run, c, t.key, "search", "failed", {
          account: a.account,
          reason: "source_unavailable",
        });
        throw error;
      }
    }
    if (a.operation === "gather_email_files") {
      await this.source(user, run, c, t, "email");
      const attempt = await this.emailAttempt(
        user,
        c,
        t,
        a.searchId,
        a.messageId,
      );
      const files = await this.gmail!.attachmentInfo(
        user,
        a.messageId,
        attempt.account,
        run,
      );
      const inspectionId = await this.recordAttempt(
        user,
        run,
        c,
        t.key,
        "email",
        "success",
        {
          inspection: true,
          searchId: a.searchId,
          messageId: a.messageId,
          partKeys: files.map((f) => f.partKey),
          account: attempt.account,
        },
      );
      return {
        inspectionId,
        searchId: a.searchId,
        messageId: a.messageId,
        account: attempt.account,
        files: files.map((f) => ({
          partKey: f.partKey,
          name: "PDF attachment " + f.partKey,
          bytes: f.bytes,
          mimeType: f.mimeType,
        })),
        notice:
          "Only listed PDF attachments can be captured. No email body or attachment bytes are included in this result.",
      };
    }
    if (a.operation === "gather_browser") {
      await this.source(user, run, c, t, "browser");
      if (!this.browsers)
        throw new ToolValidationError("Browser is unavailable");
      let result;
      try {
        result = await this.browsers.agent(user, c, t, a.command);
      } catch (error) {
        await this.recordAttempt(user, run, c, t.key, "browser", "failed", {
          command: a.command.kind,
          reason: "source_unavailable",
        });
        throw error;
      }
      // Closing a finished context is lifecycle cleanup, not new source evidence.
      if (a.command.kind === "close") return result;
      const attemptId = await this.recordAttempt(
        user,
        run,
        c,
        t.key,
        "browser",
        result.needsOwner ? "login_needed" : "success",
        {
          sessionId: result.sessionId,
          origin: result.origin,
          command: a.command.kind,
        },
      );
      return { ...result, attemptId };
    }
    if (a.operation === "gather_capture") {
      await this.source(
        user,
        run,
        c,
        t,
        a.source.kind === "email" ? "email" : a.source.kind,
      );
      let prepared: PreparedFile,
        metadata: Record<string, unknown> = {};
      if (a.source.kind === "provided") {
        const file = await this.vault.read(user, a.source.artifactId),
          turn = await this.turn(user, run);
        const parent = (
          await this.db.query(
            "SELECT w.request FROM events e JOIN work_turns w ON w.run_id=(e.data->>'parentRunId')::uuid AND w.user_id=e.user_id WHERE e.run_id=$1 AND e.user_id=$2 AND e.type='agent.child_started' LIMIT 1",
            [run, user],
          )
        ).rows[0];
        if (
          !c.scope.providedFiles.includes(file.id) &&
          !(parent
            ? String(parent.request).includes(file.id)
            : turn.request.includes(file.id))
        )
          throw new ToolValidationError(
            "This file was not supplied for this collection or owner turn",
          );
        prepared = await this.vault.prepare(
          user,
          file.name,
          file.data,
          c.scope.targets.map((t) => t.label),
        );
        metadata = { artifactId: file.id };
      } else if (a.source.kind === "email") {
        const attempt = await this.emailAttempt(
          user,
          c,
          t,
          a.source.searchId,
          a.source.messageId,
        );
        const file = await this.gmail!.attachmentBytes(
          user,
          a.source.messageId,
          a.source.partKey,
          attempt.account,
          run,
        );
        prepared = await this.vault.prepare(
          user,
          file.name,
          file.data,
          c.scope.targets.map((t) => t.label),
        );
        metadata = {
          account: attempt.account,
          messageId: a.source.messageId,
          partKey: a.source.partKey,
          searchId: a.source.searchId,
        };
      } else {
        if (!this.browsers)
          throw new ToolValidationError("Browser is unavailable");
        const file = await this.browsers.download(user, c, t, a.source);
        prepared = await this.vault.prepare(
          user,
          file.name,
          file.data,
          c.scope.targets.map((t) => t.label),
        );
        metadata = { sessionId: a.source.sessionId, origin: file.origin };
      }
      return this.saveCandidate(user, run, c, t, a, prepared, metadata);
    }
    if (a.operation === "gather_match") {
      const candidate = (
        await this.db.query(
          "SELECT c.facts,a.kind,a.metadata,a.scope_revision FROM gather_candidates c JOIN gather_attempts a ON a.id=c.attempt_id AND a.user_id=c.user_id WHERE c.collection_id=$1 AND c.user_id=$2 AND c.target_key=$3 AND c.artifact_id=$4",
          [c.id, user, t.key, a.artifactId],
        )
      ).rows[0];
      const facts = candidate?.facts as InvoiceFacts | undefined;
      if (facts && productEvidence(facts, t.label) === "conflict")
        throw new ToolValidationError(
          "This file explicitly identifies a different product from the requested target",
        );
      if (
        facts &&
        (t.accountLabel || productEvidence(facts, t.label) === "ambiguous") &&
        !(
          await this.db.query(
            "SELECT 1 FROM gather_target_verifications WHERE collection_id=$1 AND user_id=$2 AND target_key=$3 AND artifact_id=$4 AND scope_revision=$5",
            [c.id, user, t.key, a.artifactId, c.task_revision],
          )
        ).rows.length
      )
        throw new ToolValidationError(
          "The requested product/account has not been verified by the owner. Ask them to inspect this PDF and verify the target in the Invoices view.",
        );
      if (
        !facts ||
        candidate.scope_revision !== c.task_revision ||
        !c.scope.sources.includes(candidate.kind) ||
        !facts.selectableText ||
        facts.truncated ||
        !facts.invoiceHeading ||
        facts.invoiceNumbers.length > 1 ||
        (a.dateBasis === "invoice_date" && facts.invoiceDates.length !== 1) ||
        new Set(facts.issuerLabels.map(issuerIdentity)).size !== 1 ||
        !facts.issuerLabels.includes(t.label) ||
        a.date.slice(0, 7) !== t.month ||
        a.dateBasis !== t.dateBasis ||
        (a.dateBasis === "invoice_date"
          ? !datesIn(a.date).includes(a.date) ||
            !facts.invoiceDates.includes(a.date)
          : !(
              facts.serviceDates.includes(a.date) ||
              (a.date.length === 7 && facts.serviceMonths?.includes(a.date))
            ))
      )
        throw new ToolValidationError(
          "This file does not have complete recorded issuer/date clues for the requested target; leave it unverified and ask the owner",
        );
      const receipt = randomUUID();
      const result = (
        await this.mutation(
          `WITH authorized AS (${this.lockSql}),
        mutation AS (INSERT INTO gather_mutations(collection_id,user_id,request_key,request_hash,result) SELECT $1,$2,$4,$5,'{}'::jsonb FROM authorized ON CONFLICT DO NOTHING RETURNING collection_id),
        receipt AS (INSERT INTO tool_receipts(id,user_id,run_id,task_id,operation,status,details) SELECT $6::uuid,$2,$3,$7::uuid,'gather_match','success',jsonb_build_object('collectionId',$1::text,'targetKey',$8::text,'artifactId',$9::text) FROM mutation RETURNING id),
        item AS (INSERT INTO gather_items(collection_id,target_key,user_id,artifact_id,match_date,date_basis,receipt_id,scope_revision) SELECT $1,$8,$2,$9::uuid,$10,$11,receipt.id,$12::integer FROM receipt ON CONFLICT(collection_id,target_key,artifact_id) DO UPDATE SET match_date=EXCLUDED.match_date,date_basis=EXCLUDED.date_basis,receipt_id=EXCLUDED.receipt_id,scope_revision=EXCLUDED.scope_revision RETURNING artifact_id),
        target AS (UPDATE gather_targets SET state=CASE WHEN coverage_checked THEN 'covered' ELSE 'pending' END,reason=NULL,updated_at=now() WHERE collection_id=$1 AND user_id=$2 AND key=$8 AND EXISTS(SELECT 1 FROM item)),
        step AS (UPDATE work_steps SET status='done',result='A PDF with recorded issuer and date clues was matched; this is not independent invoice authentication.',proofs=ARRAY[$6::uuid] WHERE task_id=$7 AND key=$8 AND EXISTS(SELECT 1 FROM item) AND EXISTS(SELECT 1 FROM gather_targets WHERE collection_id=$1 AND key=$8 AND coverage_checked))
        SELECT jsonb_build_object('matched',true,'artifactId',$9::text,'targetKey',$8::text,'date',$10::text,'receiptId',$6::text) AS result FROM mutation WHERE EXISTS(SELECT 1 FROM item)`,
          [
            c.id,
            user,
            run,
            a.requestKey,
            hash(a),
            receipt,
            c.task_id,
            t.key,
            a.artifactId,
            a.date,
            a.dateBasis,
            c.task_revision,
          ],
        )
      ).rows[0]?.result;
      return result ?? (await this.lostMutation(user, c.id, a.requestKey, a));
    }
    if (a.operation === "gather_check") {
      await this.source(user, run, c, t, a.source);
      const proof = await this.collection(user, c.id);
      const note = await this.coverage(user, c, t, a.source);
      const result = (
        await this.mutation(
          `WITH authorized AS (${this.lockSql.replace("AND c.state='active'", "AND c.state='active' AND c.evidence_revision=$11")}),
        mutation AS (INSERT INTO gather_mutations(collection_id,user_id,request_key,request_hash,result) SELECT $1,$2,$4,$5,'{}'::jsonb FROM authorized ON CONFLICT DO NOTHING RETURNING collection_id),
        target AS (UPDATE gather_targets SET coverage_checked=true,coverage_source=$7,coverage_note=$8,state=CASE WHEN EXISTS(SELECT 1 FROM gather_items WHERE collection_id=$1 AND target_key=$6 AND scope_revision=$9) THEN 'covered' ELSE 'blocked' END,reason=CASE WHEN EXISTS(SELECT 1 FROM gather_items WHERE collection_id=$1 AND target_key=$6 AND scope_revision=$9) THEN NULL ELSE 'no_matching_file' END,updated_at=now() WHERE collection_id=$1 AND user_id=$2 AND key=$6 AND EXISTS(SELECT 1 FROM mutation) RETURNING state),
        step AS (UPDATE work_steps SET status=CASE WHEN (SELECT state FROM target)='covered' THEN 'done' ELSE 'blocked' END,result=$8,proofs=COALESCE((SELECT array_agg(receipt_id) FROM gather_items WHERE collection_id=$1 AND user_id=$2 AND target_key=$6 AND scope_revision=$9),'{}'::uuid[]) WHERE task_id=$10 AND key=$6 AND EXISTS(SELECT 1 FROM target))
        SELECT jsonb_build_object('checked',true,'targetKey',$6::text,'source',$7::text,'state',(SELECT state FROM target),'notice',$8::text) AS result FROM mutation WHERE EXISTS(SELECT 1 FROM target)`,
          [
            c.id,
            user,
            run,
            a.requestKey,
            hash(a),
            t.key,
            a.source,
            note,
            c.task_revision,
            c.task_id,
            proof.evidence_revision,
          ],
        )
      ).rows[0]?.result;
      return result ?? (await this.lostMutation(user, c.id, a.requestKey, a));
    }
    if (a.operation === "gather_block") {
      if (
        a.attemptId &&
        !(
          await this.db.query(
            "SELECT 1 FROM gather_attempts WHERE id=$1 AND user_id=$2 AND collection_id=$3 AND target_key=$4",
            [a.attemptId, user, c.id, t.key],
          )
        ).rows.length
      )
        throw new ToolValidationError("Attempt is outside this target");
      const result = (
        await this.mutation(
          `WITH authorized AS (${this.lockSql}),
        mutation AS (INSERT INTO gather_mutations(collection_id,user_id,request_key,request_hash,result) SELECT $1,$2,$4,$5,'{}'::jsonb FROM authorized ON CONFLICT DO NOTHING RETURNING collection_id),
        target AS (UPDATE gather_targets SET state=CASE WHEN state='covered' THEN state ELSE 'blocked' END,reason=CASE WHEN state='covered' THEN reason ELSE $7 END,updated_at=now() WHERE collection_id=$1 AND user_id=$2 AND key=$6 AND EXISTS(SELECT 1 FROM mutation) RETURNING state),
        step AS (UPDATE work_steps SET status='blocked',result=$7 WHERE task_id=$8 AND key=$6 AND EXISTS(SELECT 1 FROM target WHERE state='blocked'))
        SELECT jsonb_build_object('recorded',true,'targetKey',$6::text,'reason',$7::text) AS result FROM mutation WHERE EXISTS(SELECT 1 FROM target)`,
          [c.id, user, run, a.requestKey, hash(a), t.key, a.reason, c.task_id],
        )
      ).rows[0]?.result;
      return result ?? (await this.lostMutation(user, c.id, a.requestKey, a));
    }
    if (a.operation === "gather_finish") {
      const remaining = (
        await this.db.query(
          "SELECT key,state FROM gather_targets WHERE collection_id=$1 AND user_id=$2 AND active AND state<>'covered' ORDER BY key",
          [c.id, user],
        )
      ).rows;
      if (remaining.length)
        return {
          complete: false,
          remaining,
          notice:
            "Some requested targets still lack matched files. Return partial progress and the specific missing or blocked targets.",
        };
      const result = (
        await this.mutation(
          `WITH authorized AS (${this.lockSql}),
        mutation AS (INSERT INTO gather_mutations(collection_id,user_id,request_key,request_hash,result) SELECT $1,$2,$4,$5,'{}'::jsonb FROM authorized WHERE NOT EXISTS(SELECT 1 FROM gather_targets WHERE collection_id=$1 AND active AND state<>'covered') ON CONFLICT DO NOTHING RETURNING collection_id),
        completed AS (UPDATE gather_collections SET state='complete',updated_at=now() WHERE id=$1 AND user_id=$2 AND EXISTS(SELECT 1 FROM mutation) RETURNING task_id),
        task AS (UPDATE work_tasks SET status='done',lease=NULL,updated_at=now() WHERE id=(SELECT task_id FROM completed) AND user_id=$2)
        SELECT jsonb_build_object('complete',true,'collectionId',$1::text) AS result FROM mutation WHERE EXISTS(SELECT 1 FROM completed)`,
          [c.id, user, run, a.requestKey, hash(a)],
        )
      ).rows[0]?.result;
      if (result) await this.browsers?.closeCollection(user, c.id);
      return result ?? (await this.lostMutation(user, c.id, a.requestKey, a));
    }
  }
  private async coverage(
    user: string,
    c: Collection,
    t: GatherTarget,
    source: "provided" | "email" | "browser",
  ) {
    const attempts = (
      await this.db.query(
        "SELECT id,kind,state,metadata FROM gather_attempts WHERE collection_id=$1 AND user_id=$2 AND target_key=$3 AND scope_revision=$4 ORDER BY created_at,id",
        [c.id, user, t.key, c.task_revision],
      )
    ).rows;
    const candidates = (
      await this.db.query(
        "SELECT DISTINCT g.artifact_id,g.facts,a.kind,a.metadata FROM gather_candidates g JOIN gather_attempts a ON a.collection_id=g.collection_id AND a.target_key=g.target_key AND a.user_id=g.user_id AND a.metadata->>'artifactId'=g.artifact_id::text WHERE g.collection_id=$1 AND g.user_id=$2 AND g.target_key=$3 AND a.scope_revision=$4",
        [c.id, user, t.key, c.task_revision],
      )
    ).rows;
    const matched = (
      await this.db.query(
        "SELECT artifact_id FROM gather_items WHERE collection_id=$1 AND user_id=$2 AND target_key=$3 AND scope_revision=$4",
        [c.id, user, t.key, c.task_revision],
      )
    ).rows.map((r) => r.artifact_id);
    const relevant = (f: InvoiceFacts) =>
      f.invoiceHeading &&
      f.issuerLabels.includes(t.label) &&
      productEvidence(f, t.label) !== "conflict";
    for (const candidate of candidates.filter((x) => x.kind === source)) {
      const f = candidate.facts as InvoiceFacts;
      if (
        !f.selectableText ||
        f.truncated ||
        !f.invoiceHeading ||
        !f.issuerLabels.length
      )
        throw new ToolValidationError(
          "A file has unknown relevance or unreadable invoice clues; coverage remains unverified",
        );
      if (!relevant(f)) continue;
      const dates =
        t.dateBasis === "service_period"
          ? [
              ...f.serviceDates.map((d) => d.slice(0, 7)),
              ...(f.serviceMonths ?? []),
            ]
          : f.invoiceDates.map((d) => d.slice(0, 7));
      if (
        (!f.selectableText ||
          f.truncated ||
          !dates.length ||
          dates.includes(t.month)) &&
        !matched.includes(candidate.artifact_id)
      )
        throw new ToolValidationError(
          "A potentially relevant file is still unverified; match it or ask the owner before checking coverage",
        );
    }
    if (source === "provided") {
      if (
        c.scope.providedFiles.some(
          (id) =>
            !candidates.some(
              (x) => x.artifact_id === id && x.kind === "provided",
            ),
        )
      )
        throw new ToolValidationError(
          "Inspect every explicitly provided PDF before checking this target",
        );
      if (
        !c.scope.providedFiles.length &&
        !candidates.some((x) => x.kind === "provided")
      )
        throw new ToolValidationError(
          "No provided file was inspected for this target",
        );
      return "All explicitly provided PDFs were inspected for this target; coverage is limited to those files.";
    }
    if (source === "browser") {
      const confirmed = attempts
        .filter(
          (x) =>
            x.kind === "browser" &&
            Number.isInteger(x.metadata.ownerConfirmedCount) &&
            x.metadata.month === t.month,
        )
        .at(-1);
      const browserFiles = candidates.filter(
        (x) => x.kind === "browser" && matched.includes(x.artifact_id),
      );
      const uniqueFiles = [
        ...new Map(browserFiles.map((x) => [x.artifact_id, x])).values(),
      ];
      if (
        uniqueFiles.length > 1 &&
        uniqueFiles.some(
          (x) => (x.facts as InvoiceFacts).invoiceNumbers.length !== 1,
        )
      )
        throw new ToolValidationError(
          "Multiple browser PDFs need distinct recorded invoice identifiers before invoice-history coverage can be verified",
        );
      const invoiceIds = new Set(
        uniqueFiles.map(
          (x) =>
            (x.facts as InvoiceFacts).invoiceNumbers[0]?.toUpperCase() ??
            x.artifact_id,
        ),
      );
      if (
        !confirmed ||
        invoiceIds.size !== confirmed.metadata.ownerConfirmedCount
      )
        throw new ToolValidationError(
          "Browser coverage needs the owner's expected invoice count for this account/month, and that many distinct recorded invoice identifiers (or one sole matched PDF). PDF variants do not increase the count. Use the handoff view to confirm the count.",
        );
      return "Distinct recorded invoice count equals the owner's explicit invoice-history count for this account/month. PDF variants sharing an invoice identifier count once; this is owner-confirmed coverage, not an independent account census.";
    }
    for (const account of c.scope.mailboxes) {
      const roots = attempts.filter(
        (x) =>
          x.kind === "search" &&
          x.state === "success" &&
          x.metadata.account === account &&
          x.metadata.broadQuery &&
          !x.metadata.pageToken,
      );
      let page = roots.at(-1);
      if (!page)
        throw new ToolValidationError(
          "Run the full scoped PDF search in every selected mailbox before checking email coverage",
        );
      const visited = new Set<string>();
      for (let pages = 0; pages < 200; pages++) {
        for (const messageId of page.metadata.messageIds as string[]) {
          const inspection = attempts
            .filter(
              (x) =>
                x.kind === "email" &&
                x.metadata.inspection &&
                x.metadata.searchId === page!.id &&
                x.metadata.messageId === messageId,
            )
            .at(-1);
          if (!inspection)
            throw new ToolValidationError(
              "Inspect the PDF attachments of every result in the scoped search",
            );
          for (const partKey of inspection.metadata.partKeys as string[])
            if (
              !candidates.some(
                (x) =>
                  x.kind === "email" &&
                  x.metadata.searchId === page!.id &&
                  x.metadata.messageId === messageId &&
                  x.metadata.partKey === partKey,
              )
            )
              throw new ToolValidationError(
                "Capture and assess every PDF attachment in the scoped search before checking coverage",
              );
        }
        const next = page.metadata.nextPageToken;
        if (!next) break;
        if (visited.has(next))
          throw new ToolValidationError(
            "Search pagination did not advance; leave coverage incomplete",
          );
        visited.add(next);
        const following = attempts
          .filter(
            (x) =>
              x.kind === "search" &&
              x.state === "success" &&
              x.metadata.account === account &&
              x.metadata.queryHash === page!.metadata.queryHash &&
              x.metadata.pageToken === next,
          )
          .at(-1);
        if (!following)
          throw new ToolValidationError(
            "Read the remaining scoped email pages before checking coverage",
          );
        page = following;
        if (pages === 199)
          throw new ToolValidationError(
            "Search coverage exceeds the bounded inspection window",
          );
      }
    }
    return "Scoped PDF-attachment searches were exhausted in every selected mailbox, and all returned PDF parts were captured and assessed. Inline receipts and other accounts are outside this source boundary.";
  }
  private async emailAttempt(
    user: string,
    c: Collection,
    t: GatherTarget,
    id: string,
    message: string,
  ) {
    if (!this.gmail) throw new ToolValidationError("Email is unavailable");
    const row = (
      await this.db.query(
        "SELECT metadata FROM gather_attempts WHERE id=$1 AND user_id=$2 AND collection_id=$3 AND target_key=$4 AND kind='search' AND state='success' AND scope_revision=$5",
        [id, user, c.id, t.key, c.task_revision],
      )
    ).rows[0];
    if (
      !row?.metadata?.messageIds?.includes(message) ||
      !c.scope.mailboxes.includes(row.metadata.account)
    )
      throw new ToolValidationError(
        "Message is not a result of an authorized search for this target",
      );
    return row.metadata;
  }
  private async lostMutation(
    user: string,
    id: string,
    key: string,
    a: unknown,
  ) {
    const prior = await this.prior(user, id, key, a);
    if (prior) return prior;
    throw new ToolValidationError(
      "Collection scope changed or the result could not be committed; inspect status before retrying",
    );
  }
  private async saveCandidate(
    user: string,
    run: string,
    c: Collection,
    t: GatherTarget,
    a: Extract<GatherAction, { operation: "gather_capture" }>,
    f: PreparedFile,
    metadata: Record<string, unknown>,
  ) {
    const artifact = randomUUID(),
      attempt = randomUUID();
    const result = (
      await this.mutation(
        `WITH authorized AS (${this.lockSql}),
      mutation AS (INSERT INTO gather_mutations(collection_id,user_id,request_key,request_hash,result) SELECT $1,$2,$4,$5,'{}'::jsonb FROM authorized ON CONFLICT DO NOTHING RETURNING collection_id),
      file AS (INSERT INTO file_artifacts(id,user_id,sha256,name,mime_type,bytes,encrypted,facts) SELECT $6::uuid,$2,$7,$8,'application/pdf',$9::integer,$10::bytea,$11::jsonb FROM mutation ON CONFLICT(user_id,sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING id,name,bytes,sha256),
      attempt AS (INSERT INTO gather_attempts(id,user_id,collection_id,target_key,kind,state,metadata,scope_revision) SELECT $12::uuid,$2,$1,$13,$14,'success',jsonb_build_object('artifactId',file.id::text)||$15::jsonb,$16::integer FROM file RETURNING id),
      asset AS (INSERT INTO gather_assets(collection_id,user_id,artifact_id) SELECT $1,$2,id FROM file ON CONFLICT DO NOTHING),
      candidate AS (INSERT INTO gather_candidates(collection_id,target_key,user_id,artifact_id,attempt_id,facts) SELECT $1,$13,$2,file.id,attempt.id,$11::jsonb FROM file,attempt ON CONFLICT(collection_id,target_key,artifact_id) DO UPDATE SET facts=EXCLUDED.facts,attempt_id=EXCLUDED.attempt_id RETURNING artifact_id)
      SELECT jsonb_build_object('captured',true,'artifactId',(SELECT id FROM file)::text,'attemptId',$12::text,'name',(SELECT name FROM file),'bytes',(SELECT bytes FROM file),'sha256',(SELECT sha256 FROM file),'facts',$11::jsonb,'notice','Candidate file stored privately. It does not count as target coverage until gather_match accepts its recorded clues.') AS result FROM mutation WHERE EXISTS(SELECT 1 FROM candidate)`,
        [
          c.id,
          user,
          run,
          a.requestKey,
          hash(a),
          artifact,
          f.sha256,
          f.name,
          f.bytes,
          f.encrypted,
          JSON.stringify(f.facts),
          attempt,
          t.key,
          a.source.kind,
          JSON.stringify(metadata),
          c.task_revision,
        ],
      )
    ).rows[0]?.result;
    return result ?? (await this.lostMutation(user, c.id, a.requestKey, a));
  }
}
