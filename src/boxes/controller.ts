import { randomUUID } from "node:crypto";
import type { Database } from "../db.js";
import { transaction } from "../db-transaction.js";
import { ToolValidationError } from "../tool-errors.js";
import type { BoxProvider } from "./provider.js";
import {
  bootstrapSecret,
  deriveCredential,
  hashCredential,
  sameHash,
} from "./credentials.js";
import {
  eventBatch,
  helloRequest,
  type BoxConfig,
  type BoxEvent,
  type BoxProfile,
} from "./schema.js";

/** The channel refuses a caller; the HTTP layer answers 401 without detail. */
export class BoxCredentialRefused extends Error {}

type Box = {
  id: string;
  user_id: string;
  request_key: string;
  profile: string;
  provider: string;
  environment: string;
  subject: string;
  image: string;
  state: string;
  reason: string;
  provider_id: string | null;
  launch_started_at: Date | null;
  epoch: number;
  credential_hash: string;
  previous_hash: string | null;
  bootstrap_hash: string | null;
  retired_hashes: string[];
  seen_at: Date | null;
  idle_since: Date | null;
  running_since: Date | null;
  running_ms: string | number;
  stopped_at: Date | null;
  absolute_deadline: Date;
  lease: string | null;
};

export interface BoxTimings {
  /** An uncertain launch with no resource found by then is held for an operator. */
  launchTimeoutMs: number;
  /** A box that never says hello after launch or start is terminated. */
  bootTimeoutMs: number;
  /** A box that stops polling for this long is lost. */
  lostAfterMs: number;
  /** After the host starts, silent boxes are not judged until this has passed. */
  hostGraceMs: number;
  /** Longest wait of one `next` long-poll; well inside the proxy's timeouts. */
  pollMs: number;
  /** Interval between orphan sweeps. */
  sweepMs: number;
  /** A stop that has not completed by then is escalated to termination. */
  stopTimeoutMs: number;
  /** Bound on any single provider call, so one hung call cannot stall the reconciler. */
  providerCallMs: number;
}

const defaults: BoxTimings = {
  launchTimeoutMs: 5 * 60_000,
  bootTimeoutMs: 10 * 60_000,
  lostAfterMs: 3 * 60_000,
  hostGraceMs: 5 * 60_000,
  pollMs: 8_000,
  sweepMs: 5 * 60_000,
  stopTimeoutMs: 10 * 60_000,
  providerCallMs: 60_000,
};

const active = [
  "launching",
  "booting",
  "ready",
  "busy",
  "stopping",
  "starting",
] as const;
const closed = ["terminating", "terminated", "held"];
const MAX_RETIRED = 8;

/** Confirms an owner input belongs to this owner and the current turn. */
export type OwnerInputCheck = (
  user: string,
  run: string,
  inputId: string,
) => Promise<boolean>;

/**
 * Host side of boxed sub-agents (docs/boxes.md): owner operations, the box channel and the
 * reconciler. Lifecycle truth lives here; a box only ever reports, and the provider is
 * consulted, never trusted to be in step.
 */
export class BoxController {
  private readonly startedAt: number;
  private readonly timings: BoxTimings;
  private lastSweep = 0;
  private ticking = false;
  constructor(
    readonly db: Database,
    readonly config: BoxConfig,
    private providers: Record<string, BoxProvider>,
    private key: string,
    readonly origin: string,
    private clock: () => Date = () => new Date(),
    timings: Partial<BoxTimings> = {},
    private ownerInput: OwnerInputCheck = async () => false,
  ) {
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error("Box credential key must be 64 hex characters");
    this.startedAt = clock().getTime();
    this.timings = { ...defaults, ...timings };
    for (const [name, profile] of Object.entries(config.profiles))
      if (!providers[profile.provider])
        throw new Error(
          `Box profile ${name} has no ${profile.provider} provider`,
        );
  }

