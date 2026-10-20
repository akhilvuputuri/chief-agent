import type { Database } from "./db.js";
import { runFamily } from "./run-family.js";

export interface OutgoingMedia {
  kind: "photo" | "animation";
  bytes: Buffer;
  filename: string;
  /** Plain text, at most 1024 characters (Telegram's caption limit). */
  caption: string;
}

/** Pictures older than this are dropped unsent; the owner can ask again. */
const TTL_MS = 15 * 60_000;
const PER_RUN = 3;
const RUNS = 10;
type Queued = OutgoingMedia & { seq: number };

/**
 * Pictures a tool made during a run, held in memory until the reply for that
 * run is sent. Tools only queue them; the Telegram client sends them after the
 * text reply, under the same delivery guard. Nothing is persisted, so a restart
 * or a background run that never replies simply drops them.
 */
export class MediaOutbox {
  private readonly runs = new Map<string, { at: number; media: Queued[] }>();
  private seq = 0;
  constructor(private readonly now: () => number = Date.now) {}
  put(run: string, media: OutgoingMedia) {
    this.prune();
    const entry = this.runs.get(run) ?? { at: this.now(), media: [] };
    entry.media.push({
      ...media,
      caption: media.caption.slice(0, 1024),
      seq: this.seq++,
    });
    if (entry.media.length > PER_RUN) entry.media.shift();
    this.runs.delete(run);
    this.runs.set(run, entry);
    while (this.runs.size > RUNS)
      this.runs.delete(this.runs.keys().next().value!);
  }
  /** Removes and returns the pictures queued under these runs, in the order they were queued. */
  take(runs: string[]): OutgoingMedia[] {
    this.prune();
    return runs
      .flatMap((run) => {
        const entry = this.runs.get(run);
        this.runs.delete(run);
        return entry?.media ?? [];
      })
      .sort((a, b) => a.seq - b.seq)
      .map(({ seq: _seq, ...media }) => media);
  }
  /** Pictures from this run and the agent runs it started, such as Merlion's. */
  async takeForRun(db: Database, user: string, run: string) {
    if (!this.runs.size) return [];
    const family = await db.query(
      `SELECT id::text AS id FROM ${runFamily()} AS family(id)`,
      [user, run],
    );
    return this.take(family.rows.map((row) => String(row.id)));
  }
  private prune() {
    const cutoff = this.now() - TTL_MS;
    for (const [run, entry] of this.runs)
      if (entry.at < cutoff) this.runs.delete(run);
  }
}
