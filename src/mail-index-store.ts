// The gmail_recall index in Postgres (migrations 033 and 035, docs/mail-recall.md). Headers,
// Gmail's snippet and embedding vectors only: no email body text is stored. Search is an exact
// cosine query with pgvector.
import type { Database } from "./db.js";
import { transaction } from "./db-transaction.js";

/** What the stored vectors depend on; a different value means the index is rebuilt. */
export type IndexConfig = {
  model: string;
  dimensions: number;
  windowDays: number;
};

export type StoredHeaders = {
  messageId: string;
  threadId: string;
  at: number;
  from: string;
  subject: string;
  date: string;
  snippet: string;
};

export type StoredMessage = StoredHeaders & { vectors: Float32Array[] };

/** pgvector's text form. A float32 survives it exactly, because JavaScript prints enough digits. */
export const literal = (vector: Float32Array) =>
  `[${Array.from(vector).join(",")}]`;

const FILL_BATCH = 500;

/** Postgres text cannot hold NUL, and email senders control these fields. */
const storable = (text: string) => text.replaceAll("\u0000", "");

/** A Postgres data exception: this row will fail again however often it is retried. */
export const isDataError = (error: unknown) =>
  String((error as { code?: unknown })?.code ?? "").startsWith("22");

const headers = (m: Record<string, any>): StoredHeaders => ({
  messageId: m.message_id,
  threadId: m.thread_id,
  at: new Date(m.received_at).getTime(),
  from: m.sender,
  subject: m.subject,
  date: m.date_header,
  snippet: m.snippet,
});

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
   * The owner's indexed message IDs, or null when there is no index. An index stored under a
   * different configuration is deleted first, so the caller builds a fresh one.
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
    await this.fill(user, config.dimensions);
    return (
      await this.db.query(
        `SELECT m.message_id FROM mail_index_messages m WHERE m.user_id=$1 AND EXISTS(
           SELECT 1 FROM mail_index_chunks c WHERE c.user_id=m.user_id AND c.message_id=m.message_id)`,
        [user],
      )
    ).rows.map((m): string => m.message_id);
  }

  /**
   * Copies bytea vectors into the pgvector column. It covers the rows from before migration 035,
   * and any the previous gateway wrote after a rollback. Nothing is embedded again.
   */
  private async fill(user: string, dimensions: number) {
    for (;;) {
      const rows = (
        await this.db.query(
          `SELECT message_id,chunk,vector FROM mail_index_chunks
           WHERE user_id=$1 AND embedding IS NULL LIMIT ${FILL_BATCH}`,
          [user],
        )
      ).rows;
      if (!rows.length) return;
      await transaction(this.db, async (client) => {
        for (const row of rows)
          await client.query(
            "UPDATE mail_index_chunks SET embedding=$4::vector WHERE user_id=$1 AND message_id=$2 AND chunk=$3",
            [
              user,
              row.message_id,
              row.chunk,
              literal(decodeVector(row.vector, dimensions)),
            ],
          );
      });
    }
  }

  /**
   * Every message received since `since`, closest first, scored by its best chunk. Exact search:
   * it reads every vector, so nothing is missed, and it needs no index at this size.
   */
  async search(user: string, vector: Float32Array, since: number) {
    return (
      await this.db.query(
        `SELECT c.message_id,1-min(c.embedding <=> $2::vector) AS score
         FROM mail_index_chunks c JOIN mail_index_messages m USING(user_id,message_id)
         WHERE c.user_id=$1 AND c.embedding IS NOT NULL
         AND m.received_at >= to_timestamp($3::double precision/1000)
         GROUP BY c.message_id ORDER BY score DESC,c.message_id COLLATE "C"`,
        [user, literal(vector), since],
      )
    ).rows.map((r) => ({
      messageId: r.message_id as string,
      score: Number(r.score),
    }));
  }

  /** Each chunk's cosine score against a vector, for the operator-run export. */
  async scoreChunks(user: string, vector: Float32Array) {
    return (
      await this.db.query(
        `SELECT message_id,chunk,1-(embedding <=> $2::vector) AS score FROM mail_index_chunks
         WHERE user_id=$1 AND embedding IS NOT NULL`,
        [user, literal(vector)],
      )
    ).rows.map((r) => ({
      messageId: r.message_id as string,
      chunk: Number(r.chunk),
      score: Number(r.score),
    }));
  }

  /** Headers for the given messages, or for all of them. */
  async headers(user: string, messageIds?: string[]) {
    const rows = (
      await this.db.query(
        `SELECT message_id,thread_id,received_at,sender,subject,date_header,snippet
         FROM mail_index_messages WHERE user_id=$1
         ${messageIds ? "AND message_id = ANY($2::text[])" : ""}`,
        messageIds ? [user, messageIds] : [user],
      )
    ).rows;
    return new Map(rows.map((m) => [m.message_id as string, headers(m)]));
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
            storable(m.from),
            storable(m.subject),
            storable(m.date),
            storable(m.snippet),
          ],
        );
        await client.query(
          "DELETE FROM mail_index_chunks WHERE user_id=$1 AND message_id=$2",
          [user, m.messageId],
        );
        for (const [chunk, vector] of m.vectors.entries())
          await client.query(
            `INSERT INTO mail_index_chunks(user_id,message_id,chunk,vector,embedding)
             VALUES($1,$2,$3,$4,$5::vector)`,
            [user, m.messageId, chunk, encodeVector(vector), literal(vector)],
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

  /** Deletes messages received before `cutoff` and returns their IDs; their vectors cascade. */
  async prune(user: string, cutoff: number) {
    return (
      await this.db.query(
        `DELETE FROM mail_index_messages WHERE user_id=$1
         AND received_at < to_timestamp($2::double precision/1000) RETURNING message_id`,
        [user, cutoff],
      )
    ).rows.map((r): string => r.message_id);
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
