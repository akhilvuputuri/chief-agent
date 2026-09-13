import { randomUUID, createHash } from "node:crypto";
import type { Database } from "./db.js";
import type { Action } from "./protocol.js";
import { resolvePreparationChain } from "./preparation-chain.js";
import { ToolValidationError } from "./tool-errors.js";
export class PreparationTools {
  constructor(private db: Database) {}
  async call(
    user: string,
    a: Extract<
      Action,
      {
        operation:
          "prep_save" | "prep_list" | "prep_task_save" | "prep_task_read";
      }
    >,
  ) {
    if (a.operation === "prep_list") {
      const requirements = await this.db.query(
        `SELECT p.*,j.title,j.company,j.url,s.url AS source_url,s.retrieved_at
        FROM preparation_requirements p JOIN jobs j ON j.id=p.job_id
        LEFT JOIN research_sources s ON s.id=p.source_id
        WHERE j.user_id=$1 AND ($2::uuid IS NULL OR j.id=$2) ORDER BY j.company,p.topic LIMIT 500`,
        [user, a.id ?? null],
      );
      const tasks = await this.db.query(
        `SELECT id,topic,exercise,completion_criteria,status,priority,updated_at,
         jsonb_array_length(evidence_chain) AS link_count,
         (SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',c->>'scopeId','jobId',c->>'jobId',
          'preparationId',c->>'preparationId','title',c->'job'->>'title','company',c->'job'->>'company')),'[]'::jsonb)
          FROM jsonb_array_elements(evidence_chain) c) AS links
         FROM preparation_tasks WHERE user_id=$1 AND ($2::uuid IS NULL OR EXISTS
          (SELECT 1 FROM jsonb_array_elements(evidence_chain) c WHERE c->>'jobId'=$2::text)) ORDER BY topic LIMIT 500`,
        [user, a.id ?? null],
      );
      return {
        requirements: requirements.rows,
        tasks: tasks.rows,
        limit: 500,
        notice:
          "Use prep_task_read for complete evidence chains. Zero links means legacy provenance is unavailable. Task status is reported progress, not verified mastery.",
      };
    }
    if (a.operation === "prep_task_read") {
      const task = (
        await this.db.query(
          "SELECT * FROM preparation_tasks WHERE id=$1 AND user_id=$2",
          [a.id, user],
        )
      ).rows[0];
      if (!task) throw new Error("Preparation task not found");
      const content = JSON.stringify(task);
      const version = createHash("sha256").update(content).digest("hex");
      if ((a.offset > 0 && !a.version) || (a.version && a.version !== version))
        throw new ToolValidationError(
          "Preparation task changed or page version missing; restart at offset 0 and use the returned version for later pages",
        );
      let end = Math.min(content.length, a.offset + 6000);
      while (
        end > a.offset &&
        JSON.stringify(content.slice(a.offset, end)).length > 6500
      )
        end--;
      return {
        id: task.id,
        version,
        content: content.slice(a.offset, end),
        offset: a.offset,
        nextOffset: end < content.length ? end : null,
        totalCharacters: content.length,
        notice:
          "Frozen source and background quotations preserve recorded support, not semantic correctness. Status is reported progress, not verified mastery. Empty evidence_chain means legacy provenance is unavailable.",
      };
    }
    if (a.operation === "prep_task_save") {
      const chain = a.links
        ? await resolvePreparationChain(this.db, user, a.links)
        : [];
      // A single statement atomically merges links and progress under the topic's unique key.
      // Without supplied links only an already-linked existing task may be updated.
      const saved = (
        await this.db.query(
          `INSERT INTO preparation_tasks(id,user_id,topic,exercise,completion_criteria,priority,status,evidence_chain)
      SELECT $1,$2,$3,$4,$5,$6,COALESCE($7,'todo'),$8::jsonb
      WHERE jsonb_array_length($8::jsonb)>0 OR EXISTS
       (SELECT 1 FROM preparation_tasks WHERE user_id=$2 AND topic=$3 AND jsonb_array_length(evidence_chain)>0)
      ON CONFLICT(user_id,topic) DO UPDATE SET exercise=$4,completion_criteria=$5,priority=$6,
       status=COALESCE($7,preparation_tasks.status),updated_at=now(),
       evidence_chain=(SELECT jsonb_agg(link ORDER BY link->>'scopeId',link->>'jobId',link->>'preparationId')
        FROM (SELECT DISTINCT ON (value->>'scopeId',value->>'jobId',value->>'preparationId') value AS link
          FROM jsonb_array_elements(preparation_tasks.evidence_chain || EXCLUDED.evidence_chain) WITH ORDINALITY AS v(value,n)
          ORDER BY value->>'scopeId',value->>'jobId',value->>'preparationId',n DESC) merged)
       RETURNING id,topic,exercise,completion_criteria,priority,status,updated_at,jsonb_array_length(evidence_chain) AS link_count`,
          [
            randomUUID(),
            user,
            a.topic.toLowerCase(),
            a.exercise,
            a.completionCriteria,
            a.priority,
            a.status ?? null,
            JSON.stringify(chain),
          ],
        )
      ).rows[0];
      if (!saved)
        throw new ToolValidationError(
          "Preparation tasks require links to saved alignment actions. Read an alignment report and supply scopeId, jobId and preparationId; do not invent provenance for legacy tasks.",
        );
      return {
        ...saved,
        notice:
          "Evidence chain saved; read it with prep_task_read. Status records reported progress and does not certify readiness.",
      };
    }
    const job = (
      await this.db.query(
        "SELECT description FROM jobs WHERE id=$1 AND user_id=$2",
        [a.id, user],
      )
    ).rows[0];
    if (!job) throw new Error("Role not found");
    let source = job.description;
    if (a.sourceId) {
      const row = (
        await this.db.query(
          "SELECT content FROM research_sources WHERE id=$1 AND user_id=$2",
          [a.sourceId, user],
        )
      ).rows[0];
      if (!row) throw new Error("Source not found");
      source = row.content;
    }
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    if (!normalize(source).includes(normalize(a.sourceQuote)))
      throw new Error(
        "Quote must appear in the saved listing or retrieved source",
      );
    if (a.assessment !== "unknown" && !a.evidence.trim())
      throw new Error(
        "A strength or confirmed gap requires background evidence",
      );
    if (a.assessment === "unknown" && !a.question.trim())
      throw new Error("Unknown experience requires a clarification question");
    return (
      await this.db.query(
        `INSERT INTO preparation_requirements(id,job_id,topic,importance,source_id,source_quote,assessment,evidence,question)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(job_id,topic) DO UPDATE SET importance=$4,source_id=$5,source_quote=$6,assessment=$7,evidence=$8,question=$9,updated_at=now() RETURNING *`,
        [
          randomUUID(),
          a.id,
          a.topic.toLowerCase(),
          a.importance,
          a.sourceId ?? null,
          a.sourceQuote,
          a.assessment,
          a.evidence,
          a.question,
        ],
      )
    ).rows[0];
  }
}
