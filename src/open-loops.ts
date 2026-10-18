import type { Database } from "./db.js";

/**
 * Items that wait on the owner, for the turn context: coding jobs that need the owner
 * (a requirements card, a question, a pause, a PR stopped for attention) and monitoring or
 * calendar cards that expired unanswered in the last three days. Without these, Chief
 * answered "status?" without the plans it had finished and started duplicate jobs.
 * Bounded and read-only; the model still reads coding_status for detail before acting.
 */
export async function openLoops(
  db: Database,
  user: string,
  options: { coding: boolean },
) {
  const coding = options.coding
    ? (
        await db.query(
          `SELECT j.id,left(j.objective,120) objective,j.state,j.stage,left(j.summary,160) summary,
             left(j.question,200) question,j.updated_at,
             (SELECT CASE WHEN (e.payload->>'confirmUntil')::timestamptz > now() THEN 'open' ELSE 'expired' END
                FROM coding_events e WHERE e.job_id=j.id AND e.event_key LIKE 'requirements:%'
                  AND e.delivery='sent' AND NOT (e.payload ? 'decision') AND e.payload ? 'confirmUntil'
                ORDER BY e.created_at DESC LIMIT 1) AS card
           FROM coding_jobs j
           WHERE j.user_id=$1 AND j.updated_at > now() - interval '14 days'
             AND (j.state IN ('plan_ready','awaiting_input','paused')
               OR (j.state='pr_ready' AND j.stage IN ('manual_review','merge_declined'))
               OR (j.state='failed' AND j.updated_at > now() - interval '3 days'))
           ORDER BY j.updated_at DESC LIMIT 5`,
          [user],
        )
      ).rows.map((j) => ({
        id: j.id,
        objective: j.objective,
        state: j.state,
        stage: j.stage,
        updatedAt: j.updated_at,
        awaiting:
          j.state === "plan_ready"
            ? j.card === "open"
              ? "owner to confirm the requirements card"
              : "requirements ready; the card expired or was never sent, so offer a fresh one (coding_resume)"
            : j.state === "awaiting_input"
              ? `owner to answer: ${j.question || j.summary}`
              : j.state === "paused"
                ? `paused (${j.summary}); offer to resume or start fresh`
                : j.state === "failed"
                  ? `failed (${j.summary}); offer to retry or start fresh`
                  : `PR stopped for owner attention (${j.summary})`,
      }))
    : [];
  const expiredCards = (
    await db.query(
      `SELECT id,operation,created_at,expires_at FROM approvals
       WHERE user_id=$1 AND status='pending' AND operation IN ('responsibility_confirm','calendar_create')
         AND expires_at <= now() AND expires_at > now() - interval '3 days'
       ORDER BY expires_at DESC LIMIT 3`,
      [user],
    )
  ).rows.map((a) => ({
    id: a.id,
    operation: a.operation,
    createdAt: a.created_at,
    expiredAt: a.expires_at,
  }));
  if (!coding.length && !expiredCards.length) return undefined;
  return {
    note: "Items waiting on the owner. Cover them when the owner asks for status. Before coding_start, check that no listed job already covers the request; revise or resume it instead of starting a duplicate. Mention an expired card at most once, briefly, and offer a fresh one; never re-send it unasked.",
    ...(coding.length ? { coding } : {}),
    ...(expiredCards.length ? { expiredCards } : {}),
  };
}
