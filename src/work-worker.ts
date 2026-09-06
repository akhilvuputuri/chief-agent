import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
export class WorkWorker {
  private busy = false;
  constructor(
    private db: Database,
    private resume: (user: string, id: string) => Promise<string>,
    private notify: (user: string, text: string) => Promise<unknown>,
  ) {}
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.db.query(
        `UPDATE work_tasks SET status='paused',lease=NULL WHERE status='running' AND updated_at<now()-interval '5 minutes'`,
      );
      const lease = randomUUID();
      const task = (
        await this.db.query(
          `UPDATE work_tasks SET status='running',passes=passes+1,lease=$1,updated_at=now() WHERE id=(SELECT id FROM work_tasks WHERE status='queued' AND passes<3 AND next_run<=now() ORDER BY next_run FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
          [lease],
        )
      ).rows[0];
      if (!task) return;
      try {
        const text = await this.resume(task.user_id, task.id);
        await this.db.query(
          `UPDATE work_tasks SET status=CASE WHEN status IN ('done','cancelled','paused') THEN status WHEN passes>=3 OR NOT EXISTS(SELECT 1 FROM work_steps WHERE task_id=$1 AND status='pending') THEN 'paused' ELSE 'queued' END,lease=NULL,next_run=now()+interval '15 seconds',updated_at=now() WHERE id=$1 AND lease=$2`,
          [task.id, lease],
        );
        await this.notify(task.user_id, text);
      } catch {
        await this.db.query(
          `UPDATE work_tasks SET status='paused',lease=NULL,updated_at=now() WHERE id=$1 AND lease=$2`,
          [task.id, lease],
        );
      }
    } finally {
      this.busy = false;
    }
  }
}