  private profile(name: string): BoxProfile {
    const profile = this.config.profiles[name];
    if (!profile) throw new ToolValidationError(`Unknown box profile ${name}`);
    return profile;
  }

  private async load(id: string, db: Database = this.db) {
    return (await db.query("SELECT * FROM boxes WHERE id=$1", [id])).rows[0] as
      Box | undefined;
  }

  private async owned(user: string, id: string): Promise<Box> {
    const box = (
      await this.db.query("SELECT * FROM boxes WHERE id=$1 AND user_id=$2", [
        id,
        user,
      ])
    ).rows[0] as Box | undefined;
    if (!box) throw new ToolValidationError("Box not found");
    return box;
  }

  private async notice(
    boxId: string,
    key: string,
    payload: object,
    db: Database = this.db,
  ) {
    await db.query(
      "INSERT INTO box_notices(box_id,notice_key,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING",
      [boxId, key, JSON.stringify(payload)],
    );
  }

  /** Bounds a provider call; a timeout is treated like any other provider error. */
  private bounded<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Provider call timed out")),
          this.timings.providerCallMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  // ---- Owner operations --------------------------------------------------------------

  /** Requests a box for one subject; idempotent by request key. Launch happens on a tick. */
  async spawn(
    user: string,
    a: { requestKey: string; profile: string; subject: string },
  ) {
    const profile = this.profile(a.profile);
    const now = this.clock();
    const id = randomUUID();
    const inserted = await this.db.query(
      `INSERT INTO boxes(id,user_id,request_key,profile,provider,environment,subject,image,credential_hash,absolute_deadline)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id,request_key) DO NOTHING RETURNING id`,
      [
        id,
        user,
        a.requestKey,
        a.profile,
        profile.provider,
        this.config.environment,
        a.subject,
        profile.image,
        // Replaced by the bootstrap secret's hash at launch.
        hashCredential(bootstrapSecret()),
        new Date(now.getTime() + profile.absoluteDays * 86_400_000),
      ],
    );
    const box = inserted.rows.length
      ? await this.load(id)
      : ((
          await this.db.query(
            "SELECT * FROM boxes WHERE user_id=$1 AND request_key=$2",
            [user, a.requestKey],
          )
        ).rows[0] as Box);
    if (box!.profile !== a.profile || box!.subject !== a.subject)
      throw new ToolValidationError(
        "This request key already started a different box",
      );
    return this.view(box!);
  }

  /**
   * Queues a task for a box; a stopped box is started by the reconciler. The box row is
   * locked with the insert, so a concurrent close or compromise cannot orphan the task.
   */
  async delegate(
    user: string,
    boxId: string,
    a: { requestKey: string; kind: string; payload: Record<string, unknown> },
  ) {
    return transaction(this.db, async (db) => {
      const box = (
        await db.query(
          "SELECT * FROM boxes WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [boxId, user],
        )
      ).rows[0] as Box | undefined;
      if (!box) throw new ToolValidationError("Box not found");
      const existing = (
        await db.query(
          "SELECT id FROM box_tasks WHERE box_id=$1 AND request_key=$2",
          [box.id, a.requestKey],
        )
      ).rows[0];
      if (existing) return { taskId: existing.id as string };
      if (closed.includes(box.state))
        throw new ToolValidationError(
          `This box is ${box.state}; start a new box for more work`,
        );
      const taskId = randomUUID();
      await db.query(
        "INSERT INTO box_tasks(id,box_id,request_key,kind,payload) VALUES($1,$2,$3,$4,$5::jsonb)",
        [taskId, box.id, a.requestKey, a.kind, JSON.stringify(a.payload)],
      );
      await this.message(db, box.id, `task:${taskId}`, "task.assign", {
        taskId,
        kind: a.kind,
        payload: a.payload,
      });
      return { taskId };
    });
  }

