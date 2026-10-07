import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  McpTools,
  mcpRegistrySchema,
  parseMcpCredentials,
} from "../src/mcp.js";
import {
  sdkTransport,
  McpFailure,
  type McpTransport,
  type RemoteTool,
} from "../src/mcp-client.js";
import { ensureUser, type Database } from "../src/db.js";
import { runtimeContext } from "../src/runtime.js";
import { readOperations } from "../src/execution.js";
import { action } from "../src/protocol.js";
import { ToolValidationError, toolError } from "../src/tool-errors.js";

const token = "test-credential-for-mcp-only";
const registry = {
  version: 1,
  connections: [
    {
      id: "reader",
      url: "https://reader.example.com/mcp",
      credential: "reader",
      description: "Save articles",
      tools: [
        {
          name: "save_link",
          mode: "idempotent_write",
          idempotencyArgument: "idempotency_key",
          result: "reader_receipt",
        },
        {
          name: "save_document",
          mode: "idempotent_write",
          idempotencyArgument: "idempotency_key",
          result: "reader_receipt",
        },
        { name: "get_save_status", mode: "read", result: "reader_status" },
      ],
    },
  ],
};
const credentials = { reader: { owner: "123", token } };
const remote: RemoteTool[] = [
  {
    name: "save_link",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri", maxLength: 2048 },
        idempotency_key: { type: "string" },
      },
      required: ["url", "idempotency_key"],
      additionalProperties: false,
    },
  },
  {
    name: "save_document",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 300 },
        markdown: { type: "string", maxLength: 200000 },
        sources: {
          type: "array",
          items: { type: "string", format: "uri" },
          maxItems: 30,
        },
        idempotency_key: { type: "string" },
      },
      required: ["title", "markdown", "idempotency_key"],
      additionalProperties: false,
    },
  },
  {
    name: "get_save_status",
    inputSchema: {
      type: "object",
      properties: { submission_id: { type: "string", format: "uuid" } },
      required: ["submission_id"],
      additionalProperties: false,
    },
  },
  { name: "delete_all", inputSchema: { type: "object" } },
];
const text = (data: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});
async function fixture() {
  const pg = new PGlite();
  for (const name of [
    "001_initial",
    "002_preparation",
    "003_skills",
    "004_daily",
    "005_work",
    "006_runtime",
    "030_mcp",
  ])
    await pg.exec(
      await readFile(new URL(`../db/${name}.sql`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let schemas = structuredClone(remote);
  let outcome: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown> = async (name, args) =>
    name === "get_save_status"
      ? text({ id: args.submission_id, status: "ready", error: null })
      : text({
          submission_id: randomUUID(),
          status: "ready",
          duplicate: false,
        });
  const transport: McpTransport = async (_url, supplied, use) => {
    assert.equal(supplied, token);
    return use({
      list: async () => schemas,
      call: async (name, args) => {
        calls.push({ name, args });
        return outcome(name, args);
      },
    });
  };
  const make = () =>
    new McpTools(db, registry, credentials, transport, async () => {});
  return {
    pg,
    db,
    calls,
    make,
    tools: make(),
    setOutcome: (fn: typeof outcome) => {
      outcome = fn;
    },
    setSchemas: (v: RemoteTool[]) => {
      schemas = v;
    },
  };
}
const save = (requestKey = randomUUID()) => ({
  operation: "mcp_write",
  connection: "reader",
  tool: "save_link",
  requestKey,
  arguments: { url: "https://example.org/article" },
});

test("discovery exposes only reviewed grants; owner and read/write boundaries precede external calls", async () => {
  const f = await fixture();
  try {
    const list: any = await f.tools.call("123", { operation: "mcp_tools" });
    assert.deepEqual(
      list.connections[0].tools.map((t: any) => t.qualifiedName),
      ["reader/save_link", "reader/save_document", "reader/get_save_status"],
    );
    assert.deepEqual(await f.tools.call("456", { operation: "mcp_tools" }), {
      connections: [],
    });
    await assert.rejects(f.tools.call("456", save()), /owner/);
    await assert.rejects(
      f.tools.call("123", {
        operation: "mcp_read",
        connection: "reader",
        tool: "save_link",
        arguments: {},
      }),
      /not granted/,
    );
    await assert.rejects(
      f.tools.call("123", { ...save(), tool: "delete_all" }),
      /not granted/,
    );
    await assert.rejects(
      f.tools.call("123", { ...save(), arguments: { url: "bad" } }),
      /invalid/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(
      (await f.db.query("SELECT * FROM mcp_operations")).rows.length,
      0,
    );
  } finally {
    await f.pg.close();
  }
});

test("save persists payload before dispatch; duplicate and restarted replay reuse one intent", async () => {
  const f = await fixture();
  const a = save();
  const id = randomUUID();
  try {
    f.setOutcome(async (_name, args) => {
      const row = (await f.db.query("SELECT * FROM mcp_operations")).rows[0];
      assert.equal(row.request_key, a.requestKey);
      assert.equal(row.payload.url, a.arguments.url);
      assert.equal(args.idempotency_key, a.requestKey);
      return text({ submission_id: id, status: "ready", duplicate: false });
    });
    const first: any = await f.tools.call("123", a);
    assert.equal(first.result.submissionId, id);
    assert.equal(first.result.phoneOffline, "unverified");
    assert.deepEqual(
      await f.make().call("123", { ...a, arguments: undefined }),
      first,
    );
    assert.equal(f.calls.length, 1);
    await assert.rejects(
      f.tools.call("123", { ...a, arguments: { url: "https://other.org/" } }),
      /payload/,
    );
    await assert.rejects(
      f.tools.call("456", {
        operation: "mcp_operation",
        connection: "reader",
        requestKey: a.requestKey,
      }),
      /owner/,
    );
  } finally {
    await f.pg.close();
  }
});

test("uncertain writes retain the key, prevent another write, and settle only an exact stopped call", async () => {
  const f = await fixture();
  const a = save();
  const run = randomUUID();
  const journal = randomUUID();
  try {
    f.setOutcome(async () => {
      throw new McpFailure("uncertain");
    });
    const failed: any = await f.tools.call("123", a);
    assert.equal(failed.state, "pending");
    assert.equal(await f.tools.pendingAllows("123", save()), false);
    await assert.rejects(f.tools.call("123", save()), /pending/);
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,state) VALUES($1,'123','stopped')",
      [run],
    );
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state) VALUES($1,$2,'provider','mcp_write',$3::jsonb,true,'uncertain')",
      [
        journal,
        run,
        JSON.stringify({
          raw: JSON.stringify({
            connection: a.connection,
            tool: a.tool,
            requestKey: a.requestKey,
            arguments: a.arguments,
          }),
        }),
      ],
    );
    const uncertain = (
      await f.db.query("SELECT operation,arguments FROM runtime_calls")
    ).rows;
    assert.equal(await f.tools.replayMatches("123", a, uncertain), true);
    assert.equal(
      await f.tools.replayMatches("123", a, [
        ...uncertain,
        { operation: "calendar_draft", arguments: {} },
      ]),
      false,
    );
    f.setOutcome(async () =>
      text({ submission_id: randomUUID(), status: "ready", duplicate: true }),
    );
    await f.make().call("123", { ...a, arguments: undefined });
    assert.deepEqual(
      f.calls.map((c) => c.args.idempotency_key),
      [a.requestKey, a.requestKey],
    );
    assert.equal(
      (
        await f.db.query("SELECT state FROM runtime_calls WHERE id=$1", [
          journal,
        ])
      ).rows[0].state,
      "success",
    );
  } finally {
    await f.pg.close();
  }
});

