import { threadId } from "./delivery-routing.js";
import type { Database } from "./db.js";
import { exchangeIndex } from "./context-continuity.js";
import { runFamily } from "./run-family.js";

/** Small disposable projection of recent exchanges; no extra model call or summary. */
export async function conversationState(
  db: Database,
  user: string,
  inputId?: string,
) {
  const input = inputId
    ? (
        await db.query(
          "SELECT metadata FROM conversation_inputs WHERE id=$1 AND user_id=$2",
          [inputId, user],
        )
      ).rows[0]
    : undefined;
  const here = threadId(input?.metadata?.threadId) ?? 0;
  const latestHere = (
    await db.query(
      `SELECT x.run_id,x.pending_reply,
    (SELECT left(c.payload->>'content',1500) FROM conversation_messages m JOIN message_contents c USING(user_id,hash) WHERE m.user_id=x.user_id AND m.run_id=x.run_id AND c.payload->>'role'='user' ORDER BY m.ordinal DESC LIMIT 1) AS request,
    (SELECT left(c.payload->>'content',2000) FROM conversation_messages m JOIN message_contents c USING(user_id,hash) WHERE m.user_id=x.user_id AND m.run_id=x.run_id AND m.delivery_state IN ('sent','recorded') AND c.payload->>'role'='assistant' AND NOT(c.payload ? 'tool_calls') ORDER BY m.ordinal DESC LIMIT 1) AS reply
    FROM conversation_contexts x WHERE x.user_id=$1 AND
      COALESCE((SELECT (i.metadata->>'threadId')::bigint FROM conversation_inputs i WHERE i.user_id=x.user_id AND i.run_id=x.run_id ORDER BY i.ordinal LIMIT 1),0)=$2
      AND NOT EXISTS(SELECT 1 FROM conversation_messages m WHERE m.user_id=x.user_id AND m.run_id=x.run_id AND m.delivery_state='pending') ORDER BY x.id DESC LIMIT 1`,
      [user, here],
    )
  ).rows[0];
  const previous = (
    await db.query(
      "SELECT id,summary,pending_reply,run_id FROM conversation_contexts x WHERE user_id=$1 AND NOT EXISTS(SELECT 1 FROM conversation_messages m WHERE m.user_id=x.user_id AND m.run_id=x.run_id AND m.delivery_state='pending') ORDER BY id DESC LIMIT 1",
      [user],
    )
  ).rows[0];
  // Bounded heads of recent messages for the exchange index; never full observation payloads.
  const rows = (
    await db.query(
      `SELECT e.id,e.run_id AS "runId",e.created_at AS "createdAt",
         COALESCE((SELECT (i.metadata->>'threadId')::bigint FROM conversation_inputs i WHERE i.user_id=e.user_id AND i.run_id=e.run_id ORDER BY i.ordinal LIMIT 1),0) AS "threadId",
         (SELECT i.metadata->'anchor' FROM conversation_inputs i WHERE i.user_id=e.user_id AND i.metadata->>'conversationMessageId'=e.id::text LIMIT 1) AS anchor,
         c.payload->>'role' AS role,left(c.payload->>'content',400) AS content,
         jsonb_path_query_array(c.payload,'$.tool_calls[*].function.name') AS "callNames",
         jsonb_path_query_array(c.payload,'$.tool_calls[*].id') AS "callIds",
         c.payload->>'tool_call_id' AS "toolCallId"
       FROM conversation_messages e JOIN message_contents c USING(user_id,hash)
       WHERE e.user_id=$1 AND e.delivery_state IN ('recorded','sent') AND c.payload->>'role' IN ('user','assistant','tool')
       ORDER BY e.ordinal DESC LIMIT 400`,
      [user],
    )
  ).rows.reverse();
  const summary = exchangeIndex(rows);
  let replyTarget = null;
  if (inputId) {
    const messageId = input?.metadata?.replyToMessageId;
    if (Number.isSafeInteger(messageId)) {
      const target = (
        await db.query(
          `SELECT run_id FROM events WHERE user_id=$1 AND type IN ('telegram.message_sent','telegram.view_opened') AND data->>'messageId'=$2 ORDER BY created_at DESC LIMIT 1`,
          [user, String(messageId)],
        )
      ).rows[0];
      if (target) {
        const question = (
          await db.query(
            "SELECT pending_reply FROM conversation_contexts x WHERE user_id=$1 AND run_id=$2 AND NOT EXISTS(SELECT 1 FROM conversation_messages m WHERE m.user_id=x.user_id AND m.run_id=x.run_id AND m.delivery_state='pending')",
            [user, target.run_id],
          )
        ).rows[0]?.pending_reply;
        const text = (
          await db.query(
            `SELECT left(c.payload->>'content',3000) AS content FROM conversation_messages e JOIN message_contents c USING(user_id,hash) WHERE e.user_id=$1 AND e.run_id=$2 AND e.delivery_state IN ('recorded','sent') AND c.payload->>'role'='assistant' AND NOT(c.payload ? 'tool_calls') ORDER BY ordinal DESC LIMIT 1`,
            [user, target.run_id],
          )
        ).rows[0]?.content;
        replyTarget = {
          runId: target.run_id,
          messageId,
          text,
          pendingReply: question ?? null,
          notice:
            "The user explicitly replied to this delivered message. This identifies a reference, not authorization to resume a job or approve an action.",
        };
      }
    }
  }
  const interrupted = (
    await db.query(
      `SELECT t.id,left(t.objective,240) AS objective,t.pause_reason FROM conversation_inputs i JOIN runtime_runs r ON r.id=i.run_id AND r.user_id=i.user_id JOIN work_tasks t ON t.id=r.task_id AND t.user_id=r.user_id WHERE i.user_id=$1 AND i.state='interrupted' AND t.status='paused' AND t.pause_reason='interrupted' AND NOT EXISTS(SELECT 1 FROM conversation_inputs later WHERE later.user_id=i.user_id AND later.ordinal>i.ordinal AND later.id<>$2::uuid AND later.state IN ('completed','interrupted')) ORDER BY i.ordinal DESC LIMIT 1`,
      [user, inputId ?? null],
    )
  ).rows[0];
  return {
    feedAnchor: input?.metadata?.anchor ?? null,
    lastExchangeHere: latestHere
      ? {
          runId: latestHere.run_id,
          askedIn: here,
          request: latestHere.request,
          reply: latestHere.reply,
          pendingReply: latestHere.pending_reply,
        }
      : null,
    interruptedJob: interrupted ?? null,
    summary,
    previousId: previous?.id,
    pendingReply: previous?.pending_reply ?? null,
    replyTarget,
  };
}

