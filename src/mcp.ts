import type { LinkResolver } from "./link-resolution.js";
import { validateMcpSchema } from "./mcp-validation.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Database } from "./db.js";
import { publicHttps, SerialQueue } from "./security.js";
import { ToolValidationError } from "./tool-errors.js";
import {
  McpFailure,
  sdkTransport,
  type McpTransport,
  type RemoteTool,
  type McpSession,
} from "./mcp-client.js";
import { mcpAction, type McpAction } from "./mcp-schema.js";

const toolGrant = z
  .object({
    name: z.string().min(1).max(128),
    mode: z.enum(["read", "idempotent_write"]),
    idempotencyArgument: z
      .string()
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,99}$/)
      .optional(),
    result: z
      .enum(["generic", "reader_receipt", "reader_status"])
      .default("generic"),
  })
  .strict()
  .refine((g) =>
    g.mode === "read" ? !g.idempotencyArgument : !!g.idempotencyArgument,
  );
const connectionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/),
    url: z.string().url(),
    credential: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/),
    description: z.string().max(1000),
    tools: z.array(toolGrant).min(1).max(30),
  })
  .strict();
export const mcpRegistrySchema = z
  .object({
    version: z.literal(1),
    connections: z.array(connectionSchema).max(20),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (new Set(r.connections.map((c) => c.id)).size !== r.connections.length)
      ctx.addIssue({ code: "custom", message: "Duplicate MCP connection" });
    for (const c of r.connections) {
      try {
        if (new URL(c.url).search || new URL(c.url).hash) throw new Error();
        publicHttps(c.url);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "MCP requires a fixed public HTTPS endpoint",
        });
      }
      if (new Set(c.tools.map((t) => t.name)).size !== c.tools.length)
        ctx.addIssue({ code: "custom", message: "Duplicate MCP tool grant" });
    }
  });