  /**
   * Relays an owner's answer or clarification into a running task. Steering is bound to an
   * owner input of the current turn; it never changes approved scope, and Chief cannot
   * steer on its own.
   */
  async send(
    user: string,
    run: string,
    boxId: string,
    a: {
      requestKey: string;
      taskId: string;
      text: string;
      ownerInputId: string;
    },
  ) {
    if (!(await this.ownerInput(user, run, a.ownerInputId)))
      throw new ToolValidationError(
        "Steering a box needs the owner's own message in this turn",
      );
    return transaction(this.db, async (db) => {
      const box = (
        await db.query(
          "SELECT * FROM boxes WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [boxId, user],
        )
      ).rows[0] as Box | undefined;
      if (!box) throw new ToolValidationError("Box not found");
      const task = (
        await db.query(
          "SELECT state FROM box_tasks WHERE id=$1 AND box_id=$2",
          [a.taskId, box.id],
        )
      ).rows[0];
      if (
        closed.includes(box.state) ||
        !task ||
        !["queued", "running"].includes(task.state)
      )
        throw new ToolValidationError("That task is not running");
      await this.message(
        db,
        box.id,
        `message:${a.requestKey}`,
        "task.message",
        {
          taskId: a.taskId,
          text: a.text.slice(0, 8000),
          ownerInputId: a.ownerInputId,
        },
      );
      return { sent: true };
    });
  }

  /** Closes a box now; termination is verified by the reconciler. */
  async close(user: string, boxId: string) {
    const box = await this.owned(user, boxId);
    await this.terminate(box, "Closed by the owner");
    return this.view((await this.load(box.id))!);
  }

  async status(user: string, boxId: string) {
    const box = await this.owned(user, boxId);
    const tasks = (
      await this.db.query(
        "SELECT id,kind,state,result,updated_at FROM box_tasks WHERE box_id=$1 ORDER BY created_at",
        [box.id],
      )
    ).rows;
    return { ...this.view(box), tasks };
  }

  private view(box: Box) {
    return {
      id: box.id,
      profile: box.profile,
      subject: box.subject,
      state: box.state,
      reason: box.reason,
    };
  }

  /** Appends one message; the caller's transaction holds the box row lock. */
  private async message(
    db: Database,
    boxId: string,
    requestKey: string,
    kind: string,
    payload: object,
  ) {
    const exists = (
      await db.query(
        "SELECT 1 FROM box_messages WHERE box_id=$1 AND request_key=$2",
        [boxId, requestKey],
      )
    ).rows.length;
    if (exists) return;
    const seq = (
      await db.query(
        "UPDATE boxes SET message_seq=message_seq+1,updated_at=$2 WHERE id=$1 RETURNING message_seq",
        [boxId, this.clock()],
      )
    ).rows[0].message_seq;
    await db.query(
      "INSERT INTO box_messages(box_id,seq,request_key,kind,payload) VALUES($1,$2,$3,$4,$5::jsonb)",
      [boxId, seq, requestKey, kind, JSON.stringify(payload)],
    );
  }

  // ---- Channel ----------------------------------------------------------------------

