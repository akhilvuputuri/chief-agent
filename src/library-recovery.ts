import type { Database } from "./db.js";
/**
 * Conservative startup recovery for the library tables. Runs only when migration 016 is
 * installed. Nothing is replayed: a crash before a request was sent is a provable failure,
 * a crash after it is uncertain until a read-only sync reconciles it.
 */
export async function libraryMigrated(db: Database) {
  return !!(await db.query("SELECT 1 FROM runtime_migrations WHERE version=16"))
    .rows.length;
}
export async function recoverLibrary(db: Database) {
  if (!(await libraryMigrated(db))) return { recovered: false as const };
  // A displaying attempt never received the card: abort it and forget the anonymous chip.
  const aborted = (
    await db.query(
      `WITH stopped AS (
        UPDATE library_link_attempts SET state='aborted',finished_at=now() WHERE state='displaying' RETURNING user_id,approval_id
      ), forgotten AS (
        DELETE FROM library_identities i USING stopped s WHERE i.user_id=s.user_id AND i.state IN ('anonymous','linking') RETURNING i.user_id
      ), marked AS (
        UPDATE approvals a SET payload=a.payload || '{"execution":"failed","failure":{"code":"interrupted"}}'::jsonb FROM stopped s WHERE a.id=s.approval_id AND a.payload->>'execution'<>'created' RETURNING a.id
      ) SELECT count(*)::int AS n FROM stopped`,
    )
  ).rows[0]?.n;
  // fulfilled/completing attempts may hold a card-bearing token: leave them uncertain for Check shelf.
  await db.query(
    `UPDATE approvals a SET payload=jsonb_set(a.payload,'{execution}','"uncertain"'::jsonb) FROM library_link_attempts t
     WHERE a.id=t.approval_id AND t.state IN ('fulfilled','completing') AND a.payload->>'execution' NOT IN ('created','failed')`,
  );
  const uncertain = (
    await db.query(
      `UPDATE approvals SET payload=jsonb_set(payload,'{execution}','"uncertain"'::jsonb)
       WHERE operation LIKE 'library\\_%' AND status='approved' AND payload->>'execution'='executing' AND payload ? 'sentAt' RETURNING id`,
    )
  ).rows.length;
  const failed = (
    await db.query(
      `UPDATE approvals SET payload=payload || '{"execution":"failed","failure":{"code":"interrupted_before_send"}}'::jsonb
       WHERE operation LIKE 'library\\_%' AND status='approved' AND payload->>'execution'='executing' AND NOT (payload ? 'sentAt') RETURNING id`,
    )
  ).rows.length;
  await db.query(
    "UPDATE library_watch SET status='scheduled',lease=NULL WHERE status='processing'",
  );
  return {
    recovered: true as const,
    failed,
    uncertain,
    aborted: Number(aborted ?? 0),
  };
}