test("schema drift or replaced credential cannot replay an earlier pending write", async () => {
  const f = await fixture();
  const a = save();
  try {
    f.setOutcome(async () => {
      throw new McpFailure("uncertain");
    });
    await f.tools.call("123", a);
    const changed = structuredClone(remote);
    changed[0]!.inputSchema.required = ["url", "idempotency_key", "new_field"];
    f.setSchemas(changed);
    await assert.rejects(
      f.make().call("123", { ...a, arguments: undefined }),
      /schema changed/,
    );
    const replaced = new McpTools(f.db, registry, {
      reader: { owner: "123", token: "replacement-credential-test" },
    });
    await assert.rejects(replaced.call("123", a), /another connection/);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("Reader terminal states, bounded polling and cancellation never claim phone downloads", async () => {
  const f = await fixture();
  const id = randomUUID();
  let polls = 0;
  try {
    f.setOutcome(async (name) =>
      name === "get_save_status"
        ? (polls++,
          text({
            id,
            status: polls === 2 ? "bookmark" : "processing",
            error: polls === 2 ? "Extraction failed" : null,
          }))
        : text({ submission_id: id, status: "queued", duplicate: false }),
    );
    const result: any = await f.tools.call("123", save());
    assert.equal(polls, 2);
    assert.equal(result.result.status, "bookmark");
    assert.equal(result.result.error, "Extraction failed");
    f.setOutcome(async () =>
      text({ submission_id: null, status: "already_saved", duplicate: true }),
    );
    const duplicate: any = await f.tools.call("123", save());
    assert.equal(duplicate.result.submissionId, null);
    assert.equal(polls, 2);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      f.tools.call("123", save(), controller.signal),
      /cancelled/,
    );
  } finally {
    await f.pg.close();
  }
});

test("rate limiting honours retry-after; authentication rejection stops unchanged attempts", async () => {
  const f = await fixture();
  try {
    const a = save();
    f.setOutcome(async () => {
      throw new McpFailure("capacity", 60);
    });
    await f.tools.call("123", a);
    const throttled: any = await f.tools.call("123", a);
    assert.ok(throttled.retryAfterSeconds > 0);
    assert.equal(f.calls.length, 1);
    await f.db.query("DELETE FROM mcp_operations");
    await f.db.query("DELETE FROM mcp_connection_state");
    const b = save();
    f.setOutcome(async () => {
      throw new McpFailure("auth");
    });
    await f.tools.call("123", b);
    await f.tools.call("123", b);
    assert.equal(f.calls.length, 2);
    assert.equal(
      toolError(new McpFailure("auth")).code,
      "AUTHORIZATION_REQUIRED",
    );
  } finally {
    await f.pg.close();
  }
});

test("different generic server works with configuration and JSON schemas, without a domain adapter", async () => {
  const f = await fixture();
  try {
    const other = {
      version: 1,
      connections: [
        {
          id: "notes",
          credential: "reader",
          url: "https://notes.example.com/mcp",
          description: "Notes",
          tools: [{ name: "lookup", mode: "read" }],
        },
      ],
    };
    f.setSchemas([
      {
        name: "lookup",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        },
      },
    ]);
    f.setOutcome(async () => ({
      structuredContent: { found: true },
      content: [],
    }));
    const tools = new McpTools(
      f.db,
      other,
      credentials,
      async (_url, _token, use) =>
        use({
          list: async () => [
            {
              name: "lookup",
              inputSchema: {
                type: "object",
                required: ["title"],
                properties: { title: { type: "string" } },
                additionalProperties: false,
              },
            },
          ],
          call: async () => ({
            structuredContent: { found: true },
            content: [],
          }),
        }),
    );
    const found: any = await tools.call("123", {
      operation: "mcp_read",
      connection: "notes",
      tool: "lookup",
      arguments: { title: "Saved note" },
    });
    assert.equal(found.structuredContent.found, true);
    await assert.rejects(
      tools.call("123", {
        operation: "mcp_read",
        connection: "notes",
        tool: "lookup",
        arguments: { title: 1 },
      }),
      /invalid/,
    );
  } finally {
    await f.pg.close();
  }
});

test("SDK handles public handshake and stateless text results; HTTP failures do not leak response bodies", async () => {
  const methods: string[] = [];
  const http: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://reader.example.com/mcp");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${token}`,
    );
    assert.equal(init?.redirect, "error");
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const body = JSON.parse(String(init?.body));
    methods.push(body.method);
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : body.method === "tools/list"
          ? { tools: remote }
          : text({ done: true });
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
  const result: any = await sdkTransport(http)(
    "https://reader.example.com/mcp",
    token,
    async (s) => {
      assert.equal((await s.list()).length, 4);
      return s.call("save_link", {
        url: "https://example.org/",
        idempotency_key: "stable",
      });
    },
  );
  assert.equal(JSON.parse(result.content[0].text).done, true);
  assert.ok(methods.includes("notifications/initialized"));
  const bad: typeof fetch = async () => new Response(token, { status: 401 });
  await assert.rejects(
    sdkTransport(bad)(
      "https://reader.example.com/mcp",
      token,
      async () => null,
    ),
    (e: unknown) =>
      e instanceof McpFailure &&
      e.category === "auth" &&
      !e.message.includes(token),
  );
});

