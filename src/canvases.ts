import { createHash, randomUUID } from "node:crypto";
import { event, type Database } from "./db.js";
import {
  canvasCreate,
  canvasUpdate,
  canvasDocument,
  type CanvasWrite,
} from "./canvas-schema.js";
export class Canvases {
  constructor(private db: Database) {}
  async list(user: string, offset = 0) {
    const rows = (
      await this.db.query(
        "SELECT id,title,latest_revision,updated_at FROM canvases WHERE user_id=$1 ORDER BY updated_at DESC,id LIMIT 21 OFFSET $2",
        [user, offset],
      )
    ).rows;
    return {
      items: rows.slice(0, 20),
      nextOffset: rows.length > 20 ? offset + 20 : null,
    };
  }
  async read(user: string, id: string, revision?: number) {
    const row = (
      await this.db.query(
        `SELECT c.id,c.latest_revision,r.revision,r.document,r.run_id,r.created_at FROM canvases c JOIN canvas_revisions r ON r.canvas_id=c.id AND r.user_id=c.user_id AND r.revision=COALESCE($3,c.latest_revision) WHERE c.id=$1 AND c.user_id=$2`,
        [id, user, revision ?? null],
      )
    ).rows[0];
    if (!row) throw new Error("Canvas not found");
    return row;
  }
  async history(user: string, id: string, offset = 0) {
    const rows = (
      await this.db.query(
        "SELECT revision,document->>'title' AS title,created_at,run_id FROM canvas_revisions WHERE canvas_id=$1 AND user_id=$2 ORDER BY revision DESC LIMIT 21 OFFSET $3",
        [id, user, offset],
      )
    ).rows;
    return {
      items: rows.slice(0, 20),
      nextOffset: rows.length > 20 ? offset + 20 : null,
    };
  }
  private async replay(user: string, key: string, hash: string) {
    const row = (
      await this.db.query(
        "SELECT canvas_id AS id,revision,request_hash FROM canvas_revisions WHERE user_id=$1 AND request_key=$2",
        [user, key],
      )
    ).rows[0];
    if (!row) return null;
    if (row.request_hash !== hash)
      throw new Error(
        "Canvas validation: requestKey was already used for different content; inspect the previous result before making a new change",
      );
    return { id: row.id, revision: row.revision, replayed: true };
  }
  async write(user: string, run: string, input: CanvasWrite) {
    const a =
      input.operation === "canvas_create"
        ? canvasCreate.parse(input)
        : canvasUpdate.parse(input);
    const hash = createHash("sha256").update(JSON.stringify(a)).digest("hex");
    const replay = await this.replay(user, a.requestKey, hash);
    if (replay) return replay;
    for (const source of a.document.sources)
      if (source.sourceId) {
        const row = (
          await this.db.query(
            "SELECT url FROM research_sources WHERE id=$1 AND user_id=$2",
            [source.sourceId, user],
          )
        ).rows[0];
        if (!row || row.url !== source.url)
          throw new Error(
            "Canvas validation: source ID and URL must match an owned saved source",
          );
      }
    const id = a.operation === "canvas_create" ? randomUUID() : a.id;
    const params = [
      id,
      user,
      a.document.title,
      JSON.stringify(a.document),
      run,
      a.requestKey,
      hash,
    ];
    try {
      const changed =
        a.operation === "canvas_create"
          ? `INSERT INTO canvases(id,user_id,title,latest_revision) VALUES($1,$2,$3,1) RETURNING id,latest_revision`
          : `UPDATE canvases SET title=$3,latest_revision=latest_revision+1,updated_at=now() WHERE id=$1 AND user_id=$2 AND latest_revision=$8 RETURNING id,latest_revision`;
      const result = (
        await this.db.query(
          `WITH changed AS (${changed}), saved AS (
        INSERT INTO canvas_revisions(canvas_id,user_id,revision,document,run_id,request_key,request_hash)
        SELECT id,$2,latest_revision,$4::jsonb,$5,$6,$7 FROM changed RETURNING canvas_id AS id,revision
      ), traced AS (
        INSERT INTO events(user_id,run_id,type,data) SELECT $2,$5,'canvas.revised',jsonb_build_object('canvasId',id,'revision',revision,'baseRevision',revision-1) FROM saved
      ) SELECT id,revision FROM saved`,
          a.operation === "canvas_create"
            ? params
            : [...params, a.baseRevision],
        )
      ).rows[0];
      if (result) return { ...result, replayed: false };
    } catch (error) {
      // A racing retry may lose the unique request-key insertion. The whole SQL statement rolls back.
      if ((error as { code?: string }).code !== "23505") throw error;
      const raced = await this.replay(user, a.requestKey, hash);
      if (raced) return raced;
      throw error;
    }
    const raced = await this.replay(user, a.requestKey, hash);
    if (raced) return raced;
    // Do not disclose another owner's current revision.
    const current = await this.read(user, id);
    await event(this.db, user, run, "canvas.conflict", {
      canvasId: id,
      baseRevision: a.operation === "canvas_update" ? a.baseRevision : 0,
      currentRevision: current.latest_revision,
    });
    throw new Error(
      `Canvas validation: revision conflict; current revision is ${current.latest_revision}. Read it and reconcile before retrying with a fresh requestKey.`,
    );
  }
  async toolRead(
    user: string,
    run: string,
    id: string,
    revision: number | undefined,
    offset: number,
  ) {
    const row = await this.read(user, id, revision);
    const text = JSON.stringify(canvasDocument.parse(row.document));
    await event(this.db, user, run, "canvas.read", {
      canvasId: id,
      revision: row.revision,
      offset,
      originRunId: row.run_id,
    });
    return {
      id,
      revision: row.revision,
      latestRevision: row.latest_revision,
      content: text.slice(offset, offset + 8000),
      nextOffset: offset + 8000 < text.length ? offset + 8000 : null,
      totalCharacters: text.length,
    };
  }
}
