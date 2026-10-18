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
  /** Longest wait of one `next` long-poll; below the server request timeout. */
  pollMs: number;
  /** Interval between orphan sweeps. */
  sweepMs: number;
  /** A stop that has not completed by then is escalated to termination. */
  stopTimeoutMs: number;
}

const defaults: BoxTimings = {
  launchTimeoutMs: 5 * 60_000,
  bootTimeoutMs: 10 * 60_000,
  lostAfterMs: 3 * 60_000,
  hostGraceMs: 5 * 60_000,
  pollMs: 8_000,
  sweepMs: 5 * 60_000,
  stopTimeoutMs: 10 * 60_000,
};

const active = [
  "launching",
  "booting",
  "ready",
  "busy",
  "stopping",
  "starting",
] as const;
const MAX_RETIRED = 8;

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
    /** Confirms an owner input ID exists for this owner, binding steering to the owner. */
    private ownerInput: (
      user: string,
      inputId: string,
    ) => Promise<boolean> = async () => false,
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

  private async load(id: string): Promise<Box | undefined> {
    return (await this.db.query("SELECT * FROM boxes WHERE id=$1", [id]))
      .rows[0] as Box | undefined;
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

  private async notice(boxId: string, key: string, payload: object) {
    await this.db.query(
      "INSERT INTO box_notices(box_id,notice_key,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING",
      [boxId, key, JSON.stringify(payload)],
    );
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

  /** Queues a task for a box; a stopped box is started by the reconciler. */
  async delegate(
    user: string,
    boxId: string,
    a: { requestKey: string; kind: string; payload: Record<string, unknown> },
  ) {
    const box = await this.owned(user, boxId);
    if (["terminating", "terminated", "held"].includes(box.state))
      throw new ToolValidationError(
        `This box is ${box.state}; start a new box for more work`,
      );
    const taskId = randomUUID();
    const created = await this.db.query(
      "INSERT INTO box_tasks(id,box_id,request_key,kind,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(box_id,request_key) DO NOTHING RETURNING id",
      [taskId, box.id, a.requestKey, a.kind, JSON.stringify(a.payload)],
    );
    const task = created.rows.length
      ? taskId
      : (
          await this.db.query(
            "SELECT id FROM box_tasks WHERE box_id=$1 AND request_key=$2",
            [box.id, a.requestKey],
          )
        ).rows[0].id;
    await this.message(box.id, `task:${task}`, "task.assign", {
      taskId: task,
      kind: a.kind,
      payload: a.payload,
    });
    return { taskId: task };
  }

  /**
   * Relays an owner's answer or clarification into a running task. Steering is bound to an
   * owner input; it never changes approved scope, and Chief cannot steer on its own.
   */
  async send(
    user: string,
    boxId: string,
    a: {
      requestKey: string;
      taskId: string;
      text: string;
      ownerInputId: string;
    },
  ) {
    const box = await this.owned(user, boxId);
    if (!(await this.ownerInput(user, a.ownerInputId)))
      throw new ToolValidationError(
        "Steering a box needs the owner's own message",
      );
    const task = (
      await this.db.query(
        "SELECT state FROM box_tasks WHERE id=$1 AND box_id=$2",
        [a.taskId, box.id],
      )
    ).rows[0];
    if (!task || !["queued", "running"].includes(task.state))
      throw new ToolValidationError("That task is not running");
    await this.message(box.id, `message:${a.requestKey}`, "task.message", {
      taskId: a.taskId,
      text: a.text.slice(0, 8000),
      ownerInputId: a.ownerInputId,
    });
    return { sent: true };
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

  private async message(
    boxId: string,
    requestKey: string,
    kind: string,
    payload: object,
  ) {
    // The sequence counter and the message are written together so ordering has no gaps.
    await transaction(this.db, async (db) => {
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
    });
  }

  // ---- Channel ----------------------------------------------------------------------

  /**
   * Exchanges the bootstrap secret or the stored session credential for the next epoch's
   * credential. Rotation is idempotent per predecessor: a retry returns the same replacement.
   */
  async hello(boxId: string, raw: unknown) {
    const body = helloRequest.parse(raw);
    const presented = hashCredential(body.credential);
    const now = this.clock();
    const result = await transaction(this.db, async (db) => {
      const box = (
        await db.query("SELECT * FROM boxes WHERE id=$1 FOR UPDATE", [boxId])
      ).rows[0] as Box | undefined;
      if (
        !box ||
        // Until the host has recorded the resource, it cannot verify, stop or end it.
        !box.provider_id ||
        ["terminating", "terminated", "held", "requested"].includes(box.state)
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
      if (box.retired_hashes.includes(presented))
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
    const provider = this.providers[result.box.provider];
    if (provider?.verifyIdentity) {
      if (
        !result.box.provider_id ||
        !(await provider.verifyIdentity(result.box.provider_id, body.identity))
      ) {
        await this.terminate(result.box, "Box identity could not be verified");
        throw new BoxCredentialRefused();
      }
    }
    const fresh = (await this.load(boxId))!;
    return {
      protocol: 1,
      credential: result.credential,
      epoch: result.epoch,
      remainingMs: this.remaining(fresh, now),
    };
  }

  /** Authenticates channel calls. A retired credential here means compromise. */
  async authenticate(boxId: string, credential: string): Promise<Box> {
    const presented = hashCredential(credential);
    const box = await this.load(boxId);
    if (!box || ["terminating", "terminated", "held"].includes(box.state))
      throw new BoxCredentialRefused();
    if (sameHash(box.credential_hash, presented)) {
      if (box.previous_hash) {
        // First use of the replacement retires the predecessor.
        await this.db.query(
          "UPDATE boxes SET previous_hash=NULL,retired_hashes=$2 WHERE id=$1 AND credential_hash=$3",
          [
            box.id,
            [box.previous_hash, ...box.retired_hashes].slice(0, MAX_RETIRED),
            presented,
          ],
        );
      }
      return box;
    }
    if (box.retired_hashes.includes(presented)) {
      await this.compromised(box, "A retired box credential was used");
    }
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

  /** Ordered, deduplicated box events; side effects apply once per event. */
  async events(boxId: string, credential: string, raw: unknown) {
    const box = await this.authenticate(boxId, credential);
    const batch = eventBatch.parse(raw);
    if (batch.epoch > box.epoch) throw new ToolValidationError("Unknown epoch");
    const now = this.clock();
    let applied = 0;
    for (const event of batch.events) {
      const taskId = "taskId" in event ? event.taskId : null;
      if (taskId) {
        const owns = (
          await this.db.query(
            "SELECT 1 FROM box_tasks WHERE id=$1 AND box_id=$2",
            [taskId, box.id],
          )
        ).rows.length;
        if (!owns)
          throw new ToolValidationError("Event names another box's task");
      }
      const inserted = await this.db.query(
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
              : { state: (event as any).state },
          ),
        ],
      );
      if (!inserted.rows.length) continue;
      applied++;
      await this.apply(box, event, now);
    }
    await this.db.query("UPDATE boxes SET seen_at=$2 WHERE id=$1", [
      box.id,
      now,
    ]);
    return { applied };
  }

  private async apply(box: Box, event: BoxEvent, now: Date) {
    switch (event.kind) {
      case "box.state":
        await this.db.query(
          `UPDATE boxes SET state=$2,idle_since=CASE WHEN $2::text='ready' THEN COALESCE(idle_since,$3::timestamptz) ELSE NULL END,updated_at=$3
           WHERE id=$1 AND state IN ('ready','busy')`,
          [box.id, event.state === "idle" ? "ready" : "busy", now],
        );
        return;
      case "task.started":
        await this.db.query(
          "UPDATE box_tasks SET state='running',updated_at=$2 WHERE id=$1 AND state='queued'",
          [event.taskId, now],
        );
        return;
      case "task.result":
      case "task.failed":
        await this.db.query(
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

  private async terminate(box: Box, reason: string) {
    const now = this.clock();
    await this.db.query(
      `UPDATE boxes SET state='terminating',reason=$2,
         running_ms=running_ms+CASE WHEN running_since IS NULL THEN 0 ELSE (EXTRACT(EPOCH FROM ($3::timestamptz-running_since))*1000)::bigint END,
         running_since=NULL,updated_at=$3 WHERE id=$1 AND state NOT IN ('terminating','terminated')`,
      [box.id, reason, now],
    );
    await this.db.query(
      "UPDATE box_tasks SET state='failed',result=$2::jsonb,updated_at=$3 WHERE box_id=$1 AND state IN ('queued','running')",
      [box.id, JSON.stringify({ error: reason }), now],
    );
  }

  /** One reconciler pass: each live box is claimed with a lease and moved one step. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.clock();
      const seen = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const lease = randomUUID();
        const box = (
          await this.db.query(
            `UPDATE boxes SET lease=$1,lease_until=$2 WHERE id=(SELECT id FROM boxes
               WHERE state NOT IN ('terminated','held') AND (lease IS NULL OR lease_until<$3) AND NOT (id = ANY($4::uuid[]))
               ORDER BY updated_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
            [lease, new Date(now.getTime() + 120_000), now, [...seen]],
          )
        ).rows[0] as Box | undefined;
        if (!box) break;
        seen.add(box.id);
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
        await this.sweep();
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

  private async reconcile(box: Box, now: Date) {
    const profile = this.config.profiles[box.profile];
    const provider = this.providers[box.provider];
    if (!profile || !provider) {
      await this.hold(box, "Profile or provider no longer configured");
      return;
    }
    const t = now.getTime();
    const since = (d: Date | null) =>
      d ? t - new Date(d).getTime() : Infinity;
    switch (box.state) {
      case "requested": {
        if ((await this.running(box.profile)) >= profile.concurrency) return;
        const secret = bootstrapSecret();
        // The secret's hash and the launching state are recorded before the provider call,
        // so an uncertain launch is reconciled, never retried.
        if (
          !(await this.set(box, "requested", {
            state: "launching",
            credential_hash: hashCredential(secret),
            epoch: 0,
            previous_hash: null,
            launch_started_at: now,
          }))
        )
          return;
        const providerId = await provider.launch({
          boxId: box.id,
          clientToken: box.id,
          profile: box.profile,
          image: box.image,
          environment: box.environment,
          bootstrap: { origin: this.origin, boxId: box.id, secret },
        });
        await this.set({ ...box }, "launching", {
          provider_id: providerId,
          state: "booting",
          running_since: now,
        });
        return;
      }
      case "launching": {
        const found = box.provider_id ?? (await provider.find(box.id));
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
        const state = await provider.describe(box.provider_id!);
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
        const pending = (
          await this.db.query(
            "SELECT 1 FROM box_messages WHERE box_id=$1 AND acked_at IS NULL LIMIT 1",
            [box.id],
          )
        ).rows.length;
        if (
          box.state === "ready" &&
          !pending &&
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
              await provider.stop(box.provider_id!);
          } else await this.terminate(box, "Idle time-to-live reached");
        }
        return;
      }
      case "stopping": {
        const state = await provider.describe(box.provider_id!);
        if (state === "stopped")
          await this.set(box, "stopping", {
            state: "stopped",
            stopped_at: now,
          });
        else if (state === "terminated" || state === "missing")
          await this.set(box, "stopping", {
            state: "terminated",
            reason: "Ended while stopping",
          });
        else if (since(box.stopped_at) > this.timings.stopTimeoutMs)
          await this.terminate(box, "Stop did not complete");
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
        const waiting = (
          await this.db.query(
            "SELECT 1 FROM box_messages WHERE box_id=$1 AND acked_at IS NULL LIMIT 1",
            [box.id],
          )
        ).rows.length;
        if (!waiting) return;
        if ((await this.running(box.profile)) >= profile.concurrency) return;
        if (
          !(await this.set(box, "stopped", {
            state: "starting",
            running_since: now,
          }))
        )
          return;
        try {
          await provider.start(box.provider_id!);
        } catch {
          // Commonly insufficient capacity in the box's zone: work restarts in a fresh box.
          await this.terminate(
            { ...box, state: "starting" },
            "The stopped box could not be started; start a fresh box",
          );
        }
        return;
      }
      case "terminating": {
        if (!box.provider_id) {
          await this.set(box, "terminating", { state: "terminated" });
          return;
        }
        const state = await provider.describe(box.provider_id);
        if (state === "terminated" || state === "missing")
          await this.set(box, "terminating", { state: "terminated" });
        else await provider.terminate(box.provider_id);
        return;
      }
    }
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

  private async hold(box: Box, reason: string) {
    await this.db.query(
      "UPDATE boxes SET state='held',reason=$2,updated_at=$3 WHERE id=$1",
      [box.id, reason, this.clock()],
    );
    await this.notice(box.id, "held", {
      summary: `Box held for an operator: ${reason}`,
    });
  }

  /**
   * Terminates this environment's resources that no box row owns. Rows that are held, or
   * still launching, own the resources tagged with their ID.
   */
  async sweep() {
    const orphans: string[] = [];
    const kinds = new Set(
      Object.values(this.config.profiles).map((p) => p.provider),
    );
    for (const kind of kinds) {
      const provider = this.providers[kind];
      if (!provider) continue;
      for (const resource of await provider.list()) {
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
        await provider.terminate(resource.providerId);
        orphans.push(resource.providerId);
      }
    }
    return orphans;
  }
}
