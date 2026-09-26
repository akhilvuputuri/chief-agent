import pg from "pg";
import { projectEvent } from "./ops-log.js";
export interface Database {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export const connect = (url: string) =>
  new pg.Pool({ connectionString: url, max: 8 });
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
