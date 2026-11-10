import { randomUUID } from "node:crypto";
import { McpTools } from "../../src/mcp.js";
import type { McpTransport } from "../../src/mcp-client.js";
import { McpFailure } from "../../src/mcp-client.js";
import type { Database } from "../../src/db.js";

/**
 * Reader over the real McpTools, so every test's mock behaves exactly like src/mcp.ts:
 * a request key replays its stored result and refuses a different payload under it.
 */
export function readerServer() {
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
          { name: "get_save_status", mode: "read", result: "reader_status" },
        ],
      },
      {
        id: "reader-library",
        url: "https://reader.example.com/mcp",
        credential: "reader",
        description: "Saved articles",
        tools: [
          { name: "list_saved_articles", mode: "read", result: "reader_saved" },
        ],
      },
    ],
  };
  const credentials = {
    reader: { owner: "123", token: "reader-token-for-tests" },
  };
  const tools = [
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
      name: "get_save_status",
      inputSchema: {
        type: "object",
        properties: { submission_id: { type: "string" } },
        required: ["submission_id"],
        additionalProperties: false,
      },
    },
    { name: "list_saved_articles", inputSchema: { type: "object" } },
  ];
  // The server side of Reader: a key is bound to the payload it was first sent with.
  const stored = new Map<string, { url: string; result: unknown }>();
  const calls: { key: string; url: string }[] = [];
  let failNext: "invalid" | "uncertain" | null = null;
  let library: { url: string; title: string; domain: string }[] = [];
  const text = (data: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(data) }],
  });
  const transport: McpTransport = async (_url, _token, use) =>
    use({
      list: async () => tools,
      call: async (name, args) => {
        if (name === "list_saved_articles")
          return text({
            articles: library.map((a) => ({
              ...a,
              site: a.domain,
              saved_at: "2026-11-01T00:00:00.000Z",
            })),
            next: null,
          });
        if (name !== "save_link")
          return text({ id: args.submission_id, status: "ready", error: null });
        const key = String(args.idempotency_key);
        const url = String(args.url);
        calls.push({ key, url });
        const prior = stored.get(key);
        if (prior) {
          if (prior.url !== url) throw new McpFailure("invalid");
          return text(prior.result);
        }
        if (failNext === "invalid") {
          failNext = null;
          throw new McpFailure("invalid");
        }
        if (failNext === "uncertain") {
          failNext = null;
          throw new McpFailure("uncertain");
        }
        const result = {
          submission_id: randomUUID(),
          status: "queued",
          duplicate: false,
        };
        stored.set(key, { url, result });
        return text(result);
      },
    });
  // The database holds the key→payload binding the replay check reads.
  const make = (db: Database) =>
    new McpTools(
      db,
      registry as any,
      credentials as any,
      transport,
      async () => {},
    );
  return {
    calls,
    stored,
    make,
    fail: (kind: "invalid" | "uncertain" | null) => {
      failNext = kind;
    },
    setLibrary: (items: { url: string; title: string; domain: string }[]) => {
      library = items;
    },
  };
}
