import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "../db.js";
import { seal, open } from "../secret-box.js";
import type { CodingJob } from "./controller.js";

const batch = z
  .object({
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    after: z.number().int().min(0).max(10000),
    entries: z.array(z.record(z.unknown())).min(1).max(32),
  })
  .strict();
/** Immutable encrypted session entries; no full transcript in job checkpoints. */
export class PiSessions {
  constructor(
    private db: Database,
    private key: Buffer,
  ) {}
  private context(
    job: CodingJob,
    scope: string,
    index: number,
    attempt: string,
  ) {
    return `pi:${job.user_id}:${job.id}:${attempt}:${scope}:${index}`;
  }
  async append(job: CodingJob, raw: unknown) {
    if (job.settings.runtime !== "pi")
      throw new Error("Pi session storage unavailable");
    const input = batch.parse(raw);
    const prefix = `pi-session:${input.scope}:`;
    const count = (
      await this.db.query(
        "SELECT count(*)::int AS count FROM coding_events WHERE job_id=$1 AND event_key LIKE $2",
        [job.id, prefix + "%"],
      )
    ).rows[0].count;
    const used = Number(
      (
        await this.db.query(
          "SELECT COALESCE(sum((payload->>'bytes')::bigint),0)::bigint AS bytes FROM coding_events WHERE job_id=$1 AND payload->>'kind'='pi_session'",
          [job.id],
        )
      ).rows[0].bytes,
    );
    let newlyStored = 0;
    if (input.after > count || input.after + input.entries.length > 10000)
      throw new Error("Session append has a gap or exceeds the bound");
    for (const [offset, entry] of input.entries.entries()) {
      const index = input.after + offset;
      const body = JSON.stringify(entry);
      if (Buffer.byteLength(body) > 512000)
        throw new Error("Session entry exceeds supported size");
      const hash = createHash("sha256").update(body).digest("hex");
      if (
        index >= count &&
        used + newlyStored + Buffer.byteLength(body) > 64_000_000
      )
        throw new Error(
          "Private session storage allowance exhausted; inspect retained state",
        );
      const payload = {
        kind: "pi_session",
        index,
        hash,
        bytes: Buffer.byteLength(body),
        attempt: job.attempt_id,
        box: seal(
          this.key,
          body,
          this.context(job, input.scope, index, job.attempt_id!),
        ),
      };
      const inserted = await this.db.query(
        "INSERT INTO coding_events(job_id,event_key,payload,delivery) SELECT id,$3,$4::jsonb,'suppressed' FROM coding_jobs WHERE id=$1 AND attempt_id=$2 AND state IN ('provisioning','running') ON CONFLICT(job_id,event_key) DO NOTHING RETURNING id",
        [job.id, job.attempt_id, prefix + index, JSON.stringify(payload)],
      );
      if (inserted.rows.length) newlyStored += Buffer.byteLength(body);
      if (!inserted.rows.length) {
        const saved = (
          await this.db.query(
            "SELECT payload->>'hash' AS hash FROM coding_events WHERE job_id=$1 AND event_key=$2",
            [job.id, prefix + index],
          )
        ).rows[0];
        if (saved?.hash !== hash)
          throw new Error("Session prefix conflict or superseded worker");
      }
    }
    return { accepted: true, after: input.after + input.entries.length };
  }
  async read(job: CodingJob, scope: string, offset: number) {
    if (
      job.settings.runtime !== "pi" ||
      !/^[a-f0-9]{64}$/.test(scope) ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error("Invalid session read");
    const rows = (
      await this.db.query(
        "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key LIKE $2 AND (payload->>'index')::int >= $3 ORDER BY (payload->>'index')::int LIMIT 16",
        [job.id, `pi-session:${scope}:%`, offset],
      )
    ).rows;
    let bytes = 0;
    const entries: Record<string, unknown>[] = [];
    for (const { payload } of rows) {
      if (payload.index !== offset + entries.length)
        throw new Error("Session has an incomplete prefix");
      const text = open(
        this.key,
        payload.box,
        this.context(job, scope, payload.index, payload.attempt),
      );
      if (bytes + Buffer.byteLength(text) > 640000 && entries.length) break;
      bytes += Buffer.byteLength(text);
      entries.push(JSON.parse(text));
    }
    return { entries, next: entries.length ? offset + entries.length : null };
  }
}
