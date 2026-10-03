import { atomicMutation, transaction } from "../db-transaction.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../db.js";
import { publicHttps } from "../security.js";
import { ToolValidationError } from "../tool-errors.js";
import type { Collection } from "./controller.js";
import type { GatherAction, GatherTarget } from "./schema.js";
import { decryptBytes, encryptBytes, FileVault } from "./vault.js";
import { BrowserSessionMissing, type BrowserClient } from "./browser-client.js";
const vendorOrigins: Record<string, string[]> = {
  chatgpt: ["https://chatgpt.com"],
  openaiapi: ["https://platform.openai.com"],
  anthropic: [
    "https://platform.claude.com",
    "https://console.anthropic.com",
    "https://claude.ai",
  ],
  claude: ["https://claude.ai", "https://platform.claude.com"],
  digitalocean: ["https://cloud.digitalocean.com"],
};
export function targetOrigins(t: GatherTarget) {
  return t.browserOrigins.length
    ? t.browserOrigins
    : (vendorOrigins[t.label.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? []);
}
const observation = z
  .object({
    sessionId: z.string().uuid(),
    snapshotId: z.string().uuid(),
    origin: z.string().max(300),
    path: z.string().max(2000),
    needsOwner: z.boolean(),
    links: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: z.string().max(160),
            dates: z.array(z.string().max(10)).max(8),
            amounts: z
              .array(
                z.object({
                  currency: z.string().max(3),
                  amount: z.string().max(20),
                }),
              )
              .max(4),
          })
          .strict(),
      )
      .max(60),
    invoiceDates: z.array(z.string().max(10)).max(60),
    notice: z.string().max(400),
  })
  .strict();
const saved = z
  .object({
    storageState: z.string().max(2_000_000),
    origins: z.array(z.string().max(300)).max(30),
  })
  .strict();
const frame = z
  .object({
    data: z.string().max(2_000_000),
    width: z.number().int().min(1).max(1600),
    height: z.number().int().min(1).max(1200),
    origin: z.string().max(300),
    path: z.string().max(2000),
    state: z.enum(["owner", "readonly"]),
  })
  .strict();