  /**
   * Exchanges the bootstrap secret or the stored session credential for the next epoch's
   * credential. Rotation is idempotent per predecessor: a retry returns the same replacement.
   * Provider identity is verified before anything changes, so a stolen secret without the
   * instance's proof is refused without harming the real box.
   */
  async hello(boxId: string, raw: unknown) {
    const body = helloRequest.parse(raw);
    const presented = hashCredential(body.credential);
    const before = await this.load(boxId);
    if (
      !before ||
      // Until the host has recorded the resource, it cannot verify, stop or end it.
      !before.provider_id ||
      [...closed, "requested"].includes(before.state)
    )
      throw new BoxCredentialRefused();
    const provider = this.providers[before.provider];
    if (provider?.verifyIdentity) {
      const verified = await this.bounded(
        provider.verifyIdentity(before.provider_id, body.identity),
      ).catch(() => false);
      if (!verified) {
        await this.notice(before.id, `alert:identity:${before.epoch}`, {
          summary:
            "A hello for this box failed identity verification and was refused.",
        });
        throw new BoxCredentialRefused();
      }
    }
    const now = this.clock();
    const result = await transaction(this.db, async (db) => {
      const box = (
        await db.query("SELECT * FROM boxes WHERE id=$1 FOR UPDATE", [boxId])
      ).rows[0] as Box;
      if (
        !box.provider_id ||
        box.provider_id !== before.provider_id ||
        [...closed, "requested"].includes(box.state)
      )
        return { refused: true as const };
      // A retry while the replacement is still unused returns that same replacement.
      if (sameHash(box.previous_hash, presented))
        return {
          box,
          credential: deriveCredential(this.key, box.id, presented, box.epoch),
          epoch: box.epoch,
        };
      if (sameHash(box.credential_hash, presented)) {
        const epoch = box.epoch + 1;
        const credential = deriveCredential(this.key, box.id, presented, epoch);
        // Presenting the pending replacement is its first use: the older predecessor retires.
        const retired = [
          ...(box.previous_hash ? [box.previous_hash] : []),
          ...box.retired_hashes,
        ].slice(0, MAX_RETIRED);
        const wasBooting = ["launching", "booting", "starting"].includes(
          box.state,
        );
        await db.query(
          `UPDATE boxes SET epoch=$2,previous_hash=$3,credential_hash=$4,retired_hashes=$5,
             seen_at=$6::timestamptz,state=CASE WHEN $7 THEN 'ready' ELSE state END,
             idle_since=CASE WHEN $7 THEN $6::timestamptz ELSE idle_since END,
             running_since=COALESCE(running_since,$6::timestamptz),updated_at=$6 WHERE id=$1`,
          [
            box.id,
            epoch,
            presented,
            hashCredential(credential),
            retired,
            now,
            wasBooting,
          ],
        );
        return { box, credential, epoch };
      }
      if (this.retired(box, presented))
        return { refused: true as const, retired: box };
      return { refused: true as const };
    });
    if ("retired" in result && result.retired)
      // A delayed duplicate is the benign explanation; the caller gains nothing, so alert only.
      await this.notice(boxId, `alert:retired-hello:${result.retired.epoch}`, {
        summary:
          "A box presented a retired credential to hello; it was refused. Inspect if this repeats.",
      });
    if ("refused" in result) throw new BoxCredentialRefused();
    const fresh = (await this.load(boxId))!;
    return {
      protocol: 1,
      credential: result.credential,
      epoch: result.epoch,
      remainingMs: this.remaining(fresh, now),
    };
  }

  /** Retired credentials, including the consumed bootstrap secret, which never expires. */
  private retired(box: Box, presented: string) {
    return (
      box.retired_hashes.includes(presented) ||
      (box.epoch > 0 &&
        sameHash(box.bootstrap_hash, presented) &&
        !sameHash(box.previous_hash, presented))
    );
  }

  /** Authenticates channel calls. A retired credential here means compromise. */
  async authenticate(boxId: string, credential: string): Promise<Box> {
    const presented = hashCredential(credential);
    const box = await this.load(boxId);
    if (!box || closed.includes(box.state)) throw new BoxCredentialRefused();
    if (sameHash(box.credential_hash, presented)) {
      if (box.previous_hash)
        // First use of the replacement retires the predecessor.
        await this.db.query(
          "UPDATE boxes SET previous_hash=NULL,retired_hashes=$2 WHERE id=$1 AND credential_hash=$3 AND previous_hash=$4",
          [
            box.id,
            [box.previous_hash, ...box.retired_hashes].slice(0, MAX_RETIRED),
            presented,
            box.previous_hash,
          ],
        );
      return box;
    }
    if (this.retired(box, presented))
      await this.compromised(box, "A retired box credential was used");
    // The predecessor is accepted only to retry hello.
    throw new BoxCredentialRefused();
  }

