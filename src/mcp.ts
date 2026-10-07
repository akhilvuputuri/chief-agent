import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import type { Database } from "./db.js";
import { publicHttps, SerialQueue } from "./security.js";
import { ToolValidationError } from "./tool-errors.js";
import {
  McpFailure,
  sdkTransport,
  type McpTransport,
  type RemoteTool,
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
  ) {
    this.registry = mcpRegistrySchema.parse(registry);
    this.credentials = credentialSchema.parse(credentials);
  }
  get configured() {
    return this.registry.connections.some(
      (c) => !!this.credentials[c.credential],
    );
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
  private validate(
    schema: Record<string, unknown>,
    args: Record<string, unknown>,
  ) {
    try {
      // Compile locally, never retrieve remote references or execute schemas. No coercion/default mutation.
      const Validator =
        schema.$schema === "https://json-schema.org/draft/2020-12/schema"
          ? Ajv2020
          : Ajv;
      const ajv = new Validator({
        strict: false,
        validateFormats: true,
        ownProperties: true,
      });
      addFormats.default(ajv);
      if (!ajv.compile(schema)(args)) throw new Error();
    } catch {
      throw new ToolValidationError(
        "MCP arguments or discovered schema are invalid; inspect mcp_tools",
      );
    }
  }
  private safe(result: unknown, token: string) {
    const encoded = JSON.stringify(result);
    if (!encoded || Buffer.byteLength(encoded) > 200000)
      throw new McpFailure("uncertain");
    return JSON.parse(encoded.split(token).join("[REDACTED_CREDENTIAL]"));
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
      (a.arguments && canonical(a.arguments) !== canonical(row.payload))
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
              await this.transport(
                c.url,
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
      return this.transport(
        c.url,
        secret.token,
        async (s) => {
          this.validate(this.discovered(await s.list(), a.tool), a.arguments);
          try {
            return decode(
              this.safe(await s.call(a.tool, a.arguments), secret.token),
              g.result,
            );
          } catch (e) {
            if (e instanceof McpFailure) throw e;
            throw new McpFailure("uncertain");
          }
        },
        signal,
      );
    }
    const g = this.grant(c, a.tool, "idempotent_write");
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
      const payload = row?.payload ?? a.arguments;
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
        return await this.transport(
          c.url,
          secret.token,
          async (s) => {
            const schema = this.discovered(await s.list(), a.tool);
            const schemaHash = hash(schema);
            if (row && row.schema_hash !== schemaHash)
              throw new ToolValidationError(
                "MCP schema changed; reconcile the previous operation before retrying",
              );
            const args = { ...payload, [g.idempotencyArgument!]: a.requestKey };
            this.validate(schema, args);
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
              "INSERT INTO mcp_operations(user_id,connection,request_key,tool,binding,schema_hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING",
              [
                user,
                c.id,
                a.requestKey,
                a.tool,
                binding,
                schemaHash,
                JSON.stringify(payload),
              ],
            );
            row = await this.stored(user, c.id, a.requestKey);
            this.checkReplay(row, binding, a);
            if (signal?.aborted)
              throw new ToolValidationError(
                "Task cancelled; operation retained for inspection",
              );
            let result: any;
            dispatched = true;
            try {
              result = decode(
                this.safe(await s.call(a.tool, args), secret.token),
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
            await this.db.query(
              "UPDATE mcp_operations SET state='complete',result=$4::jsonb,updated_at=now() WHERE user_id=$1 AND connection=$2 AND request_key=$3",
              [user, c.id, a.requestKey, JSON.stringify(result)],
            );
            await this.reconcile(user, a, result);
            if (
              g.result === "reader_receipt" &&
              result.submissionId &&
              ["queued", "processing"].includes(result.status) &&
              c.tools.some(
                (t) => t.name === "get_save_status" && t.mode === "read",
              )
            ) {
              const pollSignal = AbortSignal.any([
                ...(signal ? [signal] : []),
                AbortSignal.timeout(45000),
              ]);
              for (const seconds of [2, 5, 10, 20]) {
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
                    signal,
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
        if (dispatched || e instanceof ToolValidationError) throw e;
        throw new ToolValidationError(
          e instanceof McpFailure && e.category === "auth"
            ? "MCP authentication failed before saving; reconnect first"
            : "MCP discovery failed before saving; no write was submitted",
        );
      }
    });
  }
}
