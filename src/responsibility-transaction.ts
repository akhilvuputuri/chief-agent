import type { Database } from "./db.js";
import { withClientTransaction } from "./db-transaction.js";
/** Use one connection. The lock and subsequent statement have separate snapshots,
 * so daily counts see reservations committed by a preceding lock holder. */
export async function withResponsibilityOwner<T>(
  db: Database,
  user: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  const adapter = db as Database & {
    transaction?: <R>(fn: (tx: Database) => Promise<R>) => Promise<R>;
    connect?: () => Promise<Parameters<typeof withClientTransaction>[0]>;
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
  return withClientTransaction(await adapter.connect(), locked);
}
