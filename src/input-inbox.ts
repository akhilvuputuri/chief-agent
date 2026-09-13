import type { Database } from "./db.js";
import type { ImageAttachment } from "./protocol.js";

export interface InboxInput {
  id: string;
  ordinal: number;
  message: string;
  metadata: Record<string, unknown>;
  preparation: "pending" | "ready" | "failed";
  images?: ImageAttachment[];
}

/** Durable text/identity, ephemeral bounded media, and wakeups independent of execution. */
export class InputInbox {
  private images = new Map<string, ImageAttachment[]>();
  private listeners = new Map<string, Set<() => void>>();
  private versions = new Map<string, number>();
  constructor(private db: Database) {}
  version(user: string) {
    return this.versions.get(user) ?? 0;
  }
  wake(user: string) {
    this.versions.set(user, this.version(user) + 1);
    for (const notify of this.listeners.get(user) ?? []) notify();
  }
  async ready(
    user: string,
    id: string,
    message: string,
    images?: ImageAttachment[],
  ) {
    if (images?.length) {
      const retained = [...this.images]
        .filter(([key]) => key !== id)
        .flatMap(([, value]) => value);
      if (
        [...retained, ...images].reduce((sum, image) => sum + image.bytes, 0) >
        64 * 1024 * 1024
      )
        throw new Error(
          "Attachment preparation memory is full; try this attachment again shortly",
        );
      this.images.set(id, images);
    }
    const result = await this.db.query(
      "UPDATE conversation_inputs SET message=$3,preparation='ready' WHERE user_id=$1 AND id=$2 AND state='queued' RETURNING id",
      [user, id, message],
    );
    if (!result.rows.length) this.images.delete(id);
    this.wake(user);
  }
  async fail(user: string, id: string) {
    await this.db.query(
      "UPDATE conversation_inputs SET state='failed',preparation='failed',finished_at=now() WHERE user_id=$1 AND id=$2 AND state='queued'",
      [user, id],
    );
    this.images.delete(id);
    this.wake(user);
  }
  release(ids: string[]) {
    for (const id of ids) this.images.delete(id);
  }
  async pending(user: string): Promise<InboxInput[]> {
    const rows = (
      await this.db.query(
        "SELECT id,ordinal,message,metadata,preparation FROM conversation_inputs WHERE user_id=$1 AND state='queued' ORDER BY ordinal LIMIT 100",
        [user],
      )
    ).rows;
    return rows.map((row) => ({
      ...row,
      ordinal: Number(row.ordinal),
      images: this.images.get(row.id),
    }));
  }
  async waitReady(user: string, signal?: AbortSignal): Promise<InboxInput[]> {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      // Register before the read so a readiness transition cannot lose its wakeup.
      let notify!: () => void;
      const changed = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const set = this.listeners.get(user) ?? new Set<() => void>();
      this.listeners.set(user, set);
      set.add(notify);
      signal?.addEventListener("abort", notify, { once: true });
      try {
        const rows = await this.pending(user);
        const pending = rows.findIndex((row) => row.preparation === "pending");
        if (pending !== 0) return pending < 0 ? rows : rows.slice(0, pending);
        await changed;
      } finally {
        set.delete(notify);
        if (!set.size) this.listeners.delete(user);
        signal?.removeEventListener("abort", notify);
      }
    }
  }
}
