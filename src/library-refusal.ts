import type { Database } from "./db.js";
import { isPrivateApiRefusal } from "./library-client.js";
import { linkRestricted } from "./library-cards.js";

/** Read-only evidence check. Never infer a final refusal from another attempt's response. */
export async function libraryLinkRefusal(
  db: Database,
  user: string,
  approvalId?: string,
) {
  const previous = (
    await db.query(
      `SELECT a.id,a.payload,t.id AS attempt_id,t.last_result,t.finished_at FROM approvals a
     LEFT JOIN library_link_attempts t ON t.approval_id=a.id AND t.user_id=a.user_id
     WHERE a.user_id=$1 AND a.operation='library_link' AND a.status='approved'
     AND ($2::uuid IS NULL OR a.id=$2) AND a.payload->>'execution' IN ('failed','uncertain')
     ORDER BY a.created_at DESC,t.started_at DESC LIMIT 1`,
      [user, approvalId ?? null],
    )
  ).rows[0];
  if (!previous) return null;
  if (previous.payload.failure?.code === "client_restricted")
    return { approvalId: previous.id as string, historical: false };
  if (
    previous.payload.execution !== "uncertain" ||
    !previous.finished_at ||
    previous.last_result !== "error:unauthenticated:missing_chip"
  )
    return null;
  const diagnostic = (
    await db.query(
      "SELECT data FROM events WHERE user_id=$1 AND run_id=$2 AND type='library.clone_refused' AND data->>'attemptId'=$3 ORDER BY created_at DESC LIMIT 1",
      [user, previous.id, previous.attempt_id],
    )
  ).rows[0]?.data;
  if (
    diagnostic?.recovered ||
    !Array.isArray(diagnostic?.attempts) ||
    !diagnostic.attempts.length ||
    diagnostic.attempts.length > 4
  )
    return null;
  const refused = diagnostic.attempts.every((a: unknown) => {
    if (!a || typeof a !== "object") return false;
    const response = a as Record<string, unknown>;
    if (
      response.status !== 403 ||
      response.route !== "/chip/clone" ||
      typeof response.body !== "string"
    )
      return false;
    try {
      return isPrivateApiRefusal(JSON.parse(response.body));
    } catch {
      return false;
    }
  });
  return refused
    ? { approvalId: previous.id as string, historical: true }
    : null;
}

/** The same provider-free connection context for the coordinator and shelf tool. */
export async function libraryAccountContext(db: Database, user: string) {
  const row = (
    await db.query(
      'SELECT i.state,i.token_expires_at AS "tokenRenewsBy",s.synced_at AS "lastSyncAt" FROM library_identities i LEFT JOIN library_shelf s ON s.user_id=i.user_id WHERE i.user_id=$1',
      [user],
    )
  ).rows[0];
  if (row?.state !== "linked" && (await libraryLinkRefusal(db, user)))
    return {
      ...(row ?? { state: "none" }),
      linkingRestricted: true,
      note: linkRestricted,
    };
  return (
    row ?? {
      state: "none",
      note: "Not linked; the user can send /library link.",
    }
  );
}
