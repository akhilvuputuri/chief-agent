import type { Database } from "../db.js";
import type { BoxController } from "../boxes/controller.js";
import type { SandboxProvider, SandboxRequest } from "./provider.js";

const PREFIX = "box:";
/** The box sandbox closes its own boxes with this reason, so it can tell them apart. */
const ENDED = "Coding attempt ended";
/**
 * Box endings that say nothing about the attempt itself: its own close, an idle box whose
 * task had already ended, and infrastructure faults. Like a CodeBuild failure, they leave
 * the controller free to retry once; every other reason (limits, compromise, an operator
 * close) is stated to the owner and not retried.
 */
const UNSTATED = new Set([
  ENDED,
  "Idle time-to-live reached",
  "The box never connected after boot",
  "The box stopped polling and is lost",
  "The provider ended the box before it connected",
  "The provider ended the box while stopping",
  "Stop did not complete",
  "The stopped box could not be started; start a fresh box",
]);
/** The only task command a coding box may run; checked at startup. */
export const CODING_TASK_COMMAND = [
  "node",
  "--disable-sigusr1",
  "/opt/chief-worker/dist/boxes/coding-task.js",
];

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
    /** The profile's current image first, then earlier box-capable images it still runs. */
    readonly images: string[],
  ) {}

  /**
   * Whether this sandbox runs the attempt: the Pi runtime with one of the profile's images.
   * A job keeps the image it was snapshotted with, so after a re-pin its box is started
   * with that earlier image, as long as the profile still lists it.
   */
  accepts(r: SandboxRequest) {
    return r.runtime === "pi" && this.images.includes(r.image);
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
      image: r.image,
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

  readonly authoritativeFind = true;

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
   * that has ended (or was never queued) closes its box. A held box is left alone and
   * reported running: the attempt then pauses through its deadline or heartbeat, and
   * cleanup waits for an operator.
   */
  async inspect(id: string) {
    const { box, task } = await this.load(id);
    if (box.state === "terminated") {
      await this.scrub(box.id);
      return "terminal" as const;
    }
    if (
      box.state !== "held" &&
      (!task || !["queued", "running"].includes(task.state))
    )
      await this.boxes.close(box.user_id, box.id, ENDED);
    return "running" as const;
  }

  async terminate(id: string) {
    const { box } = await this.load(id);
    if (box.state !== "terminated" && box.state !== "held")
      await this.boxes.close(box.user_id, box.id, ENDED);
  }

  /**
   * A stated reason when the task's deadline, the box's limits, a compromise or an operator
   * ended the attempt. `undefined` means nothing about the attempt is known (the worker
   * exited, or the infrastructure failed), which the controller may retry once.
   */
  async terminalReason(id: string) {
    const { box, task } = await this.load(id);
    if (box.state !== "terminated") return undefined;
    const error = task?.result?.error;
    if (typeof error === "string" && /deadline/i.test(error))
      return "Coding box task passed its deadline before a result was recorded; saved work is retained";
    if (box.reason && !UNSTATED.has(box.reason))
      return `Coding box ended (${String(box.reason).slice(0, 200)}) before a result was recorded; saved work is retained`;
    return undefined;
  }

  /** The attempt token is only needed while the box runs; drop it from stored payloads. */
  private async scrub(boxId: string) {
    await this.db.query(
      "UPDATE box_tasks SET payload=payload - 'token' WHERE box_id=$1 AND payload ? 'token'",
      [boxId],
    );
    await this.db.query(
      "UPDATE box_messages SET payload=payload #- '{payload,token}' WHERE box_id=$1 AND kind='task.assign' AND payload->'payload' ? 'token'",
      [boxId],
    );
  }
}

/**
 * Chooses the coding sandbox at startup. Coding runs only in EC2 boxes (phase 6), so it
 * needs boxes on and a reviewed `coding` profile, and startup is refused while an attempt
 * still depends on a CodeBuild build that nothing could inspect or clean up any more.
 */
export async function codingSandbox(o: {
  db: Database;
  settings: { runtime?: string; image?: string };
  boxes?: BoxController;
  taskCommand?: string[];
}): Promise<BoxSandbox> {
  const profile = o.boxes?.config.profiles.coding;
  if (!o.boxes || !profile)
    throw new Error("Coding needs BOXES_RUNTIME=on and a coding box profile");
  if (o.settings.runtime !== "pi" || profile.image !== o.settings.image)
    throw new Error(
      "The coding box profile must use the selected Pi worker image",
    );
  if (profile.concurrency !== 1)
    throw new Error("The coding box profile must admit one box at a time");
  if (JSON.stringify(o.taskCommand) !== JSON.stringify(CODING_TASK_COMMAND))
    throw new Error(
      `The coding box profile must run ${CODING_TASK_COMMAND.join(" ")}`,
    );
  const images = [profile.image, ...(profile.previousImages ?? [])];
  // A recorded CodeBuild build, or an unrecorded launch with an image no box runs (an
  // uncertain CodeBuild create), would sit in cleanup forever and block the queue.
  // An unrecorded launch is fine when its box exists (found by its key) or when its image
  // is one a box would have been started with (nothing found means nothing launched).
  const stranded = await o.db.query(
    `SELECT 1 FROM coding_jobs j
     WHERE (j.state IN ('provisioning','running','publishing') OR j.cleanup='pending')
       AND ((j.sandbox_id IS NOT NULL AND j.sandbox_id NOT LIKE 'box:%')
         OR (j.sandbox_id IS NULL
           AND NOT (COALESCE(j.settings->>'image','') = ANY($1::text[]))
           AND NOT EXISTS (SELECT 1 FROM boxes b
             WHERE b.profile='coding' AND b.request_key='coding:'||j.attempt_id::text)))
     LIMIT 1`,
    [images],
  );
  if (stranded.rows.length)
    throw new Error(
      "A coding attempt still depends on a CodeBuild build; settle it before starting without CodeBuild",
    );
  return new BoxSandbox(o.db, o.boxes, "coding", images);
}
