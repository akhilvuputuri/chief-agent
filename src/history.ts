import type { Database } from "./db.js";
import type { Message } from "./model.js";
import { boundHistory } from "./context.js";

// Tool outputs include copies of earlier search results. They remain immutable history,
// but are not original conversational evidence and must never become fresh search hits.
const conversational = `c.payload->>'role' IN ('user','assistant')
  AND jsonb_typeof(c.payload->'content')='string'
  AND length(btrim(c.payload->>'content'))>0
  AND NOT (c.payload ? 'tool_call_id')
  AND NOT (c.payload->>'role'='assistant' AND c.payload->>'content' LIKE '[Saved answer details:%')
  AND NOT EXISTS(SELECT 1 FROM events x WHERE x.user_id=e.user_id AND x.run_id=e.run_id AND x.type='research.child_started')
  AND (NOT EXISTS(SELECT 1 FROM work_turns w WHERE w.user_id=e.user_id AND w.run_id=e.run_id AND w.background)
    OR EXISTS(SELECT 1 FROM events d WHERE d.user_id=e.user_id AND d.run_id=e.run_id AND d.type='conversation.delivery' AND d.data->>'messageId'=e.id::text))`;

type ConversationExcerpt = {
  id: string;
  run_id: string | null;
  role: "user" | "assistant";
  excerpt: string;
  ordinal: number;
};
type SearchRow = ConversationExcerpt & {
  created_at: string | Date;
  task_id: string | null;
  neighborhood: ConversationExcerpt[];
};

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

  /** Commit only this run's new conversation suffix, tolerating another completed run's append. */
  async appendConversation(user: string, run: string, messages: Message[]) {
    await this.appendRunConversation(user, run, messages, false);
  }

  /** Call after a background reply was delivered; internal worker messages stay in the run journal. */
  async appendDelivery(user: string, run: string, reply: string) {
    if (!reply.trim()) return;
    await this.appendRunConversation(
      user,
      run,
      [{ role: "assistant", content: reply }],
      true,
    );
  }

  private async appendRunConversation(
    user: string,
    run: string,
    messages: Message[],
    delivery: boolean,
  ) {
    if (!messages.length) return;
    await this.db.query(
      "INSERT INTO conversations(user_id,history,runtime_version) VALUES($1,'[]',1) ON CONFLICT DO NOTHING",
      [user],
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      const expected = await this.count(user);
      // Equality is checked in PostgreSQL JSONB, so object-key ordering cannot make
      // an exact retry look different. Partial or changed suffixes are never suppressed.
      const result = await this.db.query(
        `WITH owner_run AS (
        SELECT id,task_id FROM runtime_runs WHERE user_id=$1 AND id=$2
      ), prior AS (
        SELECT count(*)::int AS count,coalesce(jsonb_agg(c.payload ORDER BY e.ordinal),'[]'::jsonb)=$4::jsonb AS identical
        FROM conversation_messages e JOIN message_contents c USING(user_id,hash)
        WHERE e.user_id=$1 AND e.run_id=$2
      ), guard AS (
        UPDATE conversations SET message_count=message_count+jsonb_array_length($4::jsonb),updated_at=now()
        WHERE user_id=$1 AND message_count=$3 AND EXISTS(SELECT 1 FROM owner_run)
          AND (SELECT count FROM prior)=0 RETURNING user_id
      ), input AS (
        SELECT m AS payload,n::int-1+$3 AS ordinal,encode(sha256(convert_to(m::text,'UTF8')),'hex') AS hash
        FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY a(m,n)
      ), content AS (
        INSERT INTO message_contents(user_id,hash,payload,characters)
        SELECT DISTINCT $1,i.hash,i.payload,length(i.payload::text) FROM input i WHERE EXISTS(SELECT 1 FROM guard)
        ON CONFLICT DO NOTHING RETURNING hash
      ), refs AS (
        INSERT INTO conversation_messages(user_id,ordinal,hash,run_id)
        SELECT $1,i.ordinal,i.hash,$2::uuid FROM input i WHERE EXISTS(SELECT 1 FROM guard)
        RETURNING id
      ), delivered AS (
        INSERT INTO events(user_id,run_id,type,data)
        SELECT $1,$2,'conversation.delivery',jsonb_build_object('messageId',refs.id,'taskId',owner_run.task_id)
        FROM refs CROSS JOIN owner_run WHERE $5::boolean RETURNING id
      ) SELECT (SELECT count(*)::int FROM refs) AS saved,prior.count AS existing,prior.identical,
        EXISTS(SELECT 1 FROM owner_run) AS owned FROM prior`,
        [user, run, expected, JSON.stringify(messages), delivery],
      );
      const row = result.rows[0];
      if (!row?.owned) throw new Error("Conversation run not found");
      if (row.saved === messages.length) return;
      if (row.existing) {
        if (row.identical) return;
        throw new Error("Conversation run already has a different suffix");
      }
    }
    throw new Error(
      "History changed concurrently; retry the conversation commit",
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
    const rows = (
      await this.db.query(
        `WITH eligible AS NOT MATERIALIZED (
        SELECT e.id,e.ordinal,e.run_id,e.created_at,r.task_id,c.payload->>'role' AS role,
          left(c.payload->>'content',400) AS excerpt,c.search
        FROM conversation_messages e JOIN message_contents c USING(user_id,hash)
        LEFT JOIN runtime_runs r ON r.user_id=e.user_id AND r.id=e.run_id
        WHERE e.user_id=$1 AND ${conversational}
      ), matches AS (
        SELECT *,ts_rank(search,plainto_tsquery('english',$2)) AS rank
        FROM eligible WHERE search @@ plainto_tsquery('english',$2)
        ORDER BY rank DESC,ordinal DESC LIMIT 10
      ) SELECT m.id,m.run_id,m.created_at,m.task_id,m.role,m.excerpt,m.ordinal,
        coalesce((SELECT jsonb_agg(jsonb_build_object('id',n.id,'run_id',n.run_id,'role',n.role,
          'excerpt',left(n.excerpt,240),'ordinal',n.ordinal) ORDER BY abs(n.ordinal-m.ordinal),n.ordinal)
          FROM ((SELECT id,run_id,role,excerpt,ordinal FROM eligible WHERE ordinal<m.ordinal ORDER BY ordinal DESC LIMIT 2)
            UNION ALL (SELECT id,run_id,role,excerpt,ordinal FROM eligible WHERE ordinal>m.ordinal ORDER BY ordinal LIMIT 2)) n),'[]'::jsonb) AS neighborhood
      FROM matches m ORDER BY m.rank DESC,m.ordinal DESC`,
        [user, query],
      )
    ).rows as SearchRow[];
    // Keep structured results below the generic observation projection's 12k limit.
    // Nearby original messages get room before more distant neighbors; never cut JSON.
    const results = rows.map(({ neighborhood, ...row }) => ({
      ...row,
      neighborhood: [] as ConversationExcerpt[],
      neighborhoodTruncated: neighborhood.length > 0,
    }));
    for (let index = 0; index < 4; index++) {
      for (let hit = 0; hit < rows.length; hit++) {
        const neighbor = rows[hit]!.neighborhood[index];
        if (!neighbor) continue;
        results[hit]!.neighborhood.push(neighbor);
        // Leave room for the final truncation flags (false is one byte longer).
        if (JSON.stringify(results).length > 10900)
          results[hit]!.neighborhood.pop();
      }
    }
    for (let hit = 0; hit < rows.length; hit++) {
      results[hit]!.neighborhood.sort((a, b) => a.ordinal - b.ordinal);
      results[hit]!.neighborhoodTruncated =
        results[hit]!.neighborhood.length < rows[hit]!.neighborhood.length;
    }
    return results;
  }

  async read(user: string, id: string, offset: number) {
    const row = (
      await this.db.query(
        `SELECT e.run_id,e.created_at,e.ordinal,r.task_id,c.payload->>'role' AS role,
        substring(c.payload::text FROM $3::int+1 FOR 8000) AS content,length(c.payload::text) AS total,
        EXISTS(SELECT 1 FROM events d WHERE d.user_id=e.user_id AND d.run_id=e.run_id AND d.type='conversation.delivery' AND d.data->>'messageId'=e.id::text) AS delivered
      FROM conversation_messages e JOIN message_contents c USING(user_id,hash)
      LEFT JOIN runtime_runs r ON r.user_id=e.user_id AND r.id=e.run_id
      WHERE e.user_id=$1 AND e.id=$2`,
        [user, id, offset],
      )
    ).rows[0];
    if (!row) throw new Error("Conversation message not found");
    return {
      id,
      runId: row.run_id,
      taskId: row.task_id,
      role: row.role,
      ordinal: row.ordinal,
      source: row.delivered ? "background_delivery" : "conversation",
      createdAt: row.created_at,
      content: row.content,
      offset,
      nextOffset: offset + 8000 < row.total ? offset + 8000 : null,
      totalCharacters: row.total,
    };
  }
}
