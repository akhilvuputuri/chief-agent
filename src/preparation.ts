import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { Action } from "./protocol.js";
export class PreparationTools {
  constructor(private db: Database) {}
  async call(
    user: string,
    a: Extract<
      Action,
      { operation: "prep_save" | "prep_list" | "prep_task_save" }
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
        "SELECT * FROM preparation_tasks WHERE user_id=$1 ORDER BY topic LIMIT 500",
        [user],
      );
      return { requirements: requirements.rows, tasks: tasks.rows, limit: 500 };
    }
    if (a.operation === "prep_task_save")
      return (
        await this.db.query(
          `INSERT INTO preparation_tasks(id,user_id,topic,exercise,completion_criteria,priority,status)
      VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,'todo')) ON CONFLICT(user_id,topic) DO UPDATE SET exercise=$4,completion_criteria=$5,priority=$6,status=COALESCE($7,preparation_tasks.status),updated_at=now() RETURNING *`,
          [
            randomUUID(),
            user,
            a.topic.toLowerCase(),
            a.exercise,
            a.completionCriteria,
            a.priority,
            a.status ?? null,
          ],
        )
      ).rows[0];
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
