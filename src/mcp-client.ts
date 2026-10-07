import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolValidationError } from "./tool-errors.js";
import { McpFailure } from "./mcp-errors.js";
export { McpFailure } from "./mcp-errors.js";
export type RemoteTool = {
  name: string;
  inputSchema: Record<string, unknown>;
  description?: string;
};
export interface McpSession {
  list(): Promise<RemoteTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}
export type McpTransport = <T>(
  url: string,
  token: string,
  use: (session: McpSession) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

/** No OAuth, roots, sampling, elicitation or process execution is granted to a server. */
export function sdkTransport(http: typeof fetch = fetch): McpTransport {
  return async (url, token, use, signal) => {
    const client = new Client(
      { name: "chief", version: "1" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (input, init) => {
        if (String(input) !== url)
          throw new ToolValidationError("MCP endpoint changed");
        const headers = new Headers(init?.headers);
        if (token) headers.set("Authorization", `Bearer ${token}`);
        else headers.delete("Authorization");
        if (
          typeof init?.body === "string" &&
          Buffer.byteLength(init.body) > 220000
        )
          throw new ToolValidationError("MCP request exceeds 220000 bytes");
        const response = await http(input, {
          ...init,
          headers,
          redirect: "error",
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            ...(signal ? [signal] : []),
            AbortSignal.timeout(20000),
          ]),
        });
        if (!response.ok && response.status !== 405) {
          await response.body?.cancel();
          const after = response.headers.get("retry-after");
          const seconds =
            after && /^\d+$/.test(after)
              ? Number(after)
              : after
                ? Math.max(
                    0,
                    Math.ceil((Date.parse(after) - Date.now()) / 1000),
                  )
                : undefined;
          throw new McpFailure(
            response.status === 401
              ? "auth"
              : response.status === 403
                ? "permission"
                : [400, 413].includes(response.status)
                  ? "invalid"
                  : response.status === 429
                    ? "capacity"
                    : "uncertain",
            Number.isFinite(seconds) ? seconds : undefined,
          );
        }
        let bytes = 0;
        const body = response.body?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > 500000) throw new McpFailure("uncertain");
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    });
    try {
      await client.connect(transport, { timeout: 20000 });
      return await use({
        async list() {
          const tools: RemoteTool[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 5; page++) {
            const result = await client.listTools(cursor ? { cursor } : {}, {
              timeout: 20000,
            });
            tools.push(...result.tools);
            if (tools.length > 200)
              throw new ToolValidationError("MCP catalogue exceeds limits");
            cursor = result.nextCursor;
            if (!cursor) return tools;
          }
          throw new ToolValidationError("MCP catalogue exceeds limits");
        },
        async call(name, args) {
          const result = await client.callTool(
            { name, arguments: args },
            undefined,
            { timeout: 20000 },
          );
          if (result.isError) throw new McpFailure("tool");
          // Do not expose binary/resource content or server instructions as host authority.
          return {
            ...(result.structuredContent
              ? { structuredContent: result.structuredContent }
              : {}),
            content: Array.isArray(result.content)
              ? result.content.filter((part) => part.type === "text")
              : [],
          };
        },
      });
    } catch (error) {
      if (error instanceof McpFailure || error instanceof ToolValidationError)
        throw error;
      // SDK/server errors can contain private response bodies, URLs and authorization data.
      throw new McpFailure("uncertain");
    } finally {
      await client.close().catch(() => {});
    }
  };
}