test("runtime gates MCP off by default; schemas and registry reject unsafe configurations", () => {
  assert.equal(
    runtimeContext({}, {}).tools.some((t) => t.name.startsWith("mcp_")),
    false,
  );
  assert.equal(
    runtimeContext({ mcp: true }, {}).tools.filter((t) =>
      t.name.startsWith("mcp_"),
    ).length,
    4,
  );
  assert.equal(readOperations.has("mcp_write"), false);
  assert.equal(readOperations.has("mcp_read"), true);
  assert.ok(action.safeParse(save()).success);
  assert.throws(() =>
    mcpRegistrySchema.parse({
      ...registry,
      connections: [
        { ...registry.connections[0], url: "http://localhost/mcp" },
      ],
    }),
  );
  assert.throws(
    () =>
      parseMcpCredentials('{"reader":{"owner":"123","token":"private-short"}}'),
    /values withheld/,
  );
  assert.throws(
    () =>
      new McpTools(
        { query: async () => ({ rows: [] }) },
        {
          ...registry,
          connections: [
            {
              ...registry.connections[0],
              tools: [{ name: "delete_all", mode: "idempotent_write" }],
            },
          ],
        },
        credentials,
      ),
  );
  assert.ok(new ToolValidationError("test") instanceof Error);
});