  private async compromised(box: Box, reason: string) {
    await this.notice(box.id, "compromised", {
      summary: `Box marked compromised: ${reason}. Its tasks were stopped and it is being terminated.`,
    });
    await this.terminate(box, `Compromised: ${reason}`);
  }

  /** Long-poll for ordered host messages; acknowledges everything up to `after`. */
  async next(
    boxId: string,
    credential: string,
    after: number,
    signal?: AbortSignal,
  ) {
    const box = await this.authenticate(boxId, credential);
    const now = this.clock();
    await this.db.query("UPDATE boxes SET seen_at=$2 WHERE id=$1", [
      box.id,
      now,
    ]);
    await this.db.query(
      "UPDATE box_messages SET acked_at=$3 WHERE box_id=$1 AND seq<=$2 AND acked_at IS NULL",
      [box.id, after, now],
    );
    const until = Date.now() + this.timings.pollMs;
    while (true) {
      const messages = (
        await this.db.query(
          "SELECT seq,kind,payload FROM box_messages WHERE box_id=$1 AND seq>$2 ORDER BY seq LIMIT 20",
          [box.id, after],
        )
      ).rows.map((m) => ({ ...m, seq: Number(m.seq) }));
      if (messages.length || Date.now() >= until || signal?.aborted)
        return {
          messages,
          remainingMs: this.remaining((await this.load(box.id))!, this.clock()),
        };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Ordered, deduplicated box events; each is recorded and applied atomically, once. */
  async events(boxId: string, credential: string, raw: unknown) {
    const box = await this.authenticate(boxId, credential);
    const batch = eventBatch.parse(raw);
    if (batch.epoch > box.epoch) throw new ToolValidationError("Unknown epoch");
    const now = this.clock();
    let applied = 0;
    for (const event of batch.events) {
      const taskId = "taskId" in event ? event.taskId : null;
      const done = await transaction(this.db, async (db) => {
        if (taskId) {
          const owns = (
            await db.query(
              "SELECT 1 FROM box_tasks WHERE id=$1 AND box_id=$2",
              [taskId, box.id],
            )
          ).rows.length;
          if (!owns)
            throw new ToolValidationError("Event names another box's task");
        }
        const inserted = await db.query(
          "INSERT INTO box_events(box_id,epoch,seq,kind,task_id,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING RETURNING seq",
          [
            box.id,
            batch.epoch,
            event.seq,
            event.kind,
            taskId,
            JSON.stringify(
              "payload" in event
                ? event.payload
                : { state: (event as { state: string }).state },
            ),
          ],
        );
        if (!inserted.rows.length) return false;
        await this.apply(db, box, event, now);
        return true;
      });
      if (done) applied++;
    }
    await this.db.query("UPDATE boxes SET seen_at=$2 WHERE id=$1", [
      box.id,
      now,
    ]);
    return { applied };
  }

  private async apply(db: Database, box: Box, event: BoxEvent, now: Date) {
    switch (event.kind) {
      case "box.state":
        await db.query(
          `UPDATE boxes SET state=$2,idle_since=CASE WHEN $2::text='ready' THEN COALESCE(idle_since,$3::timestamptz) ELSE NULL END,updated_at=$3
           WHERE id=$1 AND state IN ('ready','busy')`,
          [box.id, event.state === "idle" ? "ready" : "busy", now],
        );
        return;
      case "task.started":
        await db.query(
          "UPDATE box_tasks SET state='running',updated_at=$2 WHERE id=$1 AND state='queued'",
          [event.taskId, now],
        );
        return;
      case "task.result":
      case "task.failed":
        await db.query(
          "UPDATE box_tasks SET state=$2,result=$3::jsonb,updated_at=$4 WHERE id=$1 AND state IN ('queued','running')",
          [
            event.taskId,
            event.kind === "task.result" ? "done" : "failed",
            JSON.stringify(event.payload),
            now,
          ],
        );
        return;
      default:
        // Progress and questions are recorded as events for Chief to read and relay.
        return;
    }
  }

  private remaining(box: Box, now: Date) {
    const profile = this.config.profiles[box.profile];
    if (!profile) return 0;
    const used =
      Number(box.running_ms) +
      (box.running_since
        ? now.getTime() - new Date(box.running_since).getTime()
        : 0);
    return Math.max(
      0,
      Math.min(
        profile.hardMaxHours * 3_600_000 - used,
        new Date(box.absolute_deadline).getTime() - now.getTime(),
      ),
    );
  }

  // ---- Reconciler -------------------------------------------------------------------

  /** Moves a box to terminating and fails its open tasks, atomically. */
  private async terminate(box: Box, reason: string) {
    const now = this.clock();
    await transaction(this.db, async (db) => {
      await db.query(
        `UPDATE boxes SET state='terminating',reason=$2,
           running_ms=running_ms+CASE WHEN running_since IS NULL THEN 0 ELSE (EXTRACT(EPOCH FROM ($3::timestamptz-running_since))*1000)::bigint END,
           running_since=NULL,updated_at=$3 WHERE id=$1 AND state NOT IN ('terminating','terminated')`,
        [box.id, reason, now],
      );
      await this.failTasks(db, box.id, reason, now);
    });
  }

  private async failTasks(
    db: Database,
    boxId: string,
    reason: string,
    now: Date,
  ) {
    await db.query(
      "UPDATE box_tasks SET state='failed',result=$2::jsonb,updated_at=$3 WHERE box_id=$1 AND state IN ('queued','running')",
      [boxId, JSON.stringify({ error: reason }), now],
    );
  }

  /** One reconciler pass: each live box is claimed with a lease and moved one step. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.clock();
      const seen: string[] = [];
      for (let i = 0; i < 50; i++) {
        const lease = randomUUID();
        // Least recently reconciled first, so no box is starved when there are many.
        const box = (
          await this.db.query(
            `UPDATE boxes SET lease=$1,lease_until=$2,reconciled_at=$3 WHERE id=(SELECT id FROM boxes
               WHERE state NOT IN ('terminated','held') AND (lease IS NULL OR lease_until<$3) AND NOT (id = ANY($4::uuid[]))
               ORDER BY reconciled_at NULLS FIRST,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
            [lease, new Date(now.getTime() + 120_000), now, seen],
          )
        ).rows[0] as Box | undefined;
        if (!box) break;
        seen.push(box.id);
        try {
          await this.reconcile(box, now);
        } catch {
          // Provider errors are retried on the next tick; nothing is assumed to have happened.
        } finally {
          await this.db.query(
            "UPDATE boxes SET lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2",
            [box.id, lease],
          );
        }
      }
      if (now.getTime() - this.lastSweep >= this.timings.sweepMs) {
        this.lastSweep = now.getTime();
        await this.sweep().catch(() => {});
      }
    } finally {
      this.ticking = false;
    }
  }

  private async set(box: Box, from: string, fields: Record<string, unknown>) {
    const names = Object.keys(fields);
    const result = await this.db.query(
      `UPDATE boxes SET ${names.map((n, i) => `${n}=$${i + 4}`).join(",")},updated_at=$3 WHERE id=$1 AND state=$2 RETURNING id`,
      [box.id, from, this.clock(), ...names.map((n) => fields[n])],
    );
    return result.rows.length > 0;
  }

  private async running(profile: string) {
    return Number(
      (
        await this.db.query(
          "SELECT count(*)::int AS n FROM boxes WHERE profile=$1 AND state = ANY($2::text[])",
          [profile, [...active]],
        )
      ).rows[0].n,
    );
  }

  private async pending(boxId: string) {
    return (
      await this.db.query(
        "SELECT 1 FROM box_messages WHERE box_id=$1 AND acked_at IS NULL LIMIT 1",
        [boxId],
      )
    ).rows.length;
  }

  private async reconcile(box: Box, now: Date) {
    const profile = this.config.profiles[box.profile];
    const provider = this.providers[box.provider];
    if (!profile || !provider) {
      await this.hold(box, "Profile or provider no longer configured");
      return;
    }
    const call = <T>(work: Promise<T>) => this.bounded(work);
    const t = now.getTime();
    const since = (d: Date | null) =>
      d ? t - new Date(d).getTime() : Infinity;
    switch (box.state) {
      case "requested": {
        if ((await this.running(box.profile)) >= profile.concurrency) return;
        const secret = bootstrapSecret();
        const hash = hashCredential(secret);
        // The secret's hash and the launching state are recorded before the provider call,
        // so an uncertain launch is reconciled, never retried.
        if (
          !(await this.set(box, "requested", {
            state: "launching",
            credential_hash: hash,
            bootstrap_hash: hash,
            epoch: 0,
            previous_hash: null,
            launch_started_at: now,
          }))
        )
          return;
        const providerId = await call(
          provider.launch({
            boxId: box.id,
            clientToken: box.id,
            profile: box.profile,
            image: box.image,
            environment: box.environment,
            bootstrap: { origin: this.origin, boxId: box.id, secret },
          }),
        );
        await this.set(box, "launching", {
          provider_id: providerId,
          state: "booting",
          running_since: now,
        });
        return;
      }
      case "launching": {
        const found = await call(provider.find(box.id));
        if (found) {
          await this.set(box, "launching", {
            provider_id: found,
            state: "booting",
            running_since: now,
          });
          return;
        }
        if (since(box.launch_started_at) > this.timings.launchTimeoutMs)
          await this.hold(
            box,
            "Launch outcome unknown and no resource was found; inspect the provider before retrying",
          );
        return;
      }
      case "booting":
      case "starting": {
        const state = await call(provider.describe(box.provider_id!));
        if (state === "terminated" || state === "missing") {
          await this.terminate(
            box,
            "The provider ended the box before it connected",
          );
          return;
        }
        const connected =
          box.seen_at &&
          box.running_since &&
          new Date(box.seen_at) >= new Date(box.running_since);
        if (!connected && since(box.running_since) > this.timings.bootTimeoutMs)
          await this.terminate(box, "The box never connected after boot");
        return;
      }
      case "ready":
      case "busy": {
        if (this.remaining(box, now) <= 0) {
          await this.terminate(box, "Lifetime limit reached");
          return;
        }
        if (
          since(box.seen_at) > this.timings.lostAfterMs &&
          t - this.startedAt > this.timings.hostGraceMs
        ) {
          await this.terminate(box, "The box stopped polling and is lost");
          return;
        }
        // A box with any open task is never idle, whatever it last reported.
        const open = (
          await this.db.query(
            "SELECT 1 FROM box_tasks WHERE box_id=$1 AND state IN ('queued','running') LIMIT 1",
            [box.id],
          )
        ).rows.length;
        if (
          box.state === "ready" &&
          !open &&
          !(await this.pending(box.id)) &&
          since(box.idle_since) > profile.idleTtlMinutes * 60_000
        ) {
          if (provider.canStop && profile.retentionHours > 0) {
            if (
              await this.set(box, box.state, {
                state: "stopping",
                stopped_at: now,
                running_ms:
                  Number(box.running_ms) +
                  (box.running_since ? since(box.running_since) : 0),
                running_since: null,
              })
            )
              await call(provider.stop(box.provider_id!));
          } else await this.terminate(box, "Idle time-to-live reached");
        }
        return;
      }
      case "stopping": {
        const state = await call(provider.describe(box.provider_id!));
        if (state === "stopped")
          await this.set(box, "stopping", {
            state: "stopped",
            stopped_at: now,
          });
        else if (state === "terminated" || state === "missing")
          await this.terminate(
            box,
            "The provider ended the box while stopping",
          );
        else if (since(box.stopped_at) > this.timings.stopTimeoutMs)
          await this.terminate(box, "Stop did not complete");
        // A stop request that was lost or refused is repeated until the timeout.
        else if (state === "running")
          await call(provider.stop(box.provider_id!));
        return;
      }
      case "stopped": {
        if (
          t >= new Date(box.absolute_deadline).getTime() ||
          since(box.stopped_at) > profile.retentionHours * 3_600_000
        ) {
          await this.terminate(box, "Stopped retention reached");
          return;
        }
        if (!(await this.pending(box.id))) return;
        if ((await this.running(box.profile)) >= profile.concurrency) return;
        if (
          !(await this.set(box, "stopped", {
            state: "starting",
            running_since: now,
          }))
        )
          return;
        try {
          await call(provider.start(box.provider_id!));
        } catch {
          // Commonly insufficient capacity in the box's zone: work restarts in a fresh box.
          await this.terminate(
            box,
            "The stopped box could not be started; start a fresh box",
          );
        }
        return;
      }
      case "terminating": {
        let providerId = box.provider_id;
        if (!providerId && box.launch_started_at) {
          // Closed during an uncertain launch: find the resource before declaring it gone.
          providerId = (await call(provider.find(box.id))) ?? null;
          if (!providerId) {
            if (since(box.launch_started_at) > this.timings.launchTimeoutMs)
              await this.set(box, "terminating", { state: "terminated" });
            return;
          }
          await this.set(box, "terminating", { provider_id: providerId });
        }
        if (!providerId) {
          await this.set(box, "terminating", { state: "terminated" });
          return;
        }
        const state = await call(provider.describe(providerId));
        if (state === "terminated" || state === "missing")
          await this.set(box, "terminating", { state: "terminated" });
        else await call(provider.terminate(providerId));
        return;
      }
    }
  }

  private async hold(box: Box, reason: string) {
    const now = this.clock();
    const held = await transaction(this.db, async (db) => {
      const changed = await db.query(
        "UPDATE boxes SET state='held',reason=$2,updated_at=$3 WHERE id=$1 AND state NOT IN ('terminating','terminated','held') RETURNING id",
        [box.id, reason, now],
      );
      if (!changed.rows.length) return false;
      await this.failTasks(db, box.id, reason, now);
      await this.notice(
        box.id,
        "held",
        { summary: `Box held for an operator: ${reason}` },
        db,
      );
      return true;
    });
    return held;
  }

  /**
   * Terminates this environment's resources that no box row owns. Rows that are held, or
   * still launching, own the resources tagged with their ID. A resource without this
   * environment's tag is never touched.
   */
  async sweep() {
    const orphans: string[] = [];
    const kinds = new Set(
      Object.values(this.config.profiles).map((p) => p.provider),
    );
    for (const kind of kinds) {
      const provider = this.providers[kind];
      if (!provider) continue;
      for (const resource of await this.bounded(provider.list())) {
        if (resource.environment !== this.config.environment) continue;
        const owner = (
          await this.db.query(
            `SELECT id,state,provider_id FROM boxes WHERE environment=$1 AND provider=$2
               AND (provider_id=$3 OR id::text=$4) AND state<>'terminated' LIMIT 1`,
            [
              this.config.environment,
              kind,
              resource.providerId,
              resource.boxId ?? "",
            ],
          )
        ).rows[0];
        if (
          owner &&
          (owner.provider_id === resource.providerId || !owner.provider_id)
        )
          continue;
        await this.bounded(provider.terminate(resource.providerId));
        orphans.push(resource.providerId);
      }
    }
    return orphans;
  }
}
