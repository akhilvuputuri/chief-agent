import type { Database } from "./db.js";
/** Use one connection. The lock and subsequent statement have separate snapshots,
 * so daily counts see reservations committed by a preceding lock holder. */
export async function withResponsibilityOwner<T>(
  db: Database,
  user: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  const adapter = db as Database & {
    transaction?: <R>(fn: (tx: Database) => Promise<R>) => Promise<R>;
    connect?: () => Promise<Database & { release: () => void }>;
  };
  const locked = async (tx: Database) => {
    await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user]);
    return fn(tx);
  };
  if (adapter.transaction) return adapter.transaction(locked);
  if (!adapter.connect)
    throw new Error(
      "A transaction-capable database is required for responsibility reservations",
    );
  const connection = await adapter.connect();
  try {
    await connection.query("BEGIN");
    const result = await locked(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
