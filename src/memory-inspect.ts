import type { Database } from "./db.js";
import { scrub } from "./memory-trace.js";
/** Shared local/cloud inspection API. Owner is configuration-derived, never selected by the model. */
export async function inspectMemory(
  db: Database,
  user: string,
  target: string,
  full = false,
) {
  if (!user) throw new Error("Owner not configured");
  if (target !== "recent" && !/^[0-9a-f-]{36}$/.test(target))
    throw new Error("Invalid run ID");
  const runs = (
    await db.query(
      "SELECT id,state,stop_reason,model,started_at FROM runtime_runs WHERE user_id=$1 AND ($2='recent' OR id::text=$2) ORDER BY started_at DESC LIMIT 10",
      [user, target],
    )
  ).rows;
  const ids = runs.map((r) => r.id);
  const events = (
    await db.query(
      "SELECT * FROM memory_events WHERE user_id=$1 AND run_id=ANY($2::uuid[]) ORDER BY id LIMIT 201",
      [user, ids],
    )
  ).rows;
  const invocations = (
    await db.query(
      "SELECT id,run_id,attempt,model,state,latency_ms,provider,usage,created_at" +
        (full ? ",request,response" : "") +
        " FROM model_invocations WHERE user_id=$1 AND run_id=ANY($2::uuid[]) ORDER BY created_at LIMIT 51",
      [user, ids],
    )
  ).rows;
  const revisions = (
    await db.query(
      "SELECT r.id,r.key,r.revision,r.source_kind,r.source_id,r.created_at,h.revision_id=r.id AS active" +
        (full ? ",r.value,r.source_quote,r.reason" : "") +
        " FROM memory_revisions r LEFT JOIN memory_heads h ON h.user_id=r.user_id AND h.key=r.key WHERE r.user_id=$1 AND (r.run_id=ANY($2::uuid[]) OR r.id IN (SELECT m.revision_id FROM invocation_memories m JOIN model_invocations i ON i.id=m.invocation_id WHERE i.user_id=$1 AND i.run_id=ANY($2::uuid[]))) ORDER BY r.created_at LIMIT 201",
      [user, ids],
    )
  ).rows;
  const included = (
    await db.query(
      "SELECT m.* FROM invocation_memories m JOIN model_invocations i ON i.id=m.invocation_id WHERE i.user_id=$1 AND i.run_id=ANY($2::uuid[])",
      [user, ids],
    )
  ).rows;
  const sources = full
    ? (
        await db.query(
          "SELECT id,role,content,origin,created_at FROM memory_sources WHERE user_id=$1 AND (run_id=ANY($2::uuid[]) OR id=ANY($3::uuid[])) ORDER BY created_at LIMIT 201",
          [
            user,
            ids,
            revisions.flatMap((r) => (r.source_id ? [r.source_id] : [])),
          ],
        )
      ).rows
    : [];
  const blobs: Record<string, unknown> = {};
  let bytes = 0;
  let truncated = false;
  if (full)
    for (const invocation of invocations.slice(0, 50)) {
      for (const hash of [
        ...(invocation.request.messageHashes ?? []),
        invocation.request.toolsHash,
      ].filter(Boolean)) {
        if (hash in blobs) continue;
        const row = (
          await db.query(
            "SELECT content FROM trace_blobs WHERE user_id=$1 AND hash=$2",
            [user, hash],
          )
        ).rows[0];
        if (!row) continue;
        const n = JSON.stringify(row.content).length;
        if (bytes + n > 4000000) {
          truncated = true;
          continue;
        }
        blobs[hash] = row.content;
        bytes += n;
      }
    }
  return scrub({
    version: 1,
    contentIncluded: full,
    runs,
    events: events
      .slice(0, 200)
      .map((e) =>
        full
          ? e
          : {
              id: e.id,
              run_id: e.run_id,
              type: e.type,
              created_at: e.created_at,
              data: {
                ...e.data,
                value: undefined,
                sourceQuote: undefined,
                reason: undefined,
                query: undefined,
              },
            },
      ),
    invocations: invocations.slice(0, 50),
    revisions: revisions.slice(0, 200),
    included,
    sources: sources.slice(0, 200),
    blobs,
    truncated:
      truncated ||
      events.length > 200 ||
      invocations.length > 50 ||
      revisions.length > 200 ||
      sources.length > 200,
    notice:
      "Included means present in model input, not proven influence. Legacy source times are import times. No private model reasoning is inferred. Full exports contain private conversation data; credential scrubbing is best-effort.",
  });
}