type Connection = z.infer<typeof connectionSchema>;
const credentialSchema = z.record(
  z
    .object({
      owner: z.string().regex(/^\d+$/),
      token: z
        .string()
        .min(16)
        .max(4096)
        .regex(/^[\x21-\x7e]+$/),
    })
    .strict(),
);
export function loadMcpRegistry() {
  return mcpRegistrySchema.parse(
    JSON.parse(
      readFileSync(new URL("../config/mcp.json", import.meta.url), "utf8"),
    ),
  );
}
export function parseMcpCredentials(raw: string) {
  try {
    if (Buffer.byteLength(raw) > 100000) throw new Error();
    return credentialSchema.parse(JSON.parse(raw || "{}"));
  } catch {
    throw new Error(
      "MCP credentials configuration is invalid; values withheld",
    );
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new ToolValidationError("MCP arguments must be JSON");
  return encoded;
}
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const receipt = z.object({
  submission_id: z.string().uuid().nullable(),
  status: z.enum([
    "queued",
    "processing",
    "ready",
    "bookmark",
    "already_saved",
  ]),
  duplicate: z.boolean(),
});
const submission = z.object({
  id: z.string().uuid(),
  status: z.enum(["queued", "processing", "ready", "bookmark"]),
  error: z.string().max(2000).nullable(),
});
function decode(result: unknown, kind: string) {
  if (kind === "generic") return result;
  const r = result as {
    structuredContent?: unknown;
    content?: { type: string; text: string }[];
  };
  const data =
    r.structuredContent ??
    JSON.parse(r.content?.find((b) => b.type === "text")?.text ?? "null");
  if (kind === "reader_receipt") {
    const parsed = receipt.parse(data);
    if (parsed.submission_id === null && parsed.status !== "already_saved")
      throw new Error("Missing submission");
    return {
      submissionId: parsed.submission_id,
      status: parsed.status,
      duplicate: parsed.duplicate,
      phoneOffline: "unverified",
    };
  }
  const parsed = submission.parse(data);
  return {
    submissionId: parsed.id,
    status: parsed.status,
    error: parsed.error,
    phoneOffline: "unverified",
  };
}

/** Remote tools are data. Reviewed grants, authenticated ownership and the host journal are authority. */
export class McpTools {
  private queue = new SerialQueue();
  private registry: z.infer<typeof mcpRegistrySchema>;
  constructor(
    private db: Database,
    registry: unknown,
    private credentials: z.infer<typeof credentialSchema>,
    private transport: McpTransport = sdkTransport(),
    private wait: (ms: number, signal?: AbortSignal) => Promise<unknown> = (
      ms,
      signal,
    ) => delay(ms, undefined, { signal }),
    private links?: LinkResolver,
  ) {
    this.registry = mcpRegistrySchema.parse(registry);
    this.credentials = credentialSchema.parse(credentials);
  }
  get configured() {
    return this.registry.connections.some(
      (c) => !!this.credentials[c.credential],
    );
  }
  private async session<T>(
    user: string,
    c: Connection,
    token: string,
    use: (session: McpSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const { binding } = this.owned(user, c.id);
    const row = (
      await this.db.query(
        "SELECT * FROM mcp_connection_state WHERE user_id=$1 AND connection=$2 AND binding=$3",
        [user, c.id, binding],
      )
    ).rows[0];
    if (row?.category === "auth") throw new McpFailure("auth");
    if (row?.retry_at && new Date(row.retry_at).getTime() > Date.now())
      throw new McpFailure(
        "capacity",
        Math.ceil((new Date(row.retry_at).getTime() - Date.now()) / 1000),
      );
    const remember = async (e: unknown) => {
      if (e instanceof McpFailure && ["auth", "capacity"].includes(e.category))
        await this.db.query(
          "INSERT INTO mcp_connection_state(user_id,connection,binding,category,retry_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,connection) DO UPDATE SET binding=EXCLUDED.binding,category=EXCLUDED.category,retry_at=EXCLUDED.retry_at",
          [
            user,
            c.id,
            binding,
            e.category,
            e.category === "capacity"
              ? new Date(Date.now() + (e.retryAfterSeconds ?? 60) * 1000)
              : null,
          ],
        );
    };
    const track = async <R>(fn: () => Promise<R>) => {
      try {
        return await fn();
      } catch (e) {
        await remember(e);
        throw e;
      }
    };
    try {
      return await this.transport(
        c.url,
        token,
        (s) =>
          use({
            list: () => track(() => s.list()),
            call: (name, args) => track(() => s.call(name, args)),
          }),
        signal,
      );
    } catch (e) {
      await remember(e);
      throw e;
    }
  }
  /** A stopped call with no durable intent cannot have reached tools/call. Never replays. */
  async settleUnsubmitted(user: string) {
    const calls = (
      await this.db.query(
        "SELECT c.id,c.arguments FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE r.user_id=$1 AND r.state='stopped' AND c.operation='mcp_write' AND c.state='uncertain'",
        [user],
      )
    ).rows;
    for (const call of calls) {
      let prior: McpAction;
      try {
        prior = mcpAction.parse({
          ...JSON.parse(call.arguments.raw),
          operation: "mcp_write",
        });
      } catch {
        continue;
      }
      if (
        prior.operation !== "mcp_write" ||
        (await this.stored(user, prior.connection, prior.requestKey))
      )
        continue;
      await this.db.query(
        "UPDATE runtime_calls c SET state='failed',finished_at=now(),result=jsonb_build_object('reconciliation','stopped MCP call without persisted intent; no submission was dispatched') FROM runtime_runs r WHERE c.id=$1 AND c.run_id=r.id AND r.user_id=$2 AND r.state='stopped' AND c.state='uncertain'",
        [call.id, user],
      );
    }
  }
  private owned(user: string, id: string) {
    const c = this.registry.connections.find((c) => c.id === id);
    const secret = c && this.credentials[c.credential];
    if (!c || !secret || secret.owner !== user)
      throw new ToolValidationError(
        "MCP connection is not configured for this owner",
      );
    return {
      c,
      secret,
      binding: hash({ connection: c, token: secret.token, owner: user }),
    };
  }
  private grant(
    c: Connection,
    name: string,
    mode: "read" | "idempotent_write",
  ) {
    const g = c.tools.find((g) => g.name === name && g.mode === mode);
    if (!g)
      throw new ToolValidationError(
        "MCP tool is not granted for this operation",
      );
    return g;
  }
  private discovered(tools: RemoteTool[], name: string) {
    const matches = tools.filter((t) => t.name === name);
    if (
      matches.length !== 1 ||
      Buffer.byteLength(canonical(matches[0]!.inputSchema)) > 32000
    )
      throw new ToolValidationError(
        "MCP tool schema is unavailable or exceeds limits",
      );
    return matches[0]!.inputSchema;
  }
  private safe(result: unknown, token: string) {
    const encoded = JSON.stringify(result);
    if (!encoded || Buffer.byteLength(encoded) > 200000)
      throw new McpFailure("uncertain");
    const replaceSecret = (value: string) =>
      value
        .split(token)
        .join("[REDACTED_CREDENTIAL]")
        .split(JSON.stringify(token).slice(1, -1))
        .join("[REDACTED_CREDENTIAL]");
    const redact = (value: unknown): unknown => {
      if (typeof value === "string") return replaceSecret(value);
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, v]) => [
            replaceSecret(key),
            redact(v),
          ]),
        );
      return value;
    };
    return redact(JSON.parse(encoded));
  }
  private async stored(user: string, connection: string, requestKey: string) {
    return (
      await this.db.query(
        "SELECT * FROM mcp_operations WHERE user_id=$1 AND connection=$2 AND request_key=$3",
        [user, connection, requestKey],
      )
    ).rows[0];
  }
  private checkReplay(
    row: any,
    binding: string,
    a: Extract<McpAction, { operation: "mcp_write" }>,
  ) {
    if (
      row.binding !== binding ||
      row.tool !== a.tool ||
      (row.reader_target ?? "article") !== (a.readerTarget ?? "article") ||
      (a.arguments &&
        canonical(a.arguments) !== canonical(row.source_payload ?? row.payload))
    )
      throw new ToolValidationError(
        "MCP operation is bound to another connection, tool or payload; do not replace its requestKey to retry",
      );
  }
  /** Only an exact replay of this owner's persisted, idempotent operation can reconcile uncertainty. */
  async replayMatches(
    user: string,
    input: unknown,
    uncertain: { operation: string; arguments: any }[],
  ) {
    const a = mcpAction.parse(input);
    if (a.operation !== "mcp_write") return false;
    const { c, binding } = this.owned(user, a.connection);
    this.grant(c, a.tool, "idempotent_write");
    const row = await this.stored(user, a.connection, a.requestKey);
    if (!row) return false;
    this.checkReplay(row, binding, a);
    return uncertain.every((call) => {
      if (call.operation !== "mcp_write") return false;
      try {
        const prior = mcpAction.parse({
          ...JSON.parse(call.arguments.raw),
          operation: "mcp_write",
        });
        if (
          prior.operation !== "mcp_write" ||
          prior.connection !== a.connection ||
          prior.tool !== a.tool ||
          prior.requestKey !== a.requestKey
        )
          return false;
        this.checkReplay(row, binding, prior);
        return true;
      } catch {
        return false;
      }
    });
  }
  async pendingAllows(user: string, input: unknown) {
    const pending = (
      await this.db.query(
        "SELECT connection,request_key FROM mcp_operations WHERE user_id=$1 AND state='pending'",
        [user],
      )
    ).rows;
    if (!pending.length) return true;
    const a = mcpAction.safeParse(input);
    return (
      a.success &&
      a.data.operation === "mcp_write" &&
      pending.every(
        (p) =>
          p.connection === a.data.connection &&
          p.request_key === (a.data as { requestKey: string }).requestKey,
      )
    );
  }
  private async reconcile(
    user: string,
    a: Extract<McpAction, { operation: "mcp_write" }>,
    result: unknown,
  ) {
    // Never settle a still-running call; verify every historical call against the persisted payload.
    const calls = (
      await this.db.query(
        "SELECT c.id,c.operation,c.arguments FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE r.user_id=$1 AND r.state='stopped' AND c.operation='mcp_write' AND c.state='uncertain'",
        [user],
      )
    ).rows;
    for (const call of calls)
      if (await this.replayMatches(user, a, [call]))
        await this.db.query(
          "UPDATE runtime_calls SET state='success',finished_at=now(),result=$2::jsonb WHERE id=$1 AND state='uncertain'",
          [
            call.id,
            JSON.stringify({
              result,
              reconciliation: "exact idempotent MCP operation",
            }),
          ],
        );
  }
  async call(
    user: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const a = mcpAction.parse(input);
    if (signal?.aborted) throw new ToolValidationError("Task cancelled");
    if (a.operation === "mcp_tools") {
      const connections = this.registry.connections.filter(
        (c) =>
          this.credentials[c.credential]?.owner === user &&
          (!a.connection || c.id === a.connection),
      );
      if (a.connection && !connections.length) this.owned(user, a.connection);
      const out = [];
      for (const c of connections) {
        const { secret } = this.owned(user, c.id);
        try {
          out.push(
            this.safe(
              await this.session(
                user,
                c,
                secret.token,
                async (s) => {
                  const discovered = await s.list();
                  return {
                    connection: c.id,
                    description: c.description,
                    tools: c.tools.map((g) => ({
                      qualifiedName: `${c.id}/${g.name}`,
                      name: g.name,
                      mode: g.mode,
                      inputSchema: this.discovered(discovered, g.name),
                      hostSuppliedArgument: g.idempotencyArgument,
                    })),
                    pending: (
                      await this.db.query(
                        "SELECT request_key,tool,state FROM mcp_operations WHERE user_id=$1 AND connection=$2 AND state='pending' ORDER BY updated_at DESC LIMIT 20",
                        [user, c.id],
                      )
                    ).rows,
                  };
                },
                signal,
              ),
              secret.token,
            ),
          );
        } catch (e) {
          out.push({
            connection: c.id,
            error: e instanceof McpFailure ? e.category : "discovery_failed",
          });
        }
      }
      return { connections: out };
    }
    const { c, secret, binding } = this.owned(user, a.connection);
    if (a.operation === "mcp_operation") {
      const row = await this.stored(user, a.connection, a.requestKey);
      if (!row || row.binding !== binding)
        throw new ToolValidationError(
          "MCP operation unavailable for this connection",
        );
      return {
        requestKey: row.request_key,
        tool: row.tool,
        state: row.state,
        result: row.result,
      };
    }
    if (a.operation === "mcp_read") {
      const g = this.grant(c, a.tool, "read");
      return this.session(
        user,
        c,
        secret.token,
        async (s) => {
          await validateMcpSchema(
            this.discovered(await s.list(), a.tool),
            a.arguments,
            signal,
          );
          try {
            const result = decode(
              this.safe(await s.call(a.tool, a.arguments), secret.token),
              g.result,
            );
            if (
              g.result === "reader_status" &&
              (result as { submissionId: string }).submissionId !==
                a.arguments.submission_id
            )
              throw new McpFailure("uncertain");
            return result;
          } catch (e) {
            if (e instanceof McpFailure) throw e;
            throw new McpFailure("uncertain");
          }
        },
        signal,
      );
    }
    const g = this.grant(c, a.tool, "idempotent_write");
    const readerSave = g.result === "reader_receipt" && a.tool === "save_link";
    if (a.readerTarget && !readerSave)
      throw new ToolValidationError(
        "readerTarget is only supported for Reader link saves",
      );
    return this.queue.run(user, async () => {
      let row = await this.stored(user, a.connection, a.requestKey);
      if (row) {
        this.checkReplay(row, binding, a);
        if (row.state === "complete") {
          await this.reconcile(user, a, row.result);
          return {
            requestKey: a.requestKey,
            state: row.state,
            result: row.result,
          };
        }
        if (row.state === "rejected")
          return {
            requestKey: a.requestKey,
            state: row.state,
            result: row.result,
          };
        if (row.result?.category === "auth")
          return {
            requestKey: a.requestKey,
            state: "pending",
            category: "auth",
            note: "Authentication failed. Reconnect and inspect the old operation; no further attempt was made.",
          };
        if (row.result?.retryAt && Date.now() < row.result.retryAt)
          return {
            requestKey: a.requestKey,
            state: "pending",
            category: "capacity",
            retryAfterSeconds: Math.ceil(
              (row.result.retryAt - Date.now()) / 1000,
            ),
          };
      }
      if (!(await this.pendingAllows(user, a)))
        throw new ToolValidationError(
          "A pending MCP write needs reconciliation before another write",
        );
      const sourcePayload = row?.source_payload ?? a.arguments ?? row?.payload;
      let payload = row?.payload ?? a.arguments;
      let resolution = row?.link_resolution;
      if (!payload || Object.hasOwn(payload, g.idempotencyArgument!))
        throw new ToolValidationError(
          "Supply new MCP arguments without the host's idempotency field; omit arguments only for a persisted retry",
        );
      if (canonical(payload).includes(secret.token))
        throw new ToolValidationError(
          "MCP content must not contain the connection credential",
        );
      let dispatched = false;
      try {
        return await this.session(
          user,
          c,
          secret.token,
          async (s) => {
            const schema = this.discovered(await s.list(), a.tool);
            const schemaHash = hash(schema);
            if (row && row.schema_hash !== schemaHash)
              throw new ToolValidationError(
                "MCP schema changed; reconcile the previous operation before retrying",
              );
            if (!row && readerSave && this.links) {
              if (typeof payload.url !== "string")
                throw new ToolValidationError("Reader requires an article URL");
              resolution = await this.links.resolve(
                user,
                payload.url,
                a.readerTarget ?? "article",
                signal,
              );
              const destination =
                resolution.status === "resolved"
                  ? resolution.articleUrl
                  : a.readerTarget === "discussion" &&
                      resolution.status === "discussion"
                    ? resolution.pageUrl
                    : null;
              if (!destination)
                throw new ToolValidationError(
                  "The article link could not be verified. Supply the publisher URL, or explicitly choose the Reddit discussion; no save was submitted.",
                );
              payload = { ...payload, url: destination };
            }
            const args = { ...payload, [g.idempotencyArgument!]: a.requestKey };
            await validateMcpSchema(schema, args, signal);
            if (
              Buffer.byteLength(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/call",
                  params: { name: a.tool, arguments: args },
                }),
              ) > 219000
            )
              throw new ToolValidationError(
                "MCP request exceeds the body limit",
              );
            await this.db.query(
              "INSERT INTO mcp_operations(user_id,connection,request_key,tool,binding,schema_hash,payload,source_payload,reader_target,link_resolution) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb) ON CONFLICT DO NOTHING",
              [
                user,
                c.id,
                a.requestKey,
                a.tool,
                binding,
                schemaHash,
                JSON.stringify(payload),
                JSON.stringify(sourcePayload),
                readerSave ? (a.readerTarget ?? "article") : null,
                resolution ? JSON.stringify(resolution) : null,
              ],
            );
            row = await this.stored(user, c.id, a.requestKey);
            this.checkReplay(row, binding, a);
            if (row.schema_hash !== schemaHash)
              throw new ToolValidationError(
                "MCP schema changed before submission; inspect the persisted operation",
              );
            if (row.state === "complete")
              return {
                requestKey: a.requestKey,
                state: "complete",
                result: row.result,
              };
            const dispatchArgs = {
              ...row.payload,
              [g.idempotencyArgument!]: a.requestKey,
            };
            if (canonical(row.payload).includes(secret.token))
              throw new ToolValidationError(
                "Resolved content must not contain the connection credential",
              );
            await validateMcpSchema(schema, dispatchArgs, signal);
            resolution = row.link_resolution;
            if (signal?.aborted)
              throw new ToolValidationError(
                "Task cancelled; operation retained for inspection",
              );
            let result: any;
            dispatched = true;
            try {
              result = decode(
                this.safe(await s.call(a.tool, dispatchArgs), secret.token),
                g.result,
              );
            } catch (e) {
              const failure =
                e instanceof McpFailure ? e : new McpFailure("uncertain");
              // A text-only business error has no reliable certainty contract. Preserve the key.
              if (["invalid", "permission"].includes(failure.category)) {
                await this.db.query(
                  "UPDATE mcp_operations SET state='rejected',result=$4::jsonb,updated_at=now() WHERE user_id=$1 AND connection=$2 AND request_key=$3",
                  [
                    user,
                    c.id,
                    a.requestKey,
                    JSON.stringify({ category: failure.category }),
                  ],
                );
              }
              if (!["invalid", "permission"].includes(failure.category))
                await this.db.query(
                  "UPDATE mcp_operations SET result=$4::jsonb,updated_at=now() WHERE user_id=$1 AND connection=$2 AND request_key=$3",
                  [
                    user,
                    c.id,
                    a.requestKey,
                    JSON.stringify({
                      category: failure.category,
                      ...(failure.retryAfterSeconds !== undefined
                        ? {
                            retryAt:
                              Date.now() + failure.retryAfterSeconds * 1000,
                          }
                        : {}),
                    }),
                  ],
                );
              return {
                requestKey: a.requestKey,
                state: ["invalid", "permission"].includes(failure.category)
                  ? "rejected"
                  : "pending",
                category: failure.category,
                retryAfterSeconds: failure.retryAfterSeconds,
                note:
                  failure.category === "auth"
                    ? "Reconnect this connection before retrying with the same key."
                    : "Inspect this operation; retry only with the same key and payload.",
              };
            }
            if (resolution) result = { ...result, linkResolution: resolution };
            await this.db.query(
              "UPDATE mcp_operations SET state='complete',result=$4::jsonb,updated_at=now() WHERE user_id=$1 AND connection=$2 AND request_key=$3",
              [user, c.id, a.requestKey, JSON.stringify(result)],
            );
            await this.reconcile(user, a, result);
            if (
              g.result === "reader_receipt" &&
              result.submissionId &&
              ["queued", "processing", "bookmark"].includes(result.status) &&
              c.tools.some(
                (t) => t.name === "get_save_status" && t.mode === "read",
              )
            ) {
              const pollSignal = AbortSignal.any([
                ...(signal ? [signal] : []),
                AbortSignal.timeout(45000),
              ]);
              for (const seconds of result.status === "bookmark"
                ? [0]
                : [2, 5, 10, 20]) {
                try {
                  await this.wait(seconds * 1000, pollSignal);
                  if (pollSignal.aborted) break;
                  const status = (await this.call(
                    user,
                    {
                      operation: "mcp_read",
                      connection: c.id,
                      tool: "get_save_status",
                      arguments: { submission_id: result.submissionId },
                    },
                    pollSignal,
                  )) as any;
                  result = {
                    ...result,
                    status: status.status,
                    error: status.error,
                  };
                  if (!["queued", "processing"].includes(result.status)) break;
                } catch {
                  break;
                }
              }
              await this.db.query(
                "UPDATE mcp_operations SET result=$4::jsonb,updated_at=now() WHERE user_id=$1 AND connection=$2 AND request_key=$3",
                [user, c.id, a.requestKey, JSON.stringify(result)],
              );
            }
            return {
              requestKey: a.requestKey,
              state: "complete",
              result,
              ...(result?.status === "queued" || result?.status === "processing"
                ? {
                    note: "Save accepted; import still pending. Check later with mcp_read; never claim phone offline availability.",
                  }
                : {}),
            };
          },
          signal,
        );
      } catch (e) {
        if (
          dispatched ||
          e instanceof ToolValidationError ||
          (e instanceof McpFailure &&
            ["capacity", "auth", "permission"].includes(e.category))
        )
          throw e;
        throw new ToolValidationError(
          e instanceof McpFailure && e.category === "auth"
            ? "MCP authentication failed before saving; reconnect first"
            : "MCP discovery failed before saving; no write was submitted",
        );
      }
    });
  }
}