test("failure before write dispatch creates no pending intent; text business errors remain inspectable", async () => {
  const f = await fixture();
  try {
    const broken: McpTransport = async () => {
      throw new McpFailure("auth");
    };
    const unavailable = new McpTools(f.db, registry, credentials, broken);
    await assert.rejects(unavailable.call("123", save()), McpFailure);
    await f.db.query("DELETE FROM mcp_connection_state");
    assert.equal(
      (await f.db.query("SELECT * FROM mcp_operations")).rows.length,
      0,
    );
    f.setOutcome(async () => {
      throw new McpFailure("tool");
    });
    const a = save();
    const result: any = await f.tools.call("123", a);
    assert.equal(result.state, "pending");
    const status: any = await f.tools.call("123", {
      operation: "mcp_operation",
      connection: "reader",
      requestKey: a.requestKey,
    });
    assert.equal(status.result.category, "tool");
  } finally {
    await f.pg.close();
  }
});

test("concurrent duplicate requests produce one dispatch; discovered schema and result cannot expose bearer secret", async () => {
  const f = await fixture();
  try {
    const a = save();
    await Promise.all([f.tools.call("123", a), f.tools.call("123", a)]);
    assert.equal(f.calls.length, 1);
    const changed = structuredClone(remote);
    changed[0]!.inputSchema.description = token;
    f.setSchemas(changed);
    assert.equal(
      JSON.stringify(
        await f.tools.call("123", { operation: "mcp_tools" }),
      ).includes(token),
      false,
    );
    f.setOutcome(async (_name, args) =>
      text({ id: args.submission_id, status: "bookmark", error: token }),
    );
    const status = await f.tools.call("123", {
      operation: "mcp_read",
      connection: "reader",
      tool: "get_save_status",
      arguments: { submission_id: randomUUID() },
    });
    assert.equal(JSON.stringify(status).includes(token), false);
  } finally {
    await f.pg.close();
  }
});

test("escaped bearer values are removed before JSON serialization", async () => {
  const f = await fixture();
  try {
    const escaped = 'synthetic-quote-"-and-backslash-\\-credential';
    const transport: McpTransport = async (_url, _token, use) =>
      use({
        list: async () => remote,
        call: async (_name, args) =>
          text({ id: args.submission_id, status: "bookmark", error: escaped }),
      });
    const tools = new McpTools(
      f.db,
      registry,
      { reader: { owner: "123", token: escaped } },
      transport,
    );
    const result: any = await tools.call("123", {
      operation: "mcp_read",
      connection: "reader",
      tool: "get_save_status",
      arguments: { submission_id: randomUUID() },
    });
    assert.equal(result.error, "[REDACTED_CREDENTIAL]");
  } finally {
    await f.pg.close();
  }
});

