import { SkillTools } from "./skills.js";
import { PreparationTools } from "./preparation.js";
import type { SheetsTools } from "./sheets.js";
import type { GmailTools } from "./gmail.js";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { event } from "./db.js";
import { action } from "./protocol.js";
import type { WebTools } from "./providers.js";
export class JobTools {
  constructor(
    private db: Database,
    private web: Pick<WebTools, "call">,
    private gmail?: Pick<GmailTools, "call">,
    private sheets?: Pick<SheetsTools, "sync">,
  ) {}
  async execute(user: string, run: string, input: unknown) {
    const a = action.parse(input);
    await event(this.db, user, run, "tool.started", { operation: a.operation });
    try {
      const result = await this.dispatch(user, run, a);
      await event(this.db, user, run, "tool.completed", {
        operation: a.operation,
      });
      return result;
    } catch (error) {
      await event(this.db, user, run, "tool.failed", {
        operation: a.operation,
      });
      throw error;
    }
  }
  private async dispatch(
    user: string,
    run: string,
    a: ReturnType<typeof action.parse>,
  ): Promise<unknown> {
    const db = this.db;
    if (
      a.operation === "skill_list" ||
      a.operation === "skill_read" ||
      a.operation === "skill_history" ||
      a.operation === "skill_draft" ||
      a.operation === "skill_evaluate" ||
      a.operation === "skill_activate"
    )
      return new SkillTools(db).call(user, run, a);
    if (
      a.operation === "prep_list" ||
      a.operation === "prep_save" ||
      a.operation === "prep_task_save"
    )
      return new PreparationTools(db).call(user, a);
    if (a.operation === "sheet_sync") {
      if (!this.sheets) throw new Error("Google Sheets is not configured");
      return this.sheets.sync(user);
    }
    if (a.operation === "gmail_search" || a.operation === "gmail_read") {
      if (!this.gmail) throw new Error("Gmail is not configured");
      return this.gmail.call(
        user,
        a.operation,
        a.operation === "gmail_search" ? a.query : a.messageId,
        a.operation === "gmail_search" ? a.pageToken : undefined,
      );
    }
    if (a.operation === "job_save")
      return (
        await db.query(
          "INSERT INTO jobs(id,user_id,title,company,url,description) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            randomUUID(),
            user,
            a.title,
            a.company,
            a.url ?? null,
            a.description ?? "",
          ],
        )
      ).rows[0];
    if (a.operation === "job_list")
      return (
        await db.query(
          "SELECT * FROM jobs WHERE user_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT 50",
          [user, a.status ?? null],
        )
      ).rows;
    if (a.operation === "memory_list")
      return (
        await db.query(
          "SELECT key,value FROM memories WHERE user_id=$1 ORDER BY key",
          [user],
        )
      ).rows;
    if (a.operation === "memory_set") {
      await db.query(
        "INSERT INTO memories(user_id,key,value) VALUES($1,$2,$3) ON CONFLICT(user_id,key) DO UPDATE SET value=$3,updated_at=now()",
        [user, a.key, a.value],
      );
      return { saved: true };
    }
    if (a.operation === "web_search" || a.operation === "web_read") {
      const result = await this.web.call(
        a.operation,
        a.operation === "web_search" ? a.query : a.url,
      );
      if (a.operation === "web_search") return result;
      const sourceId = randomUUID();
      await db.query(
        "INSERT INTO research_sources(id,user_id,url,content) VALUES($1,$2,$3,$4)",
        [sourceId, user, a.url, result.content],
      );
      return { ...result, sourceId, sourceUrl: a.url };
    }
    const job = (
      await db.query("SELECT * FROM jobs WHERE id=$1 AND user_id=$2", [
        a.id,
        user,
      ])
    ).rows[0];
    if (!job) throw new Error("Role not found");
    if (a.operation === "job_update")
      return (
        await db.query(
          "UPDATE jobs SET status=COALESCE($3,status),notes=COALESCE($4,notes),updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *",
          [a.id, user, a.status ?? null, a.notes ?? null],
        )
      ).rows[0];
    if (a.operation === "job_delete") {
      const id = randomUUID();
      await db.query(
        "INSERT INTO approvals(id,user_id,operation,payload,run_id) VALUES($1,$2,'job_delete',$3::jsonb,$4)",
        [
          id,
          user,
          JSON.stringify({ id: a.id, title: job.title, company: job.company }),
          run,
        ],
      );
      return {
        approvalRequired: true,
        id,
        preview: `Delete saved role: ${job.title} at ${job.company}`,
        instruction: `User must type /approve ${id} or /deny ${id} within 15 minutes. Do not claim deletion.`,
      };
    }
    // Supply evidence to Hermes for semantic analysis, with no fabricated fit score.
    return {
      role: job,
      profile: (
        await db.query("SELECT key,value FROM memories WHERE user_id=$1", [
          user,
        ])
      ).rows,
      analysisInstruction:
        "Analyze fit using only this evidence. Separate strengths, gaps, unknowns, and next steps. Cite the role text and profile facts. If the profile is missing, ask the user for their background. Do not invent experience or give a numeric hiring probability.",
    };
  }
  async decide(user: string, id: string, approve: boolean) {
    // Lock the owner while checking expected head and consuming the approval.
    // Skill revisions and evaluations are append-only through the application.
    const result = await this.db.query(
      `WITH owner_lock AS MATERIALIZED (SELECT id FROM users WHERE id=$2 FOR UPDATE),
       decision AS (
        UPDATE approvals SET status=$3 FROM owner_lock
        WHERE approvals.id=$1 AND user_id=$2 AND status='pending' AND expires_at>now()
        AND (operation='job_delete' OR $3='denied' OR
          (COALESCE((SELECT version_id::text FROM skill_heads WHERE user_id=$2 AND key=payload->>'key'),'')=COALESCE(payload->>'previous','')))
        RETURNING approvals.*
       ), removed AS (
        DELETE FROM jobs USING decision WHERE jobs.id=(decision.payload->>'id')::uuid AND jobs.user_id=$2 AND decision.status='approved' AND decision.operation='job_delete' RETURNING jobs.id
       ), activated AS (
        INSERT INTO skill_heads(user_id,key,version_id)
        SELECT user_id,payload->>'key',(payload->>'versionId')::uuid FROM decision WHERE status='approved' AND operation='skill_activate'
        ON CONFLICT(user_id,key) DO UPDATE SET version_id=EXCLUDED.version_id,updated_at=now()
        WHERE skill_heads.version_id::text=(SELECT payload->>'previous' FROM decision)
        RETURNING version_id
       ) SELECT decision.id,decision.status,decision.operation,(SELECT count(*) FROM removed) AS deleted,(SELECT version_id FROM activated) AS version_id FROM decision`,
      [id, user, approve ? "approved" : "denied"],
    );
    if (!result.rows[0])
      throw new Error("Approval unavailable, expired, or already used");
    if (
      approve &&
      result.rows[0].operation === "skill_activate" &&
      !result.rows[0].version_id
    )
      throw new Error("Skill changed concurrently; request a fresh approval");
    return result.rows[0];
  }
}
