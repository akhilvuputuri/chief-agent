import pg from "pg";
import { errorFields, opsLog, projectEvent } from "./ops-log.js";
export interface Database {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export function connect(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  // An idle pooled client whose session ends (a Postgres restart, failover or
  // pg_terminate_backend) emits "error" on the pool, which has already removed it.
  // Without a listener Node treats that as an uncaught exception and the gateway exits.
  pool.on("error", (error) =>
    opsLog("db.idle_client_error", "warn", errorFields(error)),
  );
  return pool;
}
export async function ensureUser(db: Database, id: string) {
  await db.query("INSERT INTO users(id) VALUES($1) ON CONFLICT DO NOTHING", [
    id,
  ]);
}
export async function event(
  db: Database,
  user: string,
  run: string,
  type: string,
  data: Record<string, unknown> = {},
) {
  await db.query(
    "INSERT INTO events(run_id,user_id,type,data) VALUES($1,$2,$3,$4::jsonb)",
    [run, user, type, JSON.stringify(data)],
  );
  projectEvent(type, run, data);
}