test("Reader preserves pending receipt on a mismatched or deadline-expired status", async () => {
  const f = await fixture();
  const id = randomUUID();
  const timeout = AbortSignal.timeout;
  try {
    f.setOutcome(async (name) =>
      name === "get_save_status"
        ? text({ id: randomUUID(), status: "ready", error: null })
        : text({ submission_id: id, status: "queued", duplicate: false }),
    );
    const mismatch: any = await f.tools.call("123", save());
    assert.equal(mismatch.result.status, "queued");
    AbortSignal.timeout = (ms) => timeout(ms === 45000 ? 1 : ms);
    const transport: McpTransport = async (_url, _token, use, signal) =>
      use({
        list: async () => remote,
        call: async (name) => {
          if (name === "get_save_status") {
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (signal?.aborted) throw new McpFailure("uncertain");
            return text({ id, status: "ready", error: null });
          }
          return text({
            submission_id: id,
            status: "queued",
            duplicate: false,
          });
        },
      });
    const tools = new McpTools(
      f.db,
      registry,
      credentials,
      transport,
      async () => {},
    );
    const expired: any = await tools.call("123", save());
    assert.equal(expired.result.status, "queued");
  } finally {
    AbortSignal.timeout = timeout;
    await f.pg.close();
  }
});

test("initial bookmark fetches its explanation without waiting or claiming offline availability", async () => {
  const f = await fixture();
  const id = randomUUID();
  try {
    f.setOutcome(async (name) =>
      name === "get_save_status"
        ? text({
            id,
            status: "bookmark",
            error: "Extraction failed; retained URL",
          })
        : text({ submission_id: id, status: "bookmark", duplicate: false }),
    );
    const result: any = await f.tools.call("123", save());
    assert.equal(result.result.error, "Extraction failed; retained URL");
    assert.equal(result.result.phoneOffline, "unverified");
    assert.equal(f.calls.length, 2);
  } finally {
    await f.pg.close();
  }
});

test("discovery throttling survives restart and preserves retry timing without submitting a save", async () => {
  const f = await fixture();
  let attempts = 0;
  try {
    const transport: McpTransport = async () => {
      attempts++;
      throw new McpFailure("capacity", 60);
    };
    const first = new McpTools(f.db, registry, credentials, transport);
    const second = new McpTools(f.db, registry, credentials, transport);
    await assert.rejects(
      first.call("123", save()),
      (e: unknown) => e instanceof McpFailure && e.retryAfterSeconds === 60,
    );
    await assert.rejects(
      second.call("123", save()),
      (e: unknown) => e instanceof McpFailure && (e.retryAfterSeconds ?? 0) > 0,
    );
    assert.equal(attempts, 1);
    assert.equal(
      (await f.db.query("SELECT * FROM mcp_operations")).rows.length,
      0,
    );
  } finally {
    await f.pg.close();
  }
});

test("restart before persistence settles only stopped calls without intents, never pending writes", async () => {
  const f = await fixture();
  const a = save();
  const run = randomUUID();
  const id = randomUUID();
  try {
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,state) VALUES($1,'123','stopped')",
      [run],
    );
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state) VALUES($1,$2,'before-persistence','mcp_write',$3::jsonb,true,'uncertain')",
      [id, run, JSON.stringify({ raw: JSON.stringify(a) })],
    );
    await f.tools.settleUnsubmitted("456");
    assert.equal(
      (await f.db.query("SELECT state FROM runtime_calls WHERE id=$1", [id]))
        .rows[0].state,
      "uncertain",
    );
    await f.tools.settleUnsubmitted("123");
    assert.equal(
      (await f.db.query("SELECT state FROM runtime_calls WHERE id=$1", [id]))
        .rows[0].state,
      "failed",
    );
    f.setOutcome(async () => {
      throw new McpFailure("uncertain");
    });
    await f.tools.call("123", a);
    await f.db.query("UPDATE runtime_calls SET state='uncertain' WHERE id=$1", [
      id,
    ]);
    await f.tools.settleUnsubmitted("123");
    assert.equal(
      (await f.db.query("SELECT state FROM runtime_calls WHERE id=$1", [id]))
        .rows[0].state,
      "uncertain",
    );
  } finally {
    await f.pg.close();
  }
});