export const ownerCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frame") }).strict(),
  z
    .object({
      kind: z.literal("click"),
      x: z.number().min(0).max(1280),
      y: z.number().min(0).max(800),
    })
    .strict(),
  z.object({ kind: z.literal("text"), text: z.string().max(3000) }).strict(),
  z
    .object({
      kind: z.literal("key"),
      key: z.enum([
        "Enter",
        "Tab",
        "Backspace",
        "Escape",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scroll"),
      delta: z.number().min(-1600).max(1600),
    })
    .strict(),
  z.object({ kind: z.literal("back") }).strict(),
  z
    .object({
      kind: z.literal("done"),
      remember: z.boolean().default(false),
      expectedInvoices: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("close") }).strict(),
]);
export class GatheringBrowsers {
  constructor(
    private db: Database,
    private key: Buffer,
    private client: BrowserClient,
    private origin = "",
  ) {}
  private async session(
    user: string,
    id: string,
    c?: Collection,
    t?: GatherTarget,
  ) {
    const row = (
      await this.db.query(
        `SELECT s.*,t.status task_status,c.state collection_state,c.task_id,c.task_revision,c.scope FROM gather_browser_sessions s JOIN gather_collections c ON c.id=s.collection_id AND c.user_id=s.user_id JOIN work_tasks t ON t.id=c.task_id AND t.user_id=c.user_id WHERE s.id=$1 AND s.user_id=$2 AND t.revision=c.task_revision`,
        [id, user],
      )
    ).rows[0];
    if (
      !row ||
      row.state === "closed" ||
      row.task_status === "cancelled" ||
      row.collection_state !== "active" ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      (c && row.collection_id !== c.id) ||
      (t && row.target_key !== t.key)
    )
      throw new ToolValidationError(
        "Browser session is unavailable; reopen it for the active collection",
      );
    return row;
  }
  private profileAad(user: string, origin: string, label: string) {
    return `browser-profile-v1:${user}:${origin}:${label}`;
  }
  async agent(
    user: string,
    c: Collection,
    t: GatherTarget,
    command: Extract<GatherAction, { operation: "gather_browser" }>["command"],
  ) {
    if (command.kind === "open") {
      const url = publicHttps(command.url),
        u = new URL(url);
      if (
        [...u.searchParams.keys()].some((k) =>
          /token|auth|key|code|signature|secret/i.test(k),
        )
      )
        throw new ToolValidationError(
          "Open a public billing entry page; signed invoice links must come from an observed page",
        );
      const origins = targetOrigins(t);
      if (!origins.includes(u.origin))
        throw new ToolValidationError(
          "This browser origin is not in the target's requested source scope; ask the owner for the portal origin",
        );
      const id = randomUUID(),
        account = t.accountLabel ?? "default";
      try {
        return await transaction(this.db, async (db) => {
          // Hold this owner lock through credential consumption and context creation, so forgetting
          // cannot finish before an in-flight open is registered and can be revoked.
          await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user]);
          const authorized = await db.query(
            "SELECT c.id FROM work_tasks t JOIN gather_collections c ON c.task_id=t.id AND c.user_id=t.user_id WHERE c.id=$1 AND c.user_id=$2 AND c.task_revision=$3 AND t.revision=$3 AND c.state='active' AND t.status IN ('active','queued','running') FOR UPDATE OF t,c",
            [c.id, user, c.task_revision],
          );
          if (!authorized.rows.length)
            throw new ToolValidationError("Browser collection changed");
          const profile = (
            await db.query(
              "SELECT encrypted_state FROM gather_browser_profiles WHERE user_id=$1 AND origin=$2 AND account_label=$3",
              [user, u.origin, account],
            )
          ).rows[0];
          const state = profile
            ? decryptBytes(
                this.key,
                profile.encrypted_state,
                this.profileAad(user, u.origin, account),
              ).toString("utf8")
            : undefined;
          await db.query(
            "INSERT INTO gather_browser_sessions(id,user_id,collection_id,target_key,origin,allowed_origins) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
            [id, user, c.id, t.key, u.origin, JSON.stringify(origins)],
          );
          return observation.parse(
            await this.client.call(user, id, {
              kind: "open",
              url,
              origins,
              storageState: state,
            }),
          );
        });
      } catch (error) {
        await this.client.call(user, id, { kind: "close" }).catch(() => {});
        throw error;
      }
    }
    const row = await this.session(user, command.sessionId, c, t);
    if (command.kind === "handoff") {
      if (row.task_status === "done")
        throw new ToolValidationError("Collection is complete");
      await this.db.query(
        "UPDATE gather_browser_sessions SET state='owner',expires_at=now()+interval '30 minutes',generation=generation+1 WHERE id=$1 AND user_id=$2",
        [row.id, user],
      );
      await this.client.call(user, row.id, { kind: "await_owner" });
      return {
        sessionId: row.id,
        origin: row.origin,
        needsOwner: true,
        view: `${this.origin}/miniapp/?view=gathering&browser=${row.id}`,
        notice:
          "Open the browser view to sign in and navigate to invoice history. Passwords and authentication codes are entered by the owner, never by the agent. Click Done, then /continue the collection's task. No task resumes automatically.",
      };
    }
    if (command.kind === "close") {
      if (row.state === "owner")
        throw new ToolValidationError(
          "Only the owner may close a browser during a handoff",
        );
      await this.db.query(
        "UPDATE gather_browser_sessions SET state='closed',encrypted_state=NULL,generation=generation+1 WHERE id=$1 AND user_id=$2",
        [row.id, user],
      );
      await this.client.call(user, row.id, { kind: "close" });
      return { sessionId: row.id, origin: row.origin, closed: true };
    }
    if (row.state === "owner")
      return {
        sessionId: row.id,
        origin: row.origin,
        needsOwner: true,
        view: `${this.origin}/miniapp/?view=gathering&browser=${row.id}`,
        notice:
          "The owner controls this browser. The agent must wait; it cannot read or act during login.",
      };
    if (command.kind === "observe") {
      try {
        return observation.parse(
          await this.client.call(user, row.id, { kind: "observe" }),
        );
      } catch (error) {
        if (!(error instanceof BrowserSessionMissing)) throw error;
        await this.recover(user, row.id);
        return observation.parse(
          await this.client.call(user, row.id, { kind: "observe" }),
        );
      }
    }
    return observation.parse(
      await this.client.call(user, row.id, {
        kind: "follow",
        snapshotId: command.snapshotId,
        linkId: command.linkId,
      }),
    );
  }
  async download(
    user: string,
    c: Collection,
    t: GatherTarget,
    source: { sessionId: string; snapshotId: string; linkId: string },
  ) {
    const row = await this.session(user, source.sessionId, c, t);
    if (row.state !== "readonly")
      throw new ToolValidationError(
        "The owner controls this browser; wait for login to finish",
      );
    const result = z
      .object({
        name: z.string().max(120),
        data: z.string().max(28_000_000),
        origin: z.string().max(300),
      })
      .strict()
      .parse(
        await this.client.call(user, row.id, {
          kind: "download",
          snapshotId: source.snapshotId,
          linkId: source.linkId,
        }),
      );
    const bytes = Buffer.from(result.data, "base64");
    if (bytes.length > 20 * 1024 * 1024)
      throw new ToolValidationError("Invoice PDF is larger than 20 MB");
    return { name: result.name, data: bytes, origin: result.origin };
  }
  async info(user: string, id: string) {
    const row = await this.session(user, id);
    return {
      id: row.id,
      collectionId: row.collection_id,
      taskId: row.task_id,
      origin: row.origin,
      state: row.state,
      expiresAt: row.expires_at,
      target: row.scope.targets.find(
        (t: GatherTarget) => t.key === row.target_key,
      ),
      notice:
        "Only you enter credentials. The agent is paused while you control the browser. Finish login, open invoice history, click Done, then return to Chief to continue.",
    };
  }
  async connectOwner(user: string, id: string) {
    const row = await this.session(user, id);
    if (row.state !== "owner")
      throw new ToolValidationError("Ask Chief for a browser handoff first");
    try {
      await this.client.call(user, id, { kind: "owner" });
    } catch (error) {
      if (!(error instanceof BrowserSessionMissing)) throw error;
      await this.recover(user, id);
      await this.client.call(user, id, { kind: "owner" });
    }
  }
  async disconnectOwner(user: string, id: string) {
    await this.client.call(user, id, { kind: "await_owner" }).catch(() => {});
  }
  private async storeOwnerFiles(user: string, row: any) {
    const listed = z
      .object({
        files: z
          .array(
            z
              .object({
                id: z.string().uuid(),
                name: z.string().max(120),
                origin: z.string().max(300),
              })
              .strict(),
          )
          .max(5),
      })
      .strict()
      .parse(await this.client.call(user, row.id, { kind: "downloads" }));
    const vault = new FileVault(this.db, this.key),
      target = (row.scope.targets as GatherTarget[]).find(
        (t) => t.key === row.target_key,
      );
    if (!target) throw new Error("Browser file is unavailable");
    const captured: string[] = [];
    for (const item of listed.files) {
      const file = z
        .object({
          name: z.string().max(120),
          data: z.string().max(28_000_000),
          origin: z.string().max(300),
        })
        .strict()
        .parse(
          await this.client.call(user, row.id, {
            kind: "owner_file",
            id: item.id,
          }),
        );
      const f = await vault.prepare(
        user,
        file.name,
        Buffer.from(file.data, "base64"),
        [target.label],
      );
      const artifact = randomUUID(),
        attempt = randomUUID(),
        requestKey = `owner-browser:${row.id}:${item.id}`;
      const result = (
        await atomicMutation(
          this.db,
          `WITH authorized AS (
      SELECT c.id FROM work_tasks t JOIN gather_collections c ON c.task_id=t.id JOIN gather_browser_sessions s ON s.collection_id=c.id AND s.user_id=c.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.state='owner' AND s.generation=$15 AND s.expires_at>now() AND c.state='active' AND c.task_revision=$14 AND t.revision=c.task_revision AND t.status NOT IN ('done','cancelled') FOR UPDATE OF t,c,s
    ), mutation AS (INSERT INTO gather_mutations(collection_id,user_id,request_key,request_hash,result) SELECT $3,$2,$4,$5,'{}'::jsonb FROM authorized ON CONFLICT DO NOTHING RETURNING collection_id),
    file AS (INSERT INTO file_artifacts(id,user_id,sha256,name,mime_type,bytes,encrypted,facts) SELECT $6::uuid,$2,$5,$7,'application/pdf',$8::integer,$9::bytea,$10::jsonb FROM mutation ON CONFLICT(user_id,sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING id),
    attempt AS (INSERT INTO gather_attempts(id,user_id,collection_id,target_key,kind,state,metadata,scope_revision) SELECT $11::uuid,$2,$3,$12,'browser','success',jsonb_build_object('sessionId',$1::text,'origin',$13::text,'ownerDownloaded',true,'artifactId',file.id::text),$14 FROM file RETURNING id),
    asset AS (INSERT INTO gather_assets(collection_id,user_id,artifact_id) SELECT $3,$2,id FROM file ON CONFLICT DO NOTHING),
    candidate AS (INSERT INTO gather_candidates(collection_id,target_key,user_id,artifact_id,attempt_id,facts) SELECT $3,$12,$2,file.id,attempt.id,$10::jsonb FROM file,attempt ON CONFLICT(collection_id,target_key,artifact_id) DO UPDATE SET facts=EXCLUDED.facts,attempt_id=EXCLUDED.attempt_id RETURNING artifact_id)
    SELECT jsonb_build_object('artifactId',(SELECT id FROM file)::text,'ownerDownloaded',true) AS result FROM mutation WHERE EXISTS(SELECT 1 FROM candidate)`,
          [
            row.id,
            user,
            row.collection_id,
            requestKey,
            f.sha256,
            artifact,
            f.name,
            f.bytes,
            f.encrypted,
            JSON.stringify(f.facts),
            attempt,
            row.target_key,
            file.origin,
            row.task_revision,
            row.generation,
          ],
          { collectionId: row.collection_id, user, requestKey },
        )
      ).rows[0]?.result;
      const prior =
        result ??
        (
          await this.db.query(
            "SELECT result FROM gather_mutations WHERE collection_id=$1 AND user_id=$2 AND request_key=$3 AND request_hash=$4",
            [row.collection_id, user, requestKey, f.sha256],
          )
        ).rows[0]?.result;
      if (!prior)
        throw new Error(
          "Browser collection changed; downloaded file could not be committed",
        );
      captured.push(prior.artifactId);
      await this.client.call(user, row.id, { kind: "ack_file", id: item.id });
    }
    return captured;
  }
  async owner(user: string, id: string, input: unknown) {
    const a = ownerCommand.parse(input),
      row = await this.session(user, id);
    if (a.kind === "close") {
      await this.db.query(
        "UPDATE gather_browser_sessions SET state='closed',encrypted_state=NULL,generation=generation+1 WHERE id=$1 AND user_id=$2",
        [id, user],
      );
      await this.client.call(user, id, { kind: "close" });
      return { closed: true };
    }
    if (row.state !== "owner")
      throw new ToolValidationError(
        "This browser is read-only; ask Chief for a login handoff before controlling it",
      );
    if (a.kind === "done") {
      const data = saved.parse(
        await this.client.call(user, id, { kind: "done" }),
      );
      const capturedFiles = await this.storeOwnerFiles(user, row);
      for (const origin of data.origins)
        if (new URL(publicHttps(origin)).origin !== origin)
          throw new Error("Browser state is unavailable");
      const encrypted = encryptBytes(
        this.key,
        Buffer.from(data.storageState),
        `browser-session-v1:${user}:${id}`,
      );
      await transaction(this.db, async (db) => {
        const authorized = await db.query(
          "SELECT s.id FROM work_tasks t JOIN gather_collections c ON c.task_id=t.id AND c.user_id=t.user_id JOIN gather_browser_sessions s ON s.collection_id=c.id AND s.user_id=c.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.state='owner' AND s.generation=$3 AND s.expires_at>now() AND c.state='active' AND c.task_revision=$4 AND t.revision=$4 AND t.status NOT IN ('done','cancelled') FOR UPDATE OF t,c,s",
          [id, user, row.generation, row.task_revision],
        );
        if (!authorized.rows.length)
          throw new ToolValidationError(
            "Browser handoff was cancelled, expired or superseded; login was not saved",
          );
        const changed = await db.query(
          "UPDATE gather_browser_sessions SET encrypted_state=$3,state='readonly',allowed_origins=$4::jsonb,generation=generation+1,expires_at=now()+interval '30 minutes' WHERE id=$1 AND user_id=$2 AND state='owner' AND generation=$5 RETURNING id",
          [id, user, encrypted, JSON.stringify(data.origins), row.generation],
        );
        if (changed.rows.length !== 1)
          throw new ToolValidationError("Browser handoff was revoked");
        if (a.remember) {
          const t = (row.scope.targets as GatherTarget[]).find(
            (t) => t.key === row.target_key,
          );
          if (!t) throw new Error("Browser state is unavailable");
          const label = t.accountLabel ?? "default",
            box = encryptBytes(
              this.key,
              Buffer.from(data.storageState),
              this.profileAad(user, row.origin, label),
            );
          await db.query(
            "INSERT INTO gather_browser_profiles(user_id,origin,account_label,encrypted_state) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,origin,account_label) DO UPDATE SET encrypted_state=EXCLUDED.encrypted_state,updated_at=now()",
            [user, row.origin, label, box],
          );
        }
        if (a.expectedInvoices !== undefined)
          await db.query(
            "INSERT INTO gather_attempts(id,user_id,collection_id,target_key,kind,state,metadata,scope_revision) VALUES($1,$2,$3,$4,'browser','success',$5::jsonb,$6)",
            [
              randomUUID(),
              user,
              row.collection_id,
              row.target_key,
              JSON.stringify({
                sessionId: id,
                ownerConfirmedCount: a.expectedInvoices,
                month: row.scope.targets.find(
                  (t: GatherTarget) => t.key === row.target_key,
                )?.month,
              }),
              row.task_revision,
            ],
          );
      });
      return {
        saved: true,
        capturedFiles,
        collectionId: row.collection_id,
        taskId: row.task_id,
        remembered: a.remember,
        notice:
          "Login is ready. Return to Chief and explicitly continue the task. Saving login did not resume it or add model budget.",
      };
    }
    return frame.parse(await this.client.call(user, id, a));
  }
  async recover(user: string, id: string) {
    const row = await this.session(user, id);
    const t = (row.scope.targets as GatherTarget[]).find(
      (t) => t.key === row.target_key,
    );
    if (!t) throw new Error("Browser state is unavailable");
    const storageState = row.encrypted_state
      ? decryptBytes(
          this.key,
          row.encrypted_state,
          `browser-session-v1:${user}:${id}`,
        ).toString("utf8")
      : undefined;
    await this.client.call(user, id, {
      kind: "restore",
      url: row.origin,
      origins: row.allowed_origins,
      storageState,
      state: row.state,
    });
  }
  async closeTask(user: string, taskId: string) {
    const rows = (
      await this.db.query(
        "SELECT id FROM gather_collections WHERE user_id=$1 AND task_id=$2",
        [user, taskId],
      )
    ).rows;
    for (const row of rows) await this.closeCollection(user, row.id);
  }
  async sweep() {
    const rows = (
      await this.db.query(
        "UPDATE gather_browser_sessions s SET state='closed',encrypted_state=NULL,generation=generation+1 FROM gather_collections c,work_tasks t WHERE s.collection_id=c.id AND c.task_id=t.id AND s.state<>'closed' AND (s.expires_at<=now() OR t.status IN ('cancelled','done') OR t.revision<>c.task_revision OR c.state<>'active') RETURNING s.id,s.user_id",
      )
    ).rows;
    for (const row of rows)
      await this.client
        .call(row.user_id, row.id, { kind: "close" })
        .catch(() => {});
  }
  async forgetProfile(user: string, origin: string, label: string) {
    const revoked: string[] = [];
    await transaction(this.db, async (db) => {
      await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user]);
      // Serialize against Done using the same task/collection/session lock order.
      const sessions = (
        await db.query(
          "SELECT s.id FROM work_tasks t JOIN gather_collections c ON c.task_id=t.id AND c.user_id=t.user_id JOIN gather_browser_sessions s ON s.collection_id=c.id AND s.user_id=c.user_id WHERE s.user_id=$1 AND s.origin=$2 FOR UPDATE OF t,c,s",
          [user, origin],
        )
      ).rows;
      await db.query(
        "DELETE FROM gather_browser_profiles WHERE user_id=$1 AND origin=$2 AND account_label=$3",
        [user, origin, label],
      );
      revoked.push(...sessions.map((row) => row.id));
      for (const row of sessions)
        await db.query(
          "UPDATE gather_browser_sessions SET state='closed',encrypted_state=NULL,generation=generation+1 WHERE id=$1 AND user_id=$2",
          [row.id, user],
        );
    });
    for (const id of revoked)
      await this.client.call(user, id, { kind: "close" }).catch(() => {});
    return { forgotten: true };
  }
  async forget(user: string, id: string) {
    const row = (
      await this.db.query(
        "SELECT s.origin,c.scope,s.target_key FROM gather_browser_sessions s JOIN gather_collections c ON c.id=s.collection_id AND c.user_id=s.user_id WHERE s.id=$1 AND s.user_id=$2",
        [id, user],
      )
    ).rows[0];
    if (!row) throw new ToolValidationError("Browser session is unavailable");
    const target = row.scope.targets.find(
      (t: GatherTarget) => t.key === row.target_key,
    );
    return this.forgetProfile(
      user,
      row.origin,
      target?.accountLabel ?? "default",
    );
  }
  async closeCollection(user: string, id: string) {
    const rows = (
      await this.db.query(
        "UPDATE gather_browser_sessions SET state='closed',encrypted_state=NULL,generation=generation+1 WHERE collection_id=$1 AND user_id=$2 RETURNING id",
        [id, user],
      )
    ).rows;
    for (const row of rows)
      await this.client.call(user, row.id, { kind: "close" }).catch(() => {});
  }
}
