import type { Database } from "./db.js";
import type { Message } from "./model.js";
import { boundHistory } from "./context.js";

/** Normalized ordered references, with immutable content shared only within an owner. */
export class HistoryStore {
  constructor(private db: Database) {}

  async append(
    user: string,
    run: string | null,
    expected: number,
    messages: Message[],
    originRun?: string,
  ) {
    if (!messages.length) return;
    const table = run ? "runtime_runs" : "conversations";
    const entries = run ? "run_messages" : "conversation_messages";
    const scope = run ? "user_id=$1 AND id=$2::uuid" : "user_id=$1";
    if (!run)
      await this.db.query(
        "INSERT INTO conversations(user_id,history,runtime_version) VALUES($1,'[]',1) ON CONFLICT DO NOTHING",
        [user],
      );
    // A single statement guards the sequence and commits references, content and count together.
    const result = await this.db.query(
      `WITH guard AS (
      UPDATE ${table} SET message_count=message_count+jsonb_array_length($4::jsonb),updated_at=now()
      WHERE ${scope} AND message_count=$3 RETURNING user_id
    ), input AS (
      SELECT m AS payload, n::int-1+$3 AS ordinal, encode(sha256(convert_to(m::text,'UTF8')),'hex') AS hash
      FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY a(m,n)
    ), content AS (
      INSERT INTO message_contents(user_id,hash,payload,characters)
      SELECT DISTINCT $1,i.hash,i.payload,length(i.payload::text) FROM input i WHERE EXISTS(SELECT 1 FROM guard)
      ON CONFLICT DO NOTHING RETURNING hash
    ), refs AS (
      INSERT INTO ${entries}(user_id,${run ? "run_id," : ""}ordinal,hash${run ? "" : ",run_id"})
      SELECT $1,${run ? "$2::uuid," : ""}i.ordinal,i.hash${run ? "" : ",$2::uuid"} FROM input i WHERE EXISTS(SELECT 1 FROM guard)
      RETURNING ordinal
    ) SELECT count(*)::int AS saved FROM refs`,
      [user, run ?? originRun ?? null, expected, JSON.stringify(messages)],
    );
    if (result.rows[0]?.saved !== messages.length)
      throw new Error(
        "History changed concurrently; reload authoritative state",
      );
  }

  async count(user: string, run?: string) {
    const result = await this.db.query(
      run
        ? "SELECT message_count FROM runtime_runs WHERE user_id=$1 AND id=$2"
        : "SELECT message_count FROM conversations WHERE user_id=$1",
      run ? [user, run] : [user],
    );
    return result.rows[0]?.message_count ?? 0;
  }

  /** Read at most 1000 recent references and 100k characters; the model gets a further context bound. */
  async recent(user: string, run?: string) {
    const count = await this.count(user, run);
    const rows = (
      await this.db.query(
        `WITH recent AS (
      SELECT e.ordinal,e.hash,c.characters,c.payload->>'role' AS role
      FROM ${run ? "run_messages" : "conversation_messages"} e JOIN message_contents c USING(user_id,hash)
      WHERE e.user_id=$1 ${run ? "AND e.run_id=$2" : ""} ORDER BY e.ordinal DESC LIMIT 1000
    ), selected AS (
      SELECT *,sum(characters) OVER(ORDER BY ordinal DESC) AS chars,
      count(*) FILTER(WHERE role='user') OVER(ORDER BY ordinal DESC) AS turns FROM recent
    ) SELECT c.payload FROM selected s JOIN message_contents c ON c.user_id=$1 AND c.hash=s.hash
    WHERE s.chars<=100000 AND s.turns<=20 ORDER BY s.ordinal`,
        run ? [user, run] : [user],
      )
    ).rows;
    const bounded = boundHistory(rows.map((r) => r.payload));
    return {
      messages: bounded.messages,
      omitted: count - bounded.messages.length,
      total: count,
    };
  }

  async search(user: string, query: string) {
    return (
      await this.db.query(
        `SELECT e.id,e.run_id,e.created_at,c.payload->>'role' AS role,
      left(c.payload->>'content',400) AS excerpt
      FROM message_contents c JOIN conversation_messages e USING(user_id,hash)
      WHERE c.user_id=$1 AND c.search @@ plainto_tsquery('english',$2)
      ORDER BY ts_rank(c.search,plainto_tsquery('english',$2)) DESC,e.ordinal DESC LIMIT 10`,
        [user, query],
      )
    ).rows;
  }

  async read(user: string, id: string, offset: number) {
    const row = (
      await this.db.query(
        `SELECT e.run_id,e.created_at,c.payload::text AS content
      FROM conversation_messages e JOIN message_contents c USING(user_id,hash)
      WHERE e.user_id=$1 AND e.id=$2`,
        [user, id],
      )
    ).rows[0];
    if (!row) throw new Error("Conversation message not found");
    return {
      id,
      runId: row.run_id,
      createdAt: row.created_at,
      content: row.content.slice(offset, offset + 8000),
      offset,
      nextOffset: offset + 8000 < row.content.length ? offset + 8000 : null,
      totalCharacters: row.content.length,
    };
  }
}