/** Only source records actually read/produced in this run may anchor its pending question. */
export async function saveConversationState(
  db: Database,
  user: string,
  run: string,
  summary: string,
  request: string,
  reply: string,
  reason?: string,
  askedIn?: number,
) {
  let pending = null;
  if (reason === "awaiting_user" || reason === "awaiting_approval") {
    const observations = (
      await db.query(
        "SELECT id,operation,result FROM runtime_calls WHERE run_id=$1 AND state='success' ORDER BY started_at DESC LIMIT 20",
        [run],
      )
    ).rows;
    const candidateIds = new Set<string>();
    const scan = (value: unknown, depth = 0) => {
      if (!value || typeof value !== "object" || depth > 8) return;
      for (const [key, v] of Object.entries(value)) {
        if (
          ["sourceId", "extractionSourceId"].includes(key) &&
          typeof v === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            v,
          )
        )
          candidateIds.add(v);
        else if (typeof v === "object") scan(v, depth + 1);
      }
    };
    for (const observation of observations) scan(observation.result);
    const sourceIds = (
      await db.query(
        "SELECT id FROM research_sources WHERE user_id=$1 AND id=ANY($2::uuid[]) LIMIT 12",
        [user, [...candidateIds]],
      )
    ).rows.map((r) => r.id);
    const approvalIds = (
      await db.query(
        `SELECT id FROM approvals WHERE user_id=$1 AND run_id IN ${runFamily()} AND status='pending' LIMIT 12`,
        [user, run],
      )
    ).rows.map((r) => r.id);
    pending = {
      askedIn: threadId(askedIn) ?? 0,
      runId: run,
      request: request.slice(0, 2000),
      question: reply.slice(0, 3000),
      reason,
      sourceIds,
      approvalIds,
      notice:
        "The previous foreground reply is waiting for input. Use only if this message follows up on it. This is not authority to resume background jobs or approve a draft.",
    };
  }
  await db.query(
    "INSERT INTO conversation_contexts(user_id,run_id,summary,pending_reply) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(user_id,run_id) DO NOTHING",
    [user, run, summary, pending ? JSON.stringify(pending) : null],
  );
}
