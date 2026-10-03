import type { Database } from "./db.js";
type Client = Database & { release(): void };
type Transactional = Database & {
  connect?: () => Promise<Client>;
  transaction?: <T>(fn: (client: Database) => Promise<T>) => Promise<T>;
};
export async function transaction<T>(
  db: Database,
  fn: (client: Database) => Promise<T>,
): Promise<T> {
  const driver = db as Transactional;
  if (driver.connect) {
    const client = await driver.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  if (driver.transaction) return driver.transaction(fn);
  throw new Error("This operation requires transactional storage");
}
/** Reserve the request key, write the domain result, and persist its exact response in one transaction.
 * A second SQL statement is intentional: a statement cannot UPDATE a row inserted by a sibling CTE.
 */
export async function atomicMutation(
  db: Database,
  sql: string,
  values: unknown[],
  identity: { collectionId: string; user: string; requestKey: string },
) {
  return transaction(db, async (client) => {
    const rows = (await client.query(sql, values)).rows;
    const result = rows[0]?.result;
    if (result !== undefined) {
      const updated = await client.query(
        "UPDATE gather_mutations SET result=$4::jsonb WHERE collection_id=$1 AND user_id=$2 AND request_key=$3 RETURNING request_key",
        [
          identity.collectionId,
          identity.user,
          identity.requestKey,
          JSON.stringify(result),
        ],
      );
      if (updated.rows.length !== 1)
        throw new Error("Mutation response could not be committed");
    }
    return { rows };
  });
}
