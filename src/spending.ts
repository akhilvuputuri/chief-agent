import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
export const spending = new AsyncLocalStorage<Spending>();
/** Usage accounting only. Never blocks requests or enforces a dollar cap. */
export class Spending {
  constructor(
    readonly db: Database,
    readonly user: string,
    readonly run: string,
  ) {}
  async begin(provider: string, estimate: number) {
    if (!Number.isFinite(estimate) || estimate < 0)
      throw new Error("Invalid cost estimate");
    const id = randomUUID();
    const result = await this.db.query(
      `INSERT INTO provider_charges(id,run_id,provider,estimated_usd)
    SELECT $1,id,$4,$5 FROM runtime_runs WHERE id=$2 AND user_id=$3 RETURNING id`,
      [id, this.run, this.user, provider, estimate],
    );
    if (!result.rows.length) throw new Error("Usage owner unavailable");
    return id;
  }
  async summary() {
    return (
      await this.db.query(
        `SELECT COALESCE(sum(c.actual_usd),0) AS reported_usd,
    COALESCE(sum(c.estimated_usd) FILTER(WHERE c.actual_usd IS NULL),0) AS estimated_unknown_usd,
    count(c.id) FILTER(WHERE c.actual_usd IS NULL) AS unknown_requests
    FROM runtime_runs current JOIN runtime_runs r ON r.user_id=current.user_id AND (r.id=current.id OR(current.task_id IS NOT NULL AND r.task_id=current.task_id))
    LEFT JOIN provider_charges c ON c.run_id=r.id WHERE current.id=$1 AND current.user_id=$2`,
        [this.run, this.user],
      )
    ).rows[0];
  }
  async settle(id: string, usage: any) {
    const cost = usage?.cost;
    await this.db.query(
      "UPDATE provider_charges SET actual_usd=$3,usage=$4 WHERE id=$1 AND run_id=$2 AND EXISTS(SELECT 1 FROM runtime_runs WHERE id=$2 AND user_id=$5)",
      [
        id,
        this.run,
        typeof cost === "number" && Number.isFinite(cost) && cost >= 0
          ? cost
          : null,
        JSON.stringify(usage ?? null),
        this.user,
      ],
    );
  }
}
