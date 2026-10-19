import type { Database } from "../db.js";
import type { BoxController } from "../boxes/controller.js";
import type { SandboxProvider, SandboxRequest } from "./provider.js";

const PREFIX = "box:";
/** The box sandbox closes its own boxes with this reason, so it can tell them apart. */
const ENDED = "Coding attempt ended";

/**
 * Runs each coding attempt as one task in its own EC2 box (docs/boxes.md, phase 4a). The
 * coding controller keeps all policy: the worker inside the box calls the same
 * `/coding/worker/*` routes with the same attempt token as on CodeBuild. A box serves one
 * attempt and is closed when that attempt's task ends.
 */
export class BoxSandbox implements SandboxProvider {
  /** A cold box takes minutes before the worker's first heartbeat. */
  startupGraceMs() {
    return 12 * 60_000;
  }
  constructor(
    private db: Database,
    private boxes: BoxController,
    readonly profile: string,
    readonly image: string,
  ) {}

  /** Whether this sandbox runs the attempt; older images stay on the previous provider. */
  accepts(r: SandboxRequest) {
    return r.runtime === "pi" && r.image === this.image;
  }

  owns(id: string) {
    return id.startsWith(PREFIX);
  }

  private key = (attemptId: string) => `coding:${attemptId}`;

  async create(r: SandboxRequest) {
    if (!this.accepts(r))
      throw new Error("This attempt cannot run in a coding box");
    const job = (
      await this.db.query("SELECT user_id FROM coding_jobs WHERE id=$1", [
        r.jobId,
      ])
    ).rows[0];
    if (!job) throw new Error("Coding job not found");
    const key = this.key(r.attemptId);
    // Both calls are idempotent by request key, so a retried create reuses the box and task.
    const box = await this.boxes.spawn(job.user_id, {
      profile: this.profile,
      requestKey: key,
      subject: `coding:${r.jobId}`,
    });
    await this.boxes.delegate(job.user_id, box.id, {
      requestKey: key,
      kind: "coding",
      payload: {
        jobId: r.jobId,
        attemptId: r.attemptId,
        token: r.token,
        origin: r.origin,
      },
    });
    return `${PREFIX}${box.id}`;
  }

  /** The database is the truth for boxes, so a missing row means nothing was created. */
  async find(attemptId: string) {
    const row = (
      await this.db.query(
        "SELECT id FROM boxes WHERE request_key=$1 AND profile=$2",
        [this.key(attemptId), this.profile],
      )
    ).rows[0];
    return row ? `${PREFIX}${row.id}` : undefined;
  }

  private async load(id: string) {
    const boxId = id.slice(PREFIX.length);
    const box = (
      await this.db.query(
        "SELECT id,user_id,request_key,state,reason FROM boxes WHERE id=$1",
        [boxId],
      )
    ).rows[0];
    if (!box) throw new Error("Coding box not found");
    const task = (
      await this.db.query(
        "SELECT state,result FROM box_tasks WHERE box_id=$1 AND request_key=$2",
        [box.id, box.request_key],
      )
    ).rows[0];
    return { box, task };
  }

  /**
   * `terminal` only once the box is gone, so cleanup never leaves compute behind. A task
   * that has ended (or was never queued) closes its box; a held box needs an operator.
   */
  async inspect(id: string) {
    const { box, task } = await this.load(id);
    if (box.state === "terminated") return "terminal" as const;
    if (box.state === "held")
      throw new Error("Coding box is held for an operator");
    if (!task || !["queued", "running"].includes(task.state))
      await this.boxes.close(box.user_id, box.id, ENDED);
    return "running" as const;
  }

  async terminate(id: string) {
    const { box } = await this.load(id);
    if (box.state !== "terminated")
      await this.boxes.close(box.user_id, box.id, ENDED);
  }

  /**
   * A stated reason when the box or its lifetime ended the attempt. `undefined` means the
   * worker simply exited without a result, which the controller may retry once.
   */
  async terminalReason(id: string) {
    const { box, task } = await this.load(id);
    if (box.state !== "terminated") return undefined;
    const error = task?.result?.error;
    if (typeof error === "string" && /deadline/i.test(error))
      return "Coding box task passed its deadline before a result was recorded; saved work is retained";
    if (box.reason && box.reason !== ENDED)
      return `Coding box ended (${String(box.reason).slice(0, 200)}) before a result was recorded; saved work is retained`;
    return undefined;
  }
}

/**
 * Sends new attempts to the box sandbox when it accepts them and to the previous provider
 * otherwise; existing sandbox IDs keep the provider that created them.
 */
export class RoutedSandbox implements SandboxProvider {
  constructor(
    private boxes: BoxSandbox,
    private fallback?: SandboxProvider,
  ) {}

  private other() {
    if (!this.fallback)
      throw new Error(
        "This attempt needs a sandbox provider that is not configured",
      );
    return this.fallback;
  }

  private by(id: string) {
    return this.boxes.owns(id) ? this.boxes : this.other();
  }

  startupGraceMs(id: string | null | undefined) {
    return id && this.boxes.owns(id) ? this.boxes.startupGraceMs() : 0;
  }

  async create(r: SandboxRequest) {
    return this.boxes.accepts(r)
      ? this.boxes.create(r)
      : this.other().create(r);
  }

  async find(attemptId: string, timeoutMinutes?: number) {
    return (
      (await this.boxes.find(attemptId)) ??
      (this.fallback
        ? this.fallback.find(attemptId, timeoutMinutes)
        : undefined)
    );
  }

  async inspect(id: string) {
    return this.by(id).inspect(id);
  }

  async terminate(id: string) {
    return this.by(id).terminate(id);
  }

  async terminalReason(id: string) {
    const provider = this.by(id);
    return provider.terminalReason ? provider.terminalReason(id) : undefined;
  }
}
