// Postgres persistence for the gmail_recall index (migration 033, docs/mail-recall.md).
// Headers, Gmail's snippet and embedding vectors only: no email body text is stored.
import type { Database } from "./db.js";
import { transaction } from "./db-transaction.js";

/** What the stored vectors depend on; a different value means the index is rebuilt. */
export type IndexConfig = {
  model: string;
  dimensions: number;
  windowDays: number;
};

export type StoredMessage = {
  messageId: string;
  threadId: string;
  at: number;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  vectors: Float32Array[];
};

/** Little-endian float32, independent of the host's byte order. */
export function encodeVector(vector: Float32Array) {
  const buffer = Buffer.alloc(vector.length * 4);
  vector.forEach((value, i) => buffer.writeFloatLE(value, i * 4));
  return buffer;
}

export function decodeVector(bytes: Uint8Array, dimensions: number) {
  if (bytes.length !== dimensions * 4)
    throw new Error("Stored vector has the wrong length");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from({ length: dimensions }, (_, i) =>
    buffer.readFloatLE(i * 4),
  );
}

export class MailIndexStore {
  constructor(private db: Database) {}

  /**
   * The owner's stored index, or null when there is none. An index stored under a different
   * configuration is deleted first, so the caller builds a fresh one.
   */
  async load(user: string, config: IndexConfig) {
    const state = (
      await this.db.query(
        "SELECT model,dimensions,window_days FROM mail_index_state WHERE user_id=$1",
        [user],
      )
    ).rows[0];
    if (!state) return null;
    if (
      state.model !== config.model ||
      Number(state.dimensions) !== config.dimensions ||
      Number(state.window_days) !== config.windowDays
    ) {
      await this.clear(user);
      return null;
    }
    const messages = (
      await this.db.query(
        `SELECT message_id,thread_id,received_at,sender,subject,date_header,snippet
         FROM mail_index_messages WHERE user_id=$1 ORDER BY received_at,message_id`,
        [user],
      )
    ).rows;
    const chunks = (
      await this.db.query(
        "SELECT message_id,vector FROM mail_index_chunks WHERE user_id=$1 ORDER BY message_id,chunk",
        [user],
      )
    ).rows;
    const vectors = new Map<string, Float32Array[]>();
    for (const c of chunks) {
      const list = vectors.get(c.message_id) ?? [];
      list.push(decodeVector(c.vector, config.dimensions));
      vectors.set(c.message_id, list);
    }
    return messages
      .filter((m) => vectors.has(m.message_id))
      .map((m): StoredMessage => ({
        messageId: m.message_id,
        threadId: m.thread_id,
        at: new Date(m.received_at).getTime(),
        from: m.sender,
        subject: m.subject,
        date: m.date_header,
        snippet: m.snippet,
        vectors: vectors.get(m.message_id)!,
      }));
  }

  /** Records the configuration a fresh build uses, before its first save. */
  async begin(user: string, config: IndexConfig) {
    await this.db.query(
      `INSERT INTO mail_index_state(user_id,model,dimensions,window_days) VALUES($1,$2,$3,$4)
       ON CONFLICT(user_id) DO UPDATE SET model=EXCLUDED.model,dimensions=EXCLUDED.dimensions,
       window_days=EXCLUDED.window_days,updated_at=now()`,
      [user, config.model, config.dimensions, config.windowDays],
    );
  }

  /** Saves messages and replaces their vectors in one transaction. */
  async save(user: string, messages: StoredMessage[]) {
    if (!messages.length) return;
    await transaction(this.db, async (client) => {
      for (const m of messages) {
        await client.query(
          `INSERT INTO mail_index_messages(user_id,message_id,thread_id,received_at,sender,subject,date_header,snippet)
           VALUES($1,$2,$3,to_timestamp($4::double precision/1000),$5,$6,$7,$8)
           ON CONFLICT(user_id,message_id) DO UPDATE SET thread_id=EXCLUDED.thread_id,
           received_at=EXCLUDED.received_at,sender=EXCLUDED.sender,subject=EXCLUDED.subject,
           date_header=EXCLUDED.date_header,snippet=EXCLUDED.snippet,indexed_at=now()`,
          [
            user,
            m.messageId,
            m.threadId,
            m.at,
            m.from,
            m.subject,
            m.date,
            m.snippet,
          ],
        );
        await client.query(
          "DELETE FROM mail_index_chunks WHERE user_id=$1 AND message_id=$2",
          [user, m.messageId],
        );
        for (const [chunk, vector] of m.vectors.entries())
          await client.query(
            "INSERT INTO mail_index_chunks(user_id,message_id,chunk,vector) VALUES($1,$2,$3,$4)",
            [user, m.messageId, chunk, encodeVector(vector)],
          );
      }
    });
  }

  async synced(user: string, at: number) {
    await this.db.query(
      "UPDATE mail_index_state SET synced_at=to_timestamp($2::double precision/1000),updated_at=now() WHERE user_id=$1",
      [user, at],
    );
  }

  /** Deletes messages received before `cutoff`; their vectors cascade. */
  async prune(user: string, cutoff: number) {
    await this.db.query(
      "DELETE FROM mail_index_messages WHERE user_id=$1 AND received_at < to_timestamp($2::double precision/1000)",
      [user, cutoff],
    );
  }

  /** Deletes the given messages, for mail that left the mailbox or the indexed category. */
  async remove(user: string, messageIds: string[]) {
    if (!messageIds.length) return;
    await this.db.query(
      "DELETE FROM mail_index_messages WHERE user_id=$1 AND message_id = ANY($2::text[])",
      [user, messageIds],
    );
  }

  async clear(user: string) {
    await transaction(this.db, async (client) => {
      await client.query("DELETE FROM mail_index_messages WHERE user_id=$1", [
        user,
      ]);
      await client.query("DELETE FROM mail_index_state WHERE user_id=$1", [
        user,
      ]);
    });
  }
}
