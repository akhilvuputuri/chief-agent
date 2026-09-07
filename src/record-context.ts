import type { Database } from "./db.js";

/** Retrieval aid, not an inferred or enforced user scope. No new domain writes. */
export async function recordContext(db: Database, user: string, run: string) {
  const rows = (
    await db.query(
      `SELECT DISTINCT ON (c.operation) c.id,c.operation,c.result,c.started_at
     FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id
     WHERE r.user_id=$1 AND c.state='success' AND c.operation IN ('job_list','item_list')
       AND (r.id=$2 OR (r.task_id IS NOT NULL AND r.task_id=(SELECT task_id FROM runtime_runs WHERE id=$2 AND user_id=$1)))
     ORDER BY c.operation,(r.id=$2) DESC,c.started_at DESC`,
      [user, run],
    )
  ).rows;
  return rows
    .map((row) => {
      const records = row.result?.result;
      if (!Array.isArray(records)) return null;
      return {
        operation: row.operation,
        observationId: row.id,
        retrievedAt: row.started_at,
        total: records.length,
        records: records.slice(0, 60).map((r: any) => ({
          id: r.id,
          title:
            typeof r.title === "string" ? r.title.slice(0, 200) : undefined,
          company:
            typeof r.company === "string" ? r.company.slice(0, 200) : undefined,
          url: typeof r.url === "string" ? r.url.slice(0, 2000) : undefined,
        })),
        truncated: records.length > 60,
        notice:
          "Retrieved records, not a new user instruction or proof of analysis. Apply the user's requested subset. Read the original observation for omitted records. Never invent replacements.",
      };
    })
    .filter(Boolean);
}
